/**
 * Aggregate resolved activities into per-rep, per-period metrics:
 *   - reach split by activity (contacts/companies via call / email / both)
 *   - coverage of the rep's owned company book (+ untapped accounts)
 *   - account temperature (hot/warm/cold) from outcomes
 *   - persistence (multi-touch), a composite quality score, and rule-based insights
 *
 * Each activity is tested against every period it belongs to, so dedupe sets are
 * per (rep, period). Every tracked rep appears even with zero activity.
 */

import { REPS, REP_OWNER_IDS } from "../../config/reps";
import { isConnected, isHighIntent, isMeeting, dispositionLabel } from "../../config/dispositions";
import { IstContext, periodsForActivity, istDateStr, IST_OFFSET_MS } from "./buckets";
import { OwnedCompany } from "./pull";
import {
  Activity,
  AccountTemp,
  Coverage,
  DailyPoint,
  Insight,
  PERIOD_KEYS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  QualityScore,
  ReachByChannel,
  RepData,
  Snapshot,
  Temperature,
} from "./types";

const DAY_MS = 86_400_000;
const COVERAGE_SAMPLE_PERIODS = new Set<PeriodKey>(["this_week", "this_month"]);
const UNTAPPED_SAMPLE_CAP = 200;

interface CompanyStat {
  contacts: Set<string>;
  calls: number;
  emails: number;
  connected: number;
  meeting: boolean;
  highIntent: boolean;
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
  unattributed: number;
}

function newAcc(): Acc {
  return {
    contactTouch: new Map(),
    companyStat: new Map(),
    callsTotal: 0,
    callsConnected: 0,
    callsNotConnected: 0,
    callsNull: 0,
    meetingsBooked: 0,
    byDisposition: new Map(),
    emailsSent: 0,
    emailsBounced: 0,
    unattributed: 0,
  };
}

function applyActivity(acc: Acc, a: Activity): void {
  if (a.type === "call") {
    acc.callsTotal++;
    if (!a.disposition) acc.callsNull++;
    else if (isConnected(a.disposition)) acc.callsConnected++;
    else acc.callsNotConnected++;
    if (isMeeting(a.disposition)) acc.meetingsBooked++;
    acc.byDisposition.set(dispositionLabel(a.disposition), (acc.byDisposition.get(dispositionLabel(a.disposition)) ?? 0) + 1);
  } else {
    acc.emailsSent++;
    if ((a.emailStatus ?? "").toUpperCase() === "BOUNCED") acc.emailsBounced++;
  }

  for (const c of a.contactIds) {
    const t = acc.contactTouch.get(c) ?? { call: 0, email: 0 };
    if (a.type === "call") t.call++;
    else t.email++;
    acc.contactTouch.set(c, t);
  }

  for (const co of a.companyIds) {
    const s = acc.companyStat.get(co) ?? { contacts: new Set<string>(), calls: 0, emails: 0, connected: 0, meeting: false, highIntent: false };
    a.contactIds.forEach((c) => s.contacts.add(c));
    if (a.type === "call") {
      s.calls++;
      if (a.disposition && isConnected(a.disposition)) s.connected++;
      if (isMeeting(a.disposition)) s.meeting = true;
      if (isHighIntent(a.disposition)) s.highIntent = true;
    } else {
      s.emails++;
    }
    acc.companyStat.set(co, s);
  }

  if (a.contactIds.length === 0 && a.companyIds.length === 0) acc.unattributed++;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function temperatureOf(s: CompanyStat): Temperature {
  if (s.meeting || s.highIntent) return "hot";
  if (s.connected > 0) return "warm";
  return "cold";
}

/** Build a reach-by-channel summary from per-entity channel touch flags. */
function reachOf(entries: { call: boolean; email: boolean }[]): ReachByChannel {
  let callOnly = 0, emailOnly = 0, both = 0;
  for (const e of entries) {
    if (e.call && e.email) both++;
    else if (e.call) callOnly++;
    else if (e.email) emailOnly++;
  }
  return {
    total: callOnly + emailOnly + both,
    call_only: callOnly,
    email_only: emailOnly,
    both,
    via_call: callOnly + both,
    via_email: emailOnly + both,
  };
}

function computeQuality(args: {
  connectRate: number;
  meetings: number;
  depth: number;
  persistenceShare: number;
  calls: number;
  emails: number;
  bounceRate: number;
  hasActivity: boolean;
}): QualityScore {
  if (!args.hasActivity) {
    return { score: 0, grade: "—", sub: { conversations: 0, depth: 0, persistence: 0, channel: 0, deliverability: 0 } };
  }
  const conversations = 100 * (0.6 * clamp01(args.connectRate / 0.2) + 0.4 * clamp01(args.meetings / 3));
  const depth = 100 * clamp01((args.depth - 1) / 2); // 1→0, 3+→100
  const persistence = 100 * clamp01(args.persistenceShare);
  const totalAct = args.calls + args.emails;
  const callShare = totalAct ? args.calls / totalAct : 0;
  const balance = 1 - Math.abs(callShare - 0.5) * 2; // 0 single-channel, 1 balanced
  const channel = 100 * (0.4 + 0.6 * clamp01(balance)); // floor 40 so call-heavy isn't crushed
  const deliverability = args.emails === 0 ? 100 : 100 * clamp01(1 - args.bounceRate);

  const score = Math.round(0.35 * conversations + 0.2 * depth + 0.2 * persistence + 0.15 * channel + 0.1 * deliverability);
  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "F";
  return {
    score,
    grade,
    sub: {
      conversations: Math.round(conversations),
      depth: Math.round(depth),
      persistence: Math.round(persistence),
      channel: Math.round(channel),
      deliverability: Math.round(deliverability),
    },
  };
}

function buildInsights(m: {
  hasActivity: boolean;
  coverage: Coverage;
  meetings: number;
  hot: number;
  calls: number;
  emails: number;
  connectRate: number;
  connectDenom: number;
  companiesTapped: number;
  depth: number;
  persistenceShare: number;
  emailsSent: number;
  bounceRate: number;
}): Insight[] {
  if (!m.hasActivity) return [{ level: "warn", text: "💤 No outbound activity this period" }];
  const out: Insight[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  if (m.coverage.owned_total > 0) {
    if (m.coverage.pct < 0.5)
      out.push({ level: "warn", text: `⚠ ${m.coverage.untapped_count} of ${m.coverage.owned_total} owned accounts untapped (${pct(m.coverage.pct)} covered)` });
    else out.push({ level: "good", text: `✓ ${pct(m.coverage.pct)} of owned accounts tapped` });
  }
  if (m.meetings > 0) out.push({ level: "good", text: `🎯 ${m.meetings} meeting${m.meetings > 1 ? "s" : ""} booked` });
  if (m.hot > 0) out.push({ level: "good", text: `🔥 ${m.hot} hot account${m.hot > 1 ? "s" : ""}` });
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
  contactNames: Record<string, string>,
  ownedSet: Set<string>,
  ownedList: OwnedCompany[],
): PeriodMetrics {
  const contacts = reachOf([...acc.contactTouch.values()].map((t) => ({ call: t.call > 0, email: t.email > 0 })));
  const companies = reachOf([...acc.companyStat.values()].map((s) => ({ call: s.calls > 0, email: s.emails > 0 })));

  let multitouchContacts = 0;
  for (const t of acc.contactTouch.values()) if (t.call + t.email >= 2) multitouchContacts++;

  let companiesWithContact = 0, contactsInCompanies = 0, multitouchAccounts = 0;
  const temp: AccountTemp = { hot: 0, warm: 0, cold: 0 };
  for (const s of acc.companyStat.values()) {
    if (s.contacts.size > 0) {
      companiesWithContact++;
      contactsInCompanies += s.contacts.size;
    }
    if (s.calls + s.emails >= 2) multitouchAccounts++;
    temp[temperatureOf(s)]++;
  }
  const companiesTapped = acc.companyStat.size;
  const depth = companiesWithContact ? contactsInCompanies / companiesWithContact : 0;

  const connectDenom = acc.callsConnected + acc.callsNotConnected;
  const connectRate = connectDenom ? acc.callsConnected / connectDenom : 0;
  const bounceRate = acc.emailsSent ? acc.emailsBounced / acc.emailsSent : 0;
  const persistenceShare = companiesTapped ? multitouchAccounts / companiesTapped : 0;

  // Coverage of owned book.
  let ownedTapped = 0;
  for (const id of acc.companyStat.keys()) if (ownedSet.has(id)) ownedTapped++;
  const ownedTotal = ownedSet.size;
  const untappedCount = Math.max(0, ownedTotal - ownedTapped);
  const untappedSample =
    COVERAGE_SAMPLE_PERIODS.has(period) && ownedTotal > 0
      ? ownedList.filter((c) => !acc.companyStat.has(c.id)).slice(0, UNTAPPED_SAMPLE_CAP).map((c) => ({ id: c.id, name: c.name }))
      : [];
  const coverage: Coverage = {
    owned_total: ownedTotal,
    owned_tapped: ownedTapped,
    pct: ownedTotal ? round(ownedTapped / ownedTotal, 3) : 0,
    untapped_count: untappedCount,
    untapped_sample: untappedSample,
  };

  const hasActivity = acc.callsTotal + acc.emailsSent > 0;
  const quality = computeQuality({
    connectRate, meetings: acc.meetingsBooked, depth, persistenceShare,
    calls: acc.callsTotal, emails: acc.emailsSent, bounceRate, hasActivity,
  });

  const insights = buildInsights({
    hasActivity, coverage, meetings: acc.meetingsBooked, hot: temp.hot,
    calls: acc.callsTotal, emails: acc.emailsSent, connectRate, connectDenom,
    companiesTapped, depth, persistenceShare, emailsSent: acc.emailsSent, bounceRate,
  });

  const metrics: PeriodMetrics = {
    calls: {
      total: acc.callsTotal,
      connected: acc.callsConnected,
      not_connected: acc.callsNotConnected,
      null_disposition: acc.callsNull,
      connect_rate: round(connectRate, 3),
      by_disposition: Object.fromEntries([...acc.byDisposition.entries()].sort((a, b) => b[1] - a[1])),
    },
    emails: { sent: acc.emailsSent, bounced: acc.emailsBounced, bounce_rate: round(bounceRate, 3) },
    meetings_booked: acc.meetingsBooked,
    contacts,
    companies,
    companies_with_contact: companiesWithContact,
    avg_contacts_per_company: round(depth),
    multitouch_contacts: multitouchContacts,
    multitouch_accounts: multitouchAccounts,
    coverage,
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
        owned: ownedSet.has(id),
        contacts_list: [...s.contacts].map((cid) => ({ id: cid, name: contactNames[cid] ?? `Contact ${cid}` })),
      }))
      .sort((a, b) => b.calls + b.emails - (a.calls + a.emails));
  }

  return metrics;
}

export function aggregate(
  activities: Activity[],
  companyNames: Record<string, string>,
  contactNames: Record<string, string>,
  ownedCompanies: Record<string, OwnedCompany[]>,
  ctx: IstContext,
  generatedAtMs: number,
  sources: { calls: boolean; emails: boolean },
): Snapshot {
  const accs = new Map<string, Map<PeriodKey, Acc>>();
  const dailyAcc = new Map<string, Map<string, { calls: number; connected: number; emails: number }>>();
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = new Map<PeriodKey, Acc>();
    for (const p of PERIOD_KEYS) byPeriod.set(p, newAcc());
    accs.set(ownerId, byPeriod);
    dailyAcc.set(ownerId, new Map());
  }

  let totalCalls = 0, totalEmails = 0;
  for (const a of activities) {
    if (a.type === "call") totalCalls++;
    else totalEmails++;
    const byPeriod = accs.get(a.ownerId);
    if (!byPeriod) continue;
    for (const period of periodsForActivity(a.timestampMs, ctx)) applyActivity(byPeriod.get(period)!, a);

    const day = istDateStr(a.timestampMs);
    const dmap = dailyAcc.get(a.ownerId)!;
    const d = dmap.get(day) ?? { calls: 0, connected: 0, emails: 0 };
    if (a.type === "call") {
      d.calls++;
      if (a.disposition && isConnected(a.disposition)) d.connected++;
    } else d.emails++;
    dmap.set(day, d);
  }

  const startIdx = Math.floor((ctx.windowStartMs + IST_OFFSET_MS) / DAY_MS);
  const windowDates: string[] = [];
  for (let di = startIdx; di <= ctx.todayIndex; di++) windowDates.push(istDateStr(di * DAY_MS - IST_OFFSET_MS));

  const reps: Record<string, RepData> = {};
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = accs.get(ownerId)!;
    const ownedList = ownedCompanies[ownerId] ?? [];
    const ownedSet = new Set(ownedList.map((c) => c.id));
    const periods = {} as Record<PeriodKey, PeriodMetrics>;
    for (const p of PERIOD_KEYS) periods[p] = finalize(byPeriod.get(p)!, p, companyNames, contactNames, ownedSet, ownedList);

    const dmap = dailyAcc.get(ownerId)!;
    const daily: DailyPoint[] = windowDates.map((date) => {
      const d = dmap.get(date) ?? { calls: 0, connected: 0, emails: 0 };
      return { date, calls: d.calls, connected: d.connected, emails: d.emails };
    });

    reps[ownerId] = { periods, daily };
  }

  return {
    generated_at_utc: new Date(generatedAtMs).toISOString(),
    today_ist: ctx.windowEndDate,
    week_start: "MON",
    scope: "outbound",
    sources,
    window: { start_ist: ctx.windowStartDate, end_ist: ctx.windowEndDate },
    totals: {
      calls: totalCalls,
      emails: totalEmails,
      reps: REP_OWNER_IDS.length,
      window_days: Math.round((ctx.nowMs - ctx.windowStartMs) / DAY_MS),
    },
    owner_names: REPS,
    reps,
  };
}
