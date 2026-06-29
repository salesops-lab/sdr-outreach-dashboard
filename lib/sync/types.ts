/** Shared types for the sync pipeline and the dashboard. */

export const PERIOD_KEYS = [
  "today",
  "yesterday",
  "last_3_days",
  "this_week",
  "last_week",
  "this_month",
] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_3_days: "Last 3 days",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
};

/** Periods small enough to carry a per-company drill-down in the snapshot. */
export const NARROW_PERIODS: PeriodKey[] = ["today", "yesterday", "this_week"];

export type ActivityType = "call" | "email";

/** A normalized outbound activity after pull + association resolution. */
export interface Activity {
  id: string;
  type: ActivityType;
  ownerId: string;
  timestampMs: number; // UTC epoch ms (from hs_timestamp)
  disposition: string | null; // call disposition GUID (calls only)
  emailStatus: string | null; // hs_email_status (emails only)
  contactIds: string[];
  companyIds: string[];
}

export interface CallMetrics {
  total: number;
  connected: number;
  not_connected: number;
  null_disposition: number;
  connect_rate: number; // connected / (connected + not_connected), null excluded
  by_disposition: Record<string, number>; // label -> count
}

export interface EmailMetrics {
  sent: number;
  bounced: number;
  bounce_rate: number;
}

export interface ChannelMix {
  call_only: number;
  email_only: number;
  both: number;
}

export interface CompanyBreakdownRow {
  id: string;
  name: string;
  contacts: number;
  calls: number;
  emails: number;
}

export interface PeriodMetrics {
  unique_contacts: number;
  unique_companies: number;
  companies_with_contact: number;
  avg_contacts_per_company: number;
  calls: CallMetrics;
  emails: EmailMetrics;
  channel_mix: ChannelMix;
  unattributed_activities: number;
  company_breakdown?: CompanyBreakdownRow[]; // narrow periods only
}

export interface RepData {
  periods: Record<PeriodKey, PeriodMetrics>;
}

export interface Snapshot {
  generated_at_utc: string;
  today_ist: string; // YYYY-MM-DD
  week_start: "MON";
  scope: "outbound";
  /** Which HubSpot object types the token could actually read this run. */
  sources: { calls: boolean; emails: boolean };
  window: { start_ist: string; end_ist: string };
  totals: { calls: number; emails: number; reps: number; window_days: number };
  owner_names: Record<string, string>;
  reps: Record<string, RepData>;
}
