"use client";

/**
 * Account side panel (V3 P2d): everything about one rooftop in a slide-over — the deal journey
 * (stage-event flow), the agent's recommended next step, and the unified activity timeline
 * (calls / emails / stage entries, newest first, SDR vs AE color-coded, who → whom → outcome).
 * Data from /api/account/[companyId]/timeline; assembly is pure (lib/sync/account-timeline.ts).
 */
import { useEffect, useState } from "react";
import { Phone, Mail, GitCommitHorizontal, Loader2, ChevronRight, Sparkles } from "lucide-react";
import RepDrawer from "./RepDrawer";
import { companyUrl, dealUrl } from "../config/hubspot";
import { cn, Chip } from "./ui";
import { AccountTimelinePayload, TimelineItem } from "../lib/sync/account-timeline";

const KIND_CHIP: Record<"sdr" | "ae", string> = {
  sdr: "bg-primary-weak text-primary",
  ae: "bg-good-weak text-good",
};

function etDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString("en-US", {
      timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }) + " ET";
  } catch { return "—"; }
}

export default function AccountTimeline({ account, onClose }: {
  account: { id: string; name: string };
  onClose: () => void;
}) {
  const [data, setData] = useState<AccountTimelinePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/account/${account.id}/timeline`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText); return r.json(); })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [account.id]);

  return (
    <RepDrawer
      title={data?.account.name ?? account.name}
      subtitle={data?.account.owner_name ? `Owner: ${data.account.owner_name}` : undefined}
      badge={<a href={companyUrl(account.id)} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-primary hover:underline">HubSpot ↗</a>}
      onClose={onClose}
    >
      {error && <p className="text-sm text-warn">⚠ {error}</p>}
      {!error && !data && (
        <p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading account history…</p>
      )}
      {data && (
        <div className="space-y-5">
          {data.watch && (data.watch.reason || data.watch.next_step) && (
            <div className="rounded-card border border-primary/25 bg-primary-weak/60 p-3.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                <Sparkles className="h-3.5 w-3.5" /> Agent
                {data.watch.priority && <Chip tone="primary" className="ml-1 px-1.5 py-0 text-[9px] uppercase">{data.watch.priority}</Chip>}
              </div>
              {data.watch.reason && <p className="text-sm text-ink">{data.watch.reason}</p>}
              {data.watch.next_step && <p className="mt-1 text-sm text-ink-muted"><span className="font-semibold text-ink">Next:</span> {data.watch.next_step}</p>}
            </div>
          )}

          {data.deals.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Deal journey</div>
              <div className="space-y-2">
                {data.deals.map((d) => (
                  <div key={d.id} className="rounded-card border border-line bg-surface p-3">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <a href={dealUrl(d.id)} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary hover:underline">Deal {d.id} ↗</a>
                      <span className="rounded-full bg-surface-muted px-2 py-0.5 font-medium text-ink-muted">{d.stage_label}</span>
                      {d.amount != null && <span className="tabular-nums text-ink-subtle">${d.amount.toLocaleString("en-US")}</span>}
                    </div>
                    {d.events.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1 text-[11px]">
                        {d.events.map((e, i) => (
                          <span key={`${e.stage_key}-${e.entered_ms}`} className="inline-flex items-center gap-1">
                            {i > 0 && <ChevronRight className="h-3 w-3 text-ink-subtle" />}
                            <span className={cn("rounded px-1.5 py-0.5 font-medium tabular-nums",
                              i === d.events.length - 1 ? "bg-primary-weak text-primary" : "bg-surface-muted text-ink-muted")}>
                              {e.label} <span className="opacity-70">{etDateTime(e.entered_ms).replace(/,.*$/, "")}</span>
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : <p className="text-[11px] italic text-ink-subtle">No stage history recorded yet.</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
              Activity timeline · {data.items.length} events{data.activity_capped ? " (most recent)" : ""}
            </div>
            {data.items.length === 0
              ? <p className="text-sm text-ink-subtle">No tracked activity on this account.</p>
              : (
                <div className="space-y-1">
                  {data.items.map((it, i) => <TimelineRow key={i} it={it} />)}
                </div>
              )}
          </div>
        </div>
      )}
    </RepDrawer>
  );
}

function TimelineRow({ it }: { it: TimelineItem }) {
  if (it.kind === "stage") {
    return (
      <div className="flex items-center gap-2 rounded-lg border-l-2 border-primary/60 bg-surface-muted/60 px-3 py-1.5 text-xs">
        <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="font-medium text-ink">Deal entered <span className="text-primary">{it.label}</span></span>
        <span className="ml-auto shrink-0 tabular-nums text-ink-subtle">{etDateTime(it.ts)}</span>
      </div>
    );
  }
  const Icon = it.kind === "call" ? Phone : Mail;
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-surface-muted/60">
      <Icon className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
      <span className={cn("shrink-0 rounded px-1.5 py-0 text-[10px] font-semibold", it.owner_kind ? KIND_CHIP[it.owner_kind] : "bg-surface-muted text-ink-subtle")}
        title={it.owner_kind ? it.owner_kind.toUpperCase() : "untracked owner"}>
        {it.owner_name}
      </span>
      <span className="min-w-0 truncate text-ink-muted">
        {it.contact ? <>→ <span className="font-medium text-ink">{it.contact.name}</span>{it.contact.dm && <span className="ml-1 rounded bg-primary-weak px-1 text-[9px] font-semibold text-primary">DM</span>}</> : "→ (no contact)"}
      </span>
      <span className="shrink-0 text-ink-muted">· {it.outcome}</span>
      {it.kind === "email" && (it.replied || it.opened) && (
        <span className={cn("shrink-0 rounded px-1 py-0 text-[9px] font-semibold", it.replied ? "bg-good-weak text-good" : "bg-surface-muted text-ink-muted")}>
          {it.replied ? "replied" : "opened"}
        </span>
      )}
      <span className="ml-auto shrink-0 tabular-nums text-ink-subtle">{etDateTime(it.ts)}</span>
    </div>
  );
}
