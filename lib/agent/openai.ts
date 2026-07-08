import "server-only";
import OpenAI from "openai";
import { AccountContext, AgentVerdict, Priority, WatchStatus } from "./types";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

export const AGENT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export function isConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

const PRIORITIES: Priority[] = ["high", "medium", "low"];
const STATUSES: WatchStatus[] = ["watching", "meeting_booked", "drop_off", "closed"];

/** Validate + coerce the model's JSON into a well-formed AgentVerdict (null if unusable). */
function coerce(raw: unknown): AgentVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const why_hot = typeof o.why_hot === "string" ? o.why_hot.trim() : "";
  const next_step = typeof o.next_step === "string" ? o.next_step.trim() : "";
  if (!why_hot || !next_step) return null;
  const priority = PRIORITIES.includes(o.priority as Priority) ? (o.priority as Priority) : "medium";
  const status = STATUSES.includes(o.status as WatchStatus) ? (o.status as WatchStatus) : "watching";
  const confidence = Math.max(0, Math.min(1, typeof o.confidence === "number" ? o.confidence : 0.5));
  return { why_hot, next_step, priority, status, confidence };
}

/** One reasoning call for one account. Throws if the key is missing; returns null on bad output. */
export async function reason(ctx: AccountContext): Promise<AgentVerdict | null> {
  if (!isConfigured()) throw new Error("OPENAI_API_KEY not set");
  const res = await getClient().chat.completions.create({
    model: AGENT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(ctx) },
    ],
  });
  try {
    return coerce(JSON.parse(res.choices[0]?.message?.content ?? ""));
  } catch {
    return null;
  }
}
