/**
 * Per-account unified timeline — GET /api/account/[companyId]/timeline
 *
 * Composes, from the spine: the account's calls/emails (any tracked doer; jsonb contains on
 * company_ids — see the GIN index in supabase/sdr_schema.sql), its deals + stage-event ledgers
 * (the journey strip), contact/owner attribution, and the agent watch (recommended next step).
 * Pure assembly lives in lib/sync/account-timeline.ts. Auth: the global /api middleware gate.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../../lib/supabase/admin";
import { loadTeamStructure } from "../../../../../lib/team/load";
import { nameMap, kindMap } from "../../../../../lib/team/helpers";
import { rowToContactMeta } from "../../../../../lib/spine/rows";
import { ContactRow } from "../../../../../lib/spine/types";
import { ContactMeta } from "../../../../../lib/sync/associate";
import { stageKey, stageLabel, DealStageKey } from "../../../../../config/deal-stages";
import {
  buildAccountTimeline, AccountTimelinePayload, DealJourney, TimelineActivityInput, TimelineStageInput,
} from "../../../../../lib/sync/account-timeline";

export const dynamic = "force-dynamic";

const ACTIVITY_CAP = 200; // newest-first; enough history for a drill-in panel

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export async function GET(_req: NextRequest, { params }: { params: { companyId: string } }) {
  const id = params.companyId;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "bad company id" }, { status: 400 });
  const db = supabaseAdmin();
  if (!db) return NextResponse.json({ error: "storage unavailable" }, { status: 503 });

  const [ts, companyRes, actRes, dealsRes, watchRes] = await Promise.all([
    loadTeamStructure(),
    db.from("sdr_companies").select("hs_id,name,owner_id,gd_stage,group_name").eq("hs_id", id).maybeSingle(),
    db.from("sdr_activities")
      .select("hs_id,type,owner_id,ts_ms,disposition,email_status,email_opened,email_replied,contact_ids")
      // jsonb contains needs the JSON-string form — a raw JS array renders as a Postgres array
      // literal and 400s ("invalid input syntax for type json").
      .contains("company_ids", JSON.stringify([id]))
      .order("ts_ms", { ascending: false })
      .limit(ACTIVITY_CAP),
    db.from("sdr_deals")
      .select("hs_id,pipeline,dealstage,amount")
      .eq("company_id", id),
    db.from("sdr_agent_watches").select("status,reason,next_step,priority").eq("account_id", id).maybeSingle(),
  ]);
  if (actRes.error) return NextResponse.json({ error: actRes.error.message }, { status: 500 });

  const activities: TimelineActivityInput[] = (actRes.data ?? []).map((r) => ({
    id: String(r.hs_id),
    type: r.type as "call" | "email",
    ownerId: String(r.owner_id),
    tsMs: Number(r.ts_ms),
    disposition: r.disposition ?? null,
    emailStatus: r.email_status ?? null,
    emailOpened: !!r.email_opened,
    emailReplied: !!r.email_replied,
    contactIds: arr(r.contact_ids),
  }));

  // Contact attribution for the touched contacts only.
  const contactIds = [...new Set(activities.flatMap((a) => a.contactIds))];
  const contactMeta: Record<string, ContactMeta> = {};
  if (contactIds.length) {
    const { data } = await db.from("sdr_contacts").select("hs_id,name,title,dm").in("hs_id", contactIds);
    for (const r of (data ?? []) as ContactRow[]) contactMeta[r.hs_id] = rowToContactMeta(r);
  }

  // Deal journeys + stage events (tolerate a pre-V3 ledger table).
  const dealRows = dealsRes.data ?? [];
  const stageInputs: TimelineStageInput[] = [];
  const eventsByDeal = new Map<string, DealJourney["events"]>();
  if (dealRows.length) {
    const { data: evRows, error: evErr } = await db
      .from("sdr_deal_stage_events")
      .select("deal_id,stage_key,entered_ms")
      .in("deal_id", dealRows.map((d) => String(d.hs_id)))
      .order("entered_ms", { ascending: true });
    if (!evErr) {
      for (const e of evRows ?? []) {
        const key = e.stage_key as DealStageKey;
        stageInputs.push({ dealId: String(e.deal_id), stageKey: key, enteredMs: Number(e.entered_ms) });
        const list = eventsByDeal.get(String(e.deal_id)) ?? [];
        list.push({ stage_key: key, label: stageLabel(key), entered_ms: Number(e.entered_ms) });
        eventsByDeal.set(String(e.deal_id), list);
      }
    }
  }
  const deals: DealJourney[] = dealRows.map((d) => {
    const key = stageKey(d.pipeline, d.dealstage);
    return {
      id: String(d.hs_id),
      stage_key: key,
      stage_label: stageLabel(key),
      amount: d.amount == null ? null : Number(d.amount),
      events: eventsByDeal.get(String(d.hs_id)) ?? [],
    };
  });

  const names = nameMap(ts);
  const co = companyRes.data;
  const payload: AccountTimelinePayload = {
    account: {
      id,
      name: co?.name?.trim() || `Company ${id}`,
      owner_id: co?.owner_id ?? null,
      owner_name: co?.owner_id ? names[co.owner_id] ?? null : null,
      gd_stage: co?.gd_stage ?? null,
      group_name: co?.group_name ?? null,
    },
    deals,
    items: buildAccountTimeline(activities, stageInputs, contactMeta, names, kindMap(ts)),
    activity_capped: activities.length === ACTIVITY_CAP,
    watch: watchRes.error ? null : (watchRes.data as AccountTimelinePayload["watch"]) ?? null,
  };
  return NextResponse.json(payload);
}
