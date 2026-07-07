"use client";

/**
 * GD Book Explorer: the rep's assigned Group-Dealership / Single units →
 * rooftops (engaged vs untapped) → top engaged contacts → activity depth.
 * Numbers reconcile with BookCoverage by construction (same everTapped source).
 * Unit detail is lazy-loaded from /api/rep/[ownerId]/book (stripped from the
 * page payload for size).
 */
import { useEffect, useMemo, useState } from "react";
import { BookCoverage, BookUnitDetail, MARKET_SEGMENT_LABELS } from "../lib/sync/types";
import { companyUrl, contactUrl } from "../config/hubspot";
import { STAGE_CHIP, TEMP_ICON } from "./ui-tokens";

const fmt = (n: number) => n.toLocaleString("en-IN");

function etDay(ms: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" });
  } catch { return "—"; }
}

type Filter = "all" | "gds" | "singles" | "untapped";

export default function GdExplorer({ ownerId, book }: { ownerId: string; book: BookCoverage }) {
  const [units, setUnits] = useState<BookUnitDetail[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [openUnit, setOpenUnit] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/rep/${ownerId}/book`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => live && setUnits(d.units ?? []))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [ownerId]);

  const shown = useMemo(() => {
    const all = units ?? [];
    if (filter === "gds") return all.filter((u) => u.isGroup);
    if (filter === "singles") return all.filter((u) => !u.isGroup);
    if (filter === "untapped") return all.filter((u) => !u.tapped);
    return all;
  }, [units, filter]);

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: `All (${fmt(book.units_total)})` },
    { key: "gds", label: `GDs (${fmt(book.gds)})` },
    { key: "singles", label: `Singles (${fmt(book.singles)})` },
    { key: "untapped", label: `Untapped (${fmt(Math.max(0, book.units_total - book.units_tapped))})` },
  ];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Book explorer (GD → rooftops → contacts)</h3>
        <span className="text-[11px] text-slate-400">{fmt(book.gds)} GDs · {fmt(book.singles)} singles · {fmt(book.rooftops_total)} rooftops · {fmt(book.units_tapped)}/{fmt(book.units_total)} tapped</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setFilter(t.key)}
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${filter === t.key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {failed ? <p className="text-sm text-slate-400">Book detail unavailable.</p>
      : units === null ? <p className="text-sm text-slate-400">Loading book…</p>
      : shown.length === 0 ? <p className="text-sm text-slate-400">Nothing in this view.</p> : (
        <div className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
          {shown.map((u) => {
            const isOpen = openUnit === u.key;
            const tappedRoofs = u.rooftops.filter((r) => r.tapped).length;
            return (
              <div key={u.key} className={`rounded-xl border ${u.tapped ? "border-slate-100" : "border-amber-200 bg-amber-50/40"}`}>
                <button onClick={() => setOpenUnit(isOpen ? null : u.key)} aria-expanded={isOpen} className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="text-slate-400">{isOpen ? "▾" : "▸"}</span>
                    <span className={`shrink-0 text-xs ${u.tapped ? "text-emerald-600" : "text-amber-500"}`}>{u.tapped ? "●" : "○"}</span>
                    <span className="truncate font-semibold text-slate-700">{u.name}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${u.isGroup ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" : "bg-slate-100 text-slate-500"}`}>
                      {u.isGroup ? `GD · ${u.rooftops.length} rooftops` : "Single"}
                    </span>
                    <span className={`hidden shrink-0 rounded px-1 py-0.5 text-[9px] sm:inline ${STAGE_CHIP[u.stage] ?? ""}`}>{u.stage}</span>
                    <span className="hidden shrink-0 text-[10px] text-slate-400 md:inline">{MARKET_SEGMENT_LABELS[u.segment]}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-slate-500">{fmt(tappedRoofs)}/{fmt(u.rooftops.length)} engaged</span>
                </button>

                {isOpen && (
                  <div className="space-y-1 border-t border-slate-100 px-2 py-1.5">
                    {u.rooftops.map((r) => (
                      <div key={r.id} className="rounded-lg bg-slate-50/60 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className={r.tapped ? "text-emerald-600" : "text-amber-500"}>{r.tapped ? "●" : "○"}</span>
                            <span className="shrink-0" title={r.temp_reason}>{TEMP_ICON[r.temp]}</span>
                            <span className="truncate font-medium text-slate-700">{r.name}</span>
                            <a href={companyUrl(r.id)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-blue-600 hover:underline">↗</a>
                          </span>
                          <span className="shrink-0 tabular-nums text-[11px] text-slate-500">
                            {r.tapped ? <>{fmt(r.calls)}☎ · {fmt(r.emails)}✉ · {fmt(r.connected)} conn · {etDay(r.last_ms)}</> : <span className="italic text-amber-600">untouched</span>}
                          </span>
                        </div>
                        {r.contacts.length > 0 && (
                          <ul className="mt-1 space-y-0.5 border-t border-slate-100 pt-1">
                            {r.contacts.map((c) => (
                              <li key={c.id} className="flex items-center justify-between gap-2 pl-5 text-[11px]">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-slate-600">{c.name}</span>
                                  {c.dm && <span className="shrink-0 rounded bg-fuchsia-100 px-1 text-[9px] font-bold text-fuchsia-700">DM</span>}
                                  {c.title && <span className="hidden truncate text-[10px] text-slate-400 sm:inline">{c.title}</span>}
                                </span>
                                <span className="flex shrink-0 items-center gap-2 tabular-nums text-slate-400">
                                  {fmt(c.calls)}☎ {fmt(c.emails)}✉
                                  <a href={contactUrl(c.id)} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">↗</a>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
