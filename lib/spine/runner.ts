/** Sync orchestration: backfill (once) → delta (every 15 min) → reconcile (nightly).
 *  All runs are idempotent (PK upserts) and watermark-driven (O(changes)). */
import { makeEtContext, etMidnightUtcMs } from "../sync/buckets";
import { COVERAGE_ANCHOR } from "../../config/hubspot";
import { hubspotGet } from "../hubspot/client";
import { aggregate } from "../sync/aggregate";
import { resolveAssociations, ContactMeta } from "../sync/associate";
import {
  pullActivities, pullChangedActivities, pullChangedCompanies, pullOwnedCompanies,
  pullOwnersTeams, PullCaps, RawActivity,
} from "../sync/pull";
import { activityToRow, nextWatermark } from "./rows";
import { loadTeamStructure } from "../team/load";
import { nameMap, trackedOwnerIds } from "../team/helpers";
import {
  getWatermark, loadStoreForAggregate, reconcileOwnedCompanies, replaceOwnersTeams,
  saveSnapshot, setSyncState, tryLock, unlock, upsertActivities, upsertCompanies, upsertContacts,
} from "./store";

const OVERLAP_MS = 5 * 60_000; // re-read 5 min to absorb clock skew / same-ms writes
const LOCK_TTL_MIN = 12;

function anchorMs(): number {
  const [y, m, d] = COVERAGE_ANCHOR.split("-").map(Number);
  return etMidnightUtcMs(y, m, d);
}

/** Probe read access + direction enum for one object type. Returns false ONLY on a
 *  403 scope error (cap off, degrade gracefully); any other error — e.g. a transient
 *  5xx — is a real failure and is rethrown (mirrors scripts/sync.ts checkAccess). */
async function checkAccess(obj: string, prop: string, expect: string): Promise<boolean> {
  try {
    const def = await hubspotGet<{ options?: { value: string }[] }>(`/crm/v3/properties/${obj}/${prop}`);
    if (!(def.options ?? []).some((o) => o.value === expect)) {
      console.warn(`  ⚠️  ${obj}.${prop} has no "${expect}" option — filter may return nothing.`);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(" 403 ")) {
      console.warn(`  ⚠️  No read access to ${obj} (403) — excluding it from this run.`);
      return false;
    }
    throw err;
  }
}

/** Which object types the token can read (calls/emails caps). */
export async function preflightCaps(): Promise<PullCaps> {
  return {
    calls: await checkAccess("calls", "hs_call_direction", "OUTBOUND"),
    emails: await checkAccess("emails", "hs_email_direction", "EMAIL"),
  };
}

async function refreshOwnersTeams() {
  const owners = await pullOwnersTeams();
  const teams = new Map<string, string>();
  const members: { team_id: string; owner_id: string; is_primary: boolean }[] = [];
  for (const o of owners) for (const t of o.teams ?? []) {
    teams.set(t.id, t.name);
    members.push({ team_id: t.id, owner_id: o.id, is_primary: !!t.primary });
  }
  await replaceOwnersTeams(
    owners.map((o) => ({ owner_id: o.id, email: o.email?.toLowerCase() ?? null,
      name: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || o.id, active: !o.archived })),
    [...teams].map(([team_id, name]) => ({ team_id, name })),
    members,
  );
  return owners.length;
}

async function persistResolved(raw: RawActivity[]) {
  const { activities, companyNames, companyGdStage, contactMeta } = await resolveAssociations(raw);
  const lastMod = new Map(raw.map((r) => [r.id, r.lastModifiedMs ?? null]));
  await upsertActivities(activities.map((a) => activityToRow(a, lastMod.get(a.id) ?? null)));
  await upsertCompanies(Object.keys(companyNames).map((id) => ({
    hs_id: id, name: companyNames[id], gd_stage: companyGdStage[id] ?? null,
  })));
  const metaRows = Object.entries(contactMeta).map(([hs_id, m]: [string, ContactMeta]) => ({
    hs_id, name: m.name, title: m.title, dm: m.dm,
  }));
  await upsertContacts(metaRows);
  return activities.length;
}

/** Rebuild the snapshot row from the spine. `expectData` guards the unattended cron:
 *  a delta/reconcile run should always find activities in the spine, so an empty read
 *  means a regression (bad anchor, fetchAll fault) — throw rather than silently
 *  overwrite the good snapshot row (which outranks the file fallback) with nothing.
 *  Backfill passes false: it is the run that legitimately populates an empty spine. */
export async function reaggregate(caps: PullCaps, expectData: boolean) {
  // Tracked roster is DB-backed (config fallback). Load once and share with the store read + the
  // aggregate so both use the same owner set within this run.
  const ts = await loadTeamStructure();
  const ownerIds = trackedOwnerIds(ts);
  const store = await loadStoreForAggregate(anchorMs(), ownerIds);
  if (expectData && store.activities.length === 0) {
    throw new Error("[spine] aggregate guard: spine returned 0 activities when data was expected — " +
      "refusing to overwrite the snapshot (check COVERAGE_ANCHOR and the store read).");
  }
  const ctx = makeEtContext(Date.now());
  const snap = aggregate(store.activities, store.companyNames, store.companyGdStage,
    store.contactMeta, store.ownedCompanies, ctx, Date.now(), caps, { ownerIds, names: nameMap(ts) });
  const sizeMb = Buffer.byteLength(JSON.stringify(snap)) / 1_048_576;
  console.log(`[spine] snapshot ${sizeMb.toFixed(2)} MB (${store.activities.length} activities)`);
  await saveSnapshot(snap);
  return snap.totals;
}

export async function runDelta(caps?: PullCaps): Promise<{ ran: boolean }> {
  caps ??= await preflightCaps();
  const lease = await tryLock(LOCK_TTL_MIN);
  if (!lease) { console.log("[delta] another run holds the lock — exiting."); return { ran: false }; }
  const t0 = Date.now();
  try {
    const [wmCalls, wmEmails, wmCompanies] = await Promise.all([
      getWatermark("calls"), getWatermark("emails"), getWatermark("companies")]);
    if (wmCalls === 0 && wmEmails === 0 && wmCompanies === 0) throw new Error("Watermarks are zero — run `npm run sync:backfill` first.");

    const raw = await pullChangedActivities(Math.max(0, wmCalls - OVERLAP_MS), Math.max(0, wmEmails - OVERLAP_MS), caps);
    const changedCompanies = await pullChangedCompanies(Math.max(0, wmCompanies - OVERLAP_MS));

    let upserted = 0;
    if (raw.length) upserted = await persistResolved(raw);
    if (changedCompanies.length) {
      await upsertCompanies(changedCompanies.map((c) => ({
        hs_id: c.id, name: c.name, gd_stage: c.gdStage, owner_id: c.ownerId || null, gd_id: c.gdId,
        is_group: c.isGroup, group_name: c.groupName, segment: c.segment,
        dealership_type: c.dealershipType, hs_lastmodified_ms: c.lastModifiedMs,
      })));
    }
    const ownerCount = await refreshOwnersTeams();
    const totals = await reaggregate(caps, true);

    const calls = raw.filter((r) => r.type === "call");
    const emails = raw.filter((r) => r.type === "email");
    await setSyncState("calls", { watermark_ms: nextWatermark(wmCalls, calls), last_counts: { changed: calls.length } });
    await setSyncState("emails", { watermark_ms: nextWatermark(wmEmails, emails), last_counts: { changed: emails.length } });
    await setSyncState("companies", { watermark_ms: nextWatermark(wmCompanies, changedCompanies), last_counts: { changed: changedCompanies.length } });
    await setSyncState("owners", { last_counts: { owners: ownerCount } });
    await setSyncState("lock", { last_duration_ms: Date.now() - t0, last_counts: { activities: upserted, snapshotCalls: totals.calls }, notes: "delta ok" });
    console.log(`[delta] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${raw.length} changed activities, ${changedCompanies.length} companies.`);
    return { ran: true };
  } catch (err) {
    await setSyncState("lock", { notes: `delta FAILED: ${err instanceof Error ? err.message : err}` }).catch(() => {});
    throw err;
  } finally {
    await unlock(lease);
  }
}

export async function runBackfill(caps: PullCaps) {
  const lease = await tryLock(120);
  if (!lease) throw new Error("locked");
  const t0 = Date.now();
  try {
    const start = anchorMs();
    console.log(`[backfill] full pull from ${COVERAGE_ANCHOR}…`);
    const raw = await pullActivities(start, Date.now(), caps);
    await persistResolved(raw);
    const books = await pullOwnedCompanies();
    const rows = Object.entries(books).flatMap(([ownerId, cos]) => cos.map((c) => ({
      hs_id: c.id, name: c.name, gd_stage: c.gdStage, owner_id: ownerId, gd_id: c.gdId,
      is_group: c.isGroup, group_name: c.groupName, segment: c.segment, dealership_type: c.dealershipType,
    })));
    await reconcileOwnedCompanies(rows);
    await refreshOwnersTeams();
    const totals = await reaggregate(caps, false); // backfill legitimately populates an empty spine
    // Watermark = run start − overlap: nothing modified after t0 can have been missed
    // by the pull, and the next delta re-reads the small overlap window on top.
    const wm = t0 - OVERLAP_MS;
    for (const k of ["calls", "emails", "companies"]) await setSyncState(k, { watermark_ms: wm });
    await setSyncState("lock", { last_duration_ms: Date.now() - t0, notes: "backfill ok" });
    console.log(`[backfill] done in ${((Date.now() - t0) / 60000).toFixed(1)}m — snapshot totals: ${totals.calls} calls / ${totals.emails} emails.`);
  } finally {
    await unlock(lease);
  }
}

/** Targeted full-history pull for ONE owner — used when an admin adds a new user (a delta only
 *  catches recently-modified rows, so a new owner needs a history pull). Scoped to the single
 *  owner: uses upsertCompanies (never the global reconcile, which would clear other owners). */
export async function runOwnerBackfill(ownerId: string, caps?: PullCaps) {
  caps ??= await preflightCaps();
  const lease = await tryLock(60);
  if (!lease) { console.log("[owner-backfill] another run holds the lock — exiting."); return; }
  const t0 = Date.now();
  try {
    console.log(`[owner-backfill] full history pull for owner ${ownerId} from ${COVERAGE_ANCHOR}…`);
    const raw = await pullActivities(anchorMs(), Date.now(), caps, [ownerId]);
    if (raw.length) await persistResolved(raw);
    const books = await pullOwnedCompanies([ownerId]);
    const rows = Object.entries(books).flatMap(([oid, cos]) => cos.map((c) => ({
      hs_id: c.id, name: c.name, gd_stage: c.gdStage, owner_id: oid, gd_id: c.gdId,
      is_group: c.isGroup, group_name: c.groupName, segment: c.segment, dealership_type: c.dealershipType,
    })));
    if (rows.length) await upsertCompanies(rows);
    await refreshOwnersTeams();
    await reaggregate(caps, true);
    await setSyncState("lock", { last_duration_ms: Date.now() - t0, notes: `owner-backfill ok (${ownerId}): ${raw.length} activities, ${rows.length} companies` });
    console.log(`[owner-backfill] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${raw.length} activities, ${rows.length} companies for ${ownerId}.`);
  } finally {
    await unlock(lease);
  }
}

export async function runReconcile(caps?: PullCaps) {
  caps ??= await preflightCaps();
  const lease = await tryLock(60);
  if (!lease) { console.log("[reconcile] locked — exiting."); return; }
  const t0 = Date.now();
  try {
    // Full book re-pull: catches owner moves AWAY from tracked reps (delta can't see those).
    const books = await pullOwnedCompanies();
    const rows = Object.entries(books).flatMap(([ownerId, cos]) => cos.map((c) => ({
      hs_id: c.id, name: c.name, gd_stage: c.gdStage, owner_id: ownerId, gd_id: c.gdId,
      is_group: c.isGroup, group_name: c.groupName, segment: c.segment, dealership_type: c.dealershipType,
    })));
    const cleared = await reconcileOwnedCompanies(rows);
    // Re-pull last 7 days of activity in full — refreshes rows that drifted (edited
    // dispositions/statuses). Rows deleted in HubSpot are NOT removed (known accepted gap).
    const since = Date.now() - 7 * 86_400_000;
    const raw = await pullActivities(since, Date.now(), caps);
    await persistResolved(raw);
    await refreshOwnersTeams();
    await reaggregate(caps, true);
    await setSyncState("lock", { last_duration_ms: Date.now() - t0, notes: `reconcile ok (cleared ${cleared} stale owners)` });
    console.log(`[reconcile] done in ${((Date.now() - t0) / 60000).toFixed(1)}m.`);
  } finally {
    await unlock(lease);
  }
}
