/** Pure scope decision (focus model: org view stays available to all) — unit-tested.
 *  Three layers from a TeamStructure: SDR → AE pod → Manager (with TLs rolling up).
 *  AE pod layer includes both AEs and SDRs (via allOwnersInPod). The structure is passed in
 *  (loaded from DB by resolve.ts, or the config fallback) so this file stays pure + testable. */
import { Role, Viewer } from "../spine/types";
import { TeamStructure } from "../team/types";
import { podByEmail, allOwnersInPod, managerKeyByOwnerId, sdrOwnersUnderManager } from "../team/helpers";

export function decideScope(
  email: string,
  roleRow: { role: string; team_id: string | null } | null,
  trackedOwnerId: string | null,
  allTracked: string[],
  ts: TeamStructure,
): Viewer {
  // Explicit admin/leadership (sdr_roles) see everyone, with admin tools.
  if (roleRow?.role === "admin" || roleRow?.role === "leadership") {
    return { email, role: roleRow.role as Role, defaultOwnerIds: allTracked, isAdmin: true };
  }

  // AE pod (middle layer), by login email → default to the pod's SDRs + AEs.
  const pod = podByEmail(ts, email);
  if (pod) {
    const scope = allOwnersInPod(ts, pod).filter((id) => allTracked.includes(id));
    if (scope.length) return { email, role: "manager", defaultOwnerIds: scope, isAdmin: false };
  }

  // Manager / TL (player-coach), by owner id → their whole subtree (incl. child TLs) + self.
  const mgr = managerKeyByOwnerId(ts, trackedOwnerId);
  if (mgr) {
    const scope = sdrOwnersUnderManager(ts, mgr).filter((id) => allTracked.includes(id));
    if (trackedOwnerId && allTracked.includes(trackedOwnerId) && !scope.includes(trackedOwnerId)) scope.push(trackedOwnerId);
    if (scope.length) return { email, role: "manager", defaultOwnerIds: scope, isAdmin: false };
  }

  // Individual SDR/AE → their own book.
  if (trackedOwnerId) return { email, role: "rep", defaultOwnerIds: [trackedOwnerId], isAdmin: false };

  // Everyone else keeps org-wide visibility (focus model default).
  return { email, role: "viewer", defaultOwnerIds: allTracked, isAdmin: false };
}
