import { describe, it, expect, beforeEach } from "vitest";
import {
  calculateRankScore,
  sortWatchesByRank,
  enhanceWatches,
  groupWatchesByWorkflow,
  RANKING_WEIGHTS,
  SEGMENT_SCORES,
} from "../lib/agent/ranking";
import { AgentWatch, Priority } from "../lib/agent/types";

const NOW = Date.now();
const ONE_DAY_MS = 86_400_000;
const THREE_DAYS_MS = 3 * ONE_DAY_MS;

function makeWatch(
  overrides: Partial<AgentWatch> & { accountId: string }
): AgentWatch {
  return {
    accountName: "Test Account",
    repId: "rep-1",
    status: "watching",
    temp: "hot",
    reason: "Meeting scheduled",
    nextStep: '{"action":"Call John","contactName":"John Doe","contactTitle":"GM","channel":"call","helperText":"Hi John..."}',
    priority: "high",
    confidence: 0.9,
    enteredHotAt: new Date(NOW).toISOString(),
    lastSignalMs: NOW,
    lastReviewedAt: new Date(NOW).toISOString(),
    model: "gpt-4o-mini",
    ...overrides,
    accountId: overrides.accountId,
  };
}

describe("calculateRankScore", () => {
  it("returns 100 for a perfect watch", () => {
    const watch = makeWatch({
      accountId: "A",
      priority: "high",
      lastSignalMs: NOW,
      confidence: 1.0,
    });
    const score = calculateRankScore(watch, "top_150");
    expect(score).toBeCloseTo(100, 0.1);
  });

  it("returns low score for a terrible watch", () => {
    const watch = makeWatch({
      accountId: "B",
      priority: "low",
      lastSignalMs: NOW - THREE_DAYS_MS - 1000, // Just over 3 days old
      confidence: 0.0,
    });
    const score = calculateRankScore(watch, "smb");
    // With low priority (30), no recency (0), smb value (40), velocity (0), no confidence (0)
    // Score = 0.30*30 + 0.25*0 + 0.20*40 + 0.15*0 + 0.10*0 = 9 + 0 + 8 + 0 + 0 = 17
    expect(score).toBeCloseTo(17, 0.1);
  });

  it("weights priority highest", () => {
    const highPriority = makeWatch({ accountId: "C", priority: "high", lastSignalMs: NOW - THREE_DAYS_MS });
    const lowPriority = makeWatch({ accountId: "D", priority: "low", lastSignalMs: NOW });
    
    const highScore = calculateRankScore(highPriority);
    const lowScore = calculateRankScore(lowPriority);
    
    // High priority with old signal: 0.30*100 + 0.25*0 + 0.20*50 + 0.15*90 + 0.10*90 = 30 + 0 + 10 + 13.5 + 9 = 62.5
    // Low priority with recent signal: 0.30*30 + 0.25*100 + 0.20*50 + 0.15*90 + 0.10*90 = 9 + 25 + 10 + 13.5 + 9 = 66.5
    // So lowScore should be higher due to recency
    expect(lowScore).toBeGreaterThan(highScore);
  });

  it("weights recency second highest", () => {
    const recent = makeWatch({ accountId: "E", priority: "medium", lastSignalMs: NOW });
    const old = makeWatch({ accountId: "F", priority: "medium", lastSignalMs: NOW - THREE_DAYS_MS });
    
    const recentScore = calculateRankScore(recent);
    const oldScore = calculateRankScore(old);
    
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("weights value by segment", () => {
    const top150 = makeWatch({ accountId: "G", lastSignalMs: NOW });
    const smb = makeWatch({ accountId: "H", lastSignalMs: NOW });
    
    const top150Score = calculateRankScore(top150, "top_150");
    const smbScore = calculateRankScore(smb, "smb");
    
    expect(top150Score).toBeGreaterThan(smbScore);
  });

  it("handles null lastSignalMs", () => {
    const watch = makeWatch({ accountId: "I", lastSignalMs: null });
    const score = calculateRankScore(watch);
    expect(score).toBeGreaterThan(0); // Should still have some score from other factors
  });

  it("handles null priority", () => {
    const watch = makeWatch({ accountId: "J", priority: null });
    const score = calculateRankScore(watch);
    expect(score).toBeGreaterThan(0);
  });

  it("handles null confidence", () => {
    const watch = makeWatch({ accountId: "K", confidence: null });
    const score = calculateRankScore(watch);
    expect(score).toBeGreaterThan(0);
  });
});

describe("sortWatchesByRank", () => {
  it("sorts by rank score descending", () => {
    const watches = [
      makeWatch({ accountId: "A", priority: "low", lastSignalMs: NOW - THREE_DAYS_MS }),
      makeWatch({ accountId: "B", priority: "high", lastSignalMs: NOW }),
      makeWatch({ accountId: "C", priority: "medium", lastSignalMs: NOW - ONE_DAY_MS }),
    ];
    
    const sorted = sortWatchesByRank(watches);
    expect(sorted[0].accountId).toBe("B"); // Highest rank
    expect(sorted[2].accountId).toBe("A"); // Lowest rank
  });

  it("breaks ties by lastReviewedAt", () => {
    const olderReview = new Date(NOW - ONE_DAY_MS).toISOString();
    const newerReview = new Date(NOW).toISOString();
    
    const watches = [
      makeWatch({ accountId: "A", lastReviewedAt: olderReview }),
      makeWatch({ accountId: "B", lastReviewedAt: newerReview }),
    ];
    
    // Make them have the same rank by using same values
    const watchA = makeWatch({ accountId: "A", priority: "high", lastSignalMs: NOW, lastReviewedAt: olderReview });
    const watchB = makeWatch({ accountId: "B", priority: "high", lastSignalMs: NOW, lastReviewedAt: newerReview });
    
    const sorted = sortWatchesByRank([watchA, watchB]);
    expect(sorted[0].accountId).toBe("B"); // More recently reviewed first
  });
});

describe("enhanceWatches", () => {
  it("adds rank to each watch", () => {
    const watches = [
      makeWatch({ accountId: "A", priority: "high", lastSignalMs: NOW }),
      makeWatch({ accountId: "B", priority: "low", lastSignalMs: NOW - THREE_DAYS_MS }),
    ];
    
    const segmentMap = new Map<string, string>([["A", "top_150"], ["B", "smb"]]);
    const enhanced = enhanceWatches(watches, segmentMap);
    
    expect(enhanced[0].rank).toBeGreaterThan(0);
    expect(enhanced[1].rank).toBeGreaterThan(0);
    expect(enhanced[0].rank).toBeGreaterThan(enhanced[1].rank);
  });

  it("adds workflowStatus", () => {
    const watches = [makeWatch({ accountId: "A" })];
    const actionMap = new Map<string, { status: any; lastActionAt: string | null }>([
      ["A", { status: "in_progress", lastActionAt: new Date().toISOString() }],
    ]);
    
    const enhanced = enhanceWatches(watches, new Map(), actionMap);
    expect(enhanced[0].workflowStatus).toBe("in_progress");
  });

  it("defaults workflowStatus to not_started", () => {
    const watches = [makeWatch({ accountId: "A" })];
    const enhanced = enhanceWatches(watches);
    expect(enhanced[0].workflowStatus).toBe("not_started");
  });

  it("adds segment from map", () => {
    const watches = [makeWatch({ accountId: "A" })];
    const segmentMap = new Map<string, string>([["A", "enterprise_a"]]);
    const enhanced = enhanceWatches(watches, segmentMap);
    expect(enhanced[0].segment).toBe("enterprise_a");
  });
});

describe("groupWatchesByWorkflow", () => {
  it("groups by workflowStatus", () => {
    const watches: any[] = [
      { accountId: "A", rank: 100, workflowStatus: "not_started" as const },
      { accountId: "B", rank: 90, workflowStatus: "in_progress" as const },
      { accountId: "C", rank: 80, workflowStatus: "completed" as const },
      { accountId: "D", rank: 70, workflowStatus: "snoozed" as const },
    ];
    
    const groups = groupWatchesByWorkflow(watches);
    
    expect(groups.not_started).toHaveLength(1);
    expect(groups.not_started[0].accountId).toBe("A");
    expect(groups.in_progress).toHaveLength(1);
    expect(groups.in_progress[0].accountId).toBe("B");
    expect(groups.completed).toHaveLength(1);
    expect(groups.completed[0].accountId).toBe("C");
    expect(groups.snoozed).toHaveLength(1);
    expect(groups.snoozed[0].accountId).toBe("D");
  });
});

describe("RANKING_WEIGHTS", () => {
  it("sums to 1.0", () => {
    const sum = Object.values(RANKING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(1.0);
  });
});

describe("SEGMENT_SCORES", () => {
  it("has top_150 as highest", () => {
    expect(SEGMENT_SCORES.top_150).toBe(100);
  });

  it("has smb as lowest", () => {
    expect(SEGMENT_SCORES.smb).toBe(40);
  });

  it("has all expected segments", () => {
    const expectedSegments = ["top_150", "enterprise_a", "enterprise_b", "enterprise_c", "mm_group", "mm_single", "smb", "unsized"];
    for (const segment of expectedSegments) {
      expect(SEGMENT_SCORES).toHaveProperty(segment);
    }
  });
});
