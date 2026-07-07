"use client";

/**
 * BANTIC scorecard + coaching. Snapshot data (avg, weakest dim, coaching lists)
 * arrives via props from the page load; the 6 dim averages + drill-down calls
 * load lazily from /api/rep/[id]/calls when the drawer opens.
 */
import { useEffect, useState } from "react";
import { BANTIC_DIMS, CoachingSnapshot, RepCallsPayload } from "../lib/callquality/types";
import CallsDrilldown from "./CallsDrilldown";

const DIM_LABEL: Record<(typeof BANTIC_DIMS)[number], string> = {
  budget: "Budget", authority: "Authority", need: "Need",
  timeline: "Timeline", impact: "Impact", current_process: "Current process",
};

const fmt1 = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(1));

export default function CallQualityCard({ coach, ownerId }: { coach?: CoachingSnapshot; ownerId: string }) {
  const [payload, setPayload] = useState<RepCallsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/rep/${ownerId}/calls`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => live && setPayload(d))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [ownerId]);

  const noData = !coach && failed;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Call quality (BANTIC · connected calls)</h3>
        {coach?.avgBantic != null && (
          <span className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-2.5 py-1 text-sm font-black text-white">
            {coach.avgBantic.toFixed(1)}<span className="text-xs font-medium opacity-80">/10 weekly avg</span>
          </span>
        )}
      </div>

      {noData ? (
        <p className="text-sm text-slate-400">Call data unavailable.</p>
      ) : !coach && !payload ? (
        <p className="text-sm text-slate-400">Loading call quality…</p>
      ) : (
        <div className="space-y-4">
          {payload && payload.dims.count > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <span>BANTIC dimensions (last 90 days · {payload.dims.count} calls)</span>
                {coach?.weakestDimension && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-600 ring-1 ring-rose-200">weakest: {coach.weakestDimension}</span>}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {BANTIC_DIMS.map((d) => {
                  const v = payload.dims.dims[d];
                  return (
                    <div key={d} className="text-xs">
                      <div className="flex justify-between"><span className="text-slate-600">{DIM_LABEL[d]}</span><span className="tabular-nums text-slate-500">{fmt1(v)}</span></div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${((v ?? 0) / 10) * 100}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {coach && (
            <div className="grid gap-3 sm:grid-cols-3">
              <CoachList title="Strengths" tone="good" items={coach.strengths} />
              <CoachList title="Risks" tone="warn" items={coach.risks} />
              <CoachList title="Coaching priorities" tone="info" items={coach.priorities} />
            </div>
          )}
          {coach?.managerSummary && (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs italic text-slate-600 ring-1 ring-slate-100">{coach.managerSummary}</p>
          )}

          <CallsDrilldown payload={payload} failed={failed} />
        </div>
      )}
    </div>
  );
}

function CoachList({ title, tone, items }: { title: string; tone: "good" | "warn" | "info"; items: string[] }) {
  if (!items.length) return null;
  const chip = tone === "good" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : tone === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-blue-50 text-blue-700 ring-blue-200";
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <ul className="space-y-1">
        {items.slice(0, 4).map((t, i) => <li key={i} className={`rounded-lg px-2 py-1 text-xs ring-1 ${chip}`}>{t}</li>)}
      </ul>
    </div>
  );
}
