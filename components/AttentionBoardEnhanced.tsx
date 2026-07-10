"use client";

import { useMemo, useState, useEffect, useCallback, Fragment } from "react";
import {
  Flame, ExternalLink, ArrowRight, Sparkles, ChevronDown, ChevronUp, 
  Copy, Check, Mail, Phone, User, Star, Clock, PlayCircle, PauseCircle, 
  XCircle, RefreshCw, Calendar, TrendingUp, TrendingDown
} from "lucide-react";
import { AgentWatch, Priority, WatchStatus } from "../lib/agent/types";
import { REPS } from "../config/reps";
import { companyUrl } from "../config/hubspot";
import { Surface, Chip, cn } from "./ui";
import { TEMP_CHIP_WEAK, TEMP_LABEL } from "./ui-tokens";
import {
  calculateRankScore,
  sortWatchesByRank,
  enhanceWatches,
  groupWatchesByWorkflow,
  WorkflowStatus,
  RankedWatch,
} from "../lib/agent/ranking";
import {
  loadActions,
  getAction,
  markInProgress,
  markCompleted,
  snoozeWatch,
  resetWatch,
  initActionsListener,
  closeActionsListener,
  WatchAction,
} from "../lib/agent/actions";
import { MarketSegment } from "../lib/sync/types";

interface NextStepDetails {
  action: string;
  contactName: string | null;
  contactTitle: string | null;
  channel: "call" | "email";
  helperText: string;
}

const PRIO_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const PRIO_TONE: Record<Priority, "danger" | "warn" | "neutral"> = { high: "danger", medium: "warn", low: "neutral" };
const STATUS_TONE: Record<WatchStatus, "primary" | "good" | "neutral"> = {
  watching: "primary", meeting_booked: "good", drop_off: "neutral", closed: "neutral",
};
const STATUS_LABEL: Record<WatchStatus, string> = {
  watching: "Watching", meeting_booked: "Meeting booked", drop_off: "Dropped off", closed: "Closed",
};

// Workflow status display labels
const WORKFLOW_LABEL: Record<WorkflowStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  completed: "Completed",
  snoozed: "Snoozed",
};

// Workflow status colors
const WORKFLOW_COLOR: Record<WorkflowStatus, string> = {
  not_started: "bg-surface-muted text-ink-muted",
  in_progress: "bg-primary-weak text-primary",
  completed: "bg-good-weak text-good",
  snoozed: "bg-warn-weak text-warn",
};

function formatSignalDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "2-digit",
      year: "numeric",
    });
  } catch { return "—"; }
}

function formatReviewedTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " ET";
  } catch { return "—"; }
}

function formatSnoozeUntil(iso: string | null): string {
  if (!iso) return "—";
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays <= 0) return "Expired";
    if (diffDays === 1) return "1 day";
    return `${diffDays} days`;
  } catch { return "—"; }
}

function getWorkflowIcon(status: WorkflowStatus) {
  switch (status) {
    case "not_started":
      return <PlayCircle className="h-3.5 w-3.5" />;
    case "in_progress":
      return <PauseCircle className="h-3.5 w-3.5" />;
    case "completed":
      return <Check className="h-3.5 w-3.5" />;
    case "snoozed":
      return <Clock className="h-3.5 w-3.5" />;
    default:
      return null;
  }
}

// Snooze duration options
const SNOOZE_OPTIONS = [
  { days: 1, label: "1 day" },
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
];

export default function AttentionBoardEnhanced({ watches }: { watches: AgentWatch[] }) {
  const [repFilter, setRepFilter] = useState("all");
  const [prio, setPrio] = useState<"all" | Priority>("all");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actions, setActions] = useState<Map<string, WatchAction>>(new Map());
  const [showSnoozeMenu, setShowSnoozeMenu] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "kanban">("list");

  // Load actions from localStorage on mount
  useEffect(() => {
    setActions(loadActions());
    initActionsListener(() => {
      setActions(loadActions());
    });
    
    return () => {
      closeActionsListener();
    };
  }, []);

  // Build segment map from watches (we'll use temp as a proxy for now)
  const segmentMap = useMemo(() => {
    const map = new Map<string, MarketSegment | string>();
    for (const watch of watches) {
      if (watch.temp) {
        map.set(watch.accountId, watch.temp);
      }
    }
    return map;
  }, [watches]);

  // Build action map for enhancement
  const actionMap = useMemo(() => {
    const map = new Map<string, { status: WorkflowStatus; lastActionAt: string | null }>();
    for (const [accountId, action] of actions) {
      map.set(accountId, { status: action.status, lastActionAt: action.lastActionAt });
    }
    return map;
  }, [actions]);

  // Enhance watches with rank and workflow status
  const enhancedWatches = useMemo(() => {
    return enhanceWatches(watches, segmentMap, actionMap);
  }, [watches, segmentMap, actionMap]);

  // Sort by rank
  const sortedWatches = useMemo(() => {
    return sortWatchesByRank(enhancedWatches, segmentMap);
  }, [enhancedWatches, segmentMap]);

  // Filter watches
  const filteredWatches = useMemo(() => {
    return sortedWatches
      .filter((w) => w.status !== "closed" && w.status !== "drop_off")
      .filter((w) => (repFilter === "all" || w.repId === repFilter) && (prio === "all" || w.priority === prio));
  }, [sortedWatches, repFilter, prio]);

  // Group by workflow for kanban view
  const workflowGroups = useMemo(() => {
    return groupWatchesByWorkflow(filteredWatches as RankedWatch[]);
  }, [filteredWatches]);

  // Counts for stats
  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0, meetings: 0, total: 0 };
    for (const w of watches) {
      if (w.status === "meeting_booked") c.meetings++;
      else if (w.status === "watching" && w.priority) c[w.priority]++;
      c.total++;
    }
    return c;
  }, [watches]);

  // Workflow counts
  const workflowCounts = useMemo(() => {
    const c: Record<WorkflowStatus, number> = { not_started: 0, in_progress: 0, completed: 0, snoozed: 0 };
    for (const w of filteredWatches as RankedWatch[]) {
      c[w.workflowStatus]++;
    }
    return c;
  }, [filteredWatches]);

  const reps = useMemo(
    () => [...new Set(watches.map((w) => w.repId).filter(Boolean))] as string[],
    [watches],
  );

  // Handle workflow status change
  const handleStatusChange = useCallback((accountId: string, status: WorkflowStatus) => {
    switch (status) {
      case "in_progress":
        markInProgress(accountId);
        break;
      case "completed":
        markCompleted(accountId);
        break;
      case "not_started":
        resetWatch(accountId);
        break;
    }
    setActions(loadActions());
  }, []);

  // Handle snooze
  const handleSnooze = useCallback((accountId: string, days: number) => {
    snoozeWatch(accountId, days);
    setActions(loadActions());
    setShowSnoozeMenu(null);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleCopy = useCallback((id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  // Quick action handlers
  const handleQuickAction = useCallback((accountId: string, actionType: "call" | "email") => {
    markInProgress(accountId);
    markCompleted(accountId, actionType);
    setActions(loadActions());
  }, []);

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
      {/* Stats Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
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
        <Surface className="p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">Total Watches</div>
          <div className="font-mono text-2xl font-bold tabular-nums">{counts.total}</div>
        </Surface>
        <Surface className="p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">In Progress</div>
          <div className="font-mono text-2xl font-bold tabular-nums text-primary">{workflowCounts.in_progress}</div>
        </Surface>
      </div>

      {/* View Mode Toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl border border-line bg-surface p-1 shadow-card">
          <button
            onClick={() => setViewMode("list")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition",
              viewMode === "list" 
                ? "bg-primary text-primary-fg" 
                : "text-ink-muted hover:bg-surface-muted hover:text-ink"
            )}
          >
            List View
          </button>
          <button
            onClick={() => setViewMode("kanban")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition",
              viewMode === "kanban" 
                ? "bg-primary text-primary-fg" 
                : "text-ink-muted hover:bg-surface-muted hover:text-ink"
            )}
          >
            Kanban View
          </button>
        </div>

        <div className="flex gap-1 rounded-xl border border-line bg-surface p-1 shadow-card">
          {((["all", "high", "medium", "low"] as const)).map((p) => (
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

      {filteredWatches.length === 0 ? (
        <Surface className="p-6 text-center text-sm text-ink-subtle">No accounts match this filter.</Surface>
      ) : viewMode === "kanban" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {(Object.entries(workflowGroups) as [WorkflowStatus, RankedWatch[]][]).map(([status, groupWatches]) => (
            <div key={status} className="space-y-2">
              <div className="flex items-center gap-2 px-2">
                <span className={cn("p-1 rounded", WORKFLOW_COLOR[status])}>
                  {getWorkflowIcon(status)}
                </span>
                <span className="font-semibold text-sm text-ink">{WORKFLOW_LABEL[status]}</span>
                <span className="text-xs text-ink-muted bg-surface-muted px-1.5 py-0.5 rounded-full">{groupWatches.length}</span>
              </div>
              
              <div className="space-y-2">
                {groupWatches
                  .sort((a, b) => b.rank - a.rank)
                  .map((w) => {
                    let details: NextStepDetails | null = null;
                    try {
                      if (w.nextStep && w.nextStep.startsWith("{")) {
                        details = JSON.parse(w.nextStep);
                      }
                    } catch {}

                    const action = getAction(w.accountId);
                    const isSnoozed = w.workflowStatus === "snoozed";
                    const isExpired = isSnoozed && action?.snoozedUntil && new Date(action.snoozedUntil) <= new Date();

                    return (
                      <div
                        key={w.accountId}
                        className={cn(
                          "p-3 rounded-xl border border-line bg-surface shadow-card hover:shadow-card-hover transition-shadow cursor-pointer",
                          isExpired && "border-warn/50 bg-warn-weak/20"
                        )}
                        onClick={() => toggleExpand(w.accountId)}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Flame className="h-4 w-4 shrink-0 text-hot" />
                              <a 
                                href={companyUrl(w.accountId)} 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="font-semibold text-ink hover:text-primary hover:underline truncate"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {w.accountName ?? w.accountId}
                              </a>
                              <ExternalLink className="h-3 w-3 shrink-0 text-ink-subtle" />
                            </div>
                            
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                              <span className="font-medium text-ink-muted">{REPS[w.repId ?? ""] ?? w.repId}</span>
                              <span className="text-ink-subtle">•</span>
                              <span className={cn("px-1.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider", TEMP_CHIP_WEAK[w.temp ?? "cold"])}>
                                {TEMP_LABEL[w.temp ?? "cold"]}
                              </span>
                              <span className="text-ink-subtle">•</span>
                              <span className="text-ink-subtle">Rank: {(w as RankedWatch).rank.toFixed(0)}</span>
                              {isSnoozed && action?.snoozedUntil && (
                                <>
                                  <span className="text-ink-subtle">•</span>
                                  <span className="flex items-center gap-0.5 text-warn">
                                    <Clock className="h-3 w-3" />
                                    {formatSnoozeUntil(action.snoozedUntil)}
                                  </span>
                                </>
                              )}
                            </div>

                            <div className="mt-2 text-xs text-ink-muted line-clamp-2">
                              {w.reason}
                            </div>

                            {details && (
                              <div className="mt-2 p-2 bg-surface-muted rounded-lg">
                                <div className="flex items-center gap-1.5 text-xs text-primary font-semibold">
                                  <ArrowRight className="h-3 w-3 shrink-0" />
                                  <span>{details.action}</span>
                                </div>
                                {details.helperText && (
                                  <span className="inline-flex items-center gap-1 rounded bg-primary text-[10px] text-white px-1.5 py-0.5 font-bold uppercase cursor-pointer hover:bg-primary-hover shadow-sm mt-1">
                                    {details.channel === "call" ? <Phone className="h-2.5 w-2.5" /> : <Mail className="h-2.5 w-2.5" />}
                                    {details.channel === "call" ? "Call Script" : "Email Template"}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Quick Actions */}
                        <div className="flex gap-1 mt-2 pt-2 border-t border-line/60" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleQuickAction(w.accountId, "call")}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-primary transition"
                            title="Log call"
                          >
                            <Phone className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleQuickAction(w.accountId, "email")}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-primary transition"
                            title="Send email"
                          >
                            <Mail className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => {
                              if (w.workflowStatus === "snoozed") {
                                resetWatch(w.accountId);
                              } else {
                                setShowSnoozeMenu(showSnoozeMenu === w.accountId ? null : w.accountId);
                              }
                              setActions(loadActions());
                            }}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-warn transition"
                            title={w.workflowStatus === "snoozed" ? "Unsnooze" : "Snooze"}
                          >
                            <Clock className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleStatusChange(w.accountId, "completed")}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-good transition"
                            title="Mark complete"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                        </div>

                        {/* Snooze Menu */}
                        {showSnoozeMenu === w.accountId && (
                          <div className="absolute right-0 mt-2 w-40 bg-surface border border-line rounded-xl shadow-card p-2 z-50">
                            <div className="px-2 py-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                              Snooze for
                            </div>
                            {SNOOZE_OPTIONS.map((option) => (
                              <button
                                key={option.days}
                                onClick={() => handleSnooze(w.accountId, option.days)}
                                className="w-full px-2 py-1.5 text-sm text-ink hover:bg-surface-muted rounded-lg transition flex items-center gap-2"
                              >
                                <Clock className="h-4 w-4 text-ink-muted" />
                                {option.label}
                              </button>
                            ))}
                          </div>
                        )}

                        {expandedIds[w.accountId] && details && (
                          <div className="mt-3 pt-3 border-t border-line">
                            <pre className="p-3 bg-surface-muted rounded-xl text-xs text-ink font-mono border border-line overflow-x-auto whitespace-pre-wrap leading-relaxed shadow-inner max-h-[200px]">
                              {details.helperText}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-left text-sm text-ink">
            <thead className="bg-surface-muted/60 text-xs font-semibold uppercase tracking-wider text-ink-muted border-b border-line">
              <tr>
                <th className="px-4 py-3.5 min-w-[80px]">Rank</th>
                <th className="px-4 py-3.5 min-w-[120px]">SDR</th>
                <th className="px-4 py-3.5 min-w-[160px]">Company</th>
                <th className="px-4 py-3.5 min-w-[150px]">Contact</th>
                <th className="px-4 py-3.5 text-center w-[80px]">Temp</th>
                <th className="px-4 py-3.5 min-w-[110px]">Last Activity</th>
                <th className="px-4 py-3.5 min-w-[100px]">Status</th>
                <th className="px-4 py-3.5 min-w-[220px]">Hot Reason</th>
                <th className="px-4 py-3.5 min-w-[240px]">Next Touch Action</th>
                <th className="px-4 py-3.5 w-[100px]">Quick Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredWatches.map((w) => {
                let details: NextStepDetails | null = null;
                try {
                  if (w.nextStep && w.nextStep.startsWith("{")) {
                    details = JSON.parse(w.nextStep);
                  }
                } catch {}

                const isExpanded = !!expandedIds[w.accountId];
                const hasHelper = details && details.helperText;
                const action = getAction(w.accountId);

                return (
                  <Fragment key={w.accountId}>
                    <tr className={cn(
                      "hover:bg-surface-muted/30 transition-colors cursor-pointer align-top",
                      isExpanded && "bg-primary-weak/10 hover:bg-primary-weak/20"
                    )} onClick={() => toggleExpand(w.accountId)}>
                      <td className="px-4 py-4 font-mono font-bold text-center">
                        {(w as RankedWatch).rank.toFixed(0)}
                      </td>
                      <td className="px-4 py-4 font-medium text-ink-muted">
                        {REPS[w.repId ?? ""] ?? w.repId}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <Flame className="h-4 w-4 shrink-0 text-hot" />
                          <a href={companyUrl(w.accountId)} target="_blank" rel="noopener noreferrer" className="font-semibold text-ink hover:text-primary hover:underline truncate">
                            {w.accountName ?? w.accountId}
                          </a>
                          <ExternalLink className="h-3 w-3 shrink-0 text-ink-subtle" />
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        {details ? (
                          details.contactName ? (
                            <div className="space-y-0.5">
                              <div className="font-medium flex items-center gap-1">
                                <User className="h-3 w-3 text-ink-muted" />
                                <span className="truncate">{details.contactName}</span>
                              </div>
                              {details.contactTitle && (
                                <div className="text-xs text-ink-subtle truncate pl-4">
                                  {details.contactTitle}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-ink-subtle italic">—</span>
                          )
                        ) : (
                          <span className="text-ink-subtle italic">See action</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-center">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider", TEMP_CHIP_WEAK[w.temp ?? "cold"])}>
                          {TEMP_LABEL[w.temp ?? "cold"]}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-ink-muted whitespace-nowrap">
                        {formatSignalDate(w.lastSignalMs)}
                      </td>
                      <td className="px-4 py-4">
                        <span className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold",
                          WORKFLOW_COLOR[(w as RankedWatch).workflowStatus]
                        )}>
                          {getWorkflowIcon((w as RankedWatch).workflowStatus)}
                          {WORKFLOW_LABEL[(w as RankedWatch).workflowStatus]}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-ink-muted text-xs leading-relaxed max-w-[300px]">
                        {w.reason}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-start gap-1.5 text-xs text-primary font-semibold">
                            <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{details ? details.action : w.nextStep}</span>
                          </div>
                          {details && details.helperText && (
                            <span className="inline-flex self-start items-center gap-1 rounded bg-primary text-[10px] text-white px-1.5 py-0.5 font-bold uppercase cursor-pointer hover:bg-primary-hover shadow-sm">
                              {details.channel === "call" ? <Phone className="h-2.5 w-2.5" /> : <Mail className="h-2.5 w-2.5" />}
                              {details.channel === "call" ? "Call Script" : "Email Template"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex gap-1 justify-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickAction(w.accountId, "call");
                            }}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-primary transition"
                            title="Log call"
                          >
                            <Phone className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickAction(w.accountId, "email");
                            }}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-primary transition"
                            title="Send email"
                          >
                            <Mail className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const action = getAction(w.accountId);
                              if (action?.status === "snoozed") {
                                resetWatch(w.accountId);
                              } else {
                                setShowSnoozeMenu(showSnoozeMenu === w.accountId ? null : w.accountId);
                              }
                              setActions(loadActions());
                            }}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-warn transition"
                            title={action?.status === "snoozed" ? "Unsnooze" : "Snooze"}
                          >
                            <Clock className="h-4 w-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStatusChange(w.accountId, "completed");
                            }}
                            className="p-1.5 rounded-lg text-ink-muted hover:bg-surface-muted hover:text-good transition"
                            title="Mark complete"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                        </div>
                        
                        {/* Snooze Menu */}
                        {showSnoozeMenu === w.accountId && (
                          <div className="absolute right-4 mt-2 w-40 bg-surface border border-line rounded-xl shadow-card p-2 z-50">
                            <div className="px-2 py-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wider">
                              Snooze for
                            </div>
                            {SNOOZE_OPTIONS.map((option) => (
                              <button
                                key={option.days}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSnooze(w.accountId, option.days);
                                }}
                                className="w-full px-2 py-1.5 text-sm text-ink hover:bg-surface-muted rounded-lg transition flex items-center gap-2"
                              >
                                <Clock className="h-4 w-4 text-ink-muted" />
                                {option.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-surface-muted/20">
                        <td colSpan={10} className="px-6 py-4 border-b border-line">
                          <div className="rounded-xl border border-line bg-surface p-4 shadow-sm space-y-4">
                            <div className="flex items-center justify-between border-b border-line pb-2.5">
                              <div className="flex items-center gap-2">
                                <Sparkles className="h-4.5 w-4.5 text-primary" />
                                <span className="font-bold text-ink">Deep Agent Action Plan & Helper Draft</span>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-ink-subtle">
                                <span>Reviewed {formatReviewedTime(w.lastReviewedAt)}</span>
                                {w.confidence != null && <span>Confidence {Math.round(w.confidence * 100)}%</span>}
                                {w.model && <span className="font-mono bg-surface-muted px-1.5 py-0.5 rounded">{w.model}</span>}
                              </div>
                            </div>
                            
                            {details ? (
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="space-y-3 border-r border-line/60 pr-4 md:col-span-1">
                                  <div>
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-ink-subtle">Target Prospect</div>
                                    <div className="mt-1 flex items-start gap-1.5">
                                      <div className="h-8 w-8 rounded-full bg-primary-weak text-primary flex items-center justify-center font-bold text-xs uppercase shrink-0">
                                        {details.contactName ? details.contactName.charAt(0) : "P"}
                                      </div>
                                      <div>
                                        <div className="font-semibold text-sm text-ink">{details.contactName || "Unknown Contact"}</div>
                                        <div className="text-xs text-ink-muted">{details.contactTitle || "No Title Listed"}</div>
                                      </div>
                                    </div>
                                  </div>
                                  
                                  <div>
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-ink-subtle">Outreach Channel</div>
                                    <div className="mt-1.5">
                                      <span className={cn(
                                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wider",
                                        details.channel === "call" ? "bg-blue-100 text-blue-800" : "bg-green-100 text-green-800"
                                      )}>
                                        {details.channel === "call" ? <Phone className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
                                        {details.channel === "call" ? "Phone Call" : "Email"}
                                      </span>
                                    </div>
                                  </div>

                                  <div>
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-ink-subtle">Action Command</div>
                                    <div className="mt-1 text-xs text-ink leading-relaxed font-medium">
                                      {details.action}
                                    </div>
                                  </div>
                                </div>
                                
                                <div className="md:col-span-2 space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-ink-subtle">
                                      {details.channel === "call" ? "SDR Call Script" : "Personalized Email Draft"}
                                    </div>
                                    {details.helperText && (
                                      <button 
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleCopy(w.accountId, details.helperText);
                                        }}
                                        className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-hover px-2 py-1 rounded hover:bg-primary-weak/40 transition"
                                      >
                                        {copiedId === w.accountId ? (
                                          <>
                                            <Check className="h-3.5 w-3.5" />
                                            <span>Copied!</span>
                                          </>
                                        ) : (
                                          <>
                                            <Copy className="h-3.5 w-3.5" />
                                            <span>Copy Draft</span>
                                          </>
                                        )}
                                      </button>
                                    )}
                                  </div>
                                  {details.helperText ? (
                                    <pre className="p-3 bg-surface-muted rounded-xl text-xs text-ink font-mono border border-line overflow-x-auto whitespace-pre-wrap leading-relaxed shadow-inner max-h-[220px]">
                                      {details.helperText}
                                    </pre>
                                  ) : (
                                    <div className="p-3 bg-surface-muted/65 rounded-xl text-xs text-ink-subtle italic border border-line/60">
                                      No script or email template details were generated for this next step.
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-ink-subtle">Plain Text Next Step</div>
                                <p className="text-sm text-ink font-medium bg-surface-muted p-3 rounded-xl border border-line leading-relaxed">
                                  {w.nextStep}
                                </p>
                                <p className="text-xs text-ink-subtle italic">
                                  Note: This action recommendation was generated by an older agent run and does not contain detailed target scripts or target contact name mapping.
                                </p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
