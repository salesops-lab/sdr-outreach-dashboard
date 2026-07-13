/** All sdr_* Postgres I/O. Server-only (service role). Batched, idempotent upserts. */
import { gzipSync, gunzipSync } from "node:zlib";
import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../supabase/admin";
import { Snapshot } from "../sync/types";
import { OwnedCompany } from "../sync/pull";
import { ContactMeta } from "../sync/associate";
import { ActivityRow, CompanyRow, ContactCompanyRow, ContactRow, DealRow, DealStageEventRow, OwnerRow, TeamMemberRow, TeamRow } from "./types";
import { rowToActivity, rowToContactMeta, rowToOwnedCompany, rowToDeal, rowToStageEvent } from "./rows";
import { Activity, Deal, DealStageEvent } from "../sync/types";

const BATCH = 500;
const PAGE = 1000;

function sb(): SupabaseClient {
  const c = supabaseAdmin();
  if (!c) throw new Error("[spine] Supabase env missing");
  return c;
}

async function upsertBatched(table: string, rows: object[], onConflict: string) {
  // Dedupe on the conflict key (last wins): duplicate keys within one statement abort the whole
  // upsert (Postgres 21000), and feeders (e.g. HubSpot search paginated on a mutable sort key)
  // can return the same record twice.
  const cols = onConflict.split(",");
  const keyOf = (r: Record<string, unknown>) => cols.map((c) => String(r[c])).join(" ");
  rows = [...new Map((rows as Record<string, unknown>[]).map((r) => [keyOf(r), r])).values()] as object[];
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await sb().from(table).upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) throw new Error(`[spine] upsert ${table}: ${error.message}`);
  }
}

export const upsertActivities = (rows: ActivityRow[]) => upsertBatched("sdr_activities", rows, "hs_id");
export const upsertCompanies = (rows: Partial<CompanyRow>[]) => upsertBatched("sdr_companies", rows as object[], "hs_id");
export const upsertContacts = (rows: ContactRow[]) => upsertBatched("sdr_contacts", rows, "hs_id");
export const upsertDeals = (rows: DealRow[]) => upsertBatched("sdr_deals", rows, "hs_id");
export const upsertDealStageEvents = (rows: DealStageEventRow[]) =>
  upsertBatched("sdr_deal_stage_events", rows, "deal_id,stage_key,entered_ms");
export const upsertContactCompanies = (rows: ContactCompanyRow[]) =>
  upsertBatched("sdr_contact_companies", rows, "contact_id,company_id");

/**
 * Owners+teams are small (~100 rows). Upsert FIRST, then prune stale memberships — the app
 * reads sdr_team_members live for manager scoping, so it must never be left empty mid-run.
 */
export async function replaceOwnersTeams(owners: OwnerRow[], teams: TeamRow[], members: TeamMemberRow[]) {
  await upsertBatched("sdr_owners", owners, "owner_id");
  await upsertBatched("sdr_teams", teams, "team_id");
  await upsertBatched("sdr_team_members", members, "team_id,owner_id");
  const existing = await fetchAll<{ team_id: string; owner_id: string }>(
    "sdr_team_members", "team_id,owner_id", ["team_id", "owner_id"]);
  const keep = new Set(members.map((m) => `${m.team_id} ${m.owner_id}`));
  const staleByTeam = new Map<string, string[]>();
  for (const r of existing) {
    if (keep.has(`${r.team_id} ${r.owner_id}`)) continue;
    const list = staleByTeam.get(r.team_id) ?? [];
    list.push(r.owner_id);
    staleByTeam.set(r.team_id, list);
  }
  for (const [teamId, ownerIds] of staleByTeam) {
    for (let i = 0; i < ownerIds.length; i += 200) {
      const { error } = await sb().from("sdr_team_members").delete()
        .eq("team_id", teamId).in("owner_id", ownerIds.slice(i, i + 200));
      if (error) throw new Error(`[spine] prune team_members: ${error.message}`);
    }
  }
}

/** Owned-book reconcile: upsert current books, null out owner on rooftops no longer owned. */
export async function reconcileOwnedCompanies(current: (Partial<CompanyRow> & { hs_id: string; owner_id: string })[]) {
  await upsertCompanies(current);
  const data = await fetchAll<{ hs_id: string }>("sdr_companies", "hs_id",
    ["hs_id"], (q) => q.not("owner_id", "is", null));
  const keep = new Set(current.map((c) => c.hs_id));
  const stale = data.map((r) => r.hs_id).filter((id) => !keep.has(id));
  for (let i = 0; i < stale.length; i += 200) {
    const { error: e } = await sb().from("sdr_companies").update({ owner_id: null })
      .in("hs_id", stale.slice(i, i + 200));
    if (e) throw new Error(`[spine] clear stale owners: ${e.message}`);
  }
  return stale.length;
}

// ── sync state ────────────────────────────────────────────────────────────────
export async function getWatermark(key: string): Promise<number> {
  const { data, error } = await sb().from("sdr_sync_state").select("watermark_ms").eq("key", key).maybeSingle();
  if (error) throw new Error(`[spine] watermark ${key}: ${error.message}`);
  if (!data) throw new Error(`[spine] sync_state row '${key}' missing — apply supabase/sdr_schema.sql seeds`);
  return Number(data.watermark_ms) || 0;
}

export async function setSyncState(key: string, patch: {
  watermark_ms?: number; last_duration_ms?: number; last_counts?: object; notes?: string;
}) {
  // last_run_at is stamped from the runner's clock — skew shows in admin sync-health as-is.
  const { error } = await sb().from("sdr_sync_state")
    .update({ ...patch, last_run_at: new Date().toISOString() }).eq("key", key);
  if (error) throw new Error(`[spine] setSyncState ${key}: ${error.message}`);
}

/** Advisory lock via the 'lock' row. Returns the lease token (the until-ISO) if acquired, null on contention. */
export async function tryLock(ttlMinutes: number): Promise<string | null> {
  const now = new Date();
  const until = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  // Expiry steal compares lock_until against this runner's clock — tolerates small clock skew.
  const { data, error } = await sb().from("sdr_sync_state")
    .update({ lock_until: until }).eq("key", "lock")
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
    .select("key");
  if (error) throw new Error(`[spine] lock: ${error.message}`);
  if ((data ?? []).length > 0) return until;
  // 0 rows matched: distinguish real contention from a missing seed row, which would
  // otherwise look like eternal contention on a half-seeded database.
  const { data: row, error: rowErr } = await sb().from("sdr_sync_state")
    .select("key").eq("key", "lock").maybeSingle();
  if (rowErr) throw new Error(`[spine] lock: ${rowErr.message}`);
  if (!row) throw new Error("[spine] sync_state 'lock' row missing — apply supabase/sdr_schema.sql seeds");
  return null;
}
/** Fenced release: only the current holder (matching lease) clears the lock. Never throws. */
export async function unlock(lease: string): Promise<void> {
  try {
    const { error } = await sb().from("sdr_sync_state")
      .update({ lock_until: null }).eq("key", "lock").eq("lock_until", lease);
    if (error) console.warn(`[spine] unlock: ${error.message}`);
  } catch (e) {
    console.warn(`[spine] unlock: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── aggregate input + snapshot ───────────────────────────────────────────────
// OFFSET-based pagination: orderBy MUST be a unique total order (include the PK), and PAGE must not exceed PostgREST max-rows (default 1000) or termination breaks.
async function fetchAll<T>(table: string, select: string, orderBy: string[], filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb().from(table).select(select).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    for (const col of orderBy) q = q.order(col, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(`[spine] fetch ${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

export interface StoreForAggregate {
  activities: Activity[];
  companyNames: Record<string, string>;
  companyGdStage: Record<string, string | null>;
  contactMeta: Record<string, ContactMeta>;
  ownedCompanies: Record<string, OwnedCompany[]>;
  deals: Deal[];
}

/** All deals (already scoped to tracked owners at pull time) with their stage-event ledgers
 *  attached. Tolerates either table being absent pre-migration: no sdr_deals → [], no
 *  sdr_deal_stage_events → deals without ledgers (metrics fall back to stage-date columns).
 *  Shared by the aggregate load and the /api/metrics/range route. */
export async function loadDealsWithEvents(): Promise<Deal[]> {
  let dealRows: DealRow[] = [];
  try {
    dealRows = await fetchAll<DealRow>("sdr_deals",
      "hs_id,pipeline,dealstage,stage_key,deal_owner_id,sdr_owner_id,company_id,contact_ids,amount,demo_scheduled_for_ms,discovery_done_ms,demo_done_ms,is_closed_won,is_closed_lost",
      ["hs_id"]);
  } catch (e) {
    console.warn(`[spine] sdr_deals unavailable (${e instanceof Error ? e.message : e}) — aggregating without deals until the V2 migration is applied`);
  }
  const eventsByDeal = new Map<string, DealStageEvent[]>();
  if (dealRows.length) {
    try {
      const evRows = await fetchAll<DealStageEventRow>("sdr_deal_stage_events",
        "deal_id,stage_key,entered_ms,exited_ms", ["deal_id", "stage_key", "entered_ms"]);
      for (const r of evRows) {
        const list = eventsByDeal.get(r.deal_id) ?? [];
        list.push(rowToStageEvent(r));
        eventsByDeal.set(r.deal_id, list);
      }
      for (const list of eventsByDeal.values()) list.sort((a, b) => a.enteredMs - b.enteredMs);
    } catch (e) {
      console.warn(`[spine] sdr_deal_stage_events unavailable (${e instanceof Error ? e.message : e}) — aggregating without the stage-event ledger until the V3 migration is applied`);
    }
  }
  return dealRows.map((r) => {
    const d = rowToDeal(r);
    const ev = eventsByDeal.get(d.id);
    return ev ? { ...d, stageEvents: ev } : d;
  });
}

/** Activities within [fromMs, toMs) for the given owners — the /api/metrics/range read. */
export async function loadActivitiesBetween(fromMs: number, toMs: number, ownerIds: string[]): Promise<Activity[]> {
  if (ownerIds.length === 0) return [];
  const rows = await fetchAll<ActivityRow>("sdr_activities",
    "hs_id,type,owner_id,ts_ms,disposition,email_status,email_opened,email_replied,email_clicked,contact_ids,company_ids",
    ["ts_ms", "hs_id"], (q) => q.gte("ts_ms", fromMs).lt("ts_ms", toMs).in("owner_id", ownerIds));
  return rows.map(rowToActivity);
}

/** Contact meta for a specific id set (chunked .in reads) — range DM-reach without a full scan. */
export async function loadContactMetaFor(ids: string[]): Promise<Record<string, ContactMeta>> {
  const out: Record<string, ContactMeta> = {};
  for (let i = 0; i < ids.length; i += PAGE) {
    const { data, error } = await sb().from("sdr_contacts").select("hs_id,name,title,dm")
      .in("hs_id", ids.slice(i, i + PAGE));
    if (error) throw new Error(`[spine] fetch sdr_contacts subset: ${error.message}`);
    for (const r of (data ?? []) as ContactRow[]) out[r.hs_id] = rowToContactMeta(r);
  }
  return out;
}

export async function loadStoreForAggregate(anchorMs: number, ownerIds: string[]): Promise<StoreForAggregate> {
  const actRows = await fetchAll<ActivityRow>("sdr_activities",
    "hs_id,type,owner_id,ts_ms,disposition,email_status,email_opened,email_replied,email_clicked,contact_ids,company_ids",
    ["ts_ms", "hs_id"], (q) => q.gte("ts_ms", anchorMs));
  const coRows = await fetchAll<CompanyRow>("sdr_companies",
    "hs_id,name,gd_stage,lifecycle_stage,owner_id,gd_id,is_group,group_name,segment,dealership_type,last_activity_ms,rooftop_last_activity_ms", ["hs_id"]);
  const ctRows = await fetchAll<ContactRow>("sdr_contacts", "hs_id,name,title,dm", ["hs_id"]);
  const deals = await loadDealsWithEvents();

  const companyNames: Record<string, string> = {};
  const companyGdStage: Record<string, string | null> = {};
  const ownedCompanies: Record<string, OwnedCompany[]> = {};
  for (const id of ownerIds) ownedCompanies[id] = [];
  for (const r of coRows) {
    companyNames[r.hs_id] = r.name?.trim() || `Company ${r.hs_id}`;
    companyGdStage[r.hs_id] = r.gd_stage;
    if (r.owner_id && ownedCompanies[r.owner_id]) ownedCompanies[r.owner_id].push(rowToOwnedCompany(r));
  }
  const contactMeta: Record<string, ContactMeta> = {};
  for (const r of ctRows) contactMeta[r.hs_id] = rowToContactMeta(r);

  return { activities: actRows.map(rowToActivity), companyNames, companyGdStage, contactMeta, ownedCompanies, deals };
}

/** Snapshots are stored gzip-compressed (base64 inside the jsonb column). Uncompressed they are
 *  large (~9 MB at 40+ reps) and the single-row write tripped Postgres statement_timeout; gzip
 *  cuts that ~7× (to ~1 MB), so the write is small and fast, and it scales as the roster grows.
 *  Wrapper shape: { __gz: "<base64>", v: 1 }. Rows written before this (raw jsonb) still load. */
function packSnapshot(snap: Snapshot): { __gz: string; v: number } {
  const gz = gzipSync(Buffer.from(JSON.stringify(snap), "utf8"), { level: 6 });
  return { __gz: gz.toString("base64"), v: 1 };
}

function unpackSnapshot(data: unknown): Snapshot | null {
  if (!data) return null;
  if (typeof data === "object" && data !== null && "__gz" in (data as Record<string, unknown>)) {
    const b64 = (data as { __gz: string }).__gz;
    return JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf8")) as Snapshot;
  }
  return data as Snapshot; // legacy: raw uncompressed jsonb row
}

export async function saveSnapshot(snap: Snapshot) {
  const data = packSnapshot(snap) as unknown as object;
  const mb = (Buffer.byteLength((data as { __gz: string }).__gz) / 1_048_576).toFixed(2);
  console.log(`[spine] snapshot compressed to ${mb} MB (base64) for write`);
  // Prefer the RPC (raises statement_timeout via SET LOCAL); on ANY error fall back to a retrying
  // plain upsert. The compressed payload is small, so a timeout should no longer occur — the retry
  // path is belt-and-suspenders. A failed write leaves the last good row intact.
  const { error: rpcErr } = await sb().rpc("sdr_save_snapshot", { p_data: data });
  if (!rpcErr) return;
  console.warn(`[spine] saveSnapshot rpc failed (${rpcErr.message}) — falling back to retrying upsert`);
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { error } = await sb().from("sdr_snapshots")
      .upsert({ id: 1, data, generated_at: new Date().toISOString() }, { onConflict: "id" });
    if (!error) return;
    lastErr = error.message;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error(`[spine] saveSnapshot (after retries): ${lastErr}`);
}

export async function loadSnapshotRow(): Promise<Snapshot | null> {
  const { data, error } = await sb().from("sdr_snapshots").select("data").eq("id", 1).maybeSingle();
  if (error) throw new Error(`[spine] loadSnapshot: ${error.message}`);
  return unpackSnapshot(data?.data ?? null);
}
