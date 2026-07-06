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

import { REPS, REP_OWNER_IDS } from "../../config/reps";
import { isConnected, isHighIntent, isMeeting, dispositionLabel } from "../../config/dispositions";
import {
  EtContext, periodsForActivity, etParts, etDateStr, etMidnightUtcMs, dayIndexToYmd, PORTAL_TZ,
} from "./buckets";
import { OwnedCompany } from "./pull";
import { ContactMeta } from "./associate";
import {
  Activity,
  AccountTemp,
  BookCoverage,
  BookUnitDetail,
  CoverageDim,
  DailyPoint,
  DealershipType,
  Insight,
  MARKET_SEGMENTS,
  MarketSegment,
  NamedRef,
  PERIOD_KEYS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  QualityScore,
  ReachByChannel,
  RepData,
  RooftopContact,
  RooftopDetail,
  Snapshot,
  STAGE_GROUPS,
  StageGroup,
  Temperature,
} from "./types";

const DAY_MS = 86_400_000;
const UNTAPPED_SAMPLE_CAP = 200;

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

/** The engagement fields the temperature rules read — CompanyStat and RoofAcc both satisfy it. */
interface TouchStat {
  calls: number;
  emails: number;
  connected: number;
  meeting: boolean;
  highIntent: boolean;
  opened: number;
  replied: number;
}

interface CompanyStat extends TouchStat {
  contacts: Set<string>;
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
interface RoofAcc {
  calls: number;
  emails: number;
  connected: number;
  lastMs: number;
  meeting: boolean;
  highIntent: boolean;
  opened: number;
  replied: number;
  contacts: Map<string, { calls: number; emails: number }>;
}

function newRoofAcc(): RoofAcc {
  return { calls: 0, emails: 0, connected: 0, lastMs: 0, meeting: false, highIntent: false, opened: 0, replied: 0, contacts: new Map() };
}

/** Shared per-activity company-touch bookkeeping (business rules live in ONE place). */
function recordTouch(s: TouchStat, a: Activity): void {
  if (a.type === "call") {
    s.calls++;
    if (a.disposition && isConnected(a.disposition)) s.connected++;
    if (isMeeting(a.disposition)) s.meeting = true;
    if (isHighIntent(a.disposition)) s.highIntent = true;
  } else {
    s.emails++;
    if (a.emailOpened) s.opened++;
    if (a.emailReplied) s.replied++;
  }
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
    const s = acc.companyStat.get(co) ?? { contacts: new Set<string>(), calls: 0, emails: 0, connected: 0, meeting: false, highIntent: false, opened: 0, replied: 0 };
    a.contactIds.forEach((c) => s.contacts.add(c));
    recordTouch(s, a);
    acc.companyStat.set(co, s);
  }

  if (a.contactIds.length === 0 && a.companyIds.length === 0) acc.unattributed++;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function temperatureOf(s: TouchStat): Temperature {
  if (s.meeting || s.highIntent || s.replied > 0) return "hot";
  if (s.connected > 0 || s.opened > 0 || s.calls + s.emails >= 3) return "warm";
  return "cold";
}

function temperatureReason(s: TouchStat): string {
  const touches = s.calls + s.emails;
  if (s.meeting) return "Meeting booked";
  if (s.highIntent) return "High-intent callback";
  if (s.replied > 0) return `Replied to email`;
  if (s.connected > 0) return `Connected ${s.connected}×${s.opened > 0 ? `, opened ${s.opened}` : ""}`;
  if (s.opened > 0) return `Opened email${s.opened > 1 ? ` ${s.opened}×` : ""}, no call connect`;
  if (touches >= 3) return `${touches} touches, no engagement`;
  if (s.calls > 0) return `${s.calls} call${s.calls > 1 ? "s" : ""}, no connect`;
  if (s.emails > 0) return `Emailed, no open/reply`;
  return "Touched";
}

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
  if (m.companiesTapped >= 10 && m.depth < 1.3) out.push({ level: "warn", text: `🪨 Shallow — ${m.depth.toFixed(1)} contacts/account` });
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
    temp[temperatureOf(s)]++;
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
      .map(([id, s]) => ({
        id,
        name: companyNames[id] ?? `Company ${id}`,
        contacts: s.contacts.size,
        calls: s.calls,
        emails: s.emails,
        temp: temperatureOf(s),
        temp_reason: temperatureReason(s),
        stage: normalizeGdStage(companyGdStage[id]),
        opened: s.opened,
        replied: s.replied,
        owned: ownedSet.has(id),
        contacts_list: [...s.contacts].map((cid) => {
          const meta = contactMeta[cid];
          return { id: cid, name: meta?.name ?? `Contact ${cid}`, title: meta?.title ?? undefined, dm: meta?.dm };
        }),
      }))
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

/** Build the top-5 engaged-contact list for one rooftop's accumulator. */
function rooftopContacts(stat: RoofAcc, contactMeta: Record<string, ContactMeta>): RooftopContact[] {
  return [...stat.contacts.entries()]
    .map(([id, c]) => {
      const meta = contactMeta[id];
      return { id, name: meta?.name ?? `Contact ${id}`, title: meta?.title ?? undefined, dm: meta?.dm, calls: c.calls, emails: c.emails };
    })
    .sort((a, b) => (b.calls + b.emails) - (a.calls + a.emails))
    .slice(0, 5);
}

/**
 * Roll the rep's owned rooftops into GD/Single units and compute cumulative coverage.
 * A group unit requires BOTH the group flag AND a gd_id; anything else is a single unit
 * (group-flagged rooftops with no gd_id fall back to single — counted, never dropped).
 */
function computeBookCoverage(
  ownedList: OwnedCompany[],
  everTapped: Set<string>,
  roofStats: Map<string, RoofAcc>,
  contactMeta: Record<string, ContactMeta>,
): BookCoverage {
  const units = new Map<string, { name: string; isGroup: boolean; rooftops: OwnedCompany[] }>();
  for (const c of ownedList) {
    const isGroupUnit = c.isGroup && !!c.gdId;
    const key = isGroupUnit ? `gd:${c.gdId}` : `single:${c.id}`;
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

  let units_total = 0, units_tapped = 0, gds = 0, singles = 0, rooftops_total = 0;

  for (const [key, u] of units.entries()) {
    units_total++;
    rooftops_total += u.rooftops.length;
    if (u.isGroup) gds++; else singles++;

    const tapped = u.rooftops.some((r) => everTapped.has(r.id));
    if (tapped) units_tapped++;

    // GD-level stage is consistent across a group's rooftops; take the first non-empty.
    const stage = normalizeGdStage(u.rooftops.map((r) => r.gdStage).find(Boolean) ?? null);
    const dealership = pickDealership(u.rooftops);
    const segment = pickSegment(u.rooftops);
    bump(by_stage[stage], tapped);
    bump(by_dealership[dealership], tapped);
    bump(by_segment[segment], tapped);
    bump(u.isGroup ? by_group_kind.group : by_group_kind.single, tapped);

    if (!tapped && untapped_sample.length < UNTAPPED_SAMPLE_CAP) {
      untapped_sample.push({ id: u.rooftops[0].id, name: u.name, stage });
    }

    const rooftops: RooftopDetail[] = u.rooftops.map((r) => {
      const rTapped = everTapped.has(r.id);
      const stat = roofStats.get(r.id) ?? newRoofAcc(); // RoofAcc satisfies TouchStat directly
      const untapped = !rTapped;

      return {
        id: r.id, name: r.name, tapped: rTapped,
        calls: stat.calls, emails: stat.emails, connected: stat.connected,
        last_ms: stat.lastMs || null,
        temp: untapped ? "cold" : temperatureOf(stat),
        temp_reason: untapped ? "Untouched" : temperatureReason(stat),
        contacts: rooftopContacts(stat, contactMeta),
      };
    });

    rooftops.sort((a, b) => {
      if (a.tapped !== b.tapped) return a.tapped ? -1 : 1;
      if (a.tapped) return (b.calls + b.emails) - (a.calls + a.emails);
      return a.name.localeCompare(b.name);
    });

    unitDetails.push({ key, name: u.name, isGroup: u.isGroup, stage, dealership, segment, tapped, rooftops });
  }

  unitDetails.sort((a, b) => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    if (b.rooftops.length !== a.rooftops.length) return b.rooftops.length - a.rooftops.length;
    return a.name.localeCompare(b.name);
  });

  const book: BookCoverage = {
    units_total, units_tapped,
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
): Snapshot {
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

  // totals reflect the short (display) window; everTapped uses the full anchored set.
  let totalCalls = 0, totalEmails = 0;
  for (const a of activities) {
    const byPeriod = accs.get(a.ownerId);
    if (!byPeriod) continue;

    for (const period of periodsForActivity(a.timestampMs, ctx)) applyActivity(byPeriod.get(period)!, a);

    // Cumulative, owner-scoped tapped set (a company counts only if its owner acted on it).
    const owned = ownedSets.get(a.ownerId)!;
    const tappedSet = everTapped.get(a.ownerId)!;
    const roofMap = bookStat.get(a.ownerId)!;
    for (const co of a.companyIds) {
      if (!owned.has(co)) continue;
      tappedSet.add(co);

      const racc = roofMap.get(co) ?? newRoofAcc();
      recordTouch(racc, a);
      racc.lastMs = Math.max(racc.lastMs, a.timestampMs);
      for (const cid of a.contactIds) {
        const ct = racc.contacts.get(cid) ?? { calls: 0, emails: 0 };
        if (a.type === "call") ct.calls++; else ct.emails++;
        racc.contacts.set(cid, ct);
      }
      roofMap.set(co, racc);
    }

    // Daily trend + display totals: only within the short window.
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

  const windowDates: string[] = [];
  for (let di = ctx.dailyStartIndex; di <= ctx.todayIndex; di++) {
    const [y, m, d] = dayIndexToYmd(di);
    windowDates.push(etDateStr(etMidnightUtcMs(y, m, d)));
  }

  const reps: Record<string, RepData> = {};
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = accs.get(ownerId)!;
    const ownedList = ownedCompanies[ownerId] ?? [];
    const ownedSet = ownedSets.get(ownerId)!;
    const periods = {} as Record<PeriodKey, PeriodMetrics>;
    for (const p of PERIOD_KEYS) periods[p] = finalize(byPeriod.get(p)!, p, companyNames, companyGdStage, contactMeta, ownedSet);

    const dmap = dailyAcc.get(ownerId)!;
    const daily: DailyPoint[] = windowDates.map((date) => {
      const d = dmap.get(date) ?? { calls: 0, connected: 0, emails: 0 };
      return { date, calls: d.calls, connected: d.connected, emails: d.emails };
    });

    const book = computeBookCoverage(ownedList, everTapped.get(ownerId)!, bookStat.get(ownerId)!, contactMeta);
    reps[ownerId] = { periods, daily, book };
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
    reps,
  };
}
