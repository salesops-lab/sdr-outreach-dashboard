/**
 * Aggregate resolved activities into per-rep, per-period metrics.
 *
 * Each activity is tested against ALL periods it belongs to (an activity today is
 * simultaneously in today / last_3_days / this_week / this_month), so the dedupe
 * sets are per (rep, period) — never a partition. Every tracked rep appears with
 * zeroed metrics even if they did nothing, so "untapped" reps are visible.
 */

import { REPS, REP_OWNER_IDS } from "../../config/reps";
import { isConnected, dispositionLabel } from "../../config/dispositions";
import { IstContext, periodsForActivity } from "./buckets";
import {
  Activity,
  PERIOD_KEYS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  RepData,
  Snapshot,
} from "./types";

interface Acc {
  contactChannels: Map<string, { call: boolean; email: boolean }>;
  companyStats: Map<string, { contacts: Set<string>; calls: number; emails: number }>;
  callsTotal: number;
  callsConnected: number;
  callsNotConnected: number;
  callsNull: number;
  byDisposition: Map<string, number>;
  emailsSent: number;
  emailsBounced: number;
  unattributed: number;
}

function newAcc(): Acc {
  return {
    contactChannels: new Map(),
    companyStats: new Map(),
    callsTotal: 0,
    callsConnected: 0,
    callsNotConnected: 0,
    callsNull: 0,
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
    const label = dispositionLabel(a.disposition);
    acc.byDisposition.set(label, (acc.byDisposition.get(label) ?? 0) + 1);
  } else {
    acc.emailsSent++;
    if ((a.emailStatus ?? "").toUpperCase() === "BOUNCED") acc.emailsBounced++;
  }

  for (const c of a.contactIds) {
    const ch = acc.contactChannels.get(c) ?? { call: false, email: false };
    if (a.type === "call") ch.call = true;
    else ch.email = true;
    acc.contactChannels.set(c, ch);
  }

  for (const co of a.companyIds) {
    const stat = acc.companyStats.get(co) ?? { contacts: new Set<string>(), calls: 0, emails: 0 };
    a.contactIds.forEach((c) => stat.contacts.add(c));
    if (a.type === "call") stat.calls++;
    else stat.emails++;
    acc.companyStats.set(co, stat);
  }

  if (a.contactIds.length === 0 && a.companyIds.length === 0) acc.unattributed++;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function finalize(acc: Acc, period: PeriodKey, companyNames: Record<string, string>): PeriodMetrics {
  // Channel mix over touched contacts.
  let callOnly = 0;
  let emailOnly = 0;
  let both = 0;
  for (const ch of acc.contactChannels.values()) {
    if (ch.call && ch.email) both++;
    else if (ch.call) callOnly++;
    else emailOnly++;
  }

  // Companies-with-contact and contacts-per-company average.
  let companiesWithContact = 0;
  let contactsInCompanies = 0;
  for (const stat of acc.companyStats.values()) {
    if (stat.contacts.size > 0) {
      companiesWithContact++;
      contactsInCompanies += stat.contacts.size;
    }
  }

  const callDenom = acc.callsConnected + acc.callsNotConnected;

  const metrics: PeriodMetrics = {
    unique_contacts: acc.contactChannels.size,
    unique_companies: acc.companyStats.size,
    companies_with_contact: companiesWithContact,
    avg_contacts_per_company: companiesWithContact ? round(contactsInCompanies / companiesWithContact) : 0,
    calls: {
      total: acc.callsTotal,
      connected: acc.callsConnected,
      not_connected: acc.callsNotConnected,
      null_disposition: acc.callsNull,
      connect_rate: callDenom ? round(acc.callsConnected / callDenom, 3) : 0,
      by_disposition: Object.fromEntries(
        [...acc.byDisposition.entries()].sort((a, b) => b[1] - a[1]),
      ),
    },
    emails: {
      sent: acc.emailsSent,
      bounced: acc.emailsBounced,
      bounce_rate: acc.emailsSent ? round(acc.emailsBounced / acc.emailsSent, 3) : 0,
    },
    channel_mix: { call_only: callOnly, email_only: emailOnly, both },
    unattributed_activities: acc.unattributed,
  };

  if (NARROW_PERIODS.includes(period)) {
    metrics.company_breakdown = [...acc.companyStats.entries()]
      .map(([id, stat]) => ({
        id,
        name: companyNames[id] ?? `Company ${id}`,
        contacts: stat.contacts.size,
        calls: stat.calls,
        emails: stat.emails,
      }))
      .sort((a, b) => b.calls + b.emails - (a.calls + a.emails));
  }

  return metrics;
}

export function aggregate(
  activities: Activity[],
  companyNames: Record<string, string>,
  ctx: IstContext,
  generatedAtMs: number,
  sources: { calls: boolean; emails: boolean },
): Snapshot {
  // rep -> period -> Acc, pre-initialized for all tracked reps.
  const accs = new Map<string, Map<PeriodKey, Acc>>();
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = new Map<PeriodKey, Acc>();
    for (const p of PERIOD_KEYS) byPeriod.set(p, newAcc());
    accs.set(ownerId, byPeriod);
  }

  let totalCalls = 0;
  let totalEmails = 0;
  for (const a of activities) {
    if (a.type === "call") totalCalls++;
    else totalEmails++;
    const byPeriod = accs.get(a.ownerId);
    if (!byPeriod) continue; // owner not tracked (shouldn't happen — search filters by owner)
    for (const period of periodsForActivity(a.timestampMs, ctx)) {
      applyActivity(byPeriod.get(period)!, a);
    }
  }

  const reps: Record<string, RepData> = {};
  for (const ownerId of REP_OWNER_IDS) {
    const byPeriod = accs.get(ownerId)!;
    const periods = {} as Record<PeriodKey, PeriodMetrics>;
    for (const p of PERIOD_KEYS) periods[p] = finalize(byPeriod.get(p)!, p, companyNames);
    reps[ownerId] = { periods };
  }

  const windowDays = Math.round((ctx.nowMs - ctx.windowStartMs) / 86_400_000);

  return {
    generated_at_utc: new Date(generatedAtMs).toISOString(),
    today_ist: ctx.windowEndDate,
    week_start: "MON",
    scope: "outbound",
    sources,
    window: { start_ist: ctx.windowStartDate, end_ist: ctx.windowEndDate },
    totals: { calls: totalCalls, emails: totalEmails, reps: REP_OWNER_IDS.length, window_days: windowDays },
    owner_names: REPS,
    reps,
  };
}
