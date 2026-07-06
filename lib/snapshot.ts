/**
 * Server-side snapshot loader for the dashboard.
 *   - If BLOB_READ_WRITE_TOKEN is set, read the newest blob under sdr-snapshot/
 *     (lets a GitHub Action refresh the data without a redeploy).
 *   - Otherwise read the committed data/snapshot.json.
 * Always returns a valid Snapshot — never throws into the page.
 */

import {
  PERIOD_KEYS, PeriodKey, PeriodMetrics, Snapshot,
  BookCoverage, CoverageDim, MarketSegment, MARKET_SEGMENTS, StageGroup, STAGE_GROUPS,
} from "./sync/types";
import { REPS, REP_OWNER_IDS } from "../config/reps";

function emptyReach() {
  return { total: 0, call_only: 0, email_only: 0, both: 0, via_call: 0, via_email: 0 };
}

function emptyMetrics(): PeriodMetrics {
  return {
    calls: { total: 0, connected: 0, not_connected: 0, null_disposition: 0, connect_rate: 0, by_disposition: {} },
    emails: { sent: 0, bounced: 0, bounce_rate: 0, opened: 0, replied: 0, clicked: 0, open_rate: 0, reply_rate: 0, click_rate: 0 },
    meetings_booked: 0,
    contacts: emptyReach(),
    companies: emptyReach(),
    companies_with_contact: 0,
    avg_contacts_per_company: 0,
    multitouch_contacts: 0,
    multitouch_accounts: 0,
    dm_contacts: 0,
    titled_contacts: 0,
    temp: { hot: 0, warm: 0, cold: 0 },
    quality: { score: 0, grade: "—", sub: { conversations: 0, depth: 0, persistence: 0, channel: 0, deliverability: 0 } },
    insights: [],
    unattributed_activities: 0,
  };
}

const emptyDim = (): CoverageDim => ({ total: 0, tapped: 0 });

function emptyBook(): BookCoverage {
  const by_stage = {} as Record<StageGroup, CoverageDim>;
  for (const g of STAGE_GROUPS) by_stage[g] = emptyDim();
  const by_segment = {} as Record<MarketSegment, CoverageDim>;
  for (const s of MARKET_SEGMENTS) by_segment[s] = emptyDim();
  return {
    units_total: 0, units_tapped: 0, pct: 0, rooftops_total: 0, gds: 0, singles: 0,
    by_stage,
    by_dealership: { Franchise: emptyDim(), Independent: emptyDim(), Unknown: emptyDim() },
    by_segment,
    by_group_kind: { group: emptyDim(), single: emptyDim() },
    units: [],
    untapped_sample: [],
    insights: [],
  };
}

export function emptySnapshot(): Snapshot {
  const reps: Snapshot["reps"] = {};
  for (const id of REP_OWNER_IDS) {
    const periods = {} as Record<PeriodKey, PeriodMetrics>;
    for (const p of PERIOD_KEYS) periods[p] = emptyMetrics();
    reps[id] = { periods, daily: [], book: emptyBook() };
  }
  return {
    generated_at_utc: "",
    today_et: "",
    week_start: "MON",
    tz: "America/New_York",
    scope: "outbound",
    sources: { calls: false, emails: false },
    window: { start_et: "", end_et: "" },
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

/**
 * Strip the heavy per-rooftop book detail before the snapshot crosses to the client.
 * The drawer lazy-loads one rep's units via /api/rep/[ownerId]/book instead.
 */
export function stripBookUnits(s: Snapshot): Snapshot {
  const reps: Snapshot["reps"] = {};
  for (const [id, r] of Object.entries(s.reps)) {
    reps[id] = { ...r, book: { ...r.book, units: [] } };
  }
  return { ...s, reps };
}
