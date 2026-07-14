import "server-only";
import OpenAI from "openai";
import { AccountContext, AgentVerdict, Priority, WatchStatus } from "./types";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

export const AGENT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
export const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small"; // 1536 dims — matches vector(1536)

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
  
  let next_step = "";
  if (typeof o.action === "string" && o.action.trim()) {
    const nextStepObj = {
      action: o.action.trim(),
      contactName: typeof o.contact_name === "string" && o.contact_name.trim() ? o.contact_name.trim() : null,
      contactTitle: typeof o.contact_title === "string" && o.contact_title.trim() ? o.contact_title.trim() : null,
      channel: typeof o.channel === "string" && (o.channel === "call" || o.channel === "email") ? o.channel : "call",
      helperText: typeof o.helper_text === "string" && o.helper_text.trim() ? o.helper_text.trim() : "",
    };
    next_step = JSON.stringify(nextStepObj);
  } else if (typeof o.next_step === "string" && o.next_step.trim()) {
    next_step = o.next_step.trim();
  }

  if (!why_hot || !next_step) return null;
  const priority = PRIORITIES.includes(o.priority as Priority) ? (o.priority as Priority) : "medium";
  const status = STATUSES.includes(o.status as WatchStatus) ? (o.status as WatchStatus) : "watching";
  const confidence = Math.max(0, Math.min(1, typeof o.confidence === "number" ? o.confidence : 0.5));
  return { why_hot, next_step, priority, status, confidence };
}

/** Generic strict-JSON completion — the provider seam every reasoner (verdicts, briefs) goes
 *  through, so swapping/AB-testing providers is a one-file change. Returns null on bad output. */
export async function completeJSON(system: string, user: string): Promise<unknown> {
  if (!isConfigured()) throw new Error("OPENAI_API_KEY not set");
  const res = await getClient().chat.completions.create({
    model: AGENT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  try {
    return JSON.parse(res.choices[0]?.message?.content ?? "");
  } catch {
    return null;
  }
}

/** One reasoning call for one account. Throws if the key is missing; returns null on bad output. */
export async function reason(ctx: AccountContext): Promise<AgentVerdict | null> {
  return coerce(await completeJSON(SYSTEM_PROMPT, buildUserPrompt(ctx)));
}

/** Embed a batch of texts (≤ ~100 per call keeps requests small). Part of the provider seam. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!isConfigured()) throw new Error("OPENAI_API_KEY not set");
  const res = await getClient().embeddings.create({ model: EMBED_MODEL, input: texts });
  return res.data.map((d) => d.embedding);
}

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type ChatToolDef = OpenAI.Chat.ChatCompletionTool;

/** One step of a tool-calling conversation — the loop lives in toolloop.ts. Provider seam. */
export async function chatStep(messages: ChatMessage[], tools: ChatToolDef[]): Promise<OpenAI.Chat.ChatCompletionMessage> {
  if (!isConfigured()) throw new Error("OPENAI_API_KEY not set");
  const res = await getClient().chat.completions.create({
    model: AGENT_MODEL,
    temperature: 0.2,
    messages,
    tools,
    tool_choice: "auto",
  });
  return res.choices[0].message;
}
