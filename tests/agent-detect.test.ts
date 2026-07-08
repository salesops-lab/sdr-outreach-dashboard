import { describe, it, expect } from "vitest";
import { detectWatchWork, DetectOpts } from "../lib/agent/detect";
import { HotAccount, AgentWatch } from "../lib/agent/types";

const NOW = Date.UTC(2026, 6, 8, 16);
const DAY = 86_400_000;
const OPTS: DetectOpts = { nowMs: NOW, reviewStaleMs: 2 * DAY, dropOffMs: 10 * DAY };

function hot(p: Partial<HotAccount> & { accountId: string }): HotAccount {
  return {
    accountName: p.accountId, repId: "r1", repName: "Rep One", temp: "hot", tempReason: "Meeting scheduled",
    meetings: 1, highIntent: 1, connected: 1, opened: 0, replied: 0, calls: 1, emails: 0,
    disqualified: false, lastSignalMs: NOW, ...p,
  };
}

function watch(p: Partial<AgentWatch> & { accountId: string }): AgentWatch {
  return {
    accountName: p.accountId, repId: "r1", status: "watching", temp: "hot", reason: "Meeting scheduled",
    nextStep: null, priority: "high", confidence: 0.8, enteredHotAt: null, lastSignalMs: NOW,
    lastReviewedAt: new Date(NOW).toISOString(), model: "gpt-4o-mini", ...p,
  };
}

describe("detectWatchWork", () => {
  it("reviews a newly hot account (no existing watch)", () => {
    const r = detectWatchWork([hot({ accountId: "A" })], new Map(), OPTS);
    expect(r.toReview.map((h) => h.accountId)).toEqual(["A"]);
    expect(r.toDropOff).toEqual([]);
  });

  it("skips a watched account reviewed recently with unchanged signal", () => {
    const watches = new Map([["A", watch({ accountId: "A" })]]);
    const r = detectWatchWork([hot({ accountId: "A" })], watches, OPTS);
    expect(r.toReview).toEqual([]);
  });

  it("re-reviews when the review is stale", () => {
    const old = new Date(NOW - 5 * DAY).toISOString();
    const watches = new Map([["A", watch({ accountId: "A", lastReviewedAt: old })]]);
    const r = detectWatchWork([hot({ accountId: "A" })], watches, OPTS);
    expect(r.toReview.map((h) => h.accountId)).toEqual(["A"]);
  });

  it("re-reviews when the intent signal shifts", () => {
    const watches = new Map([["A", watch({ accountId: "A", reason: "Connected 1×" })]]);
    const r = detectWatchWork([hot({ accountId: "A", tempReason: "Meeting scheduled" })], watches, OPTS);
    expect(r.toReview.map((h) => h.accountId)).toEqual(["A"]);
  });

  it("leaves already meeting-booked / closed watches alone", () => {
    const watches = new Map([["A", watch({ accountId: "A", status: "meeting_booked", lastReviewedAt: new Date(NOW - 9 * DAY).toISOString() })]]);
    const r = detectWatchWork([hot({ accountId: "A" })], watches, OPTS);
    expect(r.toReview).toEqual([]);
  });

  it("drops off a watched account that is no longer hot and has gone quiet", () => {
    const watches = new Map([["B", watch({ accountId: "B", lastSignalMs: NOW - 12 * DAY })]]);
    const r = detectWatchWork([], watches, OPTS); // B not in current hot set
    expect(r.toDropOff).toEqual(["B"]);
  });

  it("does not drop a cooled account still within the drop-off window", () => {
    const watches = new Map([["B", watch({ accountId: "B", lastSignalMs: NOW - 3 * DAY })]]);
    const r = detectWatchWork([], watches, OPTS);
    expect(r.toDropOff).toEqual([]);
  });
});
