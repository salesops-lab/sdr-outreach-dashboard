"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  PERIOD_KEYS, PERIOD_LABELS, NARROW_PERIODS, STAGE_GROUPS, MARKET_SEGMENTS, MARKET_SEGMENT_LABELS,
  PeriodKey, PeriodMetrics, RepData, Snapshot, DailyPoint, ReachByChannel, Insight, StageGroup,
  BookCoverage, CoverageDim, CompanyBreakdownRow, MonthMetrics,
} from "../lib/sync/types";
import {
  Activity, Users, Building2, Gauge, PhoneCall, CalendarCheck, Flame, Phone, Mail, Download, ShieldCheck,
  AlertTriangle, ExternalLink,
} from "lucide-react";
import { CONNECTED_DISPOSITIONS } from "../config/dispositions";
import { companyUrl } from "../config/hubspot";
import { CoachingSnapshot } from "../lib/callquality/types";
import { Viewer } from "../lib/spine/types";
import RepDrawer from "./RepDrawer";
import GdExplorer from "./GdExplorer";
import LogoutButton from "./LogoutButton";
import { STAGE_CHIP } from "./ui-tokens";
import { Surface, SectionTitle, StatTile, Chip, Bar, Avatar, GradeBadge, SortHeader, TEMP_META, cn } from "./ui";
import { RooftopsTable, RooftopNode } from "./AccountsTable";

// Literal temperature color classes so Tailwind's JIT keeps them (dynamic `text-${k}` would be purged).
const TEMP_TEXT: Record<"hot" | "warm" | "cold", string> = { hot: "text-hot", warm: "text-warm", cold: "text-cold" };

const CONNECTED_LABELS = new Set(Object.values(CONNECTED_DISPOSITIONS));

type SortKey = "name" | "quality" | "touches" | "contacts" | "companies" | "coverage" | "connect" | "reply" | "meetings" | "hot";
type AcctFilter = "all" | "hot" | "warm" | "cold" | "meetings" | "disqualified";

interface Row { ownerId: string; name: string; data: RepData; m: PeriodMetrics; touches: number; }

const fmt = (n: number) => n.toLocaleString("en-IN");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;

function etStamp(iso: string): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET";
  } catch { return iso; }
}

export default function Dashboard({ snapshot, viewer }: { snapshot: Snapshot; coaching: Record<string, CoachingSnapshot>; viewer: Viewer }) {
  const [period, setPeriod] = useState<PeriodKey>("this_week");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("touches");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [drawerRep, setDrawerRep] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setDrawerRep(null), []);

  // Focus model: a viewer whose default scope is a strict, non-empty subset of the
  // tracked reps gets a "My scope / All reps" toggle (org view stays available to all).
  const scoped = viewer.defaultOwnerIds.length > 0 && viewer.defaultOwnerIds.length < Object.keys(snapshot.reps).length;
  const [scopeMode, setScopeMode] = useState<"mine" | "all">(scoped ? "mine" : "all");

  const allRows = useMemo<Row[]>(() =>
    Object.entries(snapshot.reps)
      .filter(([id]) => scopeMode === "all" || viewer.defaultOwnerIds.includes(id))
      .map(([ownerId, data]) => {
        const m = data.periods[period];
        return { ownerId, name: snapshot.owner_names[ownerId] ?? `ID:${ownerId}`, data, m, touches: m.calls.total + m.emails.sent };
      }), [snapshot, period, scopeMode, viewer]);

  const rows = useMemo<Row[]>(() => {
    const filtered = repFilter === "all" ? allRows : allRows.filter((r) => r.ownerId === repFilter);
    const val = (r: Row): number | string => ({
      name: r.name.toLowerCase(), quality: r.m.quality.score, touches: r.touches,
      contacts: r.m.contacts.total, companies: r.m.companies.total, coverage: r.data.book.pct,
      connect: r.m.calls.connect_rate, reply: r.m.emails.reply_rate, meetings: r.m.meetings_booked, hot: r.m.temp.hot,
    }[sortKey]);
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [allRows, repFilter, sortKey, sortDir]);

  const summary = useMemo(() => {
    const a = { touches: 0, contacts: 0, companies: 0, calls: 0, connected: 0, denom: 0, meetings: 0, unitsTapped: 0, unitsTotal: 0, hot: 0, active: 0 };
    for (const r of rows) {
      a.touches += r.touches; a.contacts += r.m.contacts.total; a.companies += r.m.companies.total;
      a.calls += r.m.calls.total; a.connected += r.m.calls.connected; a.denom += r.m.calls.connected + r.m.calls.not_connected;
      a.meetings += r.m.meetings_booked; a.unitsTapped += r.data.book.units_tapped; a.unitsTotal += r.data.book.units_total; a.hot += r.m.temp.hot;
      if (r.touches > 0) a.active++;
    }
    return { ...a, emails: a.touches - a.calls, connectRate: a.denom ? a.connected / a.denom : 0, coverage: a.unitsTotal ? a.unitsTapped / a.unitsTotal : 0 };
  }, [rows]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  }

  function exportCsv() {
    const head = ["Rep","Quality","Grade","Touches","Calls","Connected","Emails","OpenRate","ReplyRate","UniqContacts","DMcontacts","UniqRooftops","BookUnits","GDs","Singles","UnitsTapped","Coverage","ConnectRate","Meetings","Hot","Warm","Cold"];
    const lines = rows.map((r) => { const m = r.m; const b = r.data.book; return [`"${r.name.replace(/"/g,'""')}"`, m.quality.score, m.quality.grade, r.touches, m.calls.total, m.calls.connected, m.emails.sent, m.emails.open_rate, m.emails.reply_rate, m.contacts.total, m.dm_contacts, m.companies.total, b.units_total, b.gds, b.singles, b.units_tapped, b.pct, m.calls.connect_rate, m.meetings_booked, m.temp.hot, m.temp.warm, m.temp.cold].join(","); });
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `sdr-outreach-${period}-${snapshot.today_et || "snap"}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  const hasData = !!snapshot.generated_at_utc;

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-7 sm:px-6">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-fg shadow-card">
            <Activity className="h-5 w-5" strokeWidth={2.4} />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">SDR Outreach Coverage</h1>
            <p className="mt-0.5 hidden text-sm text-ink-muted sm:block">Quantity × quality of outbound, per rep · reach by activity · cumulative owned-book coverage · US/Eastern · week starts Mon</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 text-right text-xs text-ink-muted">
          <div className="flex items-center gap-2">
            <Chip tone="primary" className="uppercase tracking-wide"><ShieldCheck className="h-3 w-3" />{viewer.role}</Chip>
            <a href="/attention" className="inline-flex items-center gap-1 font-semibold text-hot hover:underline"><Flame className="h-3 w-3" />Attention</a>
            {viewer.isAdmin && <a href="/admin" className="font-semibold text-primary hover:underline">Admin</a>}
            <LogoutButton />
          </div>
          <div>Refreshed <span className="font-semibold text-ink">{etStamp(snapshot.generated_at_utc)}</span></div>
          <div className="tabular-nums">{snapshot.window.start_et || "—"} → {snapshot.window.end_et || "—"} · {fmt(snapshot.totals.calls)} calls + {fmt(snapshot.totals.emails)} emails</div>
        </div>
      </header>

      {!hasData && <Surface className="mb-6 p-4 text-sm text-ink-muted">No snapshot yet. Run <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-primary">npm run sync:delta</code>.</Surface>}
      {hasData && snapshot.sources && !snapshot.sources.emails && (
        <div className="mb-6 rounded-card border border-warn/30 bg-warn-weak p-3 text-sm text-warn">⚠️ Emails excluded — token lacks <code className="rounded bg-white/60 px-1.5 py-0.5 font-mono">connected-email-data-access</code>.</div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <Segmented options={PERIOD_KEYS.map((p) => [p, PERIOD_LABELS[p]] as [string, string])} value={period} onChange={(v) => setPeriod(v as PeriodKey)} />
        {scoped && (
          <Segmented
            tone="good"
            options={[["mine", viewer.role === "rep" ? "My data" : "My team"], ["all", "All reps"]]}
            value={scopeMode}
            onChange={(v) => { setScopeMode(v as "mine" | "all"); setRepFilter("all"); }}
          />
        )}
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted shadow-card outline-none focus:ring-2 focus:ring-primary/30">
          <option value="all">All reps ({allRows.length})</option>
          {[...allRows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => <option key={r.ownerId} value={r.ownerId}>{r.name}</option>)}
        </select>
        <button onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-muted shadow-card transition hover:border-line-strong hover:text-ink">
          <Download className="h-4 w-4" /> CSV
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Touches" value={fmt(summary.touches)} icon={Activity} accent="primary"
          sub={<>{fmt(summary.calls)} dials · {fmt(summary.connected)} conn · {fmt(summary.emails)} email</>} />
        <StatTile label="Contacts" value={fmt(summary.contacts)} icon={Users} accent="primary" sub="unique · this period" />
        <StatTile label="Rooftops" value={fmt(summary.companies)} icon={Building2} accent="primary" sub="unique · this period" />
        <StatTile label="Book coverage" value={summary.unitsTotal ? pct0(summary.coverage) : "—"} icon={Gauge} accent="primary"
          sub={summary.unitsTotal ? `${fmt(summary.unitsTapped)}/${fmt(summary.unitsTotal)} accounts` : "—"} />
        <StatTile label="Connect rate" value={pct(summary.connectRate)} icon={PhoneCall} accent="good"
          sub={`${fmt(summary.connected)}/${fmt(summary.denom)} connected`} />
        <StatTile label="Meetings" value={fmt(summary.meetings)} icon={CalendarCheck} accent="good"
          sub={<span className="inline-flex items-center gap-1"><Flame className="h-3 w-3 text-hot" />{fmt(summary.hot)} hot accounts</span>} />
      </div>

      <Surface className="overflow-hidden">
        <div className="scroll-x">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-muted text-[11px] font-semibold uppercase tracking-wide">
                <SortHeader onClick={() => toggleSort("name")} active={sortKey === "name"} dir={sortDir}>Rep</SortHeader>
                <SortHeader onClick={() => toggleSort("quality")} active={sortKey === "quality"} dir={sortDir}>Quality</SortHeader>
                <SortHeader right onClick={() => toggleSort("touches")} active={sortKey === "touches"} dir={sortDir}>Touches</SortHeader>
                <SortHeader right onClick={() => toggleSort("contacts")} active={sortKey === "contacts"} dir={sortDir}>Contacts</SortHeader>
                <SortHeader right onClick={() => toggleSort("companies")} active={sortKey === "companies"} dir={sortDir}>Rooftops</SortHeader>
                <SortHeader onClick={() => toggleSort("coverage")} active={sortKey === "coverage"} dir={sortDir}>Coverage</SortHeader>
                <SortHeader onClick={() => toggleSort("connect")} active={sortKey === "connect"} dir={sortDir}>Connect</SortHeader>
                <SortHeader right onClick={() => toggleSort("reply")} active={sortKey === "reply"} dir={sortDir}>Reply</SortHeader>
                <SortHeader right onClick={() => toggleSort("meetings")} active={sortKey === "meetings"} dir={sortDir}>Mtgs</SortHeader>
                <SortHeader right onClick={() => toggleSort("hot")} active={sortKey === "hot"} dir={sortDir}>Hot</SortHeader>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <RepRow key={r.ownerId} row={r} onOpen={() => setDrawerRep(r.ownerId)} />)}
            </tbody>
          </table>
        </div>
      </Surface>

      <p className="mt-4 max-w-4xl text-xs leading-relaxed text-ink-subtle">
        Coverage = cumulative owned accounts (company owner = rep) the rep has ever tapped, rolled up to Group-Dealership / Single units.
        Temperature reflects buyer intent from call outcomes + engagement — open a rep to see the per-account reason.
        Quality = conversations · depth · persistence · channel · deliverability. Per-account detail (with HubSpot links) for {NARROW_PERIODS.map((p) => PERIOD_LABELS[p]).join(", ")}.
      </p>

      {drawerRep && (() => {
        const r = allRows.find((x) => x.ownerId === drawerRep);
        return r ? (
          <RepDrawer
            title={r.name}
            badge={<GradeBadge grade={r.m.quality.grade} score={r.m.quality.score} />}
            subtitle={PERIOD_LABELS[period]}
            onClose={closeDrawer}
          >
            <Scorecard key={drawerRep} data={r.data} m={r.m} period={period} name={r.name} ownerId={drawerRep} />
          </RepDrawer>
        ) : null;
      })()}
    </main>
  );
}

/* ------------------------------------------------------------------ Home controls */

function Segmented({ options, value, onChange, tone = "primary" }: {
  options: [string, string][]; value: string; onChange: (v: string) => void; tone?: "primary" | "good";
}) {
  const active = tone === "good" ? "bg-good text-white shadow-sm" : "bg-primary text-primary-fg shadow-sm";
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1 shadow-card">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className={cn("rounded-lg px-3 py-1.5 text-sm font-medium transition", value === v ? active : "text-ink-muted hover:bg-surface-muted hover:text-ink")}>
          {label}
        </button>
      ))}
    </div>
  );
}

function RepRow({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const m = row.m;
  const dim = row.touches === 0;
  return (
    <tr onClick={onOpen} className={cn("cursor-pointer border-b border-line/70 transition-colors last:border-0 hover:bg-primary-weak/50", dim && "opacity-45")}>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar name={row.name} />
          <span className="font-semibold text-ink">{row.name}</span>
        </div>
      </td>
      <td className="px-3 py-2.5"><GradeBadge grade={m.quality.grade} score={m.quality.score} /></td>
      <td className="px-3 py-2.5 text-right">
        <div className="font-mono font-bold tabular-nums text-ink">{fmt(row.touches)}</div>
        <div className="mt-0.5 text-[10px] tabular-nums text-ink-subtle">{fmt(m.calls.total)}d · {fmt(m.calls.connected)}c · {fmt(m.emails.sent)}e</div>
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="font-mono tabular-nums text-ink">{fmt(m.contacts.total)}</div>
        <div className="mt-0.5 inline-flex items-center gap-1.5 text-[10px] tabular-nums text-ink-subtle">
          <Phone className="h-2.5 w-2.5" />{fmt(m.contacts.via_call)}<Mail className="ml-0.5 h-2.5 w-2.5" />{fmt(m.contacts.via_email)}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">{fmt(m.companies.total)}</td>
      <td className="px-3 py-2.5">
        {row.data.book.units_total > 0
          ? <div className="flex items-center gap-2"><Bar value={row.data.book.pct} tone="primary" /><span className="font-mono text-xs tabular-nums text-ink-muted">{pct0(row.data.book.pct)}</span></div>
          : <span className="text-xs text-ink-subtle">—</span>}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2"><Bar value={m.calls.connect_rate} tone="good" /><span className="font-mono text-xs tabular-nums text-ink-muted">{pct0(m.calls.connect_rate)}</span></div>
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink-muted">{m.emails.sent > 0 ? pct0(m.emails.reply_rate) : "—"}</td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{m.meetings_booked > 0 ? <span className="font-bold text-good">{m.meetings_booked}</span> : <span className="text-ink-subtle">0</span>}</td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{m.temp.hot > 0 ? <span className="font-bold text-hot">{m.temp.hot}</span> : <span className="text-ink-subtle">0</span>}</td>
    </tr>
  );
}

/* ================================================================== Drawer body (Scorecard) */

function Scorecard({ data, m, period, name, ownerId }: { data: RepData; m: PeriodMetrics; period: PeriodKey; name: string; ownerId: string }) {
  const [acctFilter, setAcctFilter] = useState<AcctFilter>("all");
  const acctRef = useRef<HTMLDivElement>(null);
  const hasBreakdown = NARROW_PERIODS.includes(period);

  const focusAccounts = useCallback((f: AcctFilter) => {
    setAcctFilter(f);
    requestAnimationFrame(() => acctRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  return (
    <div className="space-y-5">
      <InsightChips insights={m.insights} hasBreakdown={hasBreakdown} onMeetings={() => focusAccounts("meetings")} onHot={() => focusAccounts("hot")} />
      <KpiStrip m={m} />
      <MonthlyCard monthly={data.monthly} />
      <GdExplorer ownerId={ownerId} book={data.book} />
      <div className="grid gap-5 lg:grid-cols-2">
        <CoverageCard book={data.book} />
        <TempCard m={m} clickable={hasBreakdown} onPick={focusAccounts} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <ReachCard m={m} />
        <QualityCard m={m} />
        <EmailCard m={m} />
      </div>
      <DailyChart daily={data.daily} name={name} />
      <DispositionCard m={m} />
      <div ref={acctRef}>
        <CompaniesCard m={m} period={period} book={data.book} filter={acctFilter} setFilter={setAcctFilter} />
      </div>
    </div>
  );
}

function InsightChips({ insights, hasBreakdown, onMeetings, onHot }: { insights: Insight[]; hasBreakdown: boolean; onMeetings: () => void; onHot: () => void }) {
  if (!insights?.length) return null;
  const tone = (l: Insight["level"]) => l === "good" ? "bg-good-weak text-good" : l === "warn" ? "bg-warn-weak text-warn" : "bg-surface-muted text-ink-muted";
  return (
    <div className="flex flex-wrap gap-2">
      {insights.map((i, idx) => {
        const isMeeting = /meeting/i.test(i.text);
        const isHot = /hot account/i.test(i.text);
        const clickable = hasBreakdown && (isMeeting || isHot);
        return (
          <button
            key={idx}
            onClick={clickable ? (isMeeting ? onMeetings : onHot) : undefined}
            disabled={!clickable}
            className={cn("inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition", tone(i.level), clickable && "cursor-pointer ring-1 ring-inset ring-current/20 hover:brightness-95")}
          >
            {i.text}{clickable && <ExternalLink className="h-3 w-3 opacity-60" />}
          </button>
        );
      })}
    </div>
  );
}

function KpiStrip({ m }: { m: PeriodMetrics }) {
  const items: { l: string; v: string; sub?: string }[] = [
    { l: "Calls", v: fmt(m.calls.total), sub: `${fmt(m.calls.connected)} connected` },
    { l: "Emails", v: fmt(m.emails.sent), sub: "sent" },
    { l: "Connect", v: pct(m.calls.connect_rate) },
    { l: "Open", v: m.emails.sent ? pct(m.emails.open_rate) : "—" },
    { l: "Reply", v: m.emails.sent ? pct(m.emails.reply_rate) : "—" },
    { l: "Meetings", v: fmt(m.meetings_booked) },
    { l: "DM reach", v: m.titled_contacts ? `${fmt(m.dm_contacts)}/${fmt(m.titled_contacts)}` : "—" },
    { l: "Contacts/acct", v: m.avg_contacts_per_company.toFixed(1) },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {items.map((it) => (
        <Surface key={it.l} className="px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">{it.l}</div>
          <div className="font-mono text-lg font-bold tabular-nums text-ink">{it.v}</div>
          {it.sub && <div className="text-[10px] tabular-nums text-ink-subtle">{it.sub}</div>}
        </Surface>
      ))}
    </div>
  );
}

function MonthlyCard({ monthly }: { monthly: MonthMetrics[] }) {
  const [sel, setSel] = useState(0);
  if (!monthly?.length) return null;
  const m = monthly[Math.min(sel, monthly.length - 1)];
  const cells: { l: string; v: string; sub?: string; accent?: boolean }[] = [
    { l: "Rooftops worked", v: fmt(m.rooftops_engaged), sub: `${fmt(m.rooftops_new)} new`, accent: true },
    { l: "Contacts engaged", v: fmt(m.contacts_engaged), sub: `${fmt(m.contacts_new)} new`, accent: true },
    { l: "GD / Single", v: `${fmt(m.gds_engaged)} / ${fmt(m.singles_engaged)}` },
    { l: "Activity", v: fmt(m.calls + m.emails), sub: `${fmt(m.connected)} conn` },
  ];
  return (
    <Surface className="p-4">
      <SectionTitle right={
        <div className="flex gap-1">
          {monthly.map((mm, i) => (
            <button key={mm.month} onClick={() => setSel(i)}
              className={cn("rounded-lg px-2 py-1 text-[11px] font-semibold transition", i === sel ? "bg-primary text-primary-fg" : "bg-surface-muted text-ink-muted hover:text-ink")}>
              {mm.label}
            </button>
          ))}
        </div>
      }>New vs existing accounts worked — {m.label}</SectionTitle>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.l} className="rounded-xl border border-line px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">{c.l}</div>
            <div className="font-mono text-xl font-bold tabular-nums text-ink">{c.v}</div>
            {c.sub && <div className={cn("text-[11px] font-medium tabular-nums", c.accent ? "text-good" : "text-ink-subtle")}>{c.sub}</div>}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-ink-subtle">Owned book · US/Eastern month. &ldquo;New&rdquo; = first-ever worked that month (no prior activity). Counts any tracked rep&rsquo;s work on the account.</p>
    </Surface>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={cn("inline-block h-2 w-2 rounded-sm", color)} />{label}</span>;
}

function Donut({ pct: p, label }: { pct: number; label: string }) {
  const deg = Math.round(p * 360);
  return (
    <div className="relative h-20 w-20 shrink-0">
      <div className="h-20 w-20 rounded-full" style={{ background: `conic-gradient(var(--primary) ${deg}deg, var(--surface-muted) 0)` }} />
      <div className="absolute inset-[7px] flex items-center justify-center rounded-full bg-surface"><span className="font-mono text-sm font-bold tabular-nums text-ink">{label}</span></div>
    </div>
  );
}

/* Coverage as tables (lifecycle + market segment). Group-vs-single / franchise section removed. */
function CoverageTable({ title, rows }: { title: string; rows: { label: string; dim: CoverageDim; chip?: string }[] }) {
  const shown = rows.filter((r) => r.dim.total > 0);
  if (shown.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">{title}</div>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="grid grid-cols-[1.4fr_0.7fr_0.9fr] gap-2 border-b border-line bg-surface-muted px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-ink-subtle">
          <span>Segment</span><span className="text-right">Accounts</span><span className="text-right">Tapped</span>
        </div>
        {shown.map(({ label, dim, chip }) => {
          const p = dim.tapped / dim.total;
          return (
            <div key={label} className="grid grid-cols-[1.4fr_0.7fr_0.9fr] items-center gap-2 border-b border-line/60 px-2.5 py-1.5 text-xs last:border-0">
              <span className="min-w-0 truncate">{chip ? <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", chip)}>{label}</span> : <span className="text-ink-muted">{label}</span>}</span>
              <span className="text-right font-mono tabular-nums text-ink-muted">{fmt(dim.total)}</span>
              <span className="flex items-center justify-end gap-2">
                <Bar value={p} tone={p >= 0.5 ? "good" : "warm"} width="w-8" />
                <span className="font-mono tabular-nums text-ink">{fmt(dim.tapped)} · {pct0(p)}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CoverageCard({ book }: { book: BookCoverage }) {
  return (
    <Surface className="p-4">
      <SectionTitle right={book.units_total > 0 ? <span className="text-[11px] tabular-nums text-ink-subtle">{fmt(book.gds)} GDs · {fmt(book.singles)} singles · {fmt(book.rooftops_total)} rooftops</span> : undefined}>
        Owned-book coverage (cumulative · GD level)
      </SectionTitle>
      {book.units_total === 0 ? <p className="mt-3 text-sm text-ink-subtle">No owned accounts for this rep.</p> : (
        <div className="mt-3 space-y-4">
          <div className="flex items-center gap-4">
            <Donut pct={book.pct} label={pct0(book.pct)} />
            <div className="text-sm text-ink-muted"><span className="font-mono text-xl font-bold text-ink">{fmt(book.units_tapped)}</span> of {fmt(book.units_total)} owned units tapped</div>
          </div>
          <CoverageTable title="By lifecycle stage" rows={STAGE_GROUPS.map((g) => ({ label: g, dim: book.by_stage[g], chip: STAGE_CHIP[g] }))} />
          <CoverageTable title="By market segment" rows={MARKET_SEGMENTS.map((s) => ({ label: MARKET_SEGMENT_LABELS[s], dim: book.by_segment[s] }))} />
        </div>
      )}
    </Surface>
  );
}

function TempCard({ m, clickable, onPick }: { m: PeriodMetrics; clickable: boolean; onPick: (f: AcctFilter) => void }) {
  const t = m.temp;
  const total = Math.max(1, t.hot + t.warm + t.cold);
  return (
    <Surface className="p-4">
      <SectionTitle>Account temperature (tapped)</SectionTitle>
      <div className="mb-3 mt-3 grid grid-cols-3 gap-2">
        {(["hot", "warm", "cold"] as const).map((k) => {
          const meta = TEMP_META[k];
          const Icon = meta.icon;
          return (
            <button
              key={k}
              onClick={clickable ? () => onPick(k) : undefined}
              disabled={!clickable}
              className={cn(
                "rounded-xl border border-line px-3 py-2.5 text-center transition",
                clickable ? "cursor-pointer hover:border-line-strong hover:bg-surface-muted" : "cursor-default",
              )}
            >
              <div className={cn("font-mono text-2xl font-bold tabular-nums", TEMP_TEXT[k])}>{fmt(t[k])}</div>
              <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold uppercase text-ink-muted"><Icon className={cn("h-3 w-3", TEMP_TEXT[k])} />{meta.label}</div>
            </button>
          );
        })}
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full">
        <div className="bg-hot" style={{ width: `${(t.hot / total) * 100}%` }} />
        <div className="bg-warm" style={{ width: `${(t.warm / total) * 100}%` }} />
        <div className="bg-cold" style={{ width: `${(t.cold / total) * 100}%` }} />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
        🔴 Hot = meeting / high-intent callback / reply · 🟡 Warm = referral / connect / open · 🔵 Cold = no connect / disqualified.
        {clickable ? " Click a tile to see the accounts." : " Per-account detail for Today / Yesterday / This week."}
      </p>
    </Surface>
  );
}

function ReachStack({ r }: { r: ReachByChannel }) {
  const total = Math.max(1, r.total);
  return (
    <div className="mb-1 flex h-2.5 overflow-hidden rounded-full">
      <div className="bg-primary" style={{ width: `${(r.call_only / total) * 100}%` }} title={`Call only: ${r.call_only}`} />
      <div className="bg-good" style={{ width: `${(r.both / total) * 100}%` }} title={`Both: ${r.both}`} />
      <div className="bg-cold" style={{ width: `${(r.email_only / total) * 100}%` }} title={`Email only: ${r.email_only}`} />
    </div>
  );
}

function ReachCard({ m }: { m: PeriodMetrics }) {
  return (
    <Surface className="p-4">
      <SectionTitle>Unique reach by activity</SectionTitle>
      <div className="mt-3">
        {(["contacts", "companies"] as const).map((k) => {
          const r = m[k];
          return (
            <div key={k} className="mb-4 last:mb-0">
              <div className="mb-1 flex items-baseline justify-between"><span className="text-sm capitalize text-ink-muted">{k === "companies" ? "rooftops" : k}</span><span className="font-mono text-lg font-bold tabular-nums text-ink">{fmt(r.total)}</span></div>
              <ReachStack r={r} />
              <div className="flex gap-3 text-[11px] text-ink-subtle"><Legend color="bg-primary" label={`call ${fmt(r.via_call)}`} /><Legend color="bg-good" label={`both ${fmt(r.both)}`} /><Legend color="bg-cold" label={`email ${fmt(r.via_email)}`} /></div>
            </div>
          );
        })}
      </div>
    </Surface>
  );
}

function QualityCard({ m }: { m: PeriodMetrics }) {
  const subs = [["Conversations", m.quality.sub.conversations], ["Account depth", m.quality.sub.depth], ["Persistence", m.quality.sub.persistence], ["Channel mix", m.quality.sub.channel], ["Deliverability", m.quality.sub.deliverability]] as const;
  return (
    <Surface className="p-4">
      <SectionTitle right={<GradeBadge grade={m.quality.grade} score={m.quality.score} big />}>Quality breakdown</SectionTitle>
      <ul className="mt-3 space-y-2">
        {subs.map(([l, v]) => <li key={l} className="text-xs"><div className="flex justify-between text-ink-muted"><span>{l}</span><span className="font-mono tabular-nums">{v}</span></div><div className="mt-1"><Bar value={v / 100} tone="primary" width="w-full" /></div></li>)}
      </ul>
    </Surface>
  );
}

function EmailCard({ m }: { m: PeriodMetrics }) {
  const e = m.emails;
  const rows = [["Open rate", e.open_rate, e.opened, "cold" as const], ["Reply rate", e.reply_rate, e.replied, "good" as const], ["Click rate", e.click_rate, e.clicked, "primary" as const]] as const;
  return (
    <Surface className="p-4">
      <SectionTitle>Email engagement</SectionTitle>
      <div className="mb-3 mt-1 text-xs text-ink-subtle">{fmt(e.sent)} sent · {fmt(e.bounced)} bounced ({pct(e.bounce_rate)})</div>
      {e.sent === 0 ? <p className="text-sm text-ink-subtle">No emails this period.</p> : (
        <ul className="space-y-2">
          {rows.map(([l, rate, n, tone]) => <li key={l} className="text-xs"><div className="flex justify-between text-ink-muted"><span>{l}</span><span className="font-mono tabular-nums">{pct(rate)} <span className="text-ink-subtle">({fmt(n)})</span></span></div><div className="mt-1"><Bar value={rate} tone={tone} width="w-full" /></div></li>)}
        </ul>
      )}
    </Surface>
  );
}

function DailyChart({ daily, name }: { daily: DailyPoint[]; name: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!daily?.length) return null;
  const max = Math.max(1, ...daily.map((d) => d.calls + d.emails));
  const H = 132;
  const tickEvery = Math.max(1, Math.ceil(daily.length / 8));

  return (
    <Surface className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle>Daily activity — {name} (this month)</SectionTitle>
        <div className="flex items-center gap-3 text-[11px] text-ink-subtle">
          <Legend color="bg-good" label="Connected" /><Legend color="bg-primary" label="Other calls" /><Legend color="bg-cold" label="Emails" />
        </div>
      </div>

      <div className="relative mt-4" style={{ height: H }}>
        {/* y gridlines */}
        {[0, 0.5, 1].map((g) => (
          <div key={g} className="absolute left-0 right-0 border-t border-dashed border-line" style={{ bottom: g * H }}>
            <span className="absolute -top-2 left-0 font-mono text-[9px] tabular-nums text-ink-subtle">{Math.round(max * g)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px] pl-6">
          {daily.map((d, i) => {
            const others = Math.max(0, d.calls - d.connected);
            const seg = (v: number) => Math.round((v / max) * H);
            return (
              <div
                key={d.date}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                className={cn("group relative flex flex-1 flex-col justify-end transition-opacity", hover !== null && hover !== i && "opacity-40")}
                style={{ minWidth: 3 }}
              >
                <div className="bg-cold" style={{ height: seg(d.emails) }} />
                <div className="bg-primary" style={{ height: seg(others) }} />
                <div className="rounded-t-sm bg-good" style={{ height: seg(d.connected) }} />
              </div>
            );
          })}
        </div>
        {/* tooltip */}
        {hover !== null && (() => {
          const d = daily[hover];
          const leftPct = ((hover + 0.5) / daily.length) * 100;
          return (
            <div className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] shadow-pop" style={{ left: `calc(1.5rem + ${leftPct}% )` }}>
              <div className="font-semibold text-ink">{d.date}</div>
              <div className="mt-0.5 tabular-nums text-ink-muted"><span className="text-good">●</span> {fmt(d.connected)} connected · {fmt(Math.max(0, d.calls - d.connected))} other · <span className="text-cold">●</span> {fmt(d.emails)} email</div>
            </div>
          );
        })()}
      </div>

      <div className="mt-1 flex gap-[2px] pl-6 text-[9px] text-ink-subtle">
        {daily.map((d, i) => <span key={d.date} className="flex-1 text-center tabular-nums" style={{ minWidth: 3 }}>{i % tickEvery === 0 ? d.date.slice(5) : ""}</span>)}
      </div>
    </Surface>
  );
}

function DispositionCard({ m }: { m: PeriodMetrics }) {
  const entries = Object.entries(m.calls.by_disposition);
  const max = Math.max(1, ...entries.map(([, c]) => c));
  return (
    <Surface className="p-4">
      <SectionTitle right={<span className="text-[11px] tabular-nums text-ink-subtle">{fmt(m.calls.connected)} connected · {fmt(m.calls.not_connected)} not · {pct(m.calls.connect_rate)}</span>}>Calls by outcome</SectionTitle>
      {entries.length === 0 ? <p className="mt-3 text-sm text-ink-subtle">No calls this period.</p> : (
        <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {entries.map(([label, count]) => (
            <li key={label} className="text-xs">
              <div className="flex items-center justify-between"><span className="truncate pr-2 text-ink-muted">{label}</span><span className="font-mono tabular-nums text-ink-subtle">{fmt(count)}</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-muted"><div className={CONNECTED_LABELS.has(label) ? "h-full bg-good" : "h-full bg-ink-subtle/50"} style={{ width: `${(count / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

/** Map an enriched period breakdown row to the shared RooftopNode shape. */
function toNode(c: CompanyBreakdownRow): RooftopNode {
  return {
    id: c.id, name: c.name, calls: c.calls, emails: c.emails, connected: c.connected,
    temp: c.temp, temp_reason: c.temp_reason, last_ms: c.last_ms, contacts: c.contacts_list ?? [],
    tapped: true, stage: c.stage, disqualified: c.disqualified,
  };
}

const ACCT_FILTERS: { key: AcctFilter; label: string }[] = [
  { key: "all", label: "All" }, { key: "hot", label: "Hot" }, { key: "warm", label: "Warm" },
  { key: "cold", label: "Cold" }, { key: "meetings", label: "Meetings" }, { key: "disqualified", label: "Disqualified" },
];

function CompaniesCard({ m, period, book, filter, setFilter }: {
  m: PeriodMetrics; period: PeriodKey; book: BookCoverage; filter: AcctFilter; setFilter: (f: AcctFilter) => void;
}) {
  const [showUntapped, setShowUntapped] = useState(false);
  const hasBreakdown = NARROW_PERIODS.includes(period);
  const breakdown = m.company_breakdown ?? [];
  const untapped = book.untapped_sample ?? [];
  const untappedCount = Math.max(0, book.units_total - book.units_tapped);

  const filtered = useMemo(() => {
    const rows = (m.company_breakdown ?? []).filter((c) => {
      if (filter === "meetings") return c.meetings > 0;
      if (filter === "disqualified") return c.disqualified;
      if (filter === "all") return true;
      return c.temp === filter;
    });
    return rows.map(toNode);
  }, [m.company_breakdown, filter]);

  return (
    <Surface className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle>Accounts {showUntapped ? "untapped (cumulative)" : `tapped this period${hasBreakdown ? ` (${breakdown.length})` : ""}`}</SectionTitle>
        {untappedCount > 0 && (
          <button onClick={() => setShowUntapped((s) => !s)} className="inline-flex items-center gap-1 rounded-lg bg-warn-weak px-2 py-0.5 text-xs font-semibold text-warn transition hover:brightness-95">
            <AlertTriangle className="h-3 w-3" />{showUntapped ? "Show tapped" : `Untapped ${fmt(untappedCount)}`}
          </button>
        )}
      </div>

      {showUntapped ? (
        untapped.length === 0 ? <p className="mt-3 text-sm text-ink-subtle">Every owned account has been tapped. 🎉</p> : (
          <div className="mt-3 max-h-72 space-y-0.5 overflow-y-auto scroll-y pr-1">
            {untapped.map((c) => (
              <a key={c.id} href={companyUrl(c.id)} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-ink-muted transition hover:bg-surface-muted">
                <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{c.name}</span>{c.stage && <span className={cn("shrink-0 rounded px-1 text-[9px]", STAGE_CHIP[c.stage as StageGroup] ?? "")}>{c.stage}</span>}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-primary" />
              </a>
            ))}
            {untappedCount > untapped.length && <p className="px-2 py-1 text-xs text-ink-subtle">+ {fmt(untappedCount - untapped.length)} more untapped</p>}
          </div>
        )
      ) : !hasBreakdown ? <p className="mt-3 text-sm text-ink-subtle">Per-account detail for Today / Yesterday / This week.</p>
      : (
        <>
          <div className="mb-3 mt-3 flex flex-wrap gap-1">
            {ACCT_FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold transition", filter === f.key ? "bg-ink text-white" : "bg-surface-muted text-ink-muted hover:text-ink")}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="max-h-96 overflow-y-auto scroll-y">
            <RooftopsTable rows={filtered} />
          </div>
        </>
      )}
    </Surface>
  );
}
