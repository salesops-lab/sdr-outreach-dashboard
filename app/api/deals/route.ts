/**
 * Deal-funnel workbench — GET /api/deals?owners=id,id&lens=sdr|ae|all
 *
 * The stage-wise truth for the Accounts page's Funnel view: every canonical Auto-Pipeline stage
 * with count + $ (current state), the ledger-derived FLOW conversion (ever scheduled → completed
 * → contract → won), and up to LIST_CAP deals per stage (longest-in-stage first) enriched with
 * company, both owners, Deal Health and days-in-stage — so stage clicks are instant client-side.
 * Lens: sdr → deals crediting the owner via sdr_owner; ae → via hubspot_owner_id; all → either.
 * Auth: the global /api middleware gate.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../lib/supabase/admin";
import { loadDealsWithEvents } from "../../../lib/spine/store";
import { loadTeamStructure } from "../../../lib/team/load";
import { trackedOwnerIds, nameMap } from "../../../lib/team/helpers";
import { classifyDealHealth } from "../../../lib/sync/deal-health";
import { demoScheduledMs, demoCompletedMs } from "../../../lib/sync/aggregate";
import { FUNNEL_STAGES, stageLabel, stageOrder, isLost, isWon } from "../../../config/deal-stages";
import { Deal } from "../../../lib/sync/types";
import { DealListItem } from "../../../lib/sync/deal-funnel";

export const dynamic = "force-dynamic";

const LIST_CAP = 100; // deals returned per stage bucket

const lensMatch = (d: Deal, lens: string, owners: Set<string> | null): boolean => {
  if (!owners) return true;
  const sdrHit = !!d.sdrOwnerId && owners.has(d.sdrOwnerId);
  const aeHit = !!d.dealOwnerId && owners.has(d.dealOwnerId);
  return lens === "sdr" ? sdrHit : lens === "ae" ? aeHit : sdrHit || aeHit;
};

/** When the deal entered its current stage — the latest ledger entry matching it. */
function enteredCurrentStageMs(d: Deal): number | null {
  let ms: number | null = null;
  for (const e of d.stageEvents ?? []) {
    if (e.stageKey === d.stageKey && (ms == null || e.enteredMs > ms)) ms = e.enteredMs;
  }
  return ms;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const lens = sp.get("lens") ?? "all";
  const db = supabaseAdmin();
  if (!db) return NextResponse.json({ error: "storage unavailable" }, { status: 503 });

  const ts = await loadTeamStructure();
  const tracked = new Set(trackedOwnerIds(ts));
  const requested = (sp.get("owners") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Scope defaults to every tracked owner; an explicit list intersects with tracked.
  const owners = requested.length ? new Set(requested.filter((id) => tracked.has(id))) : tracked;

  const all = await loadDealsWithEvents();
  const deals = all.filter((d) => lensMatch(d, lens, owners));

  // Current-state funnel: deals sitting in each stage now (+ merged Lost block).
  const stages: Record<string, { count: number; amount: number }> = {};
  for (const k of FUNNEL_STAGES) stages[k] = { count: 0, amount: 0 };
  const lost = { count: 0, amount: 0 };
  for (const d of deals) {
    if (isLost(d.stageKey)) { lost.count++; lost.amount += d.amount ?? 0; }
    else if (stages[d.stageKey]) { stages[d.stageKey].count++; stages[d.stageKey].amount += d.amount ?? 0; }
    // stageKey "other" (out-of-funnel Auto stages) is excluded from the strip by design.
  }

  // Flow conversion (event truth over the whole ledger, independent of current stage):
  // ever scheduled → ever completed → ever reached contract → won.
  const flow = { scheduled: 0, completed: 0, contract: 0, won: 0 };
  for (const d of deals) {
    if (demoScheduledMs(d) != null) flow.scheduled++;
    if (demoCompletedMs(d) != null) flow.completed++;
    if ((d.stageEvents ?? []).some((e) => e.stageKey === "contract_initiated") ||
        stageOrder(d.stageKey) >= stageOrder("contract_initiated")) flow.contract++;
    if (isWon(d.stageKey) || d.stageKey === "transferred_cs") flow.won++;
  }

  // Per-stage lists: longest-in-stage first (what's stuck surfaces on top), capped per bucket.
  const byBucket = new Map<string, Deal[]>();
  for (const d of deals) {
    const bucket = isLost(d.stageKey) ? "lost" : d.stageKey;
    if (bucket === "other") continue;
    const list = byBucket.get(bucket) ?? [];
    list.push(d);
    byBucket.set(bucket, list);
  }
  const listed: Deal[] = [];
  for (const list of byBucket.values()) {
    list.sort((a, b) => (enteredCurrentStageMs(a) ?? Number.MAX_SAFE_INTEGER) - (enteredCurrentStageMs(b) ?? Number.MAX_SAFE_INTEGER));
    listed.push(...list.slice(0, LIST_CAP));
  }

  // Company names + last activity for the listed deals only (chunked .in).
  const companyIds = [...new Set(listed.map((d) => d.companyId).filter(Boolean))] as string[];
  const companies = new Map<string, { name: string | null; last_activity_ms: number | null }>();
  for (let i = 0; i < companyIds.length; i += 500) {
    const { data } = await db.from("sdr_companies").select("hs_id,name,last_activity_ms")
      .in("hs_id", companyIds.slice(i, i + 500));
    for (const r of data ?? []) companies.set(String(r.hs_id), {
      name: r.name ?? null, last_activity_ms: r.last_activity_ms == null ? null : Number(r.last_activity_ms),
    });
  }

  const names = nameMap(ts);
  const nowMs = Date.now();
  const items: DealListItem[] = listed.map((d) => {
    const co = d.companyId ? companies.get(d.companyId) : undefined;
    const hr = classifyDealHealth({
      stageKey: d.stageKey, demoScheduledForMs: d.demoScheduledForMs,
      lastActivityMs: co?.last_activity_ms ?? null, nowMs,
    });
    return {
      id: d.id,
      company_id: d.companyId,
      company_name: co?.name ?? null,
      stage_key: d.stageKey,
      stage_label: stageLabel(d.stageKey),
      health: hr.health,
      health_reason: hr.reason,
      amount: d.amount,
      sdr_owner_id: d.sdrOwnerId,
      sdr_name: d.sdrOwnerId ? names[d.sdrOwnerId] ?? null : null,
      ae_owner_id: d.dealOwnerId,
      ae_name: d.dealOwnerId ? names[d.dealOwnerId] ?? null : null,
      entered_stage_ms: enteredCurrentStageMs(d),
      demo_scheduled_for_ms: d.demoScheduledForMs,
      last_activity_ms: co?.last_activity_ms ?? null,
    };
  });

  return NextResponse.json({
    lens,
    total: deals.length,
    funnel: { stages, lost, flow },
    deals: items,
    list_cap: LIST_CAP,
  });
}
