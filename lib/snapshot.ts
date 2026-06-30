/**
 * Server-side snapshot loader for the dashboard.
 *   - If BLOB_READ_WRITE_TOKEN is set, read the newest blob under sdr-snapshot/
 *     (lets a GitHub Action refresh the data without a redeploy).
 *   - Otherwise read the committed data/snapshot.json.
 * Always returns a valid Snapshot — never throws into the page.
 */

import { PERIOD_KEYS, PeriodKey, PeriodMetrics, Snapshot } from "./sync/types";
import { REPS, REP_OWNER_IDS } from "../config/reps";

function emptyReach() {
  return { total: 0, call_only: 0, email_only: 0, both: 0, via_call: 0, via_email: 0 };
}

function emptyMetrics(): PeriodMetrics {
  return {
    calls: { total: 0, connected: 0, not_connected: 0, null_disposition: 0, connect_rate: 0, by_disposition: {} },
    emails: { sent: 0, bounced: 0, bounce_rate: 0 },
    meetings_booked: 0,
    contacts: emptyReach(),
    companies: emptyReach(),
    companies_with_contact: 0,
    avg_contacts_per_company: 0,
    multitouch_contacts: 0,
    multitouch_accounts: 0,
    coverage: { owned_total: 0, owned_tapped: 0, pct: 0, untapped_count: 0, untapped_sample: [] },
    temp: { hot: 0, warm: 0, cold: 0 },
    quality: { score: 0, grade: "—", sub: { conversations: 0, depth: 0, persistence: 0, channel: 0, deliverability: 0 } },
    insights: [],
    unattributed_activities: 0,
  };
}

export function emptySnapshot(): Snapshot {
  const reps: Snapshot["reps"] = {};
  for (const id of REP_OWNER_IDS) {
    const periods = {} as Record<PeriodKey, PeriodMetrics>;
    for (const p of PERIOD_KEYS) periods[p] = emptyMetrics();
    reps[id] = { periods, daily: [] };
  }
  return {
    generated_at_utc: "",
    today_ist: "",
    week_start: "MON",
    scope: "outbound",
    sources: { calls: false, emails: false },
    window: { start_ist: "", end_ist: "" },
    totals: { calls: 0, emails: 0, reps: REP_OWNER_IDS.length, window_days: 0 },
    owner_names: REPS,
    reps,
  };
}

async function loadFromBlob(): Promise<Snapshot | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: "sdr-snapshot/" });
    if (!blobs.length) return null;
    const latest = blobs.sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )[0];
    const res = await fetch(latest.url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Snapshot;
  } catch (err) {
    console.error("[snapshot] Blob load failed, falling back to file:", err);
    return null;
  }
}

async function loadFromFile(): Promise<Snapshot | null> {
  try {
    // Static import so Next.js bundles the JSON into the serverless function
    // (a runtime fs path would be missed by output-file-tracing on Vercel).
    const mod = (await import("../data/snapshot.json")) as unknown as { default?: Snapshot };
    return (mod.default ?? (mod as unknown)) as Snapshot;
  } catch {
    return null;
  }
}

export async function getSnapshot(): Promise<Snapshot> {
  return (await loadFromBlob()) ?? (await loadFromFile()) ?? emptySnapshot();
}
