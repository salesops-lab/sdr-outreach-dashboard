/** Admin-editable org structure (DB-backed, replaces config/reps.ts + config/team-structure.ts).
 *  Pure data — safe to import anywhere. The DB loader lives in ./load (server-only). */

export type OwnerKind = "sdr" | "ae";

export interface Pod {
  key: string;
  name: string;
  leadEmail: string | null; // pod lead login email; null = shared pool (no single lead)
}

export interface Manager {
  key: string;
  name: string;
  ownerId: string | null; // the player-coach's own HubSpot owner id
  parent?: string;         // TL → parent manager key
}

export interface RosterMember {
  ownerId: string;
  email: string | null;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  kind: OwnerKind;
  aePod: string | null;      // → Pod.key
  managerKey: string | null; // → Manager.key (SDRs; null for AEs)
  active: boolean;
}

/** The full org snapshot the sync + RBAC read from. Pure — helpers in ./helpers operate on it. */
export interface TeamStructure {
  pods: Pod[];
  managers: Record<string, Manager>;
  members: RosterMember[];
}
