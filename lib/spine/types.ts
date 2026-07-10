/** Row shapes for the sdr_* Postgres tables + the viewer model. */
import { Activity } from "../sync/types";

export interface ActivityRow {
  hs_id: string;
  type: "call" | "email";
  owner_id: string;
  ts_ms: number;
  disposition: string | null;
  email_status: string | null;
  email_opened: boolean;
  email_replied: boolean;
  email_clicked: boolean;
  contact_ids: string[];
  company_ids: string[];
  hs_lastmodified_ms: number | null;
}

export interface CompanyRow {
  hs_id: string;
  name: string | null;
  gd_stage: string | null; // lifecycle_stage_gd_level (GD-level)
  lifecycle_stage: string | null; // lifecyclestage (company-level)
  owner_id: string | null;
  gd_id: string | null;
  is_group: boolean;
  group_name: string | null;
  segment: string | null;
  dealership_type: string | null;
  last_activity_ms: number | null; // notes_last_updated
  rooftop_last_activity_ms: number | null; // rooftop_last_activity
  hs_lastmodified_ms: number | null;
}

export interface ContactRow {
  hs_id: string;
  name: string | null;
  title: string | null;
  dm: boolean;
}

export interface DealRow {
  hs_id: string;
  pipeline: string | null;
  dealstage: string | null; // raw HubSpot stage id
  stage_key: string; // denormalized canonical DealStageKey (for SQL filtering/indexing)
  deal_owner_id: string | null; // hubspot_owner_id (AE)
  sdr_owner_id: string | null; // sdr_owner (SDR)
  company_id: string | null; // primary associated company
  contact_ids: string[];
  amount: number | null;
  demo_scheduled_for_ms: number | null;
  discovery_done_ms: number | null;
  demo_done_ms: number | null;
  is_closed_won: boolean; // derived at write time from stage_key (query convenience)
  is_closed_lost: boolean;
  hs_lastmodified_ms: number | null;
}

export interface OwnerRow { owner_id: string; email: string | null; name: string; active: boolean; }
export interface TeamRow { team_id: string; name: string; }
export interface TeamMemberRow { team_id: string; owner_id: string; is_primary: boolean; }

export type Role = "admin" | "leadership" | "manager" | "rep" | "viewer";

export interface Viewer {
  email: string;
  role: Role;
  /** The viewer's DEFAULT scope (focus model — org view remains available to all). */
  defaultOwnerIds: string[];
  isAdmin: boolean; // admin OR leadership → /admin access
  kind?: "sdr" | "ae" | null; // the login's rep type (null if not a tracked rep) — defaults the Accounts view
}

export type { Activity };
