/** Pure scope/roster helpers over a TeamStructure — the DB-backed successors to the functions
 *  that used to live in config/team-structure.ts. No I/O, so unit-testable and importable
 *  anywhere (client or server). Callers pass the structure loaded by ../team/load. */
import { TeamStructure } from "./types";

/** Which pod a login email leads, if any. */
export function podByEmail(ts: TeamStructure, email: string | null | undefined): string | null {
  if (!email) return null;
  const lower = email.toLowerCase();
  return ts.pods.find((p) => p.leadEmail && p.leadEmail === lower)?.key ?? null;
}

/** Which manager (if any) this owner id IS (player-coach lookup). */
export function managerKeyByOwnerId(ts: TeamStructure, ownerId: string | null | undefined): string | null {
  if (!ownerId) return null;
  for (const m of Object.values(ts.managers)) if (m.ownerId === ownerId) return m.key;
  return null;
}

/** All ACTIVE owner ids (SDRs + AEs) in a pod. */
export function allOwnersInPod(ts: TeamStructure, pod: string): string[] {
  return ts.members.filter((m) => m.active && m.aePod === pod).map((m) => m.ownerId);
}

/** ACTIVE SDR owner ids in a pod. */
export function sdrOwnersInPod(ts: TeamStructure, pod: string): string[] {
  return ts.members.filter((m) => m.active && m.aePod === pod && m.kind === "sdr").map((m) => m.ownerId);
}

/** ACTIVE SDR owner ids under a manager, recursively including child managers' teams (TLs → manager). */
export function sdrOwnersUnderManager(ts: TeamStructure, mgrKey: string): string[] {
  const keys = new Set<string>([mgrKey]);
  let added = true;
  while (added) {
    added = false;
    for (const m of Object.values(ts.managers)) {
      if (m.parent && keys.has(m.parent) && !keys.has(m.key)) { keys.add(m.key); added = true; }
    }
  }
  return ts.members
    .filter((m) => m.active && m.kind === "sdr" && m.managerKey && keys.has(m.managerKey))
    .map((m) => m.ownerId);
}

/** Every tracked (active) owner id — the successor to REP_OWNER_IDS. */
export function trackedOwnerIds(ts: TeamStructure): string[] {
  return ts.members.filter((m) => m.active).map((m) => m.ownerId);
}

/** owner id → display name (successor to REPS). */
export function nameMap(ts: TeamStructure): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of ts.members) out[m.ownerId] = m.name;
  return out;
}

/** owner id → kind (sdr/ae) — drives the SDR/AE toggle on the dashboard. */
export function kindMap(ts: TeamStructure): Record<string, "sdr" | "ae"> {
  const out: Record<string, "sdr" | "ae"> = {};
  for (const m of ts.members) out[m.ownerId] = m.kind === "ae" ? "ae" : "sdr";
  return out;
}

/** One selectable team filter (an AE pod or an SDR manager subtree) with its owner ids. */
export interface TeamFilterOption {
  key: string; // "pod:<podKey>" | "team:<managerKey>" — namespaced so the two lists can share a <select>
  name: string;
  ownerIds: string[];
}

/** Serializable pod/team filter options for the UI (Overview + Accounts pickers).
 *  Pods = all active owners carrying the pod (SDRs + AEs); teams = a manager's SDR subtree
 *  (TLs roll up recursively) + the player-coach's own book. Empty groups are dropped. */
export function teamFilterOptions(ts: TeamStructure): { pods: TeamFilterOption[]; teams: TeamFilterOption[] } {
  const pods = ts.pods
    .map((p) => ({ key: `pod:${p.key}`, name: p.name, ownerIds: allOwnersInPod(ts, p.key) }))
    .filter((p) => p.ownerIds.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const teams = Object.values(ts.managers)
    .map((m) => {
      const ids = new Set(sdrOwnersUnderManager(ts, m.key));
      if (m.ownerId) ids.add(m.ownerId);
      return { key: `team:${m.key}`, name: m.name, ownerIds: [...ids] };
    })
    .filter((t) => t.ownerIds.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { pods, teams };
}
