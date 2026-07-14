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

export interface TimelineEvent {
  hsId: string;
  type: "call" | "email";
  tsMs: number;
  dateStr: string;
  disposition: string | null;
  emailStatus: string | null;
  emailOpened: boolean;
  emailReplied: boolean;
  emailClicked: boolean;
  contacts: {
    hsId: string;
    name: string | null;
    title: string | null;
    dm: boolean;
  }[];
  content: {
    callTitle: string | null;
    callBody: string | null;
    callSummary: string | null;
    transcript: string | null;
    emailSubject: string | null;
    emailBody: string | null; // hs_email_text — the full plain-text body
  } | null;
}

/** Assembled reasoning context for one account (fed to the model). */
export interface AccountContext {
  account: HotAccount;
  coachingSummary: string | null; // distilled rep-level coaching (call-scoring project)
  callSnippets: string[]; // quoted call moments / recommended actions
  timeline: TimelineEvent[]; // chronological activity timeline
}

/** A grounded per-account brief (blueprint §7.2) — synthesized from the activity timeline +
 *  call content; every signal/objection carries its dated evidence. Stored in sdr_agent_briefs. */
export interface AgentBrief {
  accountId: string;
  accountName: string | null;
  repId: string | null;
  summary: string; // 2-3 sentences: where this account stands and why
  stakeholders: { name: string; title: string | null; read: string }[]; // read = the model's take
  buyingSignals: { point: string; evidence: string }[];
  objections: { point: string; evidence: string }[];
  nextStep: string;
  confidence: number; // 0..1 — low when evidence is thin
  model: string | null;
  generatedAt: string | null;
}

