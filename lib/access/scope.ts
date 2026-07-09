/** Pure scope decision (focus model: org view stays available to all) — unit-tested.
 *  Three layers from config/team-structure: SDR → AE pod → Manager (with TLs rolling up).
 *  AE pod layer now includes both AEs and SDRs (via allOwnersInPod).
 *  Lives apart from resolve.ts so tests can import it without the server-only guard. */
import { Role, Viewer } from "../spine/types";
import { podByEmail, allOwnersInPod, managerKeyByOwnerId, sdrOwnersUnderManager } from "../../config/team-structure";

export function decideScope(
  email: string,
  roleRow: { role: string; team_id: string | null } | null,
  trackedOwnerId: string | null,
  allTracked: string[],
): Viewer {
  // Explicit admin/leadership (sdr_roles) see everyone, with admin tools.
  if (roleRow?.role === "admin" || roleRow?.role === "leadership") {
    return { email, role: roleRow.role as Role, defaultOwnerIds: allTracked, isAdmin: true };
  }

  // AE pod (middle layer), by login email → default to the pod's SDRs + AEs.
  const pod = podByEmail(email);
  if (pod) {
    const scope = allOwnersInPod(pod).filter((id) => allTracked.includes(id));
    if (scope.length) return { email, role: "manager", defaultOwnerIds: scope, isAdmin: false };
  }

  // Manager / TL (player-coach), by owner id → their whole subtree (incl. child TLs) + self.
  const mgr = managerKeyByOwnerId(trackedOwnerId);
  if (mgr) {
    const scope = sdrOwnersUnderManager(mgr).filter((id) => allTracked.includes(id));
    if (trackedOwnerId && allTracked.includes(trackedOwnerId) && !scope.includes(trackedOwnerId)) scope.push(trackedOwnerId);
    if (scope.length) return { email, role: "manager", defaultOwnerIds: scope, isAdmin: false };
  }

  // Individual SDR/AE → their own book.
  if (trackedOwnerId) return { email, role: "rep", defaultOwnerIds: [trackedOwnerId], isAdmin: false };

  // Everyone else keeps org-wide visibility (focus model default).
  return { email, role: "viewer", defaultOwnerIds: allTracked, isAdmin: false };
}
