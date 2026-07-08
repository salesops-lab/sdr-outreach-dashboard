"use client";

import { useMemo, useState } from "react";
import { Flame, ExternalLink, ArrowRight, Sparkles } from "lucide-react";
import { AgentWatch, Priority, WatchStatus } from "../lib/agent/types";
import { REPS } from "../config/reps";
import { companyUrl } from "../config/hubspot";
import { Surface, Chip, cn } from "./ui";

const PRIO_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const PRIO_TONE: Record<Priority, "danger" | "warn" | "neutral"> = { high: "danger", medium: "warn", low: "neutral" };
const STATUS_TONE: Record<WatchStatus, "primary" | "good" | "neutral"> = {
  watching: "primary", meeting_booked: "good", drop_off: "neutral", closed: "neutral",
};
const STATUS_LABEL: Record<WatchStatus, string> = {
  watching: "Watching", meeting_booked: "Meeting booked", drop_off: "Dropped off", closed: "Closed",
};

function ago(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET";
  } catch { return "—"; }
}

export default function AttentionBoard({ watches }: { watches: AgentWatch[] }) {
  const [repFilter, setRepFilter] = useState("all");
  const [prio, setPrio] = useState<"all" | Priority>("all");

  const reps = useMemo(
    () => [...new Set(watches.map((w) => w.repId).filter(Boolean))] as string[],
    [watches],
  );
  const rows = useMemo(
    () => watches
      .filter((w) => w.status !== "closed" && w.status !== "drop_off")
      .filter((w) => (repFilter === "all" || w.repId === repFilter) && (prio === "all" || w.priority === prio))
      .sort((a, b) =>
        (PRIO_ORDER[a.priority ?? "low"] - PRIO_ORDER[b.priority ?? "low"]) ||
        (b.lastReviewedAt ?? "").localeCompare(a.lastReviewedAt ?? "")),
    [watches, repFilter, prio],
  );

  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0, meetings: 0 };
    for (const w of watches) {
      if (w.status === "meeting_booked") c.meetings++;
      else if (w.status === "watching" && w.priority) c[w.priority]++;
    }
    return c;
  }, [watches]);

  if (!watches.length) {
    return (
      <Surface className="p-8 text-center">
        <Sparkles className="mx-auto h-8 w-8 text-ink-subtle" />
        <p className="mt-3 text-sm text-ink-muted">No hot accounts are being tracked yet.</p>
        <p className="mt-1 text-xs text-ink-subtle">The agent runs every 2 hours and populates this board when accounts turn hot. If you just set it up, run <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-primary">npm run agent:run</code>.</p>
      </Surface>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([["high", "High priority", "text-danger"], ["medium", "Medium", "text-warn"], ["low", "Low", "text-ink-muted"]] as const).map(([k, l, c]) => (
          <Surface key={k} className="p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">{l}</div>
            <div className={cn("font-mono text-2xl font-bold tabular-nums", c)}>{counts[k]}</div>
          </Surface>
        ))}
        <Surface className="p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">Meetings booked</div>
          <div className="font-mono text-2xl font-bold tabular-nums text-good">{counts.meetings}</div>
        </Surface>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl border border-line bg-surface p-1 shadow-card">
          {(["all", "high", "medium", "low"] as const).map((p) => (
            <button key={p} onClick={() => setPrio(p)}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition", prio === p ? "bg-primary text-primary-fg" : "text-ink-muted hover:bg-surface-muted hover:text-ink")}>
              {p}
            </button>
          ))}
        </div>
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted shadow-card outline-none focus:ring-2 focus:ring-primary/30">
          <option value="all">All reps ({reps.length})</option>
          {reps.map((id) => <option key={id} value={id}>{REPS[id] ?? id}</option>)}
        </select>
      </div>

      {rows.length === 0 ? <Surface className="p-6 text-center text-sm text-ink-subtle">No accounts match this filter.</Surface> : (
        <div className="space-y-2.5">
          {rows.map((w) => (
            <Surface key={w.accountId} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Flame className="h-4 w-4 shrink-0 text-hot" />
                  <a href={companyUrl(w.accountId)} target="_blank" rel="noopener noreferrer" className="truncate font-semibold text-ink hover:text-primary">{w.accountName ?? w.accountId}</a>
                  <ExternalLink className="h-3 w-3 shrink-0 text-ink-subtle" />
                  <span className="text-xs text-ink-subtle">· {REPS[w.repId ?? ""] ?? w.repId}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {w.priority && <Chip tone={PRIO_TONE[w.priority]} className="uppercase">{w.priority}</Chip>}
                  <Chip tone={STATUS_TONE[w.status]}>{STATUS_LABEL[w.status]}</Chip>
                </div>
              </div>
              {w.reason && <p className="mt-2 text-sm text-ink-muted">{w.reason}</p>}
              {w.nextStep && (
                <div className="mt-2 flex items-start gap-2 rounded-xl bg-primary-weak px-3 py-2 text-sm text-primary">
                  <ArrowRight className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="font-medium">{w.nextStep}</span>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-subtle">
                <span>Reviewed {ago(w.lastReviewedAt)}</span>
                {w.confidence != null && <span>Confidence {Math.round(w.confidence * 100)}%</span>}
                {w.model && <span className="font-mono">{w.model}</span>}
              </div>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
