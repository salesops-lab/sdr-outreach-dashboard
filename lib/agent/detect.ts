/**
 * Pure decision core for the hot-account agent: given the CURRENT hot accounts (from the
 * snapshot) and the EXISTING watches, decide which accounts need a fresh LLM review and which
 * watches should auto-transition to drop-off. No I/O, no model calls — fully unit-testable.
 */
import { HotAccount, AgentWatch } from "./types";

export interface DetectOpts {
  nowMs: number;
  reviewStaleMs: number; // re-review a still-hot watch after this long since last review
  dropOffMs: number; // a cooled watch with no activity for this long drops off
}

export interface DetectResult {
  toReview: HotAccount[]; // need an LLM verdict (newly hot / stale / intent shifted)
  toDropOff: string[]; // account ids to mark drop_off deterministically (no LLM)
}

export function detectWatchWork(hot: HotAccount[], watches: Map<string, AgentWatch>, opts: DetectOpts): DetectResult {
  const hotIds = new Set(hot.map((h) => h.accountId));
  const toReview: HotAccount[] = [];

  for (const h of hot) {
    const w = watches.get(h.accountId);
    if (!w) { toReview.push(h); continue; } // newly hot → review
    if (w.status === "meeting_booked" || w.status === "closed") continue; // resolved

    const reviewedMs = w.lastReviewedAt ? Date.parse(w.lastReviewedAt) : 0;
    const stale = opts.nowMs - reviewedMs > opts.reviewStaleMs;
    const shifted = (w.reason ?? "") !== h.tempReason || (w.temp ?? "") !== h.temp;
    if (stale || shifted) toReview.push(h);
  }

  const toDropOff: string[] = [];
  for (const [id, w] of watches) {
    if (w.status !== "watching") continue; // only active watches drop off
    if (hotIds.has(id)) continue; // still hot
    const lastMs = w.lastSignalMs ?? 0;
    if (opts.nowMs - lastMs > opts.dropOffMs) toDropOff.push(id);
  }

  return { toReview, toDropOff };
}
