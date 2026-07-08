/**
 * Assemble an account's reasoning context from the signals we already have:
 *  - the hot-account snapshot signals (disposition history / engagement / recency)
 *  - the call-scoring project's distilled text (rep coaching summary, quoted call moments,
 *    recommended next actions) filtered to this account
 *  - raw call/email content (once the content-backfill has populated sdr_activity_content)
 */
import { AccountContext, HotAccount } from "./types";
import { CoachingSnapshot, RepCallsPayload } from "../callquality/types";

export function buildContext(
  account: HotAccount,
  coaching: CoachingSnapshot | undefined,
  repCalls: RepCallsPayload | null,
  content: string[],
): AccountContext {
  const snippets: string[] = [];
  const calls = (repCalls?.calls ?? []).filter((c) => c.companyId === account.accountId);
  for (const c of calls) {
    if (c.nextAction) snippets.push(`Recommended next action (${c.disposition ?? "call"}): ${c.nextAction}`);
    for (const q of c.quotes.slice(0, 2)) snippets.push(`Prospect quote: "${q}"`);
    for (const m of c.coachableMoments.slice(0, 1)) snippets.push(`Call moment: ${m}`);
  }
  return {
    account,
    coachingSummary: coaching?.managerSummary ?? null,
    callSnippets: snippets,
    content,
  };
}
