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
  emailOpened: boolean;
  emailReplied: boolean;
  emailClicked: boolean;
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
  opened: number;
  replied: number;
  clicked: number;
  open_rate: number;
  reply_rate: number;
  click_rate: number;
}

/** Unique entities (contacts or companies) tapped, split by which activity reached them. */
export interface ReachByChannel {
  total: number; // distinct entities tapped
  call_only: number;
  email_only: number;
  both: number;
  via_call: number; // call_only + both
  via_email: number; // email_only + both
}

/** A company reference with its lifecycle stage group. */
export interface NamedRef {
  id: string;
  name: string;
  stage?: string; // lifecycle group label
}

/**
 * GD-level pipeline stages — sourced directly from the HubSpot `lifecycle_stage_gd_level`
 * property (title-cased here). "Other" catches empty/unrecognized values. Order = display order.
 */
export const STAGE_GROUPS = ["Prospect", "In Pipeline", "Contract Closed", "Drop Off", "Other"] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number];

/** A count pair for one coverage dimension: total units vs tapped units. */
export interface CoverageDim {
  total: number;
  tapped: number;
}

/** Market-segment sizes (HubSpot `market_segment` enum). */
export const MARKET_SEGMENTS = [
  "smb", "mm_single", "mm_group", "enterprise_a", "enterprise_b", "enterprise_c", "top_150", "unsized",
] as const;
export type MarketSegment = (typeof MARKET_SEGMENTS)[number];

export const MARKET_SEGMENT_LABELS: Record<MarketSegment, string> = {
  smb: "SMB",
  mm_single: "MM · Single",
  mm_group: "MM · Group",
  enterprise_a: "Ent A",
  enterprise_b: "Ent B",
  enterprise_c: "Ent C",
  top_150: "Top 150",
  unsized: "Unsized",
};

export type DealershipType = "Franchise" | "Independent" | "Unknown";

/** One engaged contact on a rooftop, with its own activity recency + temperature. */
export interface RooftopContact {
  id: string;
  name: string;
  title?: string;
  dm?: boolean;
  calls: number;
  emails: number;
  last_ms: number; // epoch ms of this contact's most recent touch
  last_type: "call" | "email"; // channel of that most recent touch
  temp: Temperature; // per-contact temperature (same engine as the account)
}

/** One owned rooftop inside a book unit — cumulative, owner-scoped engagement. */
export interface RooftopDetail {
  id: string;
  name: string;
  tapped: boolean;
  calls: number; // outbound calls by the OWNING rep (anchor window)
  emails: number;
  connected: number; // calls that reached a human
  opened: number; // emails opened
  replied: number; // emails replied
  meetings: number; // meeting-scheduled outcomes
  high_intent: number; // high-intent outcomes (meeting/reschedule/callback-high)
  negative: number; // disqualifying outcomes
  disqualified: boolean; // latest signal is a live rejection
  last_ms: number | null; // epoch ms of the rep's latest touch; null if untapped
  temp: Temperature; // cumulative temperature ("cold" + reason "Untouched" when untapped)
  temp_reason: string;
  contacts: RooftopContact[]; // engaged contacts, most-engaged first
}

/** A GD/Single unit with rooftop drill-down — the Book Explorer's data. */
export interface BookUnitDetail {
  key: string; // `gd:${gdId}` or `single:${companyId}`
  name: string;
  isGroup: boolean;
  stage: StageGroup;
  dealership: DealershipType;
  segment: MarketSegment;
  tapped: boolean;
  rooftops: RooftopDetail[]; // tapped first (by calls+emails desc), then untapped (name asc)
}

/**
 * Cumulative coverage of a rep's owned book, rolled up to GD/Single units. Monotonic: a
 * unit stays tapped once the owning rep has ever put an outbound activity on any of its
 * rooftops (over the coverage-anchor window). Drop-off / junk accounts stay in the
 * denominator as long as they are still owned by the rep.
 */
export interface BookCoverage {
  units_total: number; // distinct GD/single units owned
  units_tapped: number; // units with >=1 rooftop tapped by the owner
  pct: number; // units_tapped / units_total
  rooftops_total: number; // raw owned rooftops (reference)
  gds: number; // distinct group units
  singles: number; // single units
  by_stage: Record<StageGroup, CoverageDim>; // GD-level, furthest-along stage
  by_dealership: Record<DealershipType, CoverageDim>;
  by_segment: Record<MarketSegment, CoverageDim>;
  by_group_kind: { group: CoverageDim; single: CoverageDim }; // GDs vs Singles
  units: BookUnitDetail[]; // groups first (rooftop count desc), then singles; name asc tiebreak
  untapped_sample: NamedRef[]; // capped untapped units
  insights: Insight[]; // coverage-specific callouts
}

/** Tapped accounts classified by engagement temperature. */
export interface AccountTemp {
  hot: number; // meeting booked or high-intent
  warm: number; // connected / multi-touched
  cold: number; // touched but never connected
}

export interface QualitySub {
  conversations: number; // 0-100 each
  depth: number;
  persistence: number;
  channel: number;
  deliverability: number;
}

export interface QualityScore {
  score: number; // 0-100 weighted
  grade: string; // A / B / C / D / F
  sub: QualitySub;
}

export type InsightLevel = "good" | "warn" | "info";

export interface Insight {
  level: InsightLevel;
  text: string;
}

export type Temperature = "hot" | "warm" | "cold";

export interface ContactRef {
  id: string;
  name: string;
  title?: string;
  dm?: boolean; // decision-maker
}

export interface CompanyBreakdownRow {
  id: string;
  name: string;
  contacts: number;
  calls: number;
  emails: number;
  connected: number; // calls that reached a human
  meetings: number; // meeting-scheduled outcomes
  high_intent: number; // high-intent outcomes
  negative: number; // disqualifying outcomes
  disqualified: boolean; // latest signal is a live rejection
  temp: Temperature;
  temp_reason: string; // why this tier
  stage?: string; // lifecycle group label
  opened: number; // emails opened
  replied: number; // emails replied
  last_ms: number | null; // epoch ms of the account's most recent touch this period
  owned: boolean; // is this company in the rep's owned book?
  contacts_list?: ContactRef[]; // who, with HubSpot record links (narrow periods)
}

/** One IST calendar day of a rep's activity — for the per-rep trend chart. */
export interface DailyPoint {
  date: string; // YYYY-MM-DD (IST)
  calls: number;
  connected: number;
  emails: number;
}

export interface PeriodMetrics {
  // Volume
  calls: CallMetrics;
  emails: EmailMetrics;
  meetings_booked: number;
  // Reach (unique, split by activity)
  contacts: ReachByChannel;
  companies: ReachByChannel;
  companies_with_contact: number;
  avg_contacts_per_company: number;
  multitouch_contacts: number; // contacts touched 2+ times
  multitouch_accounts: number; // companies touched 2+ times
  // Decision-maker reach (by seniority / job title)
  dm_contacts: number; // unique decision-maker contacts tapped
  titled_contacts: number; // unique tapped contacts that have a job title
  // Account temperature (tapped accounts)
  temp: AccountTemp;
  // Quality
  quality: QualityScore;
  // Insights (rule-based callouts)
  insights: Insight[];
  unattributed_activities: number;
  company_breakdown?: CompanyBreakdownRow[]; // narrow periods only
}

export interface RepData {
  periods: Record<PeriodKey, PeriodMetrics>;
  daily: DailyPoint[]; // one point per ET day in the (short) window
  book: BookCoverage; // cumulative owned-book coverage — period-independent
}

export interface Snapshot {
  generated_at_utc: string;
  today_et: string; // YYYY-MM-DD (US/Eastern)
  week_start: "MON";
  tz: string; // IANA timezone the boundaries are computed in
  scope: "outbound";
  /** Which HubSpot object types the token could actually read this run. */
  sources: { calls: boolean; emails: boolean };
  window: { start_et: string; end_et: string };
  totals: { calls: number; emails: number; reps: number; window_days: number };
  owner_names: Record<string, string>;
  reps: Record<string, RepData>;
}
