/**
 * V3 arbitrary date-range metrics — GET /api/metrics/range?from=YYYY-MM-DD&to=YYYY-MM-DD[&owners=id,id]
 *
 * Reads the spine directly (activities in the ET window + deals with stage-event ledgers) and
 * folds them through the SAME pure aggregation engine as the six fixed periods (aggregateRange),
 * so a custom range means the same numbers, not a parallel implementation. Dates are US/Eastern
 * civil days, both inclusive. Auth: the global middleware gates /api/* (session + @spyne.ai).
 */
import { NextRequest, NextResponse } from "next/server";
import { etMidnightUtcMs } from "../../../../lib/sync/buckets";
import { aggregateRange } from "../../../../lib/sync/aggregate";
import { loadActivitiesBetween, loadContactMetaFor, loadDealsWithEvents } from "../../../../lib/spine/store";
import { loadTeamStructure } from "../../../../lib/team/load";
import { trackedOwnerIds, kindMap } from "../../../../lib/team/helpers";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 190; // bounds the spine read; the anchor pull is the real data floor

/** ET midnight for a YYYY-MM-DD, offset by `plusDays` civil days (Date.UTC handles overflow). */
function etDayMs(ymd: string, plusDays = 0): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + plusDays));
  return etMidnightUtcMs(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }
  const fromMs = etDayMs(from);
  const toMs = etDayMs(to, 1); // `to` is inclusive → exclusive bound is the next ET midnight
  if (!(fromMs < toMs)) return NextResponse.json({ error: "from must be <= to" }, { status: 400 });
  const days = Math.round((toMs - fromMs) / DAY_MS);
  if (days > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: `range too large (max ${MAX_RANGE_DAYS} days)` }, { status: 400 });
  }

  const ts = await loadTeamStructure();
  const tracked = trackedOwnerIds(ts);
  const requested = (sp.get("owners") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ownerIds = requested.length ? tracked.filter((id) => requested.includes(id)) : tracked;
  if (ownerIds.length === 0) return NextResponse.json({ error: "no tracked owners in scope" }, { status: 400 });

  const [activities, deals] = await Promise.all([
    loadActivitiesBetween(fromMs, toMs, ownerIds),
    loadDealsWithEvents(),
  ]);
  // Contact meta only for contacts actually touched in the window (DM-reach without a full scan).
  const contactIds = [...new Set(activities.flatMap((a) => a.contactIds))];
  const contactMeta = await loadContactMetaFor(contactIds);

  const reps = aggregateRange(activities, ownerIds, contactMeta, deals, kindMap(ts), fromMs, toMs);
  const totals = { calls: 0, emails: 0 };
  for (const a of activities) { if (a.type === "call") totals.calls++; else totals.emails++; }
  return NextResponse.json({ from, to, days, totals, reps });
}
