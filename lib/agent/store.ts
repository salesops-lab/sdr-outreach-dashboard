import "server-only";
import { supabaseAdmin } from "../supabase/admin";
import { AgentWatch, HotAccount, AgentVerdict, WatchStatus, Priority } from "./types";
import { Snapshot } from "../sync/types";
import { REPS } from "../../config/reps";

const HOT_PERIOD = "this_week"; // narrow period that carries per-account company_breakdown

/** Current hot, non-disqualified accounts across all reps (from the latest weekly breakdown). */
export function hotAccountsFromSnapshot(snap: Snapshot): HotAccount[] {
  const out: HotAccount[] = [];
  for (const [repId, rep] of Object.entries(snap.reps)) {
    const rows = rep.periods[HOT_PERIOD]?.company_breakdown ?? [];
    for (const c of rows) {
      if (c.temp !== "hot" || c.disqualified) continue;
      out.push({
        accountId: c.id, accountName: c.name, repId, repName: REPS[repId] ?? repId,
        temp: c.temp, tempReason: c.temp_reason, stage: c.stage,
        meetings: c.meetings, highIntent: c.high_intent, connected: c.connected,
        opened: c.opened, replied: c.replied, calls: c.calls, emails: c.emails,
        disqualified: c.disqualified, lastSignalMs: c.last_ms,
      });
    }
  }
  return out;
}

interface WatchRow {
  account_id: string; account_name: string | null; rep_id: string | null; status: WatchStatus;
  temp: string | null; reason: string | null; next_step: string | null; priority: Priority | null;
  confidence: number | null; entered_hot_at: string | null; last_signal_ms: number | null;
  last_reviewed_at: string | null; model: string | null;
}

function rowToWatch(r: WatchRow): AgentWatch {
  return {
    accountId: r.account_id, accountName: r.account_name, repId: r.rep_id, status: r.status, temp: r.temp,
    reason: r.reason, nextStep: r.next_step, priority: r.priority, confidence: r.confidence,
    enteredHotAt: r.entered_hot_at, lastSignalMs: r.last_signal_ms, lastReviewedAt: r.last_reviewed_at, model: r.model,
  };
}

export async function getWatches(): Promise<Map<string, AgentWatch>> {
  const db = supabaseAdmin();
  if (!db) return new Map();
  const { data, error } = await db.from("sdr_agent_watches").select("*");
  if (error) { console.warn("[agent] getWatches:", error.message); return new Map(); }
  const m = new Map<string, AgentWatch>();
  for (const r of (data ?? []) as WatchRow[]) m.set(r.account_id, rowToWatch(r));
  return m;
}

/** Watches for the UI, most-recently-reviewed first. */
export async function listWatches(): Promise<AgentWatch[]> {
  const m = await getWatches();
  return [...m.values()].sort((a, b) => (b.lastReviewedAt ?? "").localeCompare(a.lastReviewedAt ?? ""));
}

export async function upsertWatch(account: HotAccount, verdict: AgentVerdict, model: string, existed: boolean): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    account_id: account.accountId, account_name: account.accountName, rep_id: account.repId,
    status: verdict.status, temp: account.temp, reason: verdict.why_hot, next_step: verdict.next_step,
    priority: verdict.priority, confidence: verdict.confidence, last_signal_ms: account.lastSignalMs,
    last_reviewed_at: now, model, updated_at: now,
  };
  if (!existed) row.entered_hot_at = now;
  const { error } = await db.from("sdr_agent_watches").upsert(row, { onConflict: "account_id" });
  if (error) console.warn("[agent] upsertWatch:", error.message);
}

export async function markStatus(accountId: string, status: WatchStatus): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  await db.from("sdr_agent_watches").update({ status, updated_at: new Date().toISOString() }).eq("account_id", accountId);
}

export async function addNote(accountId: string, kind: string, note: string): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  await db.from("sdr_agent_notes").insert({ account_id: accountId, kind, note });
}

/** Raw call/email content for an account's activities (empty until content-backfill has run). */
export async function loadContentForAccount(accountId: string, limit = 6): Promise<string[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data: acts } = await db
    .from("sdr_activities").select("hs_id")
    .contains("company_ids", [accountId]).order("ts_ms", { ascending: false }).limit(40);
  const ids = (acts ?? []).map((a: { hs_id: string }) => a.hs_id);
  if (!ids.length) return [];
  const { data: content } = await db.from("sdr_activity_content").select("*").in("hs_id", ids).limit(limit);
  const out: string[] = [];
  for (const c of (content ?? []) as Record<string, string | null>[]) {
    const parts = [c.call_title, c.call_summary, c.call_body, c.transcript, c.email_subject].filter(Boolean);
    if (parts.length) out.push(parts.join(" — "));
  }
  return out;
}
