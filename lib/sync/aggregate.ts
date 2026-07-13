/**
 * Aggregate resolved activities into per-rep metrics — a sales-leader view of both
 * QUANTITY and QUALITY of outbound engagement:
 *   - per-period (US/Eastern) volume, reach, email engagement, decision-maker reach,
 *     account temperature, persistence, a composite quality score, and insights
 *   - a per-rep CUMULATIVE owned-book coverage, rolled up to Group-Dealership / Single
 *     units, segmented by lifecycle / dealership type / market segment. Coverage is
 *     monotonic: a unit stays "tapped" once the OWNING rep has ever put an outbound
 *     activity on any of its rooftops (over the coverage-anchor window).
 */

// Tracked owner ids + names come in via the `roster` param (DB-backed, resolved by the runner).
import {
  isConnected, isMeeting, isMeetingRescheduled, isCallbackHigh, isCallbackLow, isGaveReferral, isNegative, dispositionLabel,
} from "../../config/dispositions";
import { classifyTemperature, TempSignals } from "./temperature";
import { segmentAccount } from "./segmentation";
import { classifyDealHealth } from "./deal-health";
import {
  stageLabel, isLost, isWon, isActive, isParked, isPostDemo, isDemoCompletedStage, stageOrder,
} from "../../config/deal-stages";
import {
  EtContext, periodsForActivity, etParts, etDateStr, etMidnightUtcMs, dayIndexToYmd, PORTAL_TZ,
} from "./buckets";
import { OwnedCompany } from "./pull";
import { ContactMeta } from "./associate";
import {
  Activity,
  AccountDeal,
  AccountTemp,
  BookCoverage,
  BookUnitDetail,
  CoverageDim,
  DailyPoint,
  Deal,
  DealershipType,
  Insight,
  LastActivity,
  MARKET_SEGMENTS,
  MarketSegment,
  MonthMetrics,
  NamedRef,
  PERIOD_KEYS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  QualityScore,
  ReachByChannel,
  RepData,
  RepFunnel,
  RepPipeline,
  RooftopContact,
  RooftopDetail,
  CoverageStatus,
  Snapshot,
  STAGE_GROUPS,
  StageGroup,
} from "./types";

const DAY_MS = 86_400_000;
const UNTAPPED_SAMPLE_CAP = 200;
const ROOFTOP_CONTACT_CAP = 12; // engaged contacts per rooftop for the L3 table (avg ~1.3; caps snapshot size)

/**
 * Map a raw `lifecycle_stage_gd_level` value to a StageGroup bucket (case-insensitive).
 * This is HubSpot's dedicated GD-level pipeline stage — already rolled up to the group —
 * so no per-rooftop furthest-along derivation is needed. "Other" catches empty/unknown.
 */
function normalizeGdStage(raw: string | null | undefined): StageGroup {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "prospect": return "Prospect";
    case "in pipeline": return "In Pipeline";
    case "contract closed": return "Contract Closed";
    case "drop off": return "Drop Off";
    default: return "Other";
  }
}

/**
 * Per-entity engagement/outcome signals — the raw input to the temperature engine. One shape
 * accumulates for a company (period-scoped), an owned rooftop (cumulative), and a single
 * contact, so the same `classify()` runs at every level.
 */
interface SigAcc {
  calls: number;
  emails: number;
  connected: number;
  opened: number;
  replied: number;
  meetingScheduled: number;
  meetingRescheduled: number;
  callbackHigh: number;
  callbackLow: number;
  gaveReferral: number;
  negative: number;
  lastMs: number; // most recent touch (epoch ms)
  lastType: "call" | "email" | null; // channel of that most recent touch
  lastOwnerId: string | null; // doer of that most recent touch
  lastContactId: string | null; // a contact on that most recent touch
  lastDisposition: string | null; // call disposition GUID of that most recent touch (calls only)
  lastPositiveMs: number | null; // most recent positive/soft/reply signal
  lastNegativeMs: number | null; // most recent disqualifying outcome
  negativeLabel: string | null; // label of the most recent negative (for the reason)
}

function newSig(): SigAcc {
  return {
    calls: 0, emails: 0, connected: 0, opened: 0, replied: 0,
    meetingScheduled: 0, meetingRescheduled: 0, callbackHigh: 0, callbackLow: 0, gaveReferral: 0, negative: 0,
    lastMs: 0, lastType: null, lastOwnerId: null, lastContactId: null, lastDisposition: null,
    lastPositiveMs: null, lastNegativeMs: null, negativeLabel: null,
  };
}

const laterMs = (cur: number | null, ts: number): number => (cur == null ? ts : Math.max(cur, ts));

function mergeSig(into: SigAcc, from: SigAcc): void {
  into.calls += from.calls;
  into.emails += from.emails;
  into.connected += from.connected;
  into.opened += from.opened;
  into.replied += from.replied;
  into.meetingScheduled += from.meetingScheduled;
  into.meetingRescheduled += from.meetingRescheduled;
  into.callbackHigh += from.callbackHigh;
  into.callbackLow += from.callbackLow;
  into.gaveReferral += from.gaveReferral;
  into.negative += from.negative;
  if (from.lastMs >= into.lastMs) {
    into.lastType = from.lastType;
    into.lastOwnerId = from.lastOwnerId;
    into.lastContactId = from.lastContactId;
    into.lastDisposition = from.lastDisposition;
  }
  into.lastMs = Math.max(into.lastMs, from.lastMs);
  if (from.lastPositiveMs != null) into.lastPositiveMs = laterMs(into.lastPositiveMs, from.lastPositiveMs);
  if (from.lastNegativeMs != null) {
    const newestNegative = into.lastNegativeMs == null || from.lastNegativeMs >= into.lastNegativeMs;
    into.lastNegativeMs = laterMs(into.lastNegativeMs, from.lastNegativeMs);
    if (newestNegative) into.negativeLabel = from.negativeLabel;
  }
}

/** Fold one activity into a signal accumulator — the ONE place outcome business-rules live. */
function recordSig(s: SigAcc, a: Activity): void {
  if (a.timestampMs >= s.lastMs) {
    s.lastType = a.type;
    s.lastOwnerId = a.ownerId;
    s.lastContactId = a.contactIds[0] ?? null;
    s.lastDisposition = a.type === "call" ? a.disposition : null;
  }
  s.lastMs = Math.max(s.lastMs, a.timestampMs);
  if (a.type === "call") {
    s.calls++;
    const g = a.disposition;
    if (isConnected(g)) s.connected++;
    if (isMeeting(g)) s.meetingScheduled++;
    if (isMeetingRescheduled(g)) s.meetingRescheduled++;
    if (isCallbackHigh(g)) s.callbackHigh++;
    if (isCallbackLow(g)) s.callbackLow++;
    if (isGaveReferral(g)) s.gaveReferral++;
    if (isNegative(g)) { s.negative++; s.lastNegativeMs = laterMs(s.lastNegativeMs, a.timestampMs); s.negativeLabel = dispositionLabel(g); }
    if (isMeeting(g) || isMeetingRescheduled(g) || isCallbackHigh(g) || isCallbackLow(g) || isGaveReferral(g)) {
      s.lastPositiveMs = laterMs(s.lastPositiveMs, a.timestampMs);
    }
  } else {
    s.emails++;
    if (a.emailOpened) s.opened++;
    if (a.emailReplied) { s.replied++; s.lastPositiveMs = laterMs(s.lastPositiveMs, a.timestampMs); }
  }
}

/** Project a signal accumulator onto the temperature engine's input. */
function toSignals(s: SigAcc, tapped?: boolean): TempSignals {
  return {
    meetingScheduled: s.meetingScheduled, meetingRescheduled: s.meetingRescheduled,
    callbackHigh: s.callbackHigh, callbackLow: s.callbackLow, gaveReferral: s.gaveReferral,
    connected: s.connected, negative: s.negative, opened: s.opened, replied: s.replied,
    calls: s.calls, emails: s.emails,
    lastPositiveMs: s.lastPositiveMs, lastNegativeMs: s.lastNegativeMs, negativeLabel: s.negativeLabel,
    tapped,
  };
}

const classify = (s: SigAcc, tapped?: boolean) => classifyTemperature(toSignals(s, tapped));
const highIntentCount = (s: SigAcc) => s.meetingScheduled + s.meetingRescheduled + s.callbackHigh;

// ── Deal-driven per-account summary (segmentation + Deal Health) ────────────────────
/** The furthest LIVE deal (dead/out-of-funnel excluded) — governs demo-status + health. */
function pickFurthestLiveDeal(deals: Deal[]): Deal | null {
  let best: Deal | null = null;
  for (const d of deals) {
    if (isLost(d.stageKey) || d.stageKey === "other") continue;
    if (!best || stageOrder(d.stageKey) > stageOrder(best.stageKey)) best = d;
  }
  return best;
}

/**
 * Fold a company's deals into an AccountDeal. Deal Health is set only for accounts with a live
 * advanced deal (Demo Scheduled/Done); Demo-Pending accounts leave health null so Temperature
 * governs (the two-indicator model). `lastActivityMs` = the most recent of our synced touch and
 * HubSpot's notes_last_updated.
 */
function accountDealInfo(deals: Deal[], lastActivityMs: number | null, nowMs: number): AccountDeal {
  const seg = segmentAccount(deals.map((d) => d.stageKey));
  const info: AccountDeal = {
    demo_status: seg.status, at_risk: seg.atRisk, has_revivable: seg.hasRevivable,
    stage: seg.furthestStageKey ? stageLabel(seg.furthestStageKey) : null,
    stage_key: seg.furthestStageKey, health: null, health_reason: null, deal_count: deals.length,
  };
  if (seg.status !== "demo_pending") {
    const deal = pickFurthestLiveDeal(deals);
    if (deal) {
      const hr = classifyDealHealth({ stageKey: deal.stageKey, demoScheduledForMs: deal.demoScheduledForMs, lastActivityMs, nowMs });
      info.health = hr.health;
      info.health_reason = hr.reason;
    }
  }
  return info;
}

// ── Event-truth demo metrics + active/inactive pipeline (V3) ────────────────────────
/**
 * When was the demo SCHEDULED — the deal's (first) entry into Discovery Call Done. From the
 * stage-event ledger; falls back to the discovery_call_done_stage_date column pre-migration.
 * (Deals are created at Discovery Call Done in practice, so this ≈ deal creation.)
 */
export function demoScheduledMs(d: Deal): number | null {
  let min: number | null = null;
  for (const e of d.stageEvents ?? []) {
    if (e.stageKey === "discovery_done" && (min == null || e.enteredMs < min)) min = e.enteredMs;
  }
  return min ?? d.discoveryDoneMs ?? null;
}

/**
 * When was the demo COMPLETED — the deal's FIRST entry into Demo Done / Demo Accepted /
 * In Discussion (locked decision: all three count). Ledger-first; falls back to the
 * demo_done_stage_date column pre-migration.
 */
export function demoCompletedMs(d: Deal): number | null {
  let min: number | null = null;
  for (const e of d.stageEvents ?? []) {
    if (isDemoCompletedStage(e.stageKey) && (min == null || e.enteredMs < min)) min = e.enteredMs;
  }
  return min ?? d.demoDoneMs ?? null;
}

/** Deal → rep attribution for the funnel-truth metrics: an SDR is credited via sdr_owner, an AE
 *  via hubspot_owner_id (the roster kind picks the field) — the same deal counts once per lens,
 *  never summed across kinds. Unknown kind defaults to SDR (the roster default). */
export function dealsByRepLens(
  deals: Deal[], ownerIds: string[], kinds: Record<string, "sdr" | "ae">,
): Map<string, Deal[]> {
  const out = new Map<string, Deal[]>();
  for (const id of ownerIds) out.set(id, []);
  for (const d of deals) {
    const sdr = d.sdrOwnerId;
    const ae = d.dealOwnerId;
    if (sdr && out.has(sdr) && (kinds[sdr] ?? "sdr") === "sdr") out.get(sdr)!.push(d);
    if (ae && ae !== sdr && out.has(ae) && kinds[ae] === "ae") out.get(ae)!.push(d);
  }
  return out;
}

/** Segregate a rep's attributed deals into active (pre/post-demo) / parked / won / lost by
 *  CURRENT stage. `won` includes Transferred-to-CS (successful exit). Pure — unit-tested. */
export function computeRepPipeline(repDeals: Deal[]): RepPipeline {
  const p: RepPipeline = {
    total: repDeals.length, active: 0, active_pre_demo: 0, active_post_demo: 0,
    parked: 0, won: 0, lost: 0, by_stage: {},
  };
  for (const d of repDeals) {
    const k = d.stageKey;
    if (isLost(k)) p.lost++;
    else if (isWon(k) || k === "transferred_cs") p.won++;
    else if (isParked(k)) p.parked++;
    else if (isActive(k)) {
      p.active++;
      if (isPostDemo(k)) p.active_post_demo++;
      else p.active_pre_demo++;
      p.by_stage[k] = (p.by_stage[k] ?? 0) + 1;
    }
    // stageKey "other" (out-of-funnel Auto stages) counts only toward total.
  }
  return p;
}

/** Enriched last-touch from a signal accumulator (owner/contact/outcome), or undefined if untouched. */
function buildLastActivity(s: SigAcc, contactMeta: Record<string, ContactMeta>): LastActivity | undefined {
  if (!s.lastMs) return undefined;
  return {
    ms: s.lastMs,
    type: s.lastType,
    owner_id: s.lastOwnerId,
    contact_name: s.lastContactId ? (contactMeta[s.lastContactId]?.name ?? null) : null,
    outcome: s.lastType === "call" ? dispositionLabel(s.lastDisposition) : "Email",
  };
}

// ── Monthly (US/Eastern) new-unique tracking ───────────────────────────────────────
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const etMonthKey = (ms: number): string => etDateStr(ms).slice(0, 7); // YYYY-MM

/** The last 3 US/Eastern calendar months (incl. the current one), newest first. */
function recentMonths(todayEt: string): { key: string; label: string }[] {
  const [y, m] = todayEt.split("-").map(Number); // m is 1-12
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < 3; i++) {
    let yy = y, mm = m - i;
    while (mm <= 0) { mm += 12; yy -= 1; }
    out.push({ key: `${yy}-${String(mm).padStart(2, "0")}`, label: `${MONTH_LABELS[mm - 1]} ${yy}` });
  }
  return out;
}

interface MonthAcc {
  companies: Set<string>;
  units: Set<string>; // "gd:*" / "single:*" — distinct owned units touched this month
  contacts: Set<string>;
  calls: number;
  emails: number;
  connected: number;
}
const newMonthAcc = (): MonthAcc => ({ companies: new Set(), units: new Set(), contacts: new Set(), calls: 0, emails: 0, connected: 0 });

/** Per-contact accumulator: same signals, used to give each contact its own temperature. */
type ContactAcc = SigAcc;

interface CompanyStat extends SigAcc {
  contacts: Map<string, ContactAcc>; // per-contact signals (drives the L3 contacts table)
}

interface Acc {
  contactTouch: Map<string, { call: number; email: number }>;
  companyStat: Map<string, CompanyStat>;
  callsTotal: number;
  callsConnected: number;
  callsNotConnected: number;
  callsNull: number;
  meetingsBooked: number;
  byDisposition: Map<string, number>;
  emailsSent: number;
  emailsBounced: number;
  emailsOpened: number;
  emailsReplied: number;
  emailsClicked: number;
  unattributed: number;
}

function newAcc(): Acc {
  return {
    contactTouch: new Map(),
    companyStat: new Map(),
    callsTotal: 0, callsConnected: 0, callsNotConnected: 0, callsNull: 0,
    meetingsBooked: 0, byDisposition: new Map(),
    emailsSent: 0, emailsBounced: 0, emailsOpened: 0, emailsReplied: 0, emailsClicked: 0,
    unattributed: 0,
  };
}

/** Cumulative, owner-scoped engagement on one OWNED rooftop (feeds the Book Explorer). */
interface RoofAcc extends SigAcc {
  contacts: Map<string, ContactAcc>;
  ownerLastMs: number | null; // latest touch whose DOER is the account owner (drives owner-recency coverage)
  otherLastMs: number | null; // latest touch whose doer is a DIFFERENT tracked rep
}

function newRoofAcc(): RoofAcc {
  return { ...newSig(), contacts: new Map(), ownerLastMs: null, otherLastMs: null };
}

function applyActivity(acc: Acc, a: Activity): void {
  if (a.type === "call") {
    acc.callsTotal++;
    if (!a.disposition) acc.callsNull++;
    else if (isConnected(a.disposition)) acc.callsConnected++;
    else acc.callsNotConnected++;
    if (isMeeting(a.disposition)) acc.meetingsBooked++;
    const lbl = dispositionLabel(a.disposition);
    acc.byDisposition.set(lbl, (acc.byDisposition.get(lbl) ?? 0) + 1);
  } else {
    acc.emailsSent++;
    if ((a.emailStatus ?? "").toUpperCase() === "BOUNCED") acc.emailsBounced++;
    if (a.emailOpened) acc.emailsOpened++;
    if (a.emailReplied) acc.emailsReplied++;
    if (a.emailClicked) acc.emailsClicked++;
  }

  for (const c of a.contactIds) {
    const t = acc.contactTouch.get(c) ?? { call: 0, email: 0 };
    if (a.type === "call") t.call++;
    else t.email++;
    acc.contactTouch.set(c, t);
  }

  for (const co of a.companyIds) {
    const s = acc.companyStat.get(co) ?? { ...newSig(), contacts: new Map<string, ContactAcc>() };
    recordSig(s, a);
    for (const cid of a.contactIds) {
      const cs = s.contacts.get(cid) ?? newSig();
      recordSig(cs, a);
      s.contacts.set(cid, cs);
    }
    acc.companyStat.set(co, s);
  }

  if (a.contactIds.length === 0 && a.companyIds.length === 0) acc.unattributed++;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function reachOf(entries: { call: boolean; email: boolean }[]): ReachByChannel {
  let callOnly = 0, emailOnly = 0, both = 0;
  for (const e of entries) {
    if (e.call && e.email) both++;
    else if (e.call) callOnly++;
    else if (e.email) emailOnly++;
  }
  return { total: callOnly + emailOnly + both, call_only: callOnly, email_only: emailOnly, both, via_call: callOnly + both, via_email: emailOnly + both };
}

function computeQuality(args: {
  connectRate: number; meetings: number; replyRate: number; openRate: number;
  depth: number; persistenceShare: number; calls: number; emails: number; bounceRate: number; hasActivity: boolean;
}): QualityScore {
  if (!args.hasActivity) return { score: 0, grade: "—", sub: { conversations: 0, depth: 0, persistence: 0, channel: 0, deliverability: 0 } };
  const conversations = 100 * (0.5 * clamp01(args.connectRate / 0.2) + 0.3 * clamp01(args.meetings / 3) + 0.2 * clamp01(args.replyRate / 0.1));
  const depth = 100 * clamp01((args.depth - 1) / 2);
  const persistence = 100 * clamp01(args.persistenceShare);
  const totalAct = args.calls + args.emails;
  const callShare = totalAct ? args.calls / totalAct : 0;
  const balance = 1 - Math.abs(callShare - 0.5) * 2;
  const channel = 100 * (0.4 + 0.6 * clamp01(balance));
  const deliverability = args.emails === 0 ? 100 : 100 * (0.5 * clamp01(1 - args.bounceRate) + 0.5 * clamp01(args.openRate / 0.4));

  const score = Math.round(0.35 * conversations + 0.2 * depth + 0.2 * persistence + 0.15 * channel + 0.1 * deliverability);
  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "F";
  return { score, grade, sub: { conversations: Math.round(conversations), depth: Math.round(depth), persistence: Math.round(persistence), channel: Math.round(channel), deliverability: Math.round(deliverability) } };
}

/** Per-period ACTIVITY insights (coverage callouts live on BookCoverage — see bookInsights). */
function buildInsights(m: {
  hasActivity: boolean; meetings: number; hot: number;
  calls: number; emails: number; connectRate: number; connectDenom: number;
  companiesTapped: number; depth: number; persistenceShare: number;
  emailsSent: number; bounceRate: number; replyRate: number;
  dmContacts: number; titledContacts: number;
}): Insight[] {
  if (!m.hasActivity) return [{ level: "warn", text: "💤 No outbound activity this period" }];
  const out: Insight[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  if (m.meetings > 0) out.push({ level: "good", text: `🎯 ${m.meetings} meeting${m.meetings > 1 ? "s" : ""} booked` });
  if (m.hot > 0) out.push({ level: "good", text: `🔥 ${m.hot} hot account${m.hot > 1 ? "s" : ""}` });
  if (m.emailsSent >= 10 && m.replyRate >= 0.05) out.push({ level: "good", text: `📨 ${pct(m.replyRate)} email reply rate` });
  if (m.titledContacts >= 5) {
    const share = m.dmContacts / m.titledContacts;
    if (share < 0.3) out.push({ level: "warn", text: `🙋 Low decision-maker reach (${pct(share)})` });
    else if (share >= 0.5) out.push({ level: "good", text: `🙋 ${pct(share)} decision-makers reached` });
  }
  if (m.emails === 0 && m.calls > 0) out.push({ level: "warn", text: "📞 Call-only — 0 emails (single-channel)" });
  if (m.calls === 0 && m.emails > 0) out.push({ level: "warn", text: "✉ Email-only — 0 calls (single-channel)" });
  if (m.connectDenom >= 20 && m.connectRate < 0.08) out.push({ level: "warn", text: `📉 Low connect rate ${pct(m.connectRate)}` });
  if (m.companiesTapped >= 10 && m.persistenceShare < 0.2) out.push({ level: "warn", text: `🔁 Only ${pct(m.persistenceShare)} of accounts re-touched` });
  if (m.emailsSent >= 10 && m.bounceRate > 0.1) out.push({ level: "warn", text: `⚠ High email bounce ${pct(m.bounceRate)}` });
  return out;
}

function finalize(
  acc: Acc,
  period: PeriodKey,
  companyNames: Record<string, string>,
  companyGdStage: Record<string, string | null>,
  contactMeta: Record<string, ContactMeta>,
  ownedSet: Set<string>,
  dealInfoByCompany: Map<string, AccountDeal>,
): PeriodMetrics {
  const contacts = reachOf([...acc.contactTouch.values()].map((t) => ({ call: t.call > 0, email: t.email > 0 })));
  const companies = reachOf([...acc.companyStat.values()].map((s) => ({ call: s.calls > 0, email: s.emails > 0 })));

  let multitouchContacts = 0;
  for (const t of acc.contactTouch.values()) if (t.call + t.email >= 2) multitouchContacts++;

  // Decision-maker reach.
  let dmContacts = 0, titledContacts = 0;
  for (const cid of acc.contactTouch.keys()) {
    const meta = contactMeta[cid];
    if (!meta) continue;
    if (meta.title) titledContacts++;
    if (meta.dm) dmContacts++;
  }

  let companiesWithContact = 0, contactsInCompanies = 0, multitouchAccounts = 0;
  const temp: AccountTemp = { hot: 0, warm: 0, cold: 0 };
  for (const s of acc.companyStat.values()) {
    if (s.contacts.size > 0) { companiesWithContact++; contactsInCompanies += s.contacts.size; }
    if (s.calls + s.emails >= 2) multitouchAccounts++;
    temp[classify(s).temp]++;
  }
  const companiesTapped = acc.companyStat.size;
  const depth = companiesWithContact ? contactsInCompanies / companiesWithContact : 0;

  const connectDenom = acc.callsConnected + acc.callsNotConnected;
  const connectRate = connectDenom ? acc.callsConnected / connectDenom : 0;
  const bounceRate = acc.emailsSent ? acc.emailsBounced / acc.emailsSent : 0;
  const openRate = acc.emailsSent ? acc.emailsOpened / acc.emailsSent : 0;
  const replyRate = acc.emailsSent ? acc.emailsReplied / acc.emailsSent : 0;
  const clickRate = acc.emailsSent ? acc.emailsClicked / acc.emailsSent : 0;
  const persistenceShare = companiesTapped ? multitouchAccounts / companiesTapped : 0;

  const hasActivity = acc.callsTotal + acc.emailsSent > 0;
  const quality = computeQuality({ connectRate, meetings: acc.meetingsBooked, replyRate, openRate, depth, persistenceShare, calls: acc.callsTotal, emails: acc.emailsSent, bounceRate, hasActivity });
  const insights = buildInsights({ hasActivity, meetings: acc.meetingsBooked, hot: temp.hot, calls: acc.callsTotal, emails: acc.emailsSent, connectRate, connectDenom, companiesTapped, depth, persistenceShare, emailsSent: acc.emailsSent, bounceRate, replyRate, dmContacts, titledContacts });

  const metrics: PeriodMetrics = {
    calls: {
      total: acc.callsTotal, connected: acc.callsConnected, not_connected: acc.callsNotConnected, null_disposition: acc.callsNull,
      connect_rate: round(connectRate, 3), by_disposition: Object.fromEntries([...acc.byDisposition.entries()].sort((a, b) => b[1] - a[1])),
    },
    emails: {
      sent: acc.emailsSent, bounced: acc.emailsBounced, bounce_rate: round(bounceRate, 3),
      opened: acc.emailsOpened, replied: acc.emailsReplied, clicked: acc.emailsClicked,
      open_rate: round(openRate, 3), reply_rate: round(replyRate, 3), click_rate: round(clickRate, 3),
    },
    meetings_booked: acc.meetingsBooked,
    contacts,
    companies,
    companies_with_contact: companiesWithContact,
    avg_contacts_per_company: round(depth),
    multitouch_contacts: multitouchContacts,
    multitouch_accounts: multitouchAccounts,
    dm_contacts: dmContacts,
    titled_contacts: titledContacts,
    temp,
    quality,
    insights,
    unattributed_activities: acc.unattributed,
  };

  if (NARROW_PERIODS.includes(period)) {
    metrics.company_breakdown = [...acc.companyStat.entries()]
      .map(([id, s]) => {
        const t = classify(s);
        return {
          id,
          name: companyNames[id] ?? `Company ${id}`,
          contacts: s.contacts.size,
          calls: s.calls,
          emails: s.emails,
          connected: s.connected,
          meetings: s.meetingScheduled,
          high_intent: highIntentCount(s),
          negative: s.negative,
          disqualified: t.disqualified,
          temp: t.temp,
          temp_reason: t.reason,
          stage: normalizeGdStage(companyGdStage[id]),
          opened: s.opened,
          replied: s.replied,
          last_ms: s.lastMs || null,
          owned: ownedSet.has(id),
          deal: dealInfoByCompany.get(id),
          contacts_list: contactsFrom(s.contacts, contactMeta),
        };
      })
      .sort((a, b) => b.calls + b.emails - (a.calls + a.emails));
  }

  return metrics;
}

// ── Cumulative owned-book coverage (GD/Single units) ───────────────────────────────

function pickDealership(rooftops: OwnedCompany[]): DealershipType {
  for (const r of rooftops) {
    if (r.dealershipType === "Franchise" || r.dealershipType === "Independent") return r.dealershipType;
  }
  return "Unknown";
}

function pickSegment(rooftops: OwnedCompany[]): MarketSegment {
  for (const r of rooftops) {
    if (r.segment && (MARKET_SEGMENTS as readonly string[]).includes(r.segment)) return r.segment as MarketSegment;
  }
  return "unsized";
}

const emptyDim = (): CoverageDim => ({ total: 0, tapped: 0 });
const bump = (d: CoverageDim, tapped: boolean) => { d.total++; if (tapped) d.tapped++; };
const emptyStageDims = (): Record<StageGroup, CoverageDim> => {
  const o = {} as Record<StageGroup, CoverageDim>;
  for (const g of STAGE_GROUPS) o[g] = emptyDim();
  return o;
};
const emptySegmentDims = (): Record<MarketSegment, CoverageDim> => {
  const o = {} as Record<MarketSegment, CoverageDim>;
  for (const s of MARKET_SEGMENTS) o[s] = emptyDim();
  return o;
};

/** Coverage-specific good/warn callouts, at GD-unit granularity. */
function bookInsights(b: BookCoverage): Insight[] {
  if (b.units_total === 0) return [];
  const out: Insight[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const untapped = b.units_total - b.units_tapped;

  if (b.pct < 0.5) out.push({ level: "warn", text: `⚠ ${untapped} of ${b.units_total} owned accounts untapped (${pct(b.pct)} covered)` });
  else out.push({ level: "good", text: `✓ ${pct(b.pct)} of owned accounts tapped` });

  const pipe = b.by_stage["In Pipeline"];
  if (pipe.total > 0 && pipe.tapped / pipe.total < 0.5) {
    out.push({ level: "warn", text: `🎯 Only ${pct(pipe.tapped / pipe.total)} of in-pipeline accounts tapped` });
  }
  return out;
}

/** One engaged contact with its own recency + temperature (shared by book + period views). */
function toContact(id: string, c: SigAcc, contactMeta: Record<string, ContactMeta>): RooftopContact {
  const meta = contactMeta[id];
  return {
    id, name: meta?.name ?? `Contact ${id}`, title: meta?.title ?? undefined, dm: meta?.dm,
    calls: c.calls, emails: c.emails,
    last_ms: c.lastMs, last_type: c.lastType ?? "call",
    temp: classify(c).temp,
  };
}

/** Engaged-contact list from a per-contact signal map, most-engaged first (capped). */
function contactsFrom(contacts: Map<string, SigAcc>, contactMeta: Record<string, ContactMeta>): RooftopContact[] {
  return [...contacts.entries()]
    .map(([id, c]) => toContact(id, c, contactMeta))
    .sort((a, b) => (b.calls + b.emails) - (a.calls + a.emails))
    .slice(0, ROOFTOP_CONTACT_CAP);
}

/** GD/Single unit key for a rooftop. A rooftop belongs to a Group Dealership when it is ASSOCIATED
 *  to one — i.e. it has a gd_id OR a dealership_group_name. The `is_this_is_a_part_of_group_dealership_`
 *  boolean is unreliable (frequently unset even when the association exists), so we do NOT require it;
 *  requiring it mislabelled genuine GD rooftops (e.g. Auto Credit Solutions, Dan Wolf) as singles.
 *  Prefer gd_id; fall back to the normalized group name so a group's rooftops still merge when gd_id
 *  is missing. No group association at all → its own single unit. */
export function unitKeyFor(c: OwnedCompany): { key: string; isGroup: boolean } {
  if (c.gdId) return { key: `gd:${c.gdId}`, isGroup: true };
  const g = c.groupName?.trim();
  if (g) return { key: `gd:name:${g.toLowerCase()}`, isGroup: true };
  return { key: `single:${c.id}`, isGroup: false };
}

/**
 * Roll the rep's owned rooftops into GD/Single units and compute cumulative coverage.
 * A rooftop joins a GD unit when it is associated to a Group Dealership (gd_id OR
 * dealership_group_name — see unitKeyFor); rooftops with no group association are single units.
 */
function computeBookCoverage(
  ownedList: OwnedCompany[],
  everTapped: Set<string>, // "touched ever by anyone" — feeds TEMPERATURE's untouched detection only
  roofStats: Map<string, RoofAcc>,
  contactMeta: Record<string, ContactMeta>,
  dealInfoByCompany: Map<string, AccountDeal>,
  nowMs: number,
  gdOwners: Map<string, Set<string>>,
): BookCoverage {
  const OWNER_RECENCY_MS = 60 * 86_400_000; // "tapped" = the OWNER worked it within 60 days
  const cutoff = nowMs - OWNER_RECENCY_MS;
  const recent = (ms: number | null | undefined) => (ms ?? 0) >= cutoff && (ms ?? 0) > 0;
  const units = new Map<string, { name: string; isGroup: boolean; rooftops: OwnedCompany[] }>();
  for (const c of ownedList) {
    const { key, isGroup: isGroupUnit } = unitKeyFor(c);
    const u = units.get(key) ?? { name: isGroupUnit ? (c.groupName || c.name) : c.name, isGroup: isGroupUnit, rooftops: [] };
    if (isGroupUnit && c.groupName) u.name = c.groupName; // prefer the group label
    u.rooftops.push(c);
    units.set(key, u);
  }

  const by_stage = emptyStageDims();
  const by_dealership: Record<DealershipType, CoverageDim> = { Franchise: emptyDim(), Independent: emptyDim(), Unknown: emptyDim() };
  const by_segment = emptySegmentDims();
  const by_group_kind = { group: emptyDim(), single: emptyDim() };
  const untapped_sample: NamedRef[] = [];
  const unitDetails: BookUnitDetail[] = [];

  let units_total = 0, units_tapped = 0, units_worked_by_other = 0, units_mixed_owner = 0, gds = 0, singles = 0, rooftops_total = 0;

  for (const [key, u] of units.entries()) {
    units_total++;
    rooftops_total += u.rooftops.length;
    if (u.isGroup) gds++; else singles++;

    // Owner-recency coverage (60-day window): tapped if the OWNER worked ANY rooftop ≤60d; else
    // worked_by_other if a DIFFERENT tracked rep did; else untapped. (Temperature still keys off
    // "ever touched by anyone" below, so an engaged account isn't wrongly shown "untouched".)
    const anyOwnerRecent = u.rooftops.some((r) => recent(roofStats.get(r.id)?.ownerLastMs));
    const anyOtherRecent = u.rooftops.some((r) => recent(roofStats.get(r.id)?.otherLastMs));
    const coverage: CoverageStatus = anyOwnerRecent ? "tapped" : anyOtherRecent ? "worked_by_other" : "untapped";
    const tapped = anyOwnerRecent;
    const mixed_owner = u.isGroup && (gdOwners.get(key)?.size ?? 0) > 1;
    if (tapped) units_tapped++;
    if (coverage === "worked_by_other") units_worked_by_other++;
    if (mixed_owner) units_mixed_owner++;

    // GD-level stage is consistent across a group's rooftops; take the first non-empty.
    const stage = normalizeGdStage(u.rooftops.map((r) => r.gdStage).find(Boolean) ?? null);
    const dealership = pickDealership(u.rooftops);
    const segment = pickSegment(u.rooftops);
    bump(by_stage[stage], tapped);
    bump(by_dealership[dealership], tapped);
    bump(by_segment[segment], tapped);
    bump(u.isGroup ? by_group_kind.group : by_group_kind.single, tapped);

    if (coverage === "untapped" && untapped_sample.length < UNTAPPED_SAMPLE_CAP) {
      untapped_sample.push({ id: u.rooftops[0].id, name: u.name, stage });
    }

    const unitStat = newRoofAcc();
    const rooftops: RooftopDetail[] = u.rooftops.map((r) => {
      const stat = roofStats.get(r.id) ?? newRoofAcc();
      const rCoverage: CoverageStatus = recent(stat.ownerLastMs) ? "tapped" : recent(stat.otherLastMs) ? "worked_by_other" : "untapped";
      mergeSig(unitStat, stat);
      const t = classify(stat, everTapped.has(r.id)); // temperature keys off "touched ever by anyone"

      return {
        id: r.id, name: r.name, tapped: rCoverage === "tapped", coverage: rCoverage,
        calls: stat.calls, emails: stat.emails, connected: stat.connected,
        opened: stat.opened, replied: stat.replied,
        meetings: stat.meetingScheduled, high_intent: highIntentCount(stat),
        negative: stat.negative, disqualified: t.disqualified,
        last_ms: stat.lastMs || null,
        temp: t.temp, temp_reason: t.reason,
        deal: dealInfoByCompany.get(r.id),
        last_activity: buildLastActivity(stat, contactMeta),
        contacts: contactsFrom(stat.contacts, contactMeta),
      };
    });

    rooftops.sort((a, b) => {
      if (a.tapped !== b.tapped) return a.tapped ? -1 : 1;
      if (a.tapped) return (b.calls + b.emails) - (a.calls + a.emails);
      return a.name.localeCompare(b.name);
    });

    const unitHasActivity = u.rooftops.some((r) => everTapped.has(r.id)); // temperature only
    const unitTemp = classify(unitStat, unitHasActivity);
    unitDetails.push({
      key, name: u.name, isGroup: u.isGroup, stage, dealership, segment, tapped, coverage, mixed_owner,
      temp: unitTemp.temp, temp_reason: unitTemp.reason,
      rooftops,
    });
  }

  unitDetails.sort((a, b) => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    if (b.rooftops.length !== a.rooftops.length) return b.rooftops.length - a.rooftops.length;
    return a.name.localeCompare(b.name);
  });

  const book: BookCoverage = {
    units_total, units_tapped, units_worked_by_other, units_mixed_owner,
    pct: units_total ? round(units_tapped / units_total, 3) : 0,
    rooftops_total, gds, singles,
    by_stage, by_dealership, by_segment, by_group_kind, units: unitDetails, untapped_sample,
    insights: [],
  };
  book.insights = bookInsights(book);
  return book;
}

export function aggregate(
  activities: Activity[],
  companyNames: Record<string, string>,
  companyGdStage: Record<string, string | null>,
  contactMeta: Record<string, ContactMeta>,
  ownedCompanies: Record<string, OwnedCompany[]>,
  ctx: EtContext,
  generatedAtMs: number,
  sources: { calls: boolean; emails: boolean },
  roster: { ownerIds: string[]; names: Record<string, string>; kinds?: Record<string, "sdr" | "ae"> },
  deals: Deal[] = [],
): Snapshot {
  // Tracked set + names are DB-backed (config fallback) — see lib/team/load. Shadowed under the
  // former config names so the aggregation body below is unchanged.
  const REP_OWNER_IDS = roster.ownerIds;
  const REPS = roster.names;
  const accs = new Map<string, Map<PeriodKey, Acc>>();
  const dailyAcc = new Map<string, Map<string, { calls: number; connected: number; emails: number }>>();
  const ownedSets = new Map<string, Set<string>>();
  const everTapped = new Map<string, Set<string>>();
  const bookStat = new Map<string, Map<string, RoofAcc>>();
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = new Map<PeriodKey, Acc>();
    for (const p of PERIOD_KEYS) byPeriod.set(p, newAcc());
    accs.set(ownerId, byPeriod);
    dailyAcc.set(ownerId, new Map());
    ownedSets.set(ownerId, new Set((ownedCompanies[ownerId] ?? []).map((c) => c.id)));
    everTapped.set(ownerId, new Set());
    bookStat.set(ownerId, new Map());
  }

  // Reverse map: owned company -> its owning rep. Used so an account counts as "tapped" (and
  // its engagement rolls up to the OWNER's book) whenever ANY tracked rep works it — not only
  // when the owner does it themselves. Fixes owner≠activity-doer accounts reading as untouched.
  const companyOwner = new Map<string, string>();
  const companyUnit = new Map<string, string>(); // owned company -> its GD/Single unit key
  // Distinct tracked owners per unit key — a GD spanning >1 owner is "mixed owner" (only partially
  // this rep's book; the rest sits in other reps' books). Flagged so the case can be reassigned.
  const gdOwners = new Map<string, Set<string>>();
  for (const ownerId of REP_OWNER_IDS) {
    for (const c of ownedCompanies[ownerId] ?? []) {
      companyOwner.set(c.id, ownerId);
      const uk = unitKeyFor(c).key;
      companyUnit.set(c.id, uk);
      (gdOwners.get(uk) ?? gdOwners.set(uk, new Set()).get(uk)!).add(ownerId);
    }
  }

  // Auto-Pipeline deals grouped by their primary company (segmentation + Deal Health inputs).
  const companyDeals = new Map<string, Deal[]>();
  for (const d of deals) {
    if (!d.companyId) continue;
    const list = companyDeals.get(d.companyId) ?? [];
    list.push(d);
    companyDeals.set(d.companyId, list);
  }

  // Deal → rep attribution for the funnel-truth metrics (demos + pipeline).
  const dealsByRep = dealsByRepLens(deals, REP_OWNER_IDS, roster.kinds ?? {});

  // Monthly new-unique accumulators (owned-book scoped). firstTap* span ALL history so we can
  // tell whether an account/contact engaged in a recent month was EVER worked before it.
  const recent = recentMonths(ctx.windowEndDate);
  const recentSet = new Set(recent.map((r) => r.key));
  const firstTapCo = new Map<string, Map<string, number>>();
  const firstTapCt = new Map<string, Map<string, number>>();
  const monthAgg = new Map<string, Map<string, MonthAcc>>();
  for (const ownerId of REP_OWNER_IDS) {
    firstTapCo.set(ownerId, new Map());
    firstTapCt.set(ownerId, new Map());
    monthAgg.set(ownerId, new Map());
  }

  // totals reflect the short (display) window; everTapped uses the full anchored set.
  let totalCalls = 0, totalEmails = 0;
  for (const a of activities) {
    // Per-rep outbound metrics + daily trend are per ACTIVITY-DOER (the rep's own outreach).
    const byPeriod = accs.get(a.ownerId);
    if (byPeriod) {
      for (const period of periodsForActivity(a.timestampMs, ctx)) applyActivity(byPeriod.get(period)!, a);

      if (etParts(a.timestampMs).dayIndex >= ctx.dailyStartIndex) {
        if (a.type === "call") totalCalls++; else totalEmails++;
        const day = etDateStr(a.timestampMs);
        const dmap = dailyAcc.get(a.ownerId)!;
        const d = dmap.get(day) ?? { calls: 0, connected: 0, emails: 0 };
        if (a.type === "call") { d.calls++; if (a.disposition && isConnected(a.disposition)) d.connected++; }
        else d.emails++;
        dmap.set(day, d);
      }
    }

    // Cumulative owned-book coverage is attributed to the account's OWNER, whoever did the work —
    // so a teammate working an owner's account still taps the owner's book (owner≠doer fix).
    for (const co of a.companyIds) {
      const owner = companyOwner.get(co);
      if (!owner) continue; // not an owned/tracked account
      everTapped.get(owner)!.add(co);
      const roofMap = bookStat.get(owner)!;
      const racc = roofMap.get(co) ?? newRoofAcc();
      recordSig(racc, a);
      // Split the latest touch by doer: owner's own vs a different tracked rep — drives the
      // owner-recency coverage buckets (tapped / worked_by_other) in computeBookCoverage.
      if (a.ownerId === owner) racc.ownerLastMs = Math.max(racc.ownerLastMs ?? 0, a.timestampMs);
      else racc.otherLastMs = Math.max(racc.otherLastMs ?? 0, a.timestampMs);
      for (const cid of a.contactIds) {
        const ct = racc.contacts.get(cid) ?? newSig();
        recordSig(ct, a);
        racc.contacts.set(cid, ct);
      }
      roofMap.set(co, racc);

      // Monthly new-unique: first-tap over all history + per-recent-month engagement.
      const fco = firstTapCo.get(owner)!;
      fco.set(co, Math.min(fco.get(co) ?? a.timestampMs, a.timestampMs));
      const fct = firstTapCt.get(owner)!;
      for (const cid of a.contactIds) fct.set(cid, Math.min(fct.get(cid) ?? a.timestampMs, a.timestampMs));
      const mk = etMonthKey(a.timestampMs);
      if (recentSet.has(mk)) {
        const ma = monthAgg.get(owner)!;
        const acc = ma.get(mk) ?? newMonthAcc();
        acc.companies.add(co);
        const uk = companyUnit.get(co);
        if (uk) acc.units.add(uk);
        for (const cid of a.contactIds) acc.contacts.add(cid);
        if (a.type === "call") { acc.calls++; if (a.disposition && isConnected(a.disposition)) acc.connected++; } else acc.emails++;
        ma.set(mk, acc);
      }
    }
  }

  const windowDates: string[] = [];
  for (let di = ctx.dailyStartIndex; di <= ctx.todayIndex; di++) {
    const [y, m, d] = dayIndexToYmd(di);
    windowDates.push(etDateStr(etMidnightUtcMs(y, m, d)));
  }

  // Per-account deal summary (demo-status + Deal Health), keyed by owned company id. Built after
  // the activity loop so lastActivityMs = max(our synced touch, HubSpot notes_last_updated).
  const nowMs = generatedAtMs;
  const dealInfoByCompany = new Map<string, AccountDeal>();
  for (const ownerId of REP_OWNER_IDS) {
    const roofMap = bookStat.get(ownerId)!;
    for (const c of ownedCompanies[ownerId] ?? []) {
      const dl = companyDeals.get(c.id);
      if (!dl || dl.length === 0) continue; // no deal → Temperature governs, no AccountDeal
      const ourLast = roofMap.get(c.id)?.lastMs ?? 0;
      const lastActivityMs = Math.max(ourLast, c.lastActivityMs ?? 0) || null;
      dealInfoByCompany.set(c.id, accountDealInfo(dl, lastActivityMs, nowMs));
    }
  }

  const reps: Record<string, RepData> = {};
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = accs.get(ownerId)!;
    const ownedList = ownedCompanies[ownerId] ?? [];
    const ownedSet = ownedSets.get(ownerId)!;
    const periods = {} as Record<PeriodKey, PeriodMetrics>;
    for (const p of PERIOD_KEYS) periods[p] = finalize(byPeriod.get(p)!, p, companyNames, companyGdStage, contactMeta, ownedSet, dealInfoByCompany);

    const dmap = dailyAcc.get(ownerId)!;
    const daily: DailyPoint[] = windowDates.map((date) => {
      const d = dmap.get(date) ?? { calls: 0, connected: 0, emails: 0 };
      return { date, calls: d.calls, connected: d.connected, emails: d.emails };
    });

    const book = computeBookCoverage(ownedList, everTapped.get(ownerId)!, bookStat.get(ownerId)!, contactMeta, dealInfoByCompany, generatedAtMs, gdOwners);

    // SDR demo-status funnel over the owned book (per rooftop; no deal → Demo Pending).
    const funnel: RepFunnel = { demo_pending: 0, demo_scheduled: 0, demo_done: 0, scheduled_at_risk: 0 };
    for (const c of ownedList) {
      const di = dealInfoByCompany.get(c.id);
      const status = di?.demo_status ?? "demo_pending";
      if (status === "demo_scheduled") { funnel.demo_scheduled++; if (di?.at_risk) funnel.scheduled_at_risk++; }
      else if (status === "demo_done") funnel.demo_done++;
      else funnel.demo_pending++;
    }

    // Event-truth demo metrics: count deals by WHEN they entered the stage (ledger-driven),
    // bucketed through the same US/Eastern period logic as activities. Also the rep's
    // active/inactive pipeline segregation by current stage.
    const repDeals = dealsByRep.get(ownerId) ?? [];
    for (const p of PERIOD_KEYS) periods[p].demos = { scheduled: 0, completed: 0 };
    for (const d of repDeals) {
      const s = demoScheduledMs(d);
      if (s != null) for (const pk of periodsForActivity(s, ctx)) periods[pk].demos!.scheduled++;
      const c = demoCompletedMs(d);
      if (c != null) for (const pk of periodsForActivity(c, ctx)) periods[pk].demos!.completed++;
    }
    const pipeline = computeRepPipeline(repDeals);

    const ma = monthAgg.get(ownerId)!;
    const fco = firstTapCo.get(ownerId)!;
    const fct = firstTapCt.get(ownerId)!;
    const monthly: MonthMetrics[] = recent.map(({ key, label }) => {
      const acc = ma.get(key) ?? newMonthAcc();
      let rooftops_new = 0, gds = 0, singles = 0, contacts_new = 0;
      for (const co of acc.companies) if (etMonthKey(fco.get(co)!) === key) rooftops_new++;
      for (const uk of acc.units) { if (uk.startsWith("gd:")) gds++; else singles++; }
      for (const cid of acc.contacts) if (etMonthKey(fct.get(cid)!) === key) contacts_new++;
      return {
        month: key, label,
        rooftops_engaged: acc.companies.size, rooftops_new,
        gds_engaged: gds, singles_engaged: singles,
        contacts_engaged: acc.contacts.size, contacts_new,
        calls: acc.calls, emails: acc.emails, connected: acc.connected,
      };
    });

    reps[ownerId] = { periods, daily, book, monthly, funnel, pipeline };
  }

  return {
    generated_at_utc: new Date(generatedAtMs).toISOString(),
    today_et: ctx.windowEndDate,
    week_start: "MON",
    tz: PORTAL_TZ,
    scope: "outbound",
    sources,
    window: { start_et: ctx.windowStartDate, end_et: ctx.windowEndDate },
    totals: { calls: totalCalls, emails: totalEmails, reps: REP_OWNER_IDS.length, window_days: Math.round((ctx.nowMs - ctx.windowStartMs) / DAY_MS) },
    owner_names: REPS,
    owner_kinds: roster.kinds ?? {},
    reps,
  };
}

/**
 * V3 arbitrary date-range metrics: fold activities within [fromMs, toMs) into ONE PeriodMetrics
 * per rep (same engine as the six fixed periods), plus event-truth demos from the deals' stage
 * ledgers. Returns metrics for EVERY requested owner (zeros when idle). No company_breakdown
 * (that's a narrow-period feature) and no book/monthly/pipeline — those are period-independent
 * and live on the snapshot. Pure — the /api/metrics/range route feeds it.
 */
export function aggregateRange(
  activities: Activity[],
  ownerIds: string[],
  contactMeta: Record<string, ContactMeta>,
  deals: Deal[],
  kinds: Record<string, "sdr" | "ae">,
  fromMs: number,
  toMs: number,
): Record<string, PeriodMetrics> {
  const accs = new Map<string, Acc>();
  for (const id of ownerIds) accs.set(id, newAcc());
  for (const a of activities) {
    if (a.timestampMs < fromMs || a.timestampMs >= toMs) continue;
    const acc = accs.get(a.ownerId);
    if (acc) applyActivity(acc, a);
  }
  const dealsByRep = dealsByRepLens(deals, ownerIds, kinds);
  const out: Record<string, PeriodMetrics> = {};
  for (const id of ownerIds) {
    // "last_week" is any NON-narrow period key: finalize only reads it to decide whether to
    // build company_breakdown, which a range response intentionally omits.
    const m = finalize(accs.get(id)!, "last_week", {}, {}, contactMeta, new Set(), new Map());
    const demos = { scheduled: 0, completed: 0 };
    for (const d of dealsByRep.get(id) ?? []) {
      const s = demoScheduledMs(d);
      if (s != null && s >= fromMs && s < toMs) demos.scheduled++;
      const c = demoCompletedMs(d);
      if (c != null && c >= fromMs && c < toMs) demos.completed++;
    }
    m.demos = demos;
    out[id] = m;
  }
  return out;
}
