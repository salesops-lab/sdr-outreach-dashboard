"use client";

import { useCallback, useMemo, useState } from "react";
import {
  PERIOD_KEYS, PERIOD_LABELS, NARROW_PERIODS, STAGE_GROUPS, MARKET_SEGMENTS, MARKET_SEGMENT_LABELS,
  PeriodKey, PeriodMetrics, RepData, Snapshot, DailyPoint, ReachByChannel, Insight, StageGroup,
  BookCoverage, CoverageDim,
} from "../lib/sync/types";
import { CONNECTED_DISPOSITIONS } from "../config/dispositions";
import { companyUrl, contactUrl } from "../config/hubspot";
import { CoachingSnapshot } from "../lib/callquality/types";
import RepDrawer from "./RepDrawer";
import GdExplorer from "./GdExplorer";
import CallQualityCard from "./CallQualityCard";
import LogoutButton from "./LogoutButton";
import { STAGE_CHIP, TEMP_CHIP, TEMP_ICON } from "./ui-tokens";

const CONNECTED_LABELS = new Set(Object.values(CONNECTED_DISPOSITIONS));

type SortKey = "name" | "quality" | "callq" | "touches" | "contacts" | "companies" | "coverage" | "connect" | "reply" | "meetings" | "hot";

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

const GRADE_GRAD: Record<string, string> = {
  A: "from-emerald-400 to-teal-500 text-white",
  B: "from-sky-400 to-blue-500 text-white",
  C: "from-amber-400 to-yellow-500 text-white",
  D: "from-orange-400 to-orange-600 text-white",
  F: "from-rose-400 to-red-500 text-white",
  "—": "from-slate-200 to-slate-200 text-slate-400",
};

export default function Dashboard({ snapshot, coaching }: { snapshot: Snapshot; coaching: Record<string, CoachingSnapshot> }) {
  const [period, setPeriod] = useState<PeriodKey>("this_week");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("touches");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [drawerRep, setDrawerRep] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setDrawerRep(null), []);

  const allRows = useMemo<Row[]>(() =>
    Object.entries(snapshot.reps).map(([ownerId, data]) => {
      const m = data.periods[period];
      return { ownerId, name: snapshot.owner_names[ownerId] ?? `ID:${ownerId}`, data, m, touches: m.calls.total + m.emails.sent };
    }), [snapshot, period]);

  const rows = useMemo<Row[]>(() => {
    const filtered = repFilter === "all" ? allRows : allRows.filter((r) => r.ownerId === repFilter);
    const val = (r: Row): number | string => ({
      name: r.name.toLowerCase(), quality: r.m.quality.score, callq: coaching[r.ownerId]?.avgBantic ?? -1, touches: r.touches,
      contacts: r.m.contacts.total, companies: r.m.companies.total, coverage: r.data.book.pct,
      connect: r.m.calls.connect_rate, reply: r.m.emails.reply_rate, meetings: r.m.meetings_booked, hot: r.m.temp.hot,
    }[sortKey]);
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [allRows, repFilter, sortKey, sortDir, coaching]);

  const summary = useMemo(() => {
    const a = { touches: 0, contacts: 0, companies: 0, calls: 0, connected: 0, denom: 0, meetings: 0, unitsTapped: 0, unitsTotal: 0, hot: 0, active: 0 };
    for (const r of rows) {
      a.touches += r.touches; a.contacts += r.m.contacts.total; a.companies += r.m.companies.total;
      a.calls += r.m.calls.total; a.connected += r.m.calls.connected; a.denom += r.m.calls.connected + r.m.calls.not_connected;
      a.meetings += r.m.meetings_booked; a.unitsTapped += r.data.book.units_tapped; a.unitsTotal += r.data.book.units_total; a.hot += r.m.temp.hot;
      if (r.touches > 0) a.active++;
    }
    return { ...a, connectRate: a.denom ? a.connected / a.denom : 0, coverage: a.unitsTotal ? a.unitsTapped / a.unitsTotal : 0 };
  }, [rows]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  }

  function exportCsv() {
    const head = ["Rep","Quality","Grade","CallQ","Touches","Calls","Emails","OpenRate","ReplyRate","UniqContacts","DMcontacts","UniqCompanies","BookUnits","GDs","Singles","UnitsTapped","Coverage","ConnectRate","Meetings","Hot","Warm","Cold"];
    const lines = rows.map((r) => { const m = r.m; const b = r.data.book; return [`"${r.name.replace(/"/g,'""')}"`, m.quality.score, m.quality.grade, coaching[r.ownerId]?.avgBantic ?? "", r.touches, m.calls.total, m.emails.sent, m.emails.open_rate, m.emails.reply_rate, m.contacts.total, m.dm_contacts, m.companies.total, b.units_total, b.gds, b.singles, b.units_tapped, b.pct, m.calls.connect_rate, m.meetings_booked, m.temp.hot, m.temp.warm, m.temp.cold].join(","); });
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `sdr-outreach-${period}-${snapshot.today_et || "snap"}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  const hasData = !!snapshot.generated_at_utc;

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 bg-clip-text text-2xl font-black tracking-tight text-transparent sm:text-3xl">
            SDR Outreach Coverage
          </h1>
          <p className="mt-1 hidden text-sm text-slate-500 sm:block">Quantity × quality of outbound, per rep · reach by activity · cumulative owned-book coverage (GD level) · US/Eastern · week starts Mon</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right text-xs text-slate-500">
          <LogoutButton />
          <div>Refreshed <span className="font-semibold text-blue-600">{etStamp(snapshot.generated_at_utc)}</span></div>
          <div>{snapshot.window.start_et || "—"} → {snapshot.window.end_et || "—"} · {fmt(snapshot.totals.calls)} calls + {fmt(snapshot.totals.emails)} emails</div>
        </div>
      </header>

      {!hasData && <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No snapshot yet. Run <code className="rounded bg-slate-100 px-1.5 py-0.5 text-blue-600">npm run sync</code>.</div>}
      {hasData && snapshot.sources && !snapshot.sources.emails && (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">⚠️ Emails excluded — token lacks <code className="rounded bg-amber-100 px-1.5 py-0.5">connected-email-data-access</code>.</div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
          {PERIOD_KEYS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`rounded-xl px-3 py-1.5 text-sm transition ${period === p ? "bg-gradient-to-r from-blue-600 to-indigo-600 font-semibold text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}>
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm">
          <option value="all">All reps ({allRows.length})</option>
          {[...allRows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => <option key={r.ownerId} value={r.ownerId}>{r.name}</option>)}
        </select>
        <button onClick={exportCsv} className="ml-auto rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm hover:bg-slate-100">↓ CSV</button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="Touches" value={fmt(summary.touches)} hint={`${fmt(summary.calls)}☎ ${fmt(summary.touches - summary.calls)}✉`} grad="from-slate-700 to-slate-900" />
        <Card label="Unique contacts" value={fmt(summary.contacts)} hint="summed per rep" grad="from-blue-500 to-indigo-600" />
        <Card label="Unique companies" value={fmt(summary.companies)} hint="summed per rep" grad="from-indigo-500 to-violet-600" />
        <Card label="Book coverage" value={summary.unitsTotal ? pct0(summary.coverage) : "—"} hint={summary.unitsTotal ? `${fmt(summary.unitsTapped)}/${fmt(summary.unitsTotal)} accts` : "—"} grad="from-violet-500 to-fuchsia-600" />
        <Card label="Connect rate" value={pct(summary.connectRate)} grad="from-emerald-500 to-teal-600" />
        <Card label="Meetings 🎯" value={fmt(summary.meetings)} hint={`${fmt(summary.hot)} hot 🔥`} grad="from-rose-500 to-orange-500" />
      </div>

      <div className="scroll-x rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[1160px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Th onClick={() => toggleSort("name")} a={sortKey === "name"} d={sortDir}>Rep</Th>
              <Th onClick={() => toggleSort("quality")} a={sortKey === "quality"} d={sortDir}>Quality</Th>
              <Th onClick={() => toggleSort("callq")} a={sortKey === "callq"} d={sortDir}>Call Q</Th>
              <Th right onClick={() => toggleSort("touches")} a={sortKey === "touches"} d={sortDir}>Touches</Th>
              <Th right onClick={() => toggleSort("contacts")} a={sortKey === "contacts"} d={sortDir}>Contacts</Th>
              <Th right onClick={() => toggleSort("companies")} a={sortKey === "companies"} d={sortDir}>Cos</Th>
              <Th onClick={() => toggleSort("coverage")} a={sortKey === "coverage"} d={sortDir}>Coverage</Th>
              <Th onClick={() => toggleSort("connect")} a={sortKey === "connect"} d={sortDir}>Connect</Th>
              <Th onClick={() => toggleSort("reply")} a={sortKey === "reply"} d={sortDir}>Reply</Th>
              <Th right onClick={() => toggleSort("meetings")} a={sortKey === "meetings"} d={sortDir}>🎯</Th>
              <Th right onClick={() => toggleSort("hot")} a={sortKey === "hot"} d={sortDir}>🔥</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <RepRow key={r.ownerId} row={r} coach={coaching[r.ownerId]} onOpen={() => setDrawerRep(r.ownerId)} />)}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Coverage = cumulative owned accounts (company owner = rep) the rep has ever tapped, rolled up to Group Dealership / Single units. Temperature: 🔥 meeting/high-intent/replied · 🌤 connected/opened · 🧊 no engagement.
        Quality = conversations · depth · persistence · channel · deliverability. Decision-maker reach via job title/seniority. Per-account detail (HubSpot links) for {NARROW_PERIODS.map((p) => PERIOD_LABELS[p]).join(", ")}.
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
            <Scorecard key={drawerRep} data={r.data} m={r.m} period={period} name={r.name} coach={coaching[drawerRep]} ownerId={drawerRep} />
          </RepDrawer>
        ) : null;
      })()}
    </main>
  );
}

function Card({ label, value, hint, grad }: { label: string; value: string; hint?: string; grad: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className={`bg-gradient-to-br ${grad} px-4 py-3`}>
        <div className="text-[11px] font-medium uppercase tracking-wide text-white/80">{label}</div>
        <div className="mt-0.5 text-2xl font-black tabular-nums text-white">{value}</div>
      </div>
      {hint && <div className="px-4 py-1 text-[10px] uppercase tracking-wide text-slate-400">{hint}</div>}
    </div>
  );
}

function Th({ children, onClick, a, d, right }: { children: React.ReactNode; onClick: () => void; a: boolean; d: "asc" | "desc"; right?: boolean }) {
  return (
    <th className={`px-3 py-2.5 ${right ? "text-right" : ""}`}>
      <button onClick={onClick} className={`inline-flex items-center gap-1 hover:text-slate-900 ${a ? "text-slate-900" : ""}`}>{children}<span className="text-[9px]">{a ? (d === "asc" ? "▲" : "▼") : "↕"}</span></button>
    </th>
  );
}

function GradeBadge({ grade, score, big }: { grade: string; score: number; big?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-xl bg-gradient-to-br font-bold ${GRADE_GRAD[grade] ?? GRADE_GRAD["—"]} ${big ? "px-3 py-1.5 text-lg" : "px-2 py-0.5 text-xs"}`}>
      {grade}{grade !== "—" && <span className="font-medium opacity-80">{score}</span>}
    </span>
  );
}

function MiniBar({ x, color }: { x: number; color: string }) {
  return <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200"><div className={`h-full ${color}`} style={{ width: pct0(x) }} /></div>;
}

function RepRow({ row, coach, onOpen }: { row: Row; coach?: CoachingSnapshot; onOpen: () => void }) {
  const m = row.m;
  const dim = row.touches === 0;
  return (
    <tr onClick={onOpen} className={`cursor-pointer border-b border-slate-100 transition hover:bg-blue-50/50 ${dim ? "opacity-50" : ""}`}>
      <td className="px-3 py-2.5 font-semibold text-slate-800">{row.name}</td>
      <td className="px-3 py-2.5"><GradeBadge grade={m.quality.grade} score={m.quality.score} /></td>
      <td className="px-3 py-2.5">
        {coach?.avgBantic != null
          ? <span className="rounded-lg bg-indigo-50 px-2 py-0.5 text-xs font-bold tabular-nums text-indigo-700 ring-1 ring-indigo-200">{coach.avgBantic.toFixed(1)}<span className="font-medium opacity-60">/10</span></span>
          : <span className="text-xs text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-right font-bold tabular-nums text-slate-900">{fmt(row.touches)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.contacts.total)}<span className="ml-1 text-[10px] text-slate-400">☎{fmt(m.contacts.via_call)}/✉{fmt(m.contacts.via_email)}</span></td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.companies.total)}</td>
      <td className="px-3 py-2.5">{row.data.book.units_total > 0 ? <div className="flex items-center gap-2"><MiniBar x={row.data.book.pct} color="bg-gradient-to-r from-violet-500 to-fuchsia-500" /><span className="tabular-nums text-xs text-slate-500">{pct0(row.data.book.pct)}</span></div> : <span className="text-xs text-slate-300">—</span>}</td>
      <td className="px-3 py-2.5"><div className="flex items-center gap-2"><MiniBar x={m.calls.connect_rate} color="bg-emerald-500" /><span className="tabular-nums text-xs text-slate-500">{pct0(m.calls.connect_rate)}</span></div></td>
      <td className="px-3 py-2.5 tabular-nums text-xs text-slate-500">{m.emails.sent > 0 ? pct0(m.emails.reply_rate) : "—"}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{m.meetings_booked > 0 ? <span className="font-bold text-emerald-600">{m.meetings_booked}</span> : <span className="text-slate-300">0</span>}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{m.temp.hot > 0 ? <span className="font-bold text-rose-600">{m.temp.hot}</span> : <span className="text-slate-300">0</span>}</td>
    </tr>
  );
}

function Scorecard({ data, m, period, name, coach, ownerId }: { data: RepData; m: PeriodMetrics; period: PeriodKey; name: string; coach?: CoachingSnapshot; ownerId: string }) {
  return (
    <div className="space-y-5">
      <InsightChips insights={m.insights} />
      <KpiStrip m={m} />
      <GdExplorer ownerId={ownerId} book={data.book} />
      <div className="grid gap-5 lg:grid-cols-2">
        <CoverageCard book={data.book} />
        <TempCard m={m} />
      </div>
      <CallQualityCard coach={coach} ownerId={ownerId} />
      <div className="grid gap-5 lg:grid-cols-3">
        <ReachCard m={m} />
        <QualityCard m={m} />
        <EmailCard m={m} />
      </div>
      <DailyChart daily={data.daily} name={name} />
      <div className="grid gap-5 lg:grid-cols-2">
        <DispositionCard m={m} />
        <CompaniesCard m={m} period={period} book={data.book} />
      </div>
    </div>
  );
}

function InsightChips({ insights }: { insights: Insight[] }) {
  if (!insights?.length) return null;
  const tone = (l: Insight["level"]) => l === "good" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : l === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-slate-50 text-slate-600 ring-slate-200";
  return <div className="flex flex-wrap gap-2">{insights.map((i, idx) => <span key={idx} className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tone(i.level)}`}>{i.text}</span>)}</div>;
}

function KpiStrip({ m }: { m: PeriodMetrics }) {
  const items = [
    { l: "Calls", v: fmt(m.calls.total) }, { l: "Emails", v: fmt(m.emails.sent) },
    { l: "Connect", v: pct(m.calls.connect_rate) }, { l: "Open", v: m.emails.sent ? pct(m.emails.open_rate) : "—" },
    { l: "Reply", v: m.emails.sent ? pct(m.emails.reply_rate) : "—" }, { l: "Meetings", v: fmt(m.meetings_booked) },
    { l: "DM reach", v: m.titled_contacts ? `${fmt(m.dm_contacts)}/${fmt(m.titled_contacts)}` : "—" }, { l: "Contacts/acct", v: m.avg_contacts_per_company.toFixed(1) },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {items.map((it) => <div key={it.l} className="rounded-xl border border-slate-200 bg-white px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-slate-400">{it.l}</div><div className="text-lg font-bold tabular-nums text-slate-800">{it.v}</div></div>)}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-2 rounded-sm ${color}`} />{label}</span>;
}

function Donut({ pct: p, label }: { pct: number; label: string }) {
  const deg = Math.round(p * 360);
  return (
    <div className="relative h-20 w-20 shrink-0">
      <div className="h-20 w-20 rounded-full" style={{ background: `conic-gradient(#8b5cf6 ${deg}deg, #e2e8f0 0)` }} />
      <div className="absolute inset-[6px] flex items-center justify-center rounded-full bg-white"><span className="text-sm font-bold tabular-nums text-slate-800">{label}</span></div>
    </div>
  );
}

function CoverageBar({ label, dim, chip }: { label: string; dim: CoverageDim; chip?: string }) {
  if (dim.total === 0) return null;
  const p = dim.tapped / dim.total;
  return (
    <div className="text-xs">
      <div className="flex justify-between">
        <span className={chip ? `rounded px-1.5 py-0.5 ${chip}` : "text-slate-600"}>{label}</span>
        <span className="tabular-nums text-slate-500">{fmt(dim.tapped)}/{fmt(dim.total)} · {pct0(p)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500" style={{ width: pct0(p) }} /></div>
    </div>
  );
}

function CoverageCard({ book }: { book: BookCoverage }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-1">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Owned-book coverage (cumulative · GD level)</h3>
        {book.units_total > 0 && <span className="text-[11px] text-slate-400">{fmt(book.gds)} GDs · {fmt(book.singles)} singles · {fmt(book.rooftops_total)} rooftops</span>}
      </div>
      {book.units_total === 0 ? <p className="text-sm text-slate-400">No owned accounts for this rep.</p> : (
        <div className="flex items-start gap-4">
          <div className="flex flex-col items-center gap-1"><Donut pct={book.pct} label={pct0(book.pct)} /><div className="text-[11px] text-slate-500">{fmt(book.units_tapped)}/{fmt(book.units_total)} tapped</div></div>
          <div className="flex-1 space-y-3">
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">By lifecycle stage</div>
              <div className="space-y-2">{STAGE_GROUPS.map((g) => <CoverageBar key={g} label={g} dim={book.by_stage[g]} chip={STAGE_CHIP[g]} />)}</div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Group vs single · franchise vs independent</div>
              <div className="space-y-2">
                <CoverageBar label="Group dealerships" dim={book.by_group_kind.group} />
                <CoverageBar label="Singles" dim={book.by_group_kind.single} />
                <CoverageBar label="Franchise" dim={book.by_dealership.Franchise} />
                <CoverageBar label="Independent" dim={book.by_dealership.Independent} />
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">By market segment</div>
              <div className="space-y-2">{MARKET_SEGMENTS.map((s) => <CoverageBar key={s} label={MARKET_SEGMENT_LABELS[s]} dim={book.by_segment[s]} />)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TempCard({ m }: { m: PeriodMetrics }) {
  const t = m.temp;
  const total = Math.max(1, t.hot + t.warm + t.cold);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Account temperature (tapped)</h3>
      <div className="mb-3 flex gap-3">
        {(["hot","warm","cold"] as const).map((k) => (
          <div key={k} className={`flex-1 rounded-xl px-3 py-2 text-center ${TEMP_CHIP[k]}`}>
            <div className="text-2xl font-black tabular-nums">{fmt(t[k])}</div>
            <div className="text-[11px] font-medium uppercase opacity-90">{TEMP_ICON[k]} {k}</div>
          </div>
        ))}
      </div>
      <div className="flex h-3 overflow-hidden rounded-full">
        <div className="bg-gradient-to-br from-rose-500 to-orange-500" style={{ width: `${(t.hot / total) * 100}%` }} />
        <div className="bg-amber-400" style={{ width: `${(t.warm / total) * 100}%` }} />
        <div className="bg-sky-400" style={{ width: `${(t.cold / total) * 100}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-slate-400">🔥 meeting/high-intent/replied · 🌤 connected/opened · 🧊 attempts, no engagement. Reasons per account below.</p>
    </div>
  );
}

function ReachStack({ r }: { r: ReachByChannel }) {
  const total = Math.max(1, r.total);
  return (
    <div className="mb-1 flex h-3 overflow-hidden rounded-full">
      <div className="bg-blue-500" style={{ width: `${(r.call_only / total) * 100}%` }} title={`Call only: ${r.call_only}`} />
      <div className="bg-emerald-500" style={{ width: `${(r.both / total) * 100}%` }} title={`Both: ${r.both}`} />
      <div className="bg-indigo-400" style={{ width: `${(r.email_only / total) * 100}%` }} title={`Email only: ${r.email_only}`} />
    </div>
  );
}

function ReachCard({ m }: { m: PeriodMetrics }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Unique reach by activity</h3>
      {(["contacts","companies"] as const).map((k) => {
        const r = m[k];
        return (
          <div key={k} className="mb-4 last:mb-0">
            <div className="mb-1 flex items-baseline justify-between"><span className="text-sm capitalize text-slate-600">{k}</span><span className="text-lg font-bold tabular-nums text-slate-800">{fmt(r.total)}</span></div>
            <ReachStack r={r} />
            <div className="flex gap-3 text-[11px] text-slate-500"><Legend color="bg-blue-500" label={`☎ ${fmt(r.via_call)}`} /><Legend color="bg-emerald-500" label={`both ${fmt(r.both)}`} /><Legend color="bg-indigo-400" label={`✉ ${fmt(r.via_email)}`} /></div>
          </div>
        );
      })}
    </div>
  );
}

function QualityCard({ m }: { m: PeriodMetrics }) {
  const subs = [["Conversations", m.quality.sub.conversations], ["Account depth", m.quality.sub.depth], ["Persistence", m.quality.sub.persistence], ["Channel mix", m.quality.sub.channel], ["Deliverability", m.quality.sub.deliverability]] as const;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Quality breakdown</h3><GradeBadge grade={m.quality.grade} score={m.quality.score} big /></div>
      <ul className="space-y-2">
        {subs.map(([l, v]) => <li key={l} className="text-xs"><div className="flex justify-between text-slate-600"><span>{l}</span><span className="tabular-nums">{v}</span></div><div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-gradient-to-r from-blue-500 to-indigo-600" style={{ width: `${v}%` }} /></div></li>)}
      </ul>
    </div>
  );
}

function EmailCard({ m }: { m: PeriodMetrics }) {
  const e = m.emails;
  const rows = [["Open rate", e.open_rate, e.opened, "bg-sky-500"], ["Reply rate", e.reply_rate, e.replied, "bg-emerald-500"], ["Click rate", e.click_rate, e.clicked, "bg-violet-500"]] as const;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Email engagement</h3>
      <div className="mb-3 text-xs text-slate-500">{fmt(e.sent)} sent · {fmt(e.bounced)} bounced ({pct(e.bounce_rate)})</div>
      {e.sent === 0 ? <p className="text-sm text-slate-400">No emails this period.</p> : (
        <ul className="space-y-2">
          {rows.map(([l, rate, n, color]) => <li key={l} className="text-xs"><div className="flex justify-between text-slate-600"><span>{l}</span><span className="tabular-nums">{pct(rate)} <span className="text-slate-400">({fmt(n)})</span></span></div><div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full ${color}`} style={{ width: pct0(rate) }} /></div></li>)}
        </ul>
      )}
    </div>
  );
}

function DailyChart({ daily, name }: { daily: DailyPoint[]; name: string }) {
  if (!daily?.length) return null;
  const max = Math.max(1, ...daily.map((d) => d.calls + d.emails));
  const H = 96;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Daily activity — {name} (this month)</h3><div className="flex items-center gap-3 text-[11px] text-slate-500"><Legend color="bg-emerald-500" label="Connected" /><Legend color="bg-blue-400" label="Other calls" /><Legend color="bg-indigo-300" label="Emails" /></div></div>
      <div className="flex items-end gap-[3px]" style={{ height: H }}>
        {daily.map((d) => { const others = Math.max(0, d.calls - d.connected); const seg = (v: number) => Math.round((v / max) * H);
          return <div key={d.date} title={`${d.date}\nCalls: ${d.calls} (connected ${d.connected})\nEmails: ${d.emails}`} className="flex flex-1 flex-col justify-end" style={{ minWidth: 4 }}><div className="bg-indigo-300" style={{ height: seg(d.emails) }} /><div className="bg-blue-400" style={{ height: seg(others) }} /><div className="rounded-t-sm bg-emerald-500" style={{ height: seg(d.connected) }} /></div>; })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400"><span>{daily[0]?.date.slice(5)}</span><span>{daily[Math.floor(daily.length / 2)]?.date.slice(5)}</span><span>{daily[daily.length - 1]?.date.slice(5)}</span></div>
    </div>
  );
}

function DispositionCard({ m }: { m: PeriodMetrics }) {
  const entries = Object.entries(m.calls.by_disposition);
  const max = Math.max(1, ...entries.map(([, c]) => c));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Calls by outcome</h3>
      <div className="mb-3 text-xs text-slate-500">{fmt(m.calls.connected)} connected · {fmt(m.calls.not_connected)} not · {pct(m.calls.connect_rate)}</div>
      {entries.length === 0 ? <p className="text-sm text-slate-400">No calls this period.</p> : (
        <ul className="space-y-1.5">{entries.map(([label, count]) => <li key={label} className="text-xs"><div className="flex items-center justify-between"><span className="truncate pr-2 text-slate-600">{label}</span><span className="tabular-nums text-slate-500">{fmt(count)}</span></div><div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={CONNECTED_LABELS.has(label) ? "h-full bg-emerald-500" : "h-full bg-rose-400"} style={{ width: `${(count / max) * 100}%` }} /></div></li>)}</ul>
      )}
    </div>
  );
}

function CompaniesCard({ m, period, book }: { m: PeriodMetrics; period: PeriodKey; book: BookCoverage }) {
  const [openCo, setOpenCo] = useState<string | null>(null);
  const [showUntapped, setShowUntapped] = useState(false);
  const hasBreakdown = NARROW_PERIODS.includes(period);
  const breakdown = m.company_breakdown ?? [];
  const untapped = book.untapped_sample ?? [];
  const untappedCount = Math.max(0, book.units_total - book.units_tapped);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Accounts {showUntapped ? "untapped (cumulative)" : hasBreakdown ? `tapped this period (${breakdown.length})` : ""}</h3>
        {untappedCount > 0 && <button onClick={() => setShowUntapped((s) => !s)} className="rounded-lg bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100">{showUntapped ? "Show tapped" : `Untapped (${fmt(untappedCount)})`}</button>}
      </div>

      {showUntapped ? (
        untapped.length === 0 ? <p className="text-sm text-slate-400">Every owned account has been tapped. 🎉</p> : (
          <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
            {untapped.map((c) => (
              <a key={c.id} href={companyUrl(c.id)} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{c.name}</span>{c.stage && <span className={`shrink-0 rounded px-1 text-[9px] ${STAGE_CHIP[c.stage as StageGroup] ?? ""}`}>{c.stage}</span>}</span><span className="shrink-0 text-blue-600">↗</span>
              </a>
            ))}
            {untappedCount > untapped.length && <p className="px-2 py-1 text-xs text-slate-400">+ {fmt(untappedCount - untapped.length)} more untapped</p>}
          </div>
        )
      ) : !hasBreakdown ? <p className="text-sm text-slate-400">Per-account detail for Today / Yesterday / This week.</p>
      : breakdown.length === 0 ? <p className="text-sm text-slate-400">No accounts tapped this period.</p> : (
        <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
          {breakdown.map((c) => {
            const open = openCo === c.id; const contacts = c.contacts_list ?? [];
            return (
              <div key={c.id} className="rounded-xl border border-slate-100">
                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                  <button onClick={() => setOpenCo(open ? null : c.id)} className="flex min-w-0 items-center gap-1.5 text-left" disabled={contacts.length === 0}>
                    {contacts.length > 0 && <span className="text-slate-400">{open ? "▾" : "▸"}</span>}
                    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${TEMP_CHIP[c.temp]}`} title={c.temp_reason}>{TEMP_ICON[c.temp]}</span>
                    <span className="truncate text-slate-700">{c.name}</span>
                    {c.stage && <span className={`shrink-0 rounded px-1 text-[9px] ${STAGE_CHIP[c.stage as StageGroup] ?? ""}`}>{c.stage}</span>}
                  </button>
                  <a href={companyUrl(c.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-100">↗</a>
                </div>
                <div className="px-2 pb-1.5 text-[11px] text-slate-500">
                  <span className="italic text-slate-400">{c.temp_reason}</span>
                  <span className="ml-2 tabular-nums">{fmt(c.contacts)}c · {fmt(c.calls)}☎ · {fmt(c.emails)}✉{c.opened > 0 ? ` · ${fmt(c.opened)} opened` : ""}{c.replied > 0 ? ` · ${fmt(c.replied)} replied` : ""}</span>
                </div>
                {open && contacts.length > 0 && (
                  <ul className="border-t border-slate-100 px-2 py-1.5 text-xs">
                    {contacts.map((ct) => (
                      <li key={ct.id} className="flex items-center justify-between gap-2 py-0.5">
                        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-slate-600">{ct.name}</span>{ct.dm && <span className="shrink-0 rounded bg-fuchsia-100 px-1 text-[9px] font-bold text-fuchsia-700">DM</span>}{ct.title && <span className="hidden truncate text-[10px] text-slate-400 sm:inline">{ct.title}</span>}</span>
                        <a href={contactUrl(ct.id)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-blue-600 hover:underline">↗</a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
