/**
 * SDR outreach sync: pull outbound calls + emails from HubSpot, resolve
 * associations, bucket by IST period, aggregate, and write data/snapshot.json
 * (and upload to Vercel Blob if BLOB_READ_WRITE_TOKEN is set).
 *
 * Run:  npm run sync
 */

import { config } from "dotenv";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

config({ path: ".env.local" });
config(); // also .env if present

import { hubspotGet } from "../lib/hubspot/client";
import { makeEtContext, etMidnightUtcMs } from "../lib/sync/buckets";
import { COVERAGE_ANCHOR } from "../config/hubspot";
import { pullActivities, pullOwnedCompanies } from "../lib/sync/pull";
import { resolveAssociations } from "../lib/sync/associate";
import { aggregate } from "../lib/sync/aggregate";
import { configTeamStructure } from "../lib/team/config-source";
import { trackedOwnerIds, nameMap } from "../lib/team/helpers";

interface PropertyDef {
  name: string;
  options?: { value: string; label: string }[];
}

/**
 * Probe read access + direction enum for one object type. Returns false (and warns)
 * on a 403 scope error so the sync can degrade gracefully instead of aborting.
 */
async function checkAccess(obj: string, prop: string, expect: string): Promise<boolean> {
  try {
    const def = await hubspotGet<PropertyDef>(`/crm/v3/properties/${obj}/${prop}`);
    const values = (def.options ?? []).map((o) => o.value);
    if (!values.includes(expect)) {
      console.warn(`  ⚠️  ${obj}.${prop} has no "${expect}" option — filter may return nothing.`);
    } else {
      console.log(`  ✓ ${obj} readable (${prop} includes "${expect}")`);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(" 403 ")) {
      console.warn(`  ⚠️  No read access to ${obj} (403). It will be excluded from this snapshot.`);
      return false;
    }
    throw err; // a non-permission error is a real failure
  }
}

/** Confirm token works and which object types we can read. */
async function preflight(): Promise<{ calls: boolean; emails: boolean }> {
  console.log("Preflight: checking token + per-object read access…");
  const calls = await checkAccess("calls", "hs_call_direction", "OUTBOUND");
  const emails = await checkAccess("emails", "hs_email_direction", "EMAIL");
  if (!calls && !emails) {
    throw new Error("Token cannot read calls OR emails — nothing to sync. Check the private app scopes.");
  }
  if (!emails) {
    console.warn(
      "\n  Emails excluded. To include them, add the 'connected-email-data-access' (and 'sales-email-read') scope to the HubSpot private app, then re-run.\n",
    );
  }
  return { calls, emails };
}

async function uploadToBlob(json: string): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log("BLOB_READ_WRITE_TOKEN not set — skipping Blob upload (dashboard will read the committed file).");
    return;
  }
  const { put } = await import("@vercel/blob");
  // Unique key per upload; the dashboard loader reads the newest by uploadedAt.
  const res = await put("sdr-snapshot/snapshot.json", json, {
    access: "public",
    contentType: "application/json",
  });
  console.log(`Uploaded snapshot to Blob: ${res.url}`);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const caps = await preflight();

  const ctx = makeEtContext(Date.now());
  // Pull back to the coverage anchor (for cumulative owned-book coverage), or the display
  // window start if that is earlier. The 6 periods bucket from the same activity set.
  const [ay, am, ad] = COVERAGE_ANCHOR.split("-").map(Number);
  const pullStartMs = Math.min(ctx.windowStartMs, etMidnightUtcMs(ay, am, ad));
  console.log(
    `\nWindow (US/Eastern): display ${ctx.windowStartDate} → ${ctx.windowEndDate}; ` +
      `coverage pull from ${COVERAGE_ANCHOR} (week starts Monday)\n`,
  );

  const raw = await pullActivities(pullStartMs, ctx.nowMs, caps);
  const { activities, companyNames, companyGdStage, contactMeta } = await resolveAssociations(raw);

  // Coverage denominator: each rep's owned company book (with lifecycle).
  let ownedCompanies: Awaited<ReturnType<typeof pullOwnedCompanies>> = {};
  try {
    ownedCompanies = await pullOwnedCompanies();
  } catch (err) {
    console.warn("Could not pull owned companies (coverage will be empty):", err instanceof Error ? err.message : err);
  }

  const cfgTs = configTeamStructure(); // legacy file-snapshot path: config roster (retired script)
  const snapshot = aggregate(activities, companyNames, companyGdStage, contactMeta, ownedCompanies, ctx, Date.now(), caps,
    { ownerIds: trackedOwnerIds(cfgTs), names: nameMap(cfgTs) });

  const json = JSON.stringify(snapshot, null, 2);
  const outPath = path.join(process.cwd(), "data", "snapshot.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, json, "utf8");
  console.log(`\nWrote ${outPath}`);

  await uploadToBlob(json);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nDone in ${secs}s — ${snapshot.totals.calls} calls + ${snapshot.totals.emails} emails across ${snapshot.totals.reps} reps.`,
  );
}

main().catch((err) => {
  console.error("\nSync failed:", err);
  process.exit(1);
});
