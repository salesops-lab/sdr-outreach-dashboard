"use client";

/**
 * Deal Funnel view (V3): the stage-wise truth of the Auto Pipeline for the selected scope.
 * Three lanes — Lead→Demo (SDR motion), Demo→Closure (AE motion), Closed — plus Parked and
 * Lost blocks; a ledger-derived flow-conversion line; and a sortable deal workbench
 * (longest-in-stage surfaces first) with HubSpot deal/company backlinks and the account
 * History panel. Data: /api/deals (all stage lists arrive in one response — stage clicks
 * are instant, no refetch).
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, ExternalLink, History, ChevronRight } from "lucide-react";
import { DealStageKey, stageOrder } from "../config/deal-stages";
import { DealFunnelPayload, DealListItem } from "../lib/sync/deal-funnel";
import { companyUrl, dealUrl } from "../config/hubspot";
import { Surface, SortHeader, DealHealthBadge, cn } from "./ui";

const fmt = (n: number) => n.toLocaleString("en-IN");
const usd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;

function daysIn(ms: number | null): number | null {
  if (!ms) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}
function etDate(ms: number | null): string {
  if (!ms) return "—";
  try { return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" }); }
  catch { return "—"; }
}

/** The three funnel lanes + the two exit blocks. */
const LANES: { title: string; tint: string; stages: { key: DealStageKey; label: string }[] }[] = [
  {
    title: "Lead → Demo · SDR motion", tint: "text-primary",
    stages: [
      { key: "mql", label: "MQL" },
      { key: "discovery_done", label: "Discovery Done" },
      { key: "demo_no_show", label: "No-Show" },
      { key: "demo_rescheduled", label: "Rescheduled" },
    ],
  },
  {
    title: "Demo → Closure · AE motion", tint: "text-warm",
    stages: [
      { key: "demo_done", label: "Demo Done" },
      { key: "demo_accepted", label: "Demo Accepted" },
      { key: "in_discussion", label: "In Discussion" },
      { key: "contract_initiated", label: "Contract Initiated" },
    ],
  },
  {
    title: "Closed", tint: "text-good",
    stages: [
      { key: "contract_closed", label: "Contract Closed" },
      { key: "payment_completed", label: "Payment Done" },
      { key: "transferred_cs", label: "→ CS" },
    ],
  },
];

type Bucket = DealStageKey | "lost" | "all";
type SortKey = "company" | "stage" | "health" | "amount" | "sdr" | "ae" | "in_stage" | "last";

const HEALTH_RANK: Record<string, number> = { red: 0, yellow: 1, green: 2 };

export default function DealFunnel({ owners, lens, onTimeline }: {
  owners: string[]; // empty = whole tracked roster
  lens: "all" | "sdr" | "ae";
  onTimeline: (a: { id: string; name: string }) => void;
}) {
  const [data, setData] = useState<DealFunnelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("all");
  const [sortKey, setSortKey] = useState<SortKey>("in_stage");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    let live = true;
    setData(null); setError(null); setBucket("all");
    const q = new URLSearchParams({ lens });
    if (owners.length) q.set("owners", owners.join(","));
    fetch(`/api/deals?${q}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText); return r.json(); })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [owners.join(","), lens]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (!data) return [] as DealListItem[];
    const list = data.deals.filter((d) =>
      bucket === "all" ? true :
      bucket === "lost" ? ["drop_off_sdr", "drop_off_sales", "non_sal"].includes(d.stage_key) :
      d.stage_key === bucket);
    const val = (d: DealListItem): number | string => ({
      company: (d.company_name ?? "").toLowerCase(),
      stage: stageOrder(d.stage_key),
      health: d.health ? HEALTH_RANK[d.health] : 3,
      amount: d.amount ?? -1,
      sdr: (d.sdr_name ?? "").toLowerCase(),
      ae: (d.ae_name ?? "").toLowerCase(),
      in_stage: d.entered_stage_ms ? -d.entered_stage_ms : 1, // older entry = larger "days in stage"
      last: d.last_activity_ms ?? 0,
    }[sortKey]);
    return [...list].sort((a, b) => {
      const av = val(a), bv = val(b);
      const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, bucket, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "company" || key === "sdr" || key === "ae" ? "asc" : "desc"); }
  }

  if (error) return <Surface className="p-6 text-sm text-warn">⚠ {error}</Surface>;
  if (!data) return <Surface className="flex items-center gap-2 p-6 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading deal funnel…</Surface>;

  const st = data.funnel.stages;
  const f = data.funnel.flow;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
  const bucketLabel = bucket === "all" ? "All stages" : bucket === "lost" ? "Lost"
    : LANES.flatMap((l) => l.stages).find((s) => s.key === bucket)?.label ?? bucket;

  return (
    <div className="space-y-4">
      {/* Stage-wise breakdown: three lanes + exits */}
      <Surface className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Pipeline by stage · {fmt(data.total)} deals</span>
          <button onClick={() => setBucket("all")}
            className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold transition", bucket === "all" ? "bg-ink text-white" : "bg-surface-muted text-ink-muted hover:text-ink")}>
            All stages
          </button>
        </div>
        <div className="grid gap-3 lg:grid-cols-[4fr_4fr_3fr]">
          {LANES.map((lane) => (
            <div key={lane.title}>
              <div className={cn("mb-1.5 text-[10px] font-semibold uppercase tracking-wide", lane.tint)}>{lane.title}</div>
              <div className="flex items-stretch gap-1">
                {lane.stages.map((s, i) => {
                  const v = st[s.key] ?? { count: 0, amount: 0 };
                  return (
                    <div key={s.key} className="flex flex-1 items-center gap-1">
                      {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-ink-subtle" />}
                      <button onClick={() => setBucket(s.key)}
                        className={cn("min-w-0 flex-1 rounded-xl border px-2 py-1.5 text-left transition hover:border-line-strong",
                          bucket === s.key ? "border-ink bg-surface-muted" : "border-line")}>
                        <div className={cn("font-mono text-lg font-bold leading-none tabular-nums", v.count > 0 ? lane.tint : "text-ink-subtle")}>{fmt(v.count)}</div>
                        <div className="mt-0.5 truncate text-[10px] font-medium text-ink-muted">{s.label}</div>
                        <div className="text-[9px] tabular-nums text-ink-subtle">{v.amount > 0 ? usd(v.amount) : " "}</div>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={() => setBucket("future_prospect")}
            className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold transition",
              bucket === "future_prospect" ? "bg-ink text-white" : "bg-surface-muted text-ink-muted hover:text-ink")}>
            Parked · {fmt(st.future_prospect?.count ?? 0)}
          </button>
          <button onClick={() => setBucket("lost")}
            className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold transition",
              bucket === "lost" ? "bg-ink text-white" : "bg-hot-weak text-hot hover:brightness-95")}>
            Lost · {fmt(data.funnel.lost.count)}
          </button>
          <span className="ml-auto text-[11px] tabular-nums text-ink-subtle">
            Flow: <b className="text-ink">{fmt(f.scheduled)}</b> scheduled
            <ChevronRight className="inline h-3 w-3" /> <b className="text-ink">{fmt(f.completed)}</b> completed ({pct(f.completed, f.scheduled)})
            <ChevronRight className="inline h-3 w-3" /> <b className="text-ink">{fmt(f.contract)}</b> contract ({pct(f.contract, f.completed)})
            <ChevronRight className="inline h-3 w-3" /> <b className="text-good">{fmt(f.won)}</b> won ({pct(f.won, f.contract)})
          </span>
        </div>
      </Surface>

      {/* Deal workbench */}
      <Surface className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line bg-surface-muted/60 px-4 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
            {bucketLabel} · {fmt(rows.length)} deal{rows.length === 1 ? "" : "s"}
          </span>
          {bucket === "all" && data.total > rows.length && (
            <span className="text-[10px] text-ink-subtle">showing up to {data.list_cap}/stage — pick a stage for its full slice</span>
          )}
        </div>
        {rows.length === 0 ? <p className="p-5 text-sm text-ink-subtle">No deals in this bucket.</p> : (
          <div className="scroll-x">
            <table className="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-muted text-[11px] font-semibold uppercase tracking-wide">
                  <SortHeader onClick={() => toggleSort("company")} active={sortKey === "company"} dir={sortDir}>Account / Deal</SortHeader>
                  <SortHeader onClick={() => toggleSort("stage")} active={sortKey === "stage"} dir={sortDir}>Stage</SortHeader>
                  <SortHeader onClick={() => toggleSort("health")} active={sortKey === "health"} dir={sortDir}>Health</SortHeader>
                  <SortHeader right onClick={() => toggleSort("amount")} active={sortKey === "amount"} dir={sortDir}>Amount</SortHeader>
                  <SortHeader onClick={() => toggleSort("sdr")} active={sortKey === "sdr"} dir={sortDir}>SDR</SortHeader>
                  <SortHeader onClick={() => toggleSort("ae")} active={sortKey === "ae"} dir={sortDir}>AE</SortHeader>
                  <SortHeader right onClick={() => toggleSort("in_stage")} active={sortKey === "in_stage"} dir={sortDir}>In stage</SortHeader>
                  <SortHeader right onClick={() => toggleSort("last")} active={sortKey === "last"} dir={sortDir}>Last activity</SortHeader>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const days = daysIn(d.entered_stage_ms);
                  return (
                    <tr key={d.id} className="border-b border-line/70 transition-colors last:border-0 hover:bg-primary-weak/40">
                      <td className="max-w-[300px] px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          {d.company_id
                            ? <a href={companyUrl(d.company_id)} target="_blank" rel="noopener noreferrer" className="truncate font-semibold text-ink hover:text-primary">{d.company_name ?? `Company ${d.company_id}`}</a>
                            : <span className="truncate italic text-ink-subtle" title="Deal has no company association in HubSpot">No account linked</span>}
                          <a href={dealUrl(d.id)} target="_blank" rel="noopener noreferrer" title="Open deal in HubSpot" className="shrink-0 text-primary hover:underline"><ExternalLink className="h-3 w-3" /></a>
                        </div>
                      </td>
                      <td className="px-3 py-2"><span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">{d.stage_label}</span></td>
                      <td className="px-3 py-2">{d.health ? <DealHealthBadge health={d.health} title={d.health_reason ?? undefined} /> : <span className="text-xs text-ink-subtle">—</span>}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-ink">{d.amount != null ? usd(d.amount) : <span className="text-ink-subtle">—</span>}</td>
                      <td className="max-w-[140px] truncate px-3 py-2 text-xs text-ink-muted">{d.sdr_name ?? "—"}</td>
                      <td className="max-w-[140px] truncate px-3 py-2 text-xs text-ink-muted">{d.ae_name ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                        {days == null ? <span className="text-ink-subtle">—</span>
                          : <span className={cn(days > 30 ? "font-bold text-hot" : days > 14 ? "font-semibold text-warm" : "text-ink-muted")}>{days}d</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-ink-muted">{etDate(d.last_activity_ms)}</td>
                      <td className="px-3 py-2 text-right">
                        {d.company_id && (
                          <button onClick={() => onTimeline({ id: d.company_id!, name: d.company_name ?? `Company ${d.company_id}` })}
                            title="Account history + deal journey"
                            className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
                            <History className="h-3 w-3" /> History
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
