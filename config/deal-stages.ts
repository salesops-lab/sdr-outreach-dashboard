/**
 * Canonical deal-stage model for HubSpot portal 242626590 (app-na2).
 *
 * WHY THIS EXISTS — the pipeline-collision trap:
 *   `dealstage` is one flattened enum shared across ALL 8 deal pipelines, and the SAME stage
 *   label maps to DIFFERENT internal stage ids in different pipelines (e.g. "Discovery Call Done"
 *   = 1534610164 in Auto Pipeline but 1534462664 in Auto Pipeline US). Keying logic off a bare
 *   stage id is therefore a bug. Everything downstream keys off the canonical `DealStageKey`
 *   produced by `stageKey(pipeline, dealstage)`, which resolves ONLY ids that belong to the
 *   pipeline we track.
 *
 * SCOPE (locked with the user): V2 tracks the **Auto Pipeline** only. Every other pipeline
 *   (Auto US, CS, Partnership, Ecommerce, …) normalizes to `"other"` and is out of the funnel.
 *
 * This is the deal-stage sibling of config/dispositions.ts: a pure vocabulary + predicates,
 * no HubSpot dependency, trivially unit-testable.
 */

/** The SDR/AE new-business pipeline. */
export const AUTO_PIPELINE_ID = "1001348836";

/** Canonical funnel stage. `other` = out-of-funnel / unknown / another pipeline. */
export type DealStageKey =
  | "mql"
  | "discovery_done"
  | "demo_no_show"
  | "demo_rescheduled"
  | "demo_done"
  | "demo_accepted"
  | "in_discussion"
  | "future_prospect"
  | "non_sal"
  | "contract_initiated"
  | "contract_closed"
  | "payment_completed"
  | "transferred_cs"
  | "drop_off_sdr"
  | "drop_off_sales"
  | "other";

/**
 * Auto Pipeline (1001348836) internal stage id → canonical key.
 * Ids verified live from the portal. Out-of-funnel Auto stages (Upsell 1534610167,
 * Referrals 1534611150, Expansion 2820462324, and the onboarding/CS tail) are intentionally
 * omitted so they fall through to `other`.
 */
export const AUTO_STAGE_BY_ID: Record<string, DealStageKey> = {
  "1534610163": "mql",
  "1534610164": "discovery_done",
  "1534610165": "demo_no_show",
  "1534610166": "demo_rescheduled",
  "1534611151": "demo_done",
  "1534611152": "non_sal",
  "1534611153": "demo_accepted",
  "1534611154": "in_discussion",
  "1534611159": "future_prospect",
  "1534611155": "contract_initiated",
  "1534611156": "contract_closed",
  "1534611157": "payment_completed",
  "1534611158": "transferred_cs",
  "1534611161": "drop_off_sdr",
  "1534611160": "drop_off_sales", // = the "drop off ae" the user described (sales/AE-side drop)
};

/** Resolve the canonical stage from the (pipeline, dealstage) pair. */
export function stageKey(pipeline: string | null | undefined, dealstage: string | null | undefined): DealStageKey {
  if (pipeline !== AUTO_PIPELINE_ID) return "other";
  if (!dealstage) return "other";
  return AUTO_STAGE_BY_ID[dealstage] ?? "other";
}

const STAGE_LABELS: Record<DealStageKey, string> = {
  mql: "MQL",
  discovery_done: "Discovery Call Done",
  demo_no_show: "Demo No-Show",
  demo_rescheduled: "Demo Rescheduled",
  demo_done: "Demo Done",
  demo_accepted: "Demo Accepted",
  in_discussion: "In Discussion",
  future_prospect: "Future Prospect",
  non_sal: "Non SAL",
  contract_initiated: "Contract Initiated",
  contract_closed: "Contract Closed",
  payment_completed: "Payment Completed",
  transferred_cs: "Transferred to CS",
  drop_off_sdr: "Drop Off (SDR)",
  drop_off_sales: "Drop off (Sales)",
  other: "Other",
};

export function stageLabel(key: DealStageKey): string {
  return STAGE_LABELS[key];
}

const WON = new Set<DealStageKey>(["contract_closed", "payment_completed"]);
const LOST = new Set<DealStageKey>(["drop_off_sdr", "drop_off_sales", "non_sal"]);
/** Demo booked from the SDR's end, but not yet conducted. */
const MEETING_SET = new Set<DealStageKey>(["discovery_done", "demo_no_show", "demo_rescheduled"]);
/** The demo has happened (through to won / transferred to CS). */
const POST_DEMO = new Set<DealStageKey>([
  "demo_done",
  "demo_accepted",
  "in_discussion",
  "future_prospect",
  "contract_initiated",
  "contract_closed",
  "payment_completed",
  "transferred_cs",
]);

/**
 * The demo is considered COMPLETED once the deal has entered any of these three stages
 * (locked with the user: Demo Done, Demo Accepted, AND In Discussion all count).
 * Period metrics use the FIRST entry into this set ("demos completed in period P").
 */
const DEMO_COMPLETED = new Set<DealStageKey>(["demo_done", "demo_accepted", "in_discussion"]);

/** Closed-won terminal (Contract Closed / Payment Completed — there's no literal "Closed Won"). */
export const isWon = (key: DealStageKey): boolean => WON.has(key);
/** Dead / disqualified branch: SDR drop, sales (AE) drop, or Non SAL. */
export const isLost = (key: DealStageKey): boolean => LOST.has(key);
/** Meeting booked but the demo hasn't been conducted yet. */
export const isMeetingSet = (key: DealStageKey): boolean => MEETING_SET.has(key);
/** The demo has taken place (the account is in the AE's demo→closure motion). */
export const isPostDemo = (key: DealStageKey): boolean => POST_DEMO.has(key);
/** Entering this stage completes the demo (Demo Done / Demo Accepted / In Discussion). */
export const isDemoCompletedStage = (key: DealStageKey): boolean => DEMO_COMPLETED.has(key);
/** PARKED (locked with the user): Future Prospect is a real deal deliberately shelved —
 *  excluded from active-pipeline counts but neither lost nor won. */
export const isParked = (key: DealStageKey): boolean => key === "future_prospect";
/** No further sales motion: won, lost, or handed to CS. */
export const isTerminal = (key: DealStageKey): boolean =>
  WON.has(key) || LOST.has(key) || key === "transferred_cs";
/** ACTIVE = a live deal that needs sales motion NOW: in-funnel, not terminal, not parked.
 *  Lens split: active ∧ !isPostDemo = the SDR's lead→demo motion (MQL → Demo Rescheduled);
 *  active ∧ isPostDemo = the AE's demo→closure motion (Demo Done → Contract Initiated). */
export const isActive = (key: DealStageKey): boolean =>
  key !== "other" && !isTerminal(key) && !isParked(key);

/**
 * Funnel progression, used to pick the "furthest" deal when a company has several.
 * Dead / out-of-funnel stages carry no progress (0) so a live deal always outranks a dead one.
 */
const STAGE_ORDER: Record<DealStageKey, number> = {
  other: 0,
  drop_off_sdr: 0,
  drop_off_sales: 0,
  non_sal: 0,
  mql: 10,
  discovery_done: 20,
  demo_no_show: 30,
  demo_rescheduled: 30,
  demo_done: 40,
  future_prospect: 45,
  demo_accepted: 50,
  in_discussion: 60,
  contract_initiated: 70,
  contract_closed: 80,
  payment_completed: 90,
  transferred_cs: 100,
};

export function stageOrder(key: DealStageKey): number {
  return STAGE_ORDER[key];
}

/** Funnel-ordered stage buckets the Deal Funnel strip renders (the lost branch is one merged
 *  block rendered separately; `other` is out-of-funnel by design). */
export const FUNNEL_STAGES: DealStageKey[] = [
  "mql", "discovery_done", "demo_no_show", "demo_rescheduled", "demo_done",
  "demo_accepted", "in_discussion", "future_prospect", "contract_initiated",
  "contract_closed", "payment_completed", "transferred_cs",
];
