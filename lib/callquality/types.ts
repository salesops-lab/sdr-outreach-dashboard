/** Typed shapes for call-scoring data (tables owned by call-scoring-agent — read-only). */

/** Raw row: rep_coaching_snapshots (subset we read). */
export interface CoachingRow {
  hubspot_owner_id: string | null;
  snapshot_date: string;
  period_type: "daily" | "weekly";
  period_end: string; // ISO date
  scope: string;
  calls_analyzed: number;
  meetings_booked: number;
  avg_bantic_score: number | null;
  avg_quality_score: number | null;
  weakest_dimension: string | null;
  top_strengths: string[];
  top_risks: string[];
  coaching_priorities: string[];
  suggested_drills: string[];
  manager_summary: string | null;
}

/** Latest weekly coaching snapshot per rep — drives the table column + drawer card. */
export interface CoachingSnapshot {
  ownerId: string;
  snapshotDate: string;
  periodEnd: string;
  callsAnalyzed: number;
  meetingsBooked: number;
  avgBantic: number | null; // 0–10
  avgQuality: number | null; // 0–5
  weakestDimension: string | null;
  strengths: string[];
  risks: string[];
  priorities: string[];
  drills: string[];
  managerSummary: string | null;
}

/** Raw row: calls (analyzed subset). */
export interface CallRow {
  hubspot_call_id: string;
  hubspot_owner_id: string | null;
  hubspot_company_id: string | null;
  call_date: string | null;
  call_disposition_label: string | null;
  call_duration_ms: number | null;
  recording_url: string | null;
  score_budget: number | null;
  score_authority: number | null;
  score_need: number | null;
  score_timeline: number | null;
  score_impact: number | null;
  score_current_process: number | null;
  overall_score: number | null;
}

/** Raw row: call_quality_insights (subset). */
export interface InsightRow {
  hubspot_call_id: string;
  quality_score: number | null; // 0–5
  discovery_quality: number | null;
  objection_handling: number | null;
  next_step_clarity: number | null;
  talk_control: number | null;
  crm_hygiene: number | null;
  coachable_moments: Array<Record<string, string | number | boolean | null> | string>;
  quote_examples: Array<Record<string, string | number | boolean | null> | string>;
  recommended_next_action: string | null;
}

export const BANTIC_DIMS = [
  "budget", "authority", "need", "timeline", "impact", "current_process",
] as const;
export type BanticDim = (typeof BANTIC_DIMS)[number];

/** Averaged BANTIC dimensions over a rep's recent analyzed calls. */
export interface CallDims {
  count: number; // calls averaged
  overall: number | null;
  dims: Record<BanticDim, number | null>;
}

/** One drill-down row: a call joined with its quality insight (if any). */
export interface CallDrillRow {
  callId: string;
  date: string | null;
  companyId: string | null;
  disposition: string | null;
  durationMs: number | null;
  recordingUrl: string | null;
  overall: number | null;
  dims: Record<BanticDim, number | null>;
  quality: number | null;
  coachableMoments: string[];
  quotes: string[];
  nextAction: string | null;
}

/** Payload of GET /api/rep/[ownerId]/calls. */
export interface RepCallsPayload {
  dims: CallDims;
  calls: CallDrillRow[];
}
