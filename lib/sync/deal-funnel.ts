/** Shared contract for the /api/deals route ↔ the Accounts page's Deal Funnel view. Pure types. */
import { DealStageKey } from "../../config/deal-stages";
import { DealHealth } from "./deal-health";

export interface DealListItem {
  id: string;
  company_id: string | null;
  company_name: string | null;
  stage_key: DealStageKey;
  stage_label: string;
  health: DealHealth | null;
  health_reason: string | null;
  amount: number | null;
  sdr_owner_id: string | null;
  sdr_name: string | null;
  ae_owner_id: string | null;
  ae_name: string | null;
  entered_stage_ms: number | null; // when it entered its CURRENT stage (ledger)
  demo_scheduled_for_ms: number | null;
  last_activity_ms: number | null; // company-level last activity
}

export interface DealFunnelPayload {
  lens: string;
  total: number; // all matching deals (lists below are capped per stage)
  funnel: {
    stages: Record<string, { count: number; amount: number }>; // keyed by DealStageKey
    lost: { count: number; amount: number };
    /** Event-truth flow over the ledger: ever scheduled → completed → reached contract → won. */
    flow: { scheduled: number; completed: number; contract: number; won: number };
  };
  deals: DealListItem[]; // up to list_cap per stage bucket, longest-in-stage first
  list_cap: number;
}
