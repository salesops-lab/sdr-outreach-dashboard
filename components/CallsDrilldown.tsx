"use client";

/** Recent analyzed connected calls with expandable BANTIC + coaching detail. */
import { useState } from "react";
import { BANTIC_DIMS, RepCallsPayload } from "../lib/callquality/types";
import { companyUrl } from "../config/hubspot";

const fmt1 = (n: number | null) => (n == null ? "—" : n.toFixed(1));

function etDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return iso; }
}

const mins = (ms: number | null) => (ms == null ? "—" : `${Math.round(ms / 60000)}m`);

export default function CallsDrilldown({ payload, failed }: { payload: RepCallsPayload | null; failed: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (failed) return <p className="text-sm text-slate-400">Recent calls unavailable.</p>;
  if (!payload) return <p className="text-sm text-slate-400">Loading recent calls…</p>;
  if (!payload.calls.length) return <p className="text-sm text-slate-400">No analyzed connected calls in the last 90 days.</p>;

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Recent analyzed calls ({payload.calls.length})</div>
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {payload.calls.map((c) => {
          const isOpen = open === c.callId;
          return (
            <div key={c.callId} className="rounded-xl border border-slate-100">
              <button onClick={() => setOpen(isOpen ? null : c.callId)} aria-expanded={isOpen} className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-slate-400">{isOpen ? "▾" : "▸"}</span>
                  <span className="shrink-0 rounded-lg bg-indigo-50 px-1.5 py-0.5 text-xs font-bold tabular-nums text-indigo-700">{fmt1(c.overall)}</span>
                  <span className="truncate text-xs text-slate-600">{etDate(c.date)} · {c.disposition ?? "—"} · {mins(c.durationMs)}</span>
                </span>
                {c.quality != null && <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">rubric {fmt1(c.quality)}/5</span>}
              </button>
              {isOpen && (
                <div className="space-y-2 border-t border-slate-100 px-3 py-2 text-xs">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {BANTIC_DIMS.map((d) => (
                      <span key={d} className="tabular-nums text-slate-500">{d.replace("_", " ")}: <b className="text-slate-700">{fmt1(c.dims[d])}</b></span>
                    ))}
                  </div>
                  {c.coachableMoments.length > 0 && (
                    <ul className="space-y-1">{c.coachableMoments.slice(0, 3).map((m, i) => <li key={i} className="rounded-lg bg-amber-50 px-2 py-1 text-amber-800 ring-1 ring-amber-200">💡 {m}</li>)}</ul>
                  )}
                  {c.quotes.length > 0 && <p className="italic text-slate-500">“{c.quotes[0]}”</p>}
                  {c.nextAction && <p className="text-slate-600">→ <b>Next:</b> {c.nextAction}</p>}
                  <div className="flex gap-3 pt-1">
                    {c.recordingUrl && <a href={c.recordingUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">▶ Recording</a>}
                    {c.companyId && <a href={companyUrl(c.companyId)} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Company ↗</a>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
