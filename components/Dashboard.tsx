"use client";

import { useMemo, useState } from "react";
import {
  PERIOD_KEYS,
  PERIOD_LABELS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  RepData,
  Snapshot,
  DailyPoint,
  ReachByChannel,
  Insight,
} from "../lib/sync/types";
import { CONNECTED_DISPOSITIONS } from "../config/dispositions";
import { companyUrl, contactUrl } from "../config/hubspot";

const CONNECTED_LABELS = new Set(Object.values(CONNECTED_DISPOSITIONS));

type SortKey =
  | "name" | "quality" | "touches" | "contacts" | "companies"
  | "coverage" | "connect" | "meetings" | "hot";

interface Row {
  ownerId: string;
  name: string;
  data: RepData;
  m: PeriodMetrics;
  touches: number;
}

const fmt = (n: number) => n.toLocaleString("en-IN");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;

function istStamp(iso: string): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }) + " IST";
  } catch { return iso; }
}

const GRADE_CLASS: Record<string, string> = {
  A: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  B: "bg-sky-100 text-sky-700 ring-sky-200",
  C: "bg-amber-100 text-amber-700 ring-amber-200",
  D: "bg-orange-100 text-orange-700 ring-orange-200",
  F: "bg-rose-100 text-rose-700 ring-rose-200",
  "—": "bg-slate-100 text-slate-400 ring-slate-200",
};

export default function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const [period, setPeriod] = useState<PeriodKey>("this_week");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("touches");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<string | null>(null);

  const allRows = useMemo<Row[]>(() =>
    Object.entries(snapshot.reps).map(([ownerId, data]) => {
      const m = data.periods[period];
      return { ownerId, name: snapshot.owner_names[ownerId] ?? `ID:${ownerId}`, data, m, touches: m.calls.total + m.emails.sent };
    }), [snapshot, period]);

  const rows = useMemo<Row[]>(() => {
    const filtered = repFilter === "all" ? allRows : allRows.filter((r) => r.ownerId === repFilter);
    const val = (r: Row): number | string => {
      switch (sortKey) {
        case "name": return r.name.toLowerCase();
        case "quality": return r.m.quality.score;
        case "touches": return r.touches;
        case "contacts": return r.m.contacts.total;
        case "companies": return r.m.companies.total;
        case "coverage": return r.m.coverage.pct;
        case "connect": return r.m.calls.connect_rate;
        case "meetings": return r.m.meetings_booked;
        case "hot": return r.m.temp.hot;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [allRows, repFilter, sortKey, sortDir]);

  const summary = useMemo(() => {
    const a = { touches: 0, contacts: 0, companies: 0, calls: 0, connected: 0, denom: 0, meetings: 0, ownedTapped: 0, ownedTotal: 0, active: 0 };
    for (const r of rows) {
      a.touches += r.touches; a.contacts += r.m.contacts.total; a.companies += r.m.companies.total;
      a.calls += r.m.calls.total; a.connected += r.m.calls.connected; a.denom += r.m.calls.connected + r.m.calls.not_connected;
      a.meetings += r.m.meetings_booked; a.ownedTapped += r.m.coverage.owned_tapped; a.ownedTotal += r.m.coverage.owned_total;
      if (r.touches > 0) a.active++;
    }
    return { ...a, connectRate: a.denom ? a.connected / a.denom : 0, coverage: a.ownedTotal ? a.ownedTapped / a.ownedTotal : 0 };
  }, [rows]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  }

  function exportCsv() {
    const head = ["Rep","Quality","Grade","Touches","Calls","Emails","Uniq Contacts","Contacts via Call","Contacts via Email","Uniq Companies","Owned","Owned Tapped","Coverage","Connect Rate","Meetings","Hot","Warm","Cold","Avg Contacts/Co"];
    const lines = rows.map((r) => {
      const m = r.m;
      return [`"${r.name.replace(/"/g, '""')}"`, m.quality.score, m.quality.grade, r.touches, m.calls.total, m.emails.sent,
        m.contacts.total, m.contacts.via_call, m.contacts.via_email, m.companies.total, m.coverage.owned_total, m.coverage.owned_tapped,
        m.coverage.pct, m.calls.connect_rate, m.meetings_booked, m.temp.hot, m.temp.warm, m.temp.cold, m.avg_contacts_per_company].join(",");
    });
    const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `sdr-outreach-${period}-${snapshot.today_ist || "snapshot"}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const hasData = !!snapshot.generated_at_utc;

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">SDR Outreach Coverage</h1>
          <p className="mt-1 text-sm text-slate-500">Quantity &amp; quality of outbound per rep · unique reach by activity · owned-account coverage · IST (week starts Monday)</p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>Refreshed: <span className="font-medium text-blue-600">{istStamp(snapshot.generated_at_utc)}</span></div>
          <div>Window {snapshot.window.start_ist || "—"} → {snapshot.window.end_ist || "—"} · {fmt(snapshot.totals.calls)} calls + {fmt(snapshot.totals.emails)} emails</div>
        </div>
      </header>

      {!hasData && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
          No snapshot data yet. Run <code className="rounded bg-slate-100 px-1.5 py-0.5 text-blue-600">npm run sync</code>.
        </div>
      )}
      {hasData && snapshot.sources && !snapshot.sources.emails && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ Emails not included — token lacks the <code className="rounded bg-amber-100 px-1.5 py-0.5">connected-email-data-access</code> scope. Showing calls only.
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
          {PERIOD_KEYS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${period === p ? "bg-blue-600 font-medium text-white" : "text-slate-600 hover:bg-slate-100"}`}>
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm">
          <option value="all">All reps ({allRows.length})</option>
          {[...allRows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => <option key={r.ownerId} value={r.ownerId}>{r.name}</option>)}
        </select>
        <button onClick={exportCsv} className="ml-auto rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm hover:bg-slate-100">↓ Export CSV</button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="Touches" value={fmt(summary.touches)} hint={`${fmt(summary.calls)} calls + ${fmt(summary.touches - summary.calls)} emails`} />
        <Card label="Unique contacts" value={fmt(summary.contacts)} hint="summed per rep" />
        <Card label="Unique companies" value={fmt(summary.companies)} hint="summed per rep" />
        <Card label="Owned coverage" value={summary.ownedTotal ? pct0(summary.coverage) : "—"} hint={summary.ownedTotal ? `${fmt(summary.ownedTapped)}/${fmt(summary.ownedTotal)} tapped` : "no owned book"} tone="blue" />
        <Card label="Connect rate" value={pct(summary.connectRate)} tone="emerald" />
        <Card label="Meetings booked" value={fmt(summary.meetings)} tone="emerald" />
      </div>

      <div className="scroll-x rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[1040px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <Th onClick={() => toggleSort("name")} active={sortKey === "name"} dir={sortDir}>Rep</Th>
              <Th onClick={() => toggleSort("quality")} active={sortKey === "quality"} dir={sortDir}>Quality</Th>
              <Th right onClick={() => toggleSort("touches")} active={sortKey === "touches"} dir={sortDir}>Touches</Th>
              <Th right onClick={() => toggleSort("contacts")} active={sortKey === "contacts"} dir={sortDir}>Uniq Contacts</Th>
              <Th right onClick={() => toggleSort("companies")} active={sortKey === "companies"} dir={sortDir}>Uniq Cos</Th>
              <Th onClick={() => toggleSort("coverage")} active={sortKey === "coverage"} dir={sortDir}>Coverage</Th>
              <Th onClick={() => toggleSort("connect")} active={sortKey === "connect"} dir={sortDir}>Connect</Th>
              <Th right onClick={() => toggleSort("meetings")} active={sortKey === "meetings"} dir={sortDir}>Mtgs</Th>
              <Th right onClick={() => toggleSort("hot")} active={sortKey === "hot"} dir={sortDir}>🔥 Hot</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <RepRow key={r.ownerId} row={r} period={period} isOpen={expanded === r.ownerId}
                onToggle={() => setExpanded(expanded === r.ownerId ? null : r.ownerId)} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Coverage = owned accounts (company owner = rep) tapped this period. “Connected” = a human reached (voicemail/busy excluded).
        Quality blends conversations, depth, persistence, channel &amp; deliverability. 🔥 hot = meeting/high-intent · 🌤 warm = connected · 🧊 cold = no connect.
        Per-account detail (HubSpot links) for {NARROW_PERIODS.map((p) => PERIOD_LABELS[p]).join(", ")}. Click a row.
      </p>
    </main>
  );
}

function Card({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "emerald" | "blue" }) {
  const c = tone === "emerald" ? "text-emerald-600" : tone === "blue" ? "text-blue-600" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${c}`}>{value}</div>
      {hint && <div className="truncate text-[10px] uppercase tracking-wide text-slate-400">{hint}</div>}
    </div>
  );
}

function Th({ children, onClick, active, dir, right }: { children: React.ReactNode; onClick: () => void; active: boolean; dir: "asc" | "desc"; right?: boolean }) {
  return (
    <th className={`px-3 py-2.5 font-medium ${right ? "text-right" : ""}`}>
      <button onClick={onClick} className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? "text-slate-900" : ""}`}>
        {children}<span className="text-[9px]">{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function GradeBadge({ grade, score }: { grade: string; score: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ${GRADE_CLASS[grade] ?? GRADE_CLASS["—"]}`}>
      {grade}{grade !== "—" && <span className="font-normal opacity-70">{score}</span>}
    </span>
  );
}

function RepRow({ row, period, isOpen, onToggle }: { row: Row; period: PeriodKey; isOpen: boolean; onToggle: () => void }) {
  const m = row.m;
  const dim = row.touches === 0;
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer border-b border-slate-100 transition hover:bg-blue-50/50 ${dim ? "opacity-50" : ""} ${isOpen ? "bg-blue-50/60" : ""}`}>
        <td className="px-3 py-2.5 font-medium text-slate-800"><span className="mr-2 text-slate-400">{isOpen ? "▾" : "▸"}</span>{row.name}</td>
        <td className="px-3 py-2.5"><GradeBadge grade={m.quality.grade} score={m.quality.score} /></td>
        <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{fmt(row.touches)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {fmt(m.contacts.total)}
          <span className="ml-1 text-[10px] text-slate-400">☎{fmt(m.contacts.via_call)}/✉{fmt(m.contacts.via_email)}</span>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.companies.total)}</td>
        <td className="px-3 py-2.5">
          {m.coverage.owned_total > 0 ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-blue-500" style={{ width: pct0(m.coverage.pct) }} /></div>
              <span className="tabular-nums text-xs text-slate-500">{pct0(m.coverage.pct)}</span>
            </div>
          ) : <span className="text-xs text-slate-300">—</span>}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-rose-200"><div className="h-full bg-emerald-500" style={{ width: pct0(m.calls.connect_rate) }} /></div>
            <span className="tabular-nums text-xs text-slate-500">{pct0(m.calls.connect_rate)}</span>
          </div>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">{m.meetings_booked > 0 ? <span className="font-semibold text-emerald-600">{m.meetings_booked}</span> : <span className="text-slate-300">0</span>}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{m.temp.hot > 0 ? <span className="font-semibold text-rose-600">{m.temp.hot}</span> : <span className="text-slate-300">0</span>}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-slate-200 bg-slate-50/70">
          <td colSpan={9} className="px-4 py-5"><Scorecard data={row.data} m={m} period={period} name={row.name} /></td>
        </tr>
      )}
    </>
  );
}

function Scorecard({ data, m, period, name }: { data: RepData; m: PeriodMetrics; period: PeriodKey; name: string }) {
  return (
    <div className="space-y-5">
      <InsightChips insights={m.insights} />
      <KpiStrip m={m} />
      <div className="grid gap-5 lg:grid-cols-3">
        <ReachCard m={m} />
        <QualityCard m={m} />
        <CoverageTempCard m={m} period={period} />
      </div>
      <DailyChart daily={data.daily} name={name} />
      <div className="grid gap-5 lg:grid-cols-2">
        <DispositionCard m={m} />
        <CompaniesCard m={m} period={period} />
      </div>
    </div>
  );
}

function InsightChips({ insights }: { insights: Insight[] }) {
  if (!insights?.length) return null;
  const tone = (l: Insight["level"]) =>
    l === "good" ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : l === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200"
    : "bg-slate-50 text-slate-600 ring-slate-200";
  return (
    <div className="flex flex-wrap gap-2">
      {insights.map((i, idx) => (
        <span key={idx} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${tone(i.level)}`}>{i.text}</span>
      ))}
    </div>
  );
}

function KpiStrip({ m }: { m: PeriodMetrics }) {
  const items = [
    { l: "Calls", v: fmt(m.calls.total) },
    { l: "Emails", v: fmt(m.emails.sent) },
    { l: "Connect rate", v: pct(m.calls.connect_rate) },
    { l: "Meetings", v: fmt(m.meetings_booked) },
    { l: "Contacts/account", v: m.avg_contacts_per_company.toFixed(1) },
    { l: "Multi-touch acct", v: fmt(m.multitouch_accounts) },
  ];
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {items.map((it) => (
        <div key={it.l} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">{it.l}</div>
          <div className="text-lg font-semibold tabular-nums text-slate-800">{it.v}</div>
        </div>
      ))}
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
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Unique reach by activity</h3>
      <div className="mb-4">
        <div className="mb-1 flex items-baseline justify-between"><span className="text-sm text-slate-600">Contacts</span><span className="text-lg font-semibold tabular-nums text-slate-800">{fmt(m.contacts.total)}</span></div>
        <ReachStack r={m.contacts} />
        <div className="flex gap-3 text-[11px] text-slate-500"><Legend color="bg-blue-500" label={`☎ ${fmt(m.contacts.via_call)}`} /><Legend color="bg-emerald-500" label={`both ${fmt(m.contacts.both)}`} /><Legend color="bg-indigo-400" label={`✉ ${fmt(m.contacts.via_email)}`} /></div>
      </div>
      <div>
        <div className="mb-1 flex items-baseline justify-between"><span className="text-sm text-slate-600">Companies</span><span className="text-lg font-semibold tabular-nums text-slate-800">{fmt(m.companies.total)}</span></div>
        <ReachStack r={m.companies} />
        <div className="flex gap-3 text-[11px] text-slate-500"><Legend color="bg-blue-500" label={`☎ ${fmt(m.companies.via_call)}`} /><Legend color="bg-emerald-500" label={`both ${fmt(m.companies.both)}`} /><Legend color="bg-indigo-400" label={`✉ ${fmt(m.companies.via_email)}`} /></div>
      </div>
    </div>
  );
}

function QualityCard({ m }: { m: PeriodMetrics }) {
  const subs = [
    { l: "Conversations", v: m.quality.sub.conversations },
    { l: "Account depth", v: m.quality.sub.depth },
    { l: "Persistence", v: m.quality.sub.persistence },
    { l: "Channel mix", v: m.quality.sub.channel },
    { l: "Deliverability", v: m.quality.sub.deliverability },
  ];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Quality breakdown</h3>
        <GradeBadge grade={m.quality.grade} score={m.quality.score} />
      </div>
      <ul className="space-y-2">
        {subs.map((s) => (
          <li key={s.l} className="text-xs">
            <div className="flex justify-between text-slate-600"><span>{s.l}</span><span className="tabular-nums">{s.v}</span></div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-blue-500" style={{ width: `${s.v}%` }} /></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Donut({ pct: p, label }: { pct: number; label: string }) {
  const deg = Math.round(p * 360);
  return (
    <div className="relative h-20 w-20 shrink-0">
      <div className="h-20 w-20 rounded-full" style={{ background: `conic-gradient(#3b82f6 ${deg}deg, #e2e8f0 0)` }} />
      <div className="absolute inset-[6px] flex flex-col items-center justify-center rounded-full bg-white">
        <span className="text-sm font-semibold tabular-nums text-slate-800">{label}</span>
      </div>
    </div>
  );
}

function CoverageTempCard({ m, period }: { m: PeriodMetrics; period: PeriodKey }) {
  const t = m.temp;
  const tappedTotal = Math.max(1, t.hot + t.warm + t.cold);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Coverage &amp; temperature</h3>
      <div className="mb-4 flex items-center gap-3">
        {m.coverage.owned_total > 0 ? <Donut pct={m.coverage.pct} label={pct0(m.coverage.pct)} /> : <Donut pct={0} label="—" />}
        <div className="text-xs text-slate-600">
          {m.coverage.owned_total > 0 ? (
            <>
              <div><span className="font-semibold tabular-nums text-slate-800">{fmt(m.coverage.owned_tapped)}</span> of {fmt(m.coverage.owned_total)} owned accounts tapped</div>
              <div className="mt-1 text-amber-700">{fmt(m.coverage.untapped_count)} untapped {!NARROW_PERIODS.includes(period) && period !== "last_week" ? "" : ""}</div>
            </>
          ) : <div className="text-slate-400">No owned book for this rep.</div>}
        </div>
      </div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Tapped accounts</div>
      <div className="mb-1 flex h-3 overflow-hidden rounded-full">
        <div className="bg-rose-500" style={{ width: `${(t.hot / tappedTotal) * 100}%` }} title={`Hot: ${t.hot}`} />
        <div className="bg-amber-400" style={{ width: `${(t.warm / tappedTotal) * 100}%` }} title={`Warm: ${t.warm}`} />
        <div className="bg-sky-400" style={{ width: `${(t.cold / tappedTotal) * 100}%` }} title={`Cold: ${t.cold}`} />
      </div>
      <div className="flex gap-3 text-[11px] text-slate-500">
        <Legend color="bg-rose-500" label={`🔥 ${fmt(t.hot)}`} /><Legend color="bg-amber-400" label={`🌤 ${fmt(t.warm)}`} /><Legend color="bg-sky-400" label={`🧊 ${fmt(t.cold)}`} />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-2 rounded-sm ${color}`} />{label}</span>;
}

function DailyChart({ daily, name }: { daily: DailyPoint[]; name: string }) {
  if (!daily?.length) return null;
  const max = Math.max(1, ...daily.map((d) => d.calls + d.emails));
  const H = 96;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Daily activity — {name} (this month)</h3>
        <div className="flex items-center gap-3 text-[11px] text-slate-500"><Legend color="bg-emerald-500" label="Connected" /><Legend color="bg-blue-400" label="Other calls" /><Legend color="bg-indigo-300" label="Emails" /></div>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height: H }}>
        {daily.map((d) => {
          const others = Math.max(0, d.calls - d.connected);
          const seg = (v: number) => Math.round((v / max) * H);
          return (
            <div key={d.date} title={`${d.date}\nCalls: ${d.calls} (connected ${d.connected})\nEmails: ${d.emails}`} className="flex flex-1 flex-col justify-end" style={{ minWidth: 4 }}>
              <div className="bg-indigo-300" style={{ height: seg(d.emails) }} />
              <div className="bg-blue-400" style={{ height: seg(others) }} />
              <div className="rounded-t-sm bg-emerald-500" style={{ height: seg(d.connected) }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{daily[0]?.date.slice(5)}</span><span>{daily[Math.floor(daily.length / 2)]?.date.slice(5)}</span><span>{daily[daily.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function DispositionCard({ m }: { m: PeriodMetrics }) {
  const entries = Object.entries(m.calls.by_disposition);
  const max = Math.max(1, ...entries.map(([, c]) => c));
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Calls by outcome</h3>
      <div className="mb-3 text-xs text-slate-500">{fmt(m.calls.connected)} connected · {fmt(m.calls.not_connected)} not · {pct(m.calls.connect_rate)} rate</div>
      {entries.length === 0 ? <p className="text-sm text-slate-400">No calls in this period.</p> : (
        <ul className="space-y-1.5">
          {entries.map(([label, count]) => (
            <li key={label} className="text-xs">
              <div className="flex items-center justify-between"><span className="truncate pr-2 text-slate-600">{label}</span><span className="tabular-nums text-slate-500">{fmt(count)}</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={CONNECTED_LABELS.has(label) ? "h-full bg-emerald-500" : "h-full bg-rose-400"} style={{ width: `${(count / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TEMP_BADGE: Record<string, string> = { hot: "bg-rose-100 text-rose-700", warm: "bg-amber-100 text-amber-700", cold: "bg-sky-100 text-sky-700" };
const TEMP_ICON: Record<string, string> = { hot: "🔥", warm: "🌤", cold: "🧊" };

function CompaniesCard({ m, period }: { m: PeriodMetrics; period: PeriodKey }) {
  const [openCo, setOpenCo] = useState<string | null>(null);
  const [showUntapped, setShowUntapped] = useState(false);
  const hasBreakdown = NARROW_PERIODS.includes(period);
  const breakdown = m.company_breakdown ?? [];
  const untapped = m.coverage.untapped_sample ?? [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Accounts {hasBreakdown ? `tapped (${breakdown.length})` : ""}</h3>
        {m.coverage.untapped_count > 0 && (
          <button onClick={() => setShowUntapped((s) => !s)} className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100">
            {showUntapped ? "Show tapped" : `Untapped (${fmt(m.coverage.untapped_count)})`}
          </button>
        )}
      </div>

      {showUntapped ? (
        untapped.length === 0 ? (
          <p className="text-sm text-slate-400">Untapped list shown for This week / This month.</p>
        ) : (
          <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
            {untapped.map((c) => (
              <a key={c.id} href={companyUrl(c.id)} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                <span className="truncate pr-2">{c.name}</span><span className="shrink-0 text-blue-600">↗</span>
              </a>
            ))}
            {m.coverage.untapped_count > untapped.length && <p className="px-2 py-1 text-xs text-slate-400">+ {fmt(m.coverage.untapped_count - untapped.length)} more untapped</p>}
          </div>
        )
      ) : !hasBreakdown ? (
        <p className="text-sm text-slate-400">Per-account detail available for Today / Yesterday / This week.</p>
      ) : breakdown.length === 0 ? (
        <p className="text-sm text-slate-400">No accounts tapped in this period.</p>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {breakdown.map((c) => {
            const open = openCo === c.id;
            const contacts = c.contacts_list ?? [];
            return (
              <div key={c.id} className="rounded-md border border-slate-100">
                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                  <button onClick={() => setOpenCo(open ? null : c.id)} className="flex min-w-0 items-center gap-1.5 text-left" disabled={contacts.length === 0}>
                    {contacts.length > 0 && <span className="text-slate-400">{open ? "▾" : "▸"}</span>}
                    <span className={`rounded px-1 text-[10px] ${TEMP_BADGE[c.temp]}`}>{TEMP_ICON[c.temp]}</span>
                    <span className="truncate text-slate-700">{c.name}</span>
                    {!c.owned && <span className="shrink-0 text-[9px] uppercase text-slate-300">not owned</span>}
                  </button>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                    <span className="tabular-nums" title="contacts / calls / emails">{fmt(c.contacts)}c · {fmt(c.calls)}☎ · {fmt(c.emails)}✉</span>
                    <a href={companyUrl(c.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-600 hover:bg-blue-100" title="Open company in HubSpot">↗</a>
                  </div>
                </div>
                {open && contacts.length > 0 && (
                  <ul className="border-t border-slate-100 px-2 py-1.5 text-xs">
                    {contacts.map((ct) => (
                      <li key={ct.id} className="flex items-center justify-between py-0.5">
                        <span className="truncate pr-2 text-slate-600">{ct.name}</span>
                        <a href={contactUrl(ct.id)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-blue-600 hover:underline" title="Open contact in HubSpot">↗</a>
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
