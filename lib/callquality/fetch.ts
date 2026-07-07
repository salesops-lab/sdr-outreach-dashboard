/**
 * Server-only reads from the call-scoring Supabase project. Every function
 * returns a safe empty value when Supabase is unconfigured or errors —
 * the dashboard must keep working without call data.
 */
import { supabaseAdmin } from "../supabase/admin";
import { REP_OWNER_IDS } from "../../config/reps";
import { pickLatestSnapshots, aggregateDims, joinCallInsights } from "./map";
import { CallRow, CoachingRow, CoachingSnapshot, InsightRow, RepCallsPayload } from "./types";

const DRILL_LIMIT = 15; // calls shown in the drawer drill-down
const DIMS_WINDOW_DAYS = 90;

/** Latest weekly coaching snapshot per tracked rep. Empty map on failure. */
export async function getCoachingByRep(): Promise<Record<string, CoachingSnapshot>> {
  try {
    const sb = supabaseAdmin();
    if (!sb) return {};
    const { data, error } = await sb
      .from("rep_coaching_snapshots")
      .select(
        `hubspot_owner_id,snapshot_date,period_type,period_end,scope,calls_analyzed,meetings_booked,
        avg_bantic_score,avg_quality_score,weakest_dimension,top_strengths,top_risks,
        coaching_priorities,suggested_drills,manager_summary`,
      )
      .eq("period_type", "weekly")
      .eq("scope", "rep")
      .in("hubspot_owner_id", REP_OWNER_IDS)
      .order("period_end", { ascending: false })
      .limit(300);
    if (error) {
      console.error("[callquality] coaching fetch failed:", error.message);
      return {};
    }
    if ((data?.length ?? 0) === 300) console.warn("[callquality] coaching snapshots hit the 300 cap — some reps may be missing.");
    return pickLatestSnapshots((data ?? []) as CoachingRow[]);
  } catch (err) {
    // Structural guarantee: coaching sits on the page-load critical path — never throw into SSR.
    console.error("[callquality] unexpected failure:", err);
    return {};
  }
}

/** Recent analyzed calls + dim averages for one rep (drawer payload). */
export async function getRepCalls(ownerId: string): Promise<RepCallsPayload> {
  const empty: RepCallsPayload = {
    dims: aggregateDims([]),
    calls: [],
  };
  try {
    const sb = supabaseAdmin();
    if (!sb) return empty;

    const since = new Date(Date.now() - DIMS_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: callRows, error } = await sb
      .from("calls")
      .select(
        `hubspot_call_id,hubspot_owner_id,hubspot_company_id,call_date,call_disposition_label,
        call_duration_ms,recording_url,score_budget,score_authority,score_need,score_timeline,
        score_impact,score_current_process,overall_score`,
      )
      .eq("hubspot_owner_id", ownerId)
      .eq("analysis_status", "completed")
      .gte("call_date", since)
      .order("call_date", { ascending: false })
      .limit(400);
    if (error) {
      console.error("[callquality] calls fetch failed:", error.message);
      return empty;
    }
    const calls = (callRows ?? []) as CallRow[];
    if (calls.length === 400) console.warn(`[callquality] calls window hit the 400 cap for owner ${ownerId}.`);
    const recent = calls.slice(0, DRILL_LIMIT);

    let insights: InsightRow[] = [];
    if (recent.length) {
      const { data: insightRows, error: iErr } = await sb
        .from("call_quality_insights")
        .select(
          `hubspot_call_id,quality_score,discovery_quality,objection_handling,next_step_clarity,
          talk_control,crm_hygiene,coachable_moments,quote_examples,recommended_next_action`,
        )
        .in("hubspot_call_id", recent.map((c) => c.hubspot_call_id))
        // ascending updated_at: joinCallInsights' Map keeps the LAST row per call id, so the newest insight wins deterministically.
        .order("updated_at", { ascending: true });
      if (iErr) console.error("[callquality] insights fetch failed:", iErr.message);
      else insights = (insightRows ?? []) as InsightRow[];
    }

    return { dims: aggregateDims(calls), calls: joinCallInsights(recent, insights) };
  } catch (err) {
    // Structural guarantee: the drawer's API route must always return a valid payload.
    console.error("[callquality] unexpected failure:", err);
    return empty;
  }
}
