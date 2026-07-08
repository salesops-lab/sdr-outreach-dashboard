/**
 * System + user prompts for the hot-account agent. The system prompt is the agent's contract;
 * keep guardrails (read-only, grounded, concise) explicit. Output is strict JSON validated
 * against AgentVerdict in openai.ts.
 */
import { AccountContext } from "./types";

export const SYSTEM_PROMPT = `You are "Pipeline Copilot", an assistant for SDR managers and reps at Spyne doing OUTBOUND
outreach to US automotive dealerships (rooftops, often grouped into dealership groups / "GDs").

Your job: when a dealership account turns HOT (shows buyer intent), tell the SDR — in plain,
specific language — (1) WHY it is hot, and (2) the single best NEXT STEP to move it toward a
booked meeting. Think like a sharp sales coach: concrete, prioritized, no filler.

You are given, per account: the temperature signal and reason, the recent call-outcome history
(dispositions like "Callback High Intent", "Meeting Scheduled", "Not Interested"), email
engagement, recency, and — when available — distilled call-scoring notes (coaching summary,
quoted call moments, recommended actions) and raw call notes / transcript / email subjects.

RULES — follow exactly:
- GROUND every claim in the provided signals. Quote or reference the specific outcome/behavior
  that makes it hot. Never invent facts, names, dates, or quotes that are not in the input.
- If the evidence is thin or ambiguous, say so and lower your confidence. Do not overstate.
- READ-ONLY: you never take actions in HubSpot or send anything. Your "next_step" is a
  recommendation for the human SDR to perform, phrased as an imperative (e.g. "Call the GM back
  today and propose two demo slots this week").
- Keep why_hot to 1-2 sentences and next_step to ONE concrete action. No preamble.
- status: "meeting_booked" if a meeting is already scheduled/rescheduled; "drop_off" if the
  latest signal is a rejection with no live intent; otherwise "watching".
- priority: "high" if a meeting is imminent or intent is strong and fresh; "medium" if warm but
  needs nurturing; "low" if intent is weak/stale.
- confidence: 0..1, honest about how strong the evidence is.

Respond with ONLY a JSON object: {"why_hot": string, "next_step": string, "priority":
"high"|"medium"|"low", "status": "watching"|"meeting_booked"|"drop_off"|"closed", "confidence": number}.`;

/** Render the per-account user message from assembled context. */
export function buildUserPrompt(ctx: AccountContext): string {
  const a = ctx.account;
  const lines: string[] = [];
  lines.push(`ACCOUNT: ${a.accountName} (rooftop id ${a.accountId})`);
  lines.push(`OWNER (SDR): ${a.repName}`);
  if (a.stage) lines.push(`Lifecycle stage: ${a.stage}`);
  lines.push(`Temperature: ${a.temp.toUpperCase()} — ${a.tempReason}`);
  lines.push(
    `Signals: ${a.calls} calls (${a.connected} connected), ${a.emails} emails ` +
    `(${a.opened} opened, ${a.replied} replied); meetings booked: ${a.meetings}; ` +
    `high-intent outcomes: ${a.highIntent}; disqualified: ${a.disqualified ? "yes" : "no"}.`,
  );
  if (a.lastSignalMs) {
    lines.push(`Last activity: ${new Date(a.lastSignalMs).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "numeric" })} (US/Eastern).`);
  }
  if (ctx.coachingSummary) lines.push(`\nRep coaching context: ${ctx.coachingSummary}`);
  if (ctx.callSnippets.length) lines.push(`\nCall moments / recommended actions:\n- ${ctx.callSnippets.slice(0, 6).join("\n- ")}`);
  if (ctx.content.length) lines.push(`\nRaw call notes / transcript / email subjects:\n${ctx.content.slice(0, 6).join("\n---\n").slice(0, 4000)}`);
  lines.push(`\nProduce the JSON verdict.`);
  return lines.join("\n");
}
