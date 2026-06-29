"use client";

import { useMemo, useState } from "react";
import {
  PERIOD_KEYS,
  PERIOD_LABELS,
  NARROW_PERIODS,
  PeriodKey,
  PeriodMetrics,
  Snapshot,
} from "../lib/sync/types";
import { CONNECTED_DISPOSITIONS } from "../config/dispositions";

const CONNECTED_LABELS = new Set(Object.values(CONNECTED_DISPOSITIONS));

type SortKey =
  | "name"
  | "unique_contacts"
  | "unique_companies"
  | "avg_contacts_per_company"
  | "calls_total"
  | "connect_rate"
  | "emails_sent"
  | "activity";

interface Row {
  ownerId: string;
  name: string;
  m: PeriodMetrics;
  activity: number;
}

const fmt = (n: number) => n.toLocaleString("en-IN");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function istStamp(iso: string): string {
  if (!iso) return "never";
  try {
    return (
      new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " IST"
    );
  } catch {
    return iso;
  }
}

export default function Dashboard({ snapshot }: { snapshot: Snapshot }) {
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("activity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<string | null>(null);

  const allRows = useMemo<Row[]>(() => {
    return Object.entries(snapshot.reps).map(([ownerId, data]) => {
      const m = data.periods[period];
      return {
        ownerId,
        name: snapshot.owner_names[ownerId] ?? `ID:${ownerId}`,
        m,
        activity: m.calls.total + m.emails.sent,
      };
    });
  }, [snapshot, period]);

  const rows = useMemo<Row[]>(() => {
    const filtered = repFilter === "all" ? allRows : allRows.filter((r) => r.ownerId === repFilter);
    const val = (r: Row): number | string => {
      switch (sortKey) {
        case "name":
          return r.name.toLowerCase();
        case "unique_contacts":
          return r.m.unique_contacts;
        case "unique_companies":
          return r.m.unique_companies;
        case "avg_contacts_per_company":
          return r.m.avg_contacts_per_company;
        case "calls_total":
          return r.m.calls.total;
        case "connect_rate":
          return r.m.calls.connect_rate;
        case "emails_sent":
          return r.m.emails.sent;
        case "activity":
          return r.activity;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      let cmp: number;
      if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
      else cmp = (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [allRows, repFilter, sortKey, sortDir]);

  // Team summary across the displayed rows (calls/emails are additive; uniques are
  // summed per-rep coverage, not cross-rep-deduped — labeled accordingly).
  const summary = useMemo(() => {
    const acc = { contacts: 0, companies: 0, calls: 0, connected: 0, callDenom: 0, emails: 0, active: 0 };
    for (const r of rows) {
      acc.contacts += r.m.unique_contacts;
      acc.companies += r.m.unique_companies;
      acc.calls += r.m.calls.total;
      acc.connected += r.m.calls.connected;
      acc.callDenom += r.m.calls.connected + r.m.calls.not_connected;
      acc.emails += r.m.emails.sent;
      if (r.activity > 0) acc.active++;
    }
    return { ...acc, connectRate: acc.callDenom ? acc.connected / acc.callDenom : 0 };
  }, [rows]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  function exportCsv() {
    const head = [
      "Rep",
      "Unique Contacts",
      "Unique Companies",
      "Contacts per Company",
      "Calls",
      "Connected",
      "Not Connected",
      "Connect Rate",
      "Emails Sent",
      "Bounced",
      "Total Activity",
    ];
    const lines = rows.map((r) =>
      [
        `"${r.name.replace(/"/g, '""')}"`,
        r.m.unique_contacts,
        r.m.unique_companies,
        r.m.avg_contacts_per_company,
        r.m.calls.total,
        r.m.calls.connected,
        r.m.calls.not_connected,
        r.m.calls.connect_rate,
        r.m.emails.sent,
        r.m.emails.bounced,
        r.activity,
      ].join(","),
    );
    const csv = [head.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sdr-outreach-${period}-${snapshot.today_ist || "snapshot"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasData = !!snapshot.generated_at_utc;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SDR Outreach Coverage</h1>
          <p className="mt-1 text-sm text-muted">
            Outbound calls &amp; emails per rep · unique contacts &amp; companies tapped · IST periods (week starts Monday)
          </p>
        </div>
        <div className="text-right text-xs text-muted">
          <div>
            Refreshed: <span className="text-accent">{istStamp(snapshot.generated_at_utc)}</span>
          </div>
          <div>
            Window: {snapshot.window.start_ist || "—"} → {snapshot.window.end_ist || "—"} ·{" "}
            {fmt(snapshot.totals.calls)} calls + {fmt(snapshot.totals.emails)} emails
          </div>
        </div>
      </header>

      {!hasData && (
        <div className="mb-6 rounded-lg border border-edge bg-panel p-4 text-sm text-muted">
          No snapshot data yet. Run <code className="rounded bg-ink px-1.5 py-0.5 text-accent">npm run sync</code> to
          pull from HubSpot.
        </div>
      )}

      {hasData && snapshot.sources && !snapshot.sources.emails && (
        <div className="mb-6 rounded-lg border border-notconnected/40 bg-notconnected/10 p-3 text-sm text-notconnected">
          ⚠️ Emails are not included — the HubSpot token lacks the{" "}
          <code className="rounded bg-ink px-1.5 py-0.5">connected-email-data-access</code> scope. Showing{" "}
          <strong>calls only</strong>. Add the scope to the private app and re-run the sync to include email outreach.
        </div>
      )}

      {/* Period selector + rep filter + export */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-edge bg-panel p-1">
          {PERIOD_KEYS.map((p) => (
            <button
              key={p}
              onClick={() => {
                setPeriod(p);
                setExpanded(null);
              }}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                period === p ? "bg-accent text-ink font-medium" : "text-muted hover:text-white"
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        <select
          value={repFilter}
          onChange={(e) => {
            setRepFilter(e.target.value);
            setExpanded(null);
          }}
          className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-white"
        >
          <option value="all">All reps ({allRows.length})</option>
          {[...allRows]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => (
              <option key={r.ownerId} value={r.ownerId}>
                {r.name}
              </option>
            ))}
        </select>

        <button
          onClick={exportCsv}
          className="ml-auto rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-muted hover:text-white"
        >
          ↓ Export CSV
        </button>
      </div>

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="Unique contacts" hint="summed per rep" value={fmt(summary.contacts)} />
        <Card label="Unique companies" hint="summed per rep" value={fmt(summary.companies)} />
        <Card label="Calls" value={fmt(summary.calls)} />
        <Card label="Connect rate" value={pct(summary.connectRate)} accent />
        <Card label="Emails sent" value={fmt(summary.emails)} />
        <Card label="Active reps" hint={`of ${allRows.length}`} value={fmt(summary.active)} />
      </div>

      {/* Leaderboard */}
      <div className="scroll-x rounded-xl border border-edge bg-panel">
        <table className="w-full min-w-[920px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-edge text-left text-xs uppercase tracking-wide text-muted">
              <Th onClick={() => toggleSort("name")} active={sortKey === "name"} dir={sortDir}>
                Rep
              </Th>
              <Th right onClick={() => toggleSort("unique_contacts")} active={sortKey === "unique_contacts"} dir={sortDir}>
                Uniq Contacts
              </Th>
              <Th right onClick={() => toggleSort("unique_companies")} active={sortKey === "unique_companies"} dir={sortDir}>
                Uniq Companies
              </Th>
              <Th
                right
                onClick={() => toggleSort("avg_contacts_per_company")}
                active={sortKey === "avg_contacts_per_company"}
                dir={sortDir}
              >
                Contacts / Co
              </Th>
              <Th right onClick={() => toggleSort("calls_total")} active={sortKey === "calls_total"} dir={sortDir}>
                Calls
              </Th>
              <Th onClick={() => toggleSort("connect_rate")} active={sortKey === "connect_rate"} dir={sortDir}>
                Connect rate
              </Th>
              <Th right onClick={() => toggleSort("emails_sent")} active={sortKey === "emails_sent"} dir={sortDir}>
                Emails
              </Th>
              <Th right onClick={() => toggleSort("activity")} active={sortKey === "activity"} dir={sortDir}>
                Activity
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = expanded === r.ownerId;
              const dim = r.activity === 0;
              return (
                <RepRow
                  key={r.ownerId}
                  row={r}
                  period={period}
                  isOpen={isOpen}
                  dim={dim}
                  onToggle={() => setExpanded(isOpen ? null : r.ownerId)}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-muted">
        “Connected” = a human was reached (voicemail / busy excluded), matching your call-scoring definition. Per-company
        drill-down is available for {NARROW_PERIODS.map((p) => PERIOD_LABELS[p]).join(", ")}. Owner reflects the current
        HubSpot owner; outbound only.
      </p>
    </main>
  );
}

function Card({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-edge bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? "text-connected" : ""}`}>{value}</div>
      {hint && <div className="text-[10px] uppercase tracking-wide text-muted/70">{hint}</div>}
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
  right,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: "asc" | "desc";
  right?: boolean;
}) {
  return (
    <th className={`px-3 py-2.5 font-medium ${right ? "text-right" : ""}`}>
      <button onClick={onClick} className={`inline-flex items-center gap-1 hover:text-white ${active ? "text-white" : ""}`}>
        {children}
        <span className="text-[9px]">{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function RepRow({
  row,
  period,
  isOpen,
  dim,
  onToggle,
}: {
  row: Row;
  period: PeriodKey;
  isOpen: boolean;
  dim: boolean;
  onToggle: () => void;
}) {
  const m = row.m;
  const connPct = m.calls.connect_rate;
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-edge/60 transition hover:bg-ink/40 ${dim ? "opacity-45" : ""}`}
      >
        <td className="px-3 py-2.5">
          <span className="mr-2 text-muted">{isOpen ? "▾" : "▸"}</span>
          {row.name}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.unique_contacts)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.unique_companies)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{m.avg_contacts_per_company.toFixed(1)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.calls.total)}</td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-notconnected/30">
              <div className="h-full bg-connected" style={{ width: `${Math.round(connPct * 100)}%` }} />
            </div>
            <span className="tabular-nums text-xs text-muted">{pct(connPct)}</span>
          </div>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmt(m.emails.sent)}</td>
        <td className="px-3 py-2.5 text-right font-medium tabular-nums">{fmt(row.activity)}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-edge bg-ink/30">
          <td colSpan={8} className="px-4 py-4">
            <Drilldown m={m} period={period} name={row.name} />
          </td>
        </tr>
      )}
    </>
  );
}

function Drilldown({ m, period, name }: { m: PeriodMetrics; period: PeriodKey; name: string }) {
  const dispositions = Object.entries(m.calls.by_disposition);
  const hasBreakdown = NARROW_PERIODS.includes(period);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Calls by disposition */}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Calls by outcome</h3>
        {dispositions.length === 0 ? (
          <p className="text-sm text-muted">No calls in this period.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {dispositions.map(([label, count]) => (
              <li key={label} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      CONNECTED_LABELS.has(label) ? "bg-connected" : "bg-notconnected"
                    }`}
                  />
                  {label}
                </span>
                <span className="tabular-nums text-muted">{fmt(count)}</span>
              </li>
            ))}
            {m.calls.null_disposition > 0 && (
              <li className="flex items-center justify-between gap-3 text-muted">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-muted/50" />
                  No disposition set
                </span>
                <span className="tabular-nums">{fmt(m.calls.null_disposition)}</span>
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Channel mix + emails */}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Channel mix &amp; email</h3>
        <ul className="space-y-1 text-sm">
          <li className="flex justify-between">
            <span>Contacts via call only</span>
            <span className="tabular-nums text-muted">{fmt(m.channel_mix.call_only)}</span>
          </li>
          <li className="flex justify-between">
            <span>Contacts via email only</span>
            <span className="tabular-nums text-muted">{fmt(m.channel_mix.email_only)}</span>
          </li>
          <li className="flex justify-between">
            <span>Contacts via both</span>
            <span className="tabular-nums text-muted">{fmt(m.channel_mix.both)}</span>
          </li>
          <li className="mt-2 flex justify-between border-t border-edge pt-2">
            <span>Emails bounced</span>
            <span className="tabular-nums text-notconnected">
              {fmt(m.emails.bounced)} ({pct(m.emails.bounce_rate)})
            </span>
          </li>
          {m.unattributed_activities > 0 && (
            <li className="flex justify-between text-muted">
              <span>Unattributed activities</span>
              <span className="tabular-nums">{fmt(m.unattributed_activities)}</span>
            </li>
          )}
        </ul>
      </div>

      {/* Per-company breakdown */}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Companies tapped {m.company_breakdown ? `(${m.company_breakdown.length})` : ""}
        </h3>
        {!hasBreakdown ? (
          <p className="text-sm text-muted">Per-company detail available for Today / Yesterday / This week.</p>
        ) : !m.company_breakdown || m.company_breakdown.length === 0 ? (
          <p className="text-sm text-muted">No companies tapped in this period.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto pr-1">
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-1">Company</th>
                  <th className="pb-1 text-right">Contacts</th>
                  <th className="pb-1 text-right">Calls</th>
                  <th className="pb-1 text-right">Emails</th>
                </tr>
              </thead>
              <tbody>
                {m.company_breakdown.map((c) => (
                  <tr key={c.id} className="border-t border-edge/40">
                    <td className="py-1 pr-2">{c.name}</td>
                    <td className="py-1 text-right tabular-nums">{fmt(c.contacts)}</td>
                    <td className="py-1 text-right tabular-nums">{fmt(c.calls)}</td>
                    <td className="py-1 text-right tabular-nums">{fmt(c.emails)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
