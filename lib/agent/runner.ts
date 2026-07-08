import "server-only";
import { getSnapshot } from "../snapshot";
import { getCoachingByRep, getRepCalls } from "../callquality/fetch";
import { RepCallsPayload } from "../callquality/types";
import { hotAccountsFromSnapshot, getWatches, upsertWatch, markStatus, addNote, loadContentForAccount } from "./store";
import { detectWatchWork } from "./detect";
import { reason, AGENT_MODEL, isConfigured } from "./openai";
import { buildContext } from "./context";

const DAY = 86_400_000;

export interface AgentRunResult {
  skipped: boolean;
  hot: number;
  reviewed: number;
  droppedOff: number;
  errors: number;
}

/**
 * One agent pass: find hot accounts, decide what needs review, and for each produce a grounded
 * why-hot + next-step verdict, persisting it as a watch + an append-only note. HubSpot is never
 * written — the agent only reads the spine, call-scoring tables, and content.
 */
export async function runAgent(opts: { limit?: number; nowMs?: number } = {}): Promise<AgentRunResult> {
  if (!isConfigured()) {
    console.warn("[agent] OPENAI_API_KEY not set — skipping run");
    return { skipped: true, hot: 0, reviewed: 0, droppedOff: 0, errors: 0 };
  }
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? 25;

  const snap = await getSnapshot();
  const hot = hotAccountsFromSnapshot(snap);
  const watches = await getWatches();
  const { toReview, toDropOff } = detectWatchWork(hot, watches, { nowMs, reviewStaleMs: 2 * DAY, dropOffMs: 10 * DAY });

  for (const id of toDropOff) {
    await markStatus(id, "drop_off");
    await addNote(id, "status_change", "No activity within the drop-off window — moved to drop-off.");
  }

  const coaching = await getCoachingByRep();
  const repCallsCache = new Map<string, RepCallsPayload>();
  let reviewed = 0;
  let errors = 0;

  for (const account of toReview.slice(0, limit)) {
    try {
      if (!repCallsCache.has(account.repId)) repCallsCache.set(account.repId, await getRepCalls(account.repId));
      const content = await loadContentForAccount(account.accountId);
      const ctx = buildContext(account, coaching[account.repId], repCallsCache.get(account.repId) ?? null, content);
      const verdict = await reason(ctx);
      if (!verdict) { errors++; continue; }
      await upsertWatch(account, verdict, AGENT_MODEL, watches.has(account.accountId));
      await addNote(account.accountId, "reason", `[${verdict.priority}] ${verdict.why_hot} → ${verdict.next_step}`);
      reviewed++;
    } catch (e) {
      errors++;
      console.warn(`[agent] review ${account.accountId} failed:`, (e as Error).message);
    }
  }

  console.log(`[agent] hot=${hot.length} reviewed=${reviewed} droppedOff=${toDropOff.length} errors=${errors} model=${AGENT_MODEL}`);
  return { skipped: false, hot: hot.length, reviewed, droppedOff: toDropOff.length, errors };
}
