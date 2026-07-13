/**
 * Account Briefs (blueprint §7.2): a grounded per-account synthesis — summary, stakeholders,
 * buying signals, objections, next step — generated from the activity timeline + raw call/email
 * content (sdr_activity_content) and the account's deals. Every signal/objection must carry its
 * dated evidence; thin evidence lowers confidence rather than inviting invention. Stored in
 * sdr_agent_briefs (one row per account, refreshed when stale); read-only on HubSpot.
 */
import "server-only";
import { supabaseAdmin } from "../supabase/admin";
import { loadTimelineForAccount } from "./timeline";
import { getWatches } from "./store";
import { completeJSON, AGENT_MODEL, isConfigured } from "./openai";
import { AgentBrief } from "./types";
import { stageKey, stageLabel } from "../../config/deal-stages";

const FRESH_MS = 20 * 3_600_000; // don't regenerate briefs younger than ~20h
const TIMELINE_EVENTS = 25;
const TRANSCRIPT_CAP = 700; // chars per transcript excerpt in the prompt

export const BRIEF_SYSTEM_PROMPT = `You are a revenue-intelligence analyst for an automotive-dealership software sales team.
Synthesize ONE account brief from the provided deal state and activity evidence (call notes, AI call summaries, transcript excerpts, email engagement).
Rules:
- Ground EVERY claim in the provided evidence. Never invent names, quotes, dates, or intent.
- Every buying_signal and objection must cite its evidence: paraphrase or quote it WITH the activity date, e.g. "asked about per-rooftop pricing (call, Jul 08)".
- If the evidence is thin or stale, say so plainly in the summary and lower confidence.
- next_step: ONE concrete action the rep should take next, grounded in the evidence.
Return STRICT JSON:
{"summary": "2-3 sentences on where this account stands and why",
 "stakeholders": [{"name": "...", "title": "... or null", "read": "one-line read on their role/disposition"}],
 "buying_signals": [{"point": "...", "evidence": "... (channel, date)"}],
 "objections": [{"point": "...", "evidence": "... (channel, date)"}],
 "next_step": "...",
 "confidence": 0.0}`;

/** Assemble the user prompt: deal state header + the recent timeline with content. */
export async function buildBriefUser(accountId: string, accountName: string, repName: string | null): Promise<string | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const timeline = await loadTimelineForAccount(accountId, TIMELINE_EVENTS);
  if (timeline.length === 0) return null; // nothing to ground on — no brief

  // Deal state (columns that exist since V2 — safe pre-V3.1).
  const { data: dealRows } = await db.from("sdr_deals")
    .select("pipeline,dealstage,amount,demo_scheduled_for_ms")
    .eq("company_id", accountId);
  const dealLines = (dealRows ?? []).map((d) => {
    const label = stageLabel(stageKey(d.pipeline, d.dealstage));
    const amt = d.amount != null ? ` · $${Number(d.amount).toLocaleString("en-US")}` : "";
    const demo = d.demo_scheduled_for_ms
      ? ` · demo ${new Date(Number(d.demo_scheduled_for_ms)).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" })}`
      : "";
    return `- Deal at ${label}${amt}${demo}`;
  });

  const lines = timeline.map((e) => {
    const who = e.contacts.map((c) => `${c.name ?? "?"}${c.title ? ` (${c.title})` : ""}`).join(", ") || "(no contact)";
    const outcome = e.type === "call" ? (e.disposition ?? "no disposition") : `${e.emailStatus ?? "sent"}${e.emailReplied ? ", REPLIED" : e.emailOpened ? ", opened" : ""}`;
    const bits: string[] = [`[${e.dateStr}] ${e.type} → ${who} · ${outcome}`];
    if (e.content?.callSummary) bits.push(`summary: ${e.content.callSummary}`);
    else if (e.content?.callBody) bits.push(`notes: ${e.content.callBody.slice(0, TRANSCRIPT_CAP)}`);
    if (e.content?.transcript) bits.push(`transcript: "${e.content.transcript.slice(0, TRANSCRIPT_CAP)}"`);
    if (e.content?.emailSubject) bits.push(`subject: ${e.content.emailSubject}`);
    return bits.join(" | ");
  });

  return [
    `ACCOUNT: ${accountName}`,
    repName ? `REP: ${repName}` : null,
    dealLines.length ? `DEALS:\n${dealLines.join("\n")}` : "DEALS: none on record",
    `ACTIVITY (oldest → newest):\n${lines.join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Validate + coerce the model's JSON into an AgentBrief (null if unusable). */
export function coerceBrief(raw: unknown, accountId: string, accountName: string | null, repId: string | null): AgentBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const summary = str(o.summary);
  const nextStep = str(o.next_step);
  if (!summary || !nextStep) return null;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    accountId,
    accountName,
    repId,
    summary,
    stakeholders: arr(o.stakeholders).slice(0, 6)
      .map((s) => ({ name: str(s.name), title: str(s.title) || null, read: str(s.read) }))
      .filter((s) => s.name),
    buyingSignals: arr(o.buying_signals).slice(0, 6)
      .map((s) => ({ point: str(s.point), evidence: str(s.evidence) }))
      .filter((s) => s.point && s.evidence), // no evidence → no claim
    objections: arr(o.objections).slice(0, 5)
      .map((s) => ({ point: str(s.point), evidence: str(s.evidence) }))
      .filter((s) => s.point && s.evidence),
    nextStep,
    confidence: Math.max(0, Math.min(1, typeof o.confidence === "number" ? o.confidence : 0.5)),
    model: AGENT_MODEL,
    generatedAt: new Date().toISOString(),
  };
}

async function upsertBrief(b: AgentBrief): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  const { error } = await db.from("sdr_agent_briefs").upsert({
    account_id: b.accountId, account_name: b.accountName, rep_id: b.repId,
    brief: {
      summary: b.summary, stakeholders: b.stakeholders, buying_signals: b.buyingSignals,
      objections: b.objections, next_step: b.nextStep, confidence: b.confidence,
    },
    model: b.model, generated_at: b.generatedAt,
  }, { onConflict: "account_id" });
  if (error) console.warn("[briefs] upsert:", error.message);
}

interface BriefRow {
  account_id: string; account_name: string | null; rep_id: string | null;
  brief: Record<string, unknown>; model: string | null; generated_at: string | null;
}

function rowToBrief(r: BriefRow): AgentBrief {
  const b = r.brief ?? {};
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    accountId: r.account_id, accountName: r.account_name, repId: r.rep_id,
    summary: str(b.summary), stakeholders: arr(b.stakeholders) as AgentBrief["stakeholders"],
    buyingSignals: arr(b.buying_signals) as AgentBrief["buyingSignals"],
    objections: arr(b.objections) as AgentBrief["objections"],
    nextStep: str(b.next_step),
    confidence: typeof b.confidence === "number" ? b.confidence : 0.5,
    model: r.model, generatedAt: r.generated_at,
  };
}

/** All briefs keyed by account id (tolerates the table being absent pre-migration). */
export async function listBriefs(): Promise<Record<string, AgentBrief>> {
  const db = supabaseAdmin();
  if (!db) return {};
  const { data, error } = await db.from("sdr_agent_briefs").select("*");
  if (error) { console.warn("[briefs] list:", error.message); return {}; }
  const out: Record<string, AgentBrief> = {};
  for (const r of (data ?? []) as BriefRow[]) out[r.account_id] = rowToBrief(r);
  return out;
}

export async function getBrief(accountId: string): Promise<AgentBrief | null> {
  const db = supabaseAdmin();
  if (!db) return null;
  const { data, error } = await db.from("sdr_agent_briefs").select("*").eq("account_id", accountId).maybeSingle();
  if (error || !data) return null;
  return rowToBrief(data as BriefRow);
}

export interface BriefsRunResult { skipped: boolean; candidates: number; generated: number; errors: number }

/** One briefs pass: refresh stale/missing briefs for the accounts the agent is watching. */
export async function runBriefs(opts: { limit?: number; nowMs?: number } = {}): Promise<BriefsRunResult> {
  if (!isConfigured()) {
    console.warn("[briefs] OPENAI_API_KEY not set — skipping run");
    return { skipped: true, candidates: 0, generated: 0, errors: 0 };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? 15;

  const watches = await getWatches();
  const existing = await listBriefs();
  const candidates = [...watches.values()]
    .filter((w) => w.status === "watching" || w.status === "meeting_booked")
    .filter((w) => {
      const gen = existing[w.accountId]?.generatedAt;
      return !gen || nowMs - new Date(gen).getTime() > FRESH_MS;
    })
    .sort((a, b) => (b.lastSignalMs ?? 0) - (a.lastSignalMs ?? 0)); // freshest signal first

  let generated = 0, errors = 0;
  for (const w of candidates.slice(0, limit)) {
    try {
      const user = await buildBriefUser(w.accountId, w.accountName ?? w.accountId, null);
      if (!user) continue; // no activity to ground on
      const brief = coerceBrief(await completeJSON(BRIEF_SYSTEM_PROMPT, user), w.accountId, w.accountName, w.repId);
      if (!brief) { errors++; continue; }
      await upsertBrief(brief);
      generated++;
    } catch (e) {
      errors++;
      console.warn(`[briefs] ${w.accountId} failed:`, (e as Error).message);
    }
  }
  console.log(`[briefs] candidates=${candidates.length} generated=${generated} errors=${errors} model=${AGENT_MODEL}`);
  return { skipped: false, candidates: candidates.length, generated, errors };
}
