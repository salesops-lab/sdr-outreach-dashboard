/** Builds a TeamStructure from the legacy hard-coded config (config/reps.ts +
 *  config/team-structure.ts). Two jobs: (1) the fallback the DB loader degrades to when
 *  sdr_roster is empty or unreachable, so the app never breaks mid-migration; (2) the seed
 *  source for `npm run team:seed`. Once the DB is seeded + edited via the admin UI, this is
 *  only a safety net. Pure — no I/O. */
import { REPS } from "../../config/reps";
import { AE_PODS, AE_EMAIL, MANAGERS, SDR_TEAM, AE_TEAM } from "../../config/team-structure";
import { TeamStructure, RosterMember, Pod, Manager } from "./types";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function configTeamStructure(): TeamStructure {
  const pods: Pod[] = AE_PODS.map((key) => ({ key, name: cap(key), leadEmail: AE_EMAIL[key] ?? null }));

  const managers: Record<string, Manager> = {};
  for (const [key, m] of Object.entries(MANAGERS)) {
    managers[key] = { key, name: m.name, ownerId: m.ownerId, parent: m.parent };
  }

  const members: RosterMember[] = Object.entries(REPS).map(([ownerId, name]) => {
    const sdr = SDR_TEAM[ownerId];
    if (sdr) return { ownerId, email: null, name, kind: "sdr", aePod: sdr.pod, managerKey: sdr.manager, active: true };
    const aePod = AE_TEAM[ownerId];
    if (aePod) return { ownerId, email: null, name, kind: "ae", aePod, managerKey: null, active: true };
    // Unmapped (e.g. Ketan/Rishabh/Divyansh/Abhishek): tracked, but no pod/manager → own-data scope.
    return { ownerId, email: null, name, kind: "sdr", aePod: null, managerKey: null, active: true };
  });

  return { pods, managers, members };
}
