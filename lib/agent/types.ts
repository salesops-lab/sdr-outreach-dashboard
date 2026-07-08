/** Types for the hot-account AI agent (Phase 4). */

export type WatchStatus = "watching" | "meeting_booked" | "drop_off" | "closed";
export type Priority = "high" | "medium" | "low";

/** A hot (or watched) account surfaced from the snapshot for the agent to reason about. */
export interface HotAccount {
  accountId: string; // rooftop company id
  accountName: string;
  repId: string; // owning rep
  repName: string;
  temp: "hot" | "warm" | "cold";
  tempReason: string;
  stage?: string;
  meetings: number;
  highIntent: number;
  connected: number;
  opened: number;
  replied: number;
  calls: number;
  emails: number;
  disqualified: boolean;
  lastSignalMs: number | null;
}

/** A persisted watch row (sdr_agent_watches). */
export interface AgentWatch {
  accountId: string;
  accountName: string | null;
  repId: string | null;
  status: WatchStatus;
  temp: string | null;
  reason: string | null;
  nextStep: string | null;
  priority: Priority | null;
  confidence: number | null;
  enteredHotAt: string | null;
  lastSignalMs: number | null;
  lastReviewedAt: string | null;
  model: string | null;
}

/** The agent's structured verdict for one account (OpenAI JSON output, validated). */
export interface AgentVerdict {
  why_hot: string; // buyer-intent justification, citing the signal
  next_step: string; // one concrete recommended action for the SDR
  priority: Priority;
  status: WatchStatus; // watching | meeting_booked | drop_off | closed
  confidence: number; // 0..1
}

/** Assembled reasoning context for one account (fed to the model). */
export interface AccountContext {
  account: HotAccount;
  coachingSummary: string | null; // distilled rep-level coaching (call-scoring project)
  callSnippets: string[]; // quoted call moments / recommended actions
  content: string[]; // raw call notes / transcript / email subjects (when ingested)
}
