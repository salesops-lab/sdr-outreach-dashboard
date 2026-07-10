/**
 * Client-side action tracking for the Attention Board.
 * This module provides local storage-based action tracking without modifying the database.
 * Actions are stored in localStorage and synced across tabs.
 */
import { WorkflowStatus } from "./ranking";

/** Action tracking storage key */
const ACTION_STORAGE_KEY = "sdr-attention-actions";

/** Action record for a watch */
export interface WatchAction {
  accountId: string;
  status: WorkflowStatus;
  lastActionAt: string | null;
  lastActionType: "call" | "email" | "meeting" | "note" | "snoozed" | null;
  snoozedUntil: string | null; // ISO date string when to resurface
  notes: string[]; // History of notes/actions taken
}

/**
 * Load all actions from localStorage.
 */
export function loadActions(): Map<string, WatchAction> {
  if (typeof window === "undefined") {
    return new Map();
  }
  
  try {
    const stored = localStorage.getItem(ACTION_STORAGE_KEY);
    if (!stored) return new Map();
    
    const parsed = JSON.parse(stored) as Record<string, WatchAction>;
    const map = new Map<string, WatchAction>();
    
    for (const [accountId, action] of Object.entries(parsed)) {
      map.set(accountId, action);
    }
    
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Save all actions to localStorage.
 */
function saveActions(actions: Map<string, WatchAction>): void {
  if (typeof window === "undefined") return;
  
  try {
    const obj = Object.fromEntries(actions);
    localStorage.setItem(ACTION_STORAGE_KEY, JSON.stringify(obj));
    
    // Broadcast to other tabs
    broadcastActionsUpdate(actions);
  } catch {
    // Silently fail if localStorage is full or unavailable
  }
}

/**
 * Broadcast actions update to other tabs using BroadcastChannel.
 */
function broadcastActionsUpdate(actions: Map<string, WatchAction>): void {
  if (typeof window === "undefined") return;
  
  try {
    const channel = new BroadcastChannel(ACTION_STORAGE_KEY);
    channel.postMessage({ type: "actions-update", data: Object.fromEntries(actions) });
    channel.close();
  } catch {
    // BroadcastChannel not supported in some browsers
  }
}

/**
 * Get action for a specific account.
 */
export function getAction(accountId: string): WatchAction | null {
  const actions = loadActions();
  return actions.get(accountId) ?? null;
}

/**
 * Get all actions.
 */
export function getAllActions(): Map<string, WatchAction> {
  return loadActions();
}

/**
 * Update or create an action for an account.
 */
export function updateAction(accountId: string, updates: Partial<WatchAction>): WatchAction {
  const actions = loadActions();
  const existing = actions.get(accountId);
  
  const now = new Date().toISOString();
  const newAction: WatchAction = {
    accountId,
    status: existing?.status ?? "not_started",
    lastActionAt: existing?.lastActionAt ?? null,
    lastActionType: existing?.lastActionType ?? null,
    snoozedUntil: existing?.snoozedUntil ?? null,
    notes: existing?.notes ?? [],
    ...updates,
    // Ensure we update the timestamp for status changes
    ...(updates.status && { lastActionAt: now }),
  };
  
  actions.set(accountId, newAction);
  saveActions(actions);
  
  return newAction;
}

/**
 * Mark a watch as in progress.
 */
export function markInProgress(accountId: string): WatchAction {
  return updateAction(accountId, { status: "in_progress" });
}

/**
 * Mark a watch as completed.
 */
export function markCompleted(accountId: string, actionType?: "call" | "email" | "meeting" | "note"): WatchAction {
  return updateAction(accountId, { 
    status: "completed",
    lastActionType: actionType ?? null,
  });
}

/**
 * Snooze a watch for a number of days.
 */
export function snoozeWatch(accountId: string, days: number): WatchAction {
  const snoozedUntil = new Date();
  snoozedUntil.setDate(snoozedUntil.getDate() + days);
  
  return updateAction(accountId, {
    status: "snoozed",
    lastActionType: "snoozed",
    snoozedUntil: snoozedUntil.toISOString(),
  });
}

/**
 * Reset a watch to not started (e.g., after snooze expires).
 */
export function resetWatch(accountId: string): WatchAction {
  return updateAction(accountId, {
    status: "not_started",
    snoozedUntil: null,
  });
}

/**
 * Add a note to a watch's action history.
 */
export function addActionNote(accountId: string, note: string): WatchAction {
  const actions = loadActions();
  const existing = actions.get(accountId);
  
  const newAction: WatchAction = {
    accountId,
    status: existing?.status ?? "not_started",
    lastActionAt: existing?.lastActionAt ?? null,
    lastActionType: existing?.lastActionType ?? null,
    snoozedUntil: existing?.snoozedUntil ?? null,
    notes: [...(existing?.notes ?? []), `${new Date().toISOString()}: ${note}`],
  };
  
  actions.set(accountId, newAction);
  saveActions(actions);
  
  return newAction;
}

/**
 * Clear all actions.
 */
export function clearAllActions(): void {
  if (typeof window === "undefined") return;
  
  try {
    localStorage.removeItem(ACTION_STORAGE_KEY);
    broadcastActionsUpdate(new Map());
  } catch {
    // Silently fail
  }
}

/**
 * Check if a snoozed watch should be resurfaced.
 */
export function shouldResurface(accountId: string): boolean {
  const action = getAction(accountId);
  if (!action || !action.snoozedUntil) return false;
  
  const snoozedUntil = new Date(action.snoozedUntil);
  const now = new Date();
  
  return now >= snoozedUntil;
}

/**
 * Resurface all snoozed watches that have expired.
 */
export function resurfaceExpired(): number {
  const actions = loadActions();
  let resurfacedCount = 0;
  
  for (const [accountId, action] of actions) {
    if (action.status === "snoozed" && shouldResurface(accountId)) {
      resetWatch(accountId);
      resurfacedCount++;
    }
  }
  
  return resurfacedCount;
}

/**
 * Get the next action due date for a watch.
 * For now, this is a simple calculation based on last action.
 */
export function getNextActionDue(accountId: string): string | null {
  const action = getAction(accountId);
  if (!action?.lastActionAt) return null;
  
  // Simple heuristic: next action due in 24 hours
  const lastAction = new Date(action.lastActionAt);
  const due = new Date(lastAction.getTime() + 24 * 60 * 60 * 1000);
  
  return due.toISOString();
}

/**
 * Initialize actions listener for cross-tab sync.
 * Call this once when the app loads.
 */
export function initActionsListener(callback: () => void): void {
  if (typeof window === "undefined") return;
  
  try {
    const channel = new BroadcastChannel(ACTION_STORAGE_KEY);
    channel.addEventListener("message", (event) => {
      if (event.data.type === "actions-update") {
        callback();
      }
    });
    
    // Store reference to close later
    (window as any).__actionsBroadcastChannel = channel;
  } catch {
    // BroadcastChannel not supported
  }
}

/**
 * Close the actions listener.
 */
export function closeActionsListener(): void {
  if (typeof window === "undefined") return;
  
  const channel = (window as any).__actionsBroadcastChannel;
  if (channel) {
    channel.close();
    (window as any).__actionsBroadcastChannel = null;
  }
}
