/**
 * Smart ranking algorithm for the Attention Board.
 * Ranks watches by multiple factors to create a prioritized work queue.
 */
import { AgentWatch, Priority } from "./types";
import { MARKET_SEGMENTS, MarketSegment } from "../sync/types";

/** Weights for the ranking algorithm (sum to 1.0) */
export const RANKING_WEIGHTS = {
  priority: 0.30,    // Agent-assigned priority
  recency: 0.25,     // How recent the last activity was
  value: 0.20,      // Account value (GD vs Single, segment)
  velocity: 0.15,    // Engagement velocity (activity acceleration)
  confidence: 0.10,  // Agent's confidence in the recommendation
} as const;

/** Maximum age in milliseconds before recency score drops to 0 (3 days) */
const MAX_RECENCY_MS = 3 * 24 * 60 * 60 * 1000;

/** Maximum velocity window in milliseconds (7 days) */
const VELOCITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Account value scores by segment */
export const SEGMENT_SCORES: Record<MarketSegment | string, number> = {
  top_150: 100,
  enterprise_a: 95,
  enterprise_b: 90,
  enterprise_c: 85,
  mm_group: 70,
  mm_single: 60,
  smb: 40,
  unsized: 50,
} as const;

/** Priority scores */
const PRIORITY_SCORES: Record<Priority, number> = {
  high: 100,
  medium: 60,
  low: 30,
} as const;

/**
 * Calculate recency score (0-100) based on last signal time.
 * 100 = just now, 0 = older than MAX_RECENCY_MS
 */
function calculateRecencyScore(lastSignalMs: number | null): number {
  if (lastSignalMs === null) return 0;
  
  const now = Date.now();
  const ageMs = now - lastSignalMs;
  
  if (ageMs <= 0) return 100;
  if (ageMs >= MAX_RECENCY_MS) return 0;
  
  // Linear decay from 100 to 0 over MAX_RECENCY_MS
  return 100 * (1 - ageMs / MAX_RECENCY_MS);
}

/**
 * Calculate value score (0-100) based on account segment.
 * Uses the segment from the watch if available, otherwise defaults to medium.
 */
function calculateValueScore(watch: AgentWatch, segment?: MarketSegment | string): number {
  const effectiveSegment = segment ?? watch.temp ?? "unsized";
  return SEGMENT_SCORES[effectiveSegment] ?? SEGMENT_SCORES.unsized;
}

/**
 * Calculate velocity score (0-100) based on engagement acceleration.
 * For now, we use a simple proxy: higher activity counts = higher velocity.
 * In the future, this could track actual acceleration over time.
 */
function calculateVelocityScore(watch: AgentWatch): number {
  // This is a placeholder implementation.
  // In a full implementation, we would track activity over time
  // and calculate actual acceleration.
  // For now, we use confidence as a proxy for engagement quality.
  if (watch.confidence === null) return 50;
  return watch.confidence * 100;
}

/**
 * Calculate confidence score (0-100) from agent's confidence.
 */
function calculateConfidenceScore(watch: AgentWatch): number {
  if (watch.confidence === null) return 50;
  return watch.confidence * 100;
}

/**
 * Calculate priority score (0-100) from agent's priority.
 */
function calculatePriorityScore(watch: AgentWatch): number {
  if (watch.priority === null) return 50;
  return PRIORITY_SCORES[watch.priority];
}

/**
 * Calculate the composite rank score (0-100) for a watch.
 */
export function calculateRankScore(watch: AgentWatch, segment?: MarketSegment | string): number {
  const priorityScore = calculatePriorityScore(watch);
  const recencyScore = calculateRecencyScore(watch.lastSignalMs);
  const valueScore = calculateValueScore(watch, segment);
  const velocityScore = calculateVelocityScore(watch);
  const confidenceScore = calculateConfidenceScore(watch);
  
  const score = (
    RANKING_WEIGHTS.priority * priorityScore +
    RANKING_WEIGHTS.recency * recencyScore +
    RANKING_WEIGHTS.value * valueScore +
    RANKING_WEIGHTS.velocity * velocityScore +
    RANKING_WEIGHTS.confidence * confidenceScore
  );
  
  return Math.round(score * 100) / 100; // Round to 2 decimal places
}

/**
 * Sort watches by rank score (descending) and then by last reviewed date.
 */
export function sortWatchesByRank(watches: AgentWatch[], segmentMap: Map<string, MarketSegment | string> = new Map()): AgentWatch[] {
  return [...watches].sort((a, b) => {
    const aSegment = segmentMap.get(a.accountId);
    const bSegment = segmentMap.get(b.accountId);
    
    const aScore = calculateRankScore(a, aSegment);
    const bScore = calculateRankScore(b, bSegment);
    
    // Primary sort: rank score (descending)
    if (aScore !== bScore) {
      return bScore - aScore;
    }
    
    // Secondary sort: last reviewed (most recent first)
    const aReviewed = a.lastReviewedAt ?? "";
    const bReviewed = b.lastReviewedAt ?? "";
    return bReviewed.localeCompare(aReviewed);
  });
}

/**
 * Group watches by their workflow status for kanban-style display.
 */
export type WorkflowStatus = "not_started" | "in_progress" | "completed" | "snoozed";

export interface RankedWatch extends AgentWatch {
  rank: number;
  workflowStatus: WorkflowStatus;
  segment?: MarketSegment | string;
}

/**
 * Enhance watches with rank scores and workflow status.
 * This is a client-side enhancement that doesn't modify the database.
 */
export function enhanceWatches(
  watches: AgentWatch[],
  segmentMap: Map<string, MarketSegment | string> = new Map(),
  actionMap: Map<string, { status: WorkflowStatus; lastActionAt: string | null }> = new Map()
): RankedWatch[] {
  return watches.map((watch) => {
    const segment = segmentMap.get(watch.accountId);
    const action = actionMap.get(watch.accountId);
    
    const rank = calculateRankScore(watch, segment);
    const workflowStatus = action?.status ?? "not_started";
    
    return {
      ...watch,
      rank,
      workflowStatus,
      segment,
    };
  });
}

/**
 * Group enhanced watches by workflow status for kanban display.
 */
export function groupWatchesByWorkflow(watches: RankedWatch[]): Record<WorkflowStatus, RankedWatch[]> {
  const groups: Record<WorkflowStatus, RankedWatch[]> = {
    not_started: [],
    in_progress: [],
    completed: [],
    snoozed: [],
  };
  
  for (const watch of watches) {
    groups[watch.workflowStatus].push(watch);
  }
  
  return groups;
}
