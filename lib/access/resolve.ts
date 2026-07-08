/** Login email → role → default scope (focus model: org view stays available to all).
 *  Chain: sdr_roles override → tracked-rep match via sdr_owners → viewer.
 *  The pure decision lives in ./scope (server-only-free, unit-tested); this file
 *  is the server-side I/O wrapper and pulls in supabaseAdmin. */
import { supabaseAdmin } from "../supabase/admin";
import { REP_OWNER_IDS } from "../../config/reps";
import { Viewer } from "../spine/types";
import { decideScope } from "./scope";

/** Server-side resolution. NEVER throws — failure degrades to org-wide viewer. */
export async function resolveViewer(email: string): Promise<Viewer> {
  const fallback: Viewer = { email, role: "viewer", defaultOwnerIds: [...REP_OWNER_IDS], isAdmin: false };
  const sb = supabaseAdmin();
  if (!sb) return fallback;
  try {
    const lower = email.toLowerCase();
    const { data: roleRow } = await sb.from("sdr_roles").select("role,team_id").eq("email", lower).maybeSingle();
    // AE pods + manager tree come from config/team-structure (keyed by owner id), so we only need
    // the login's tracked owner id (player-coach managers + individual SDRs are matched from it).
    let trackedOwnerId: string | null = null;
    if (!roleRow) {
      const { data: owner } = await sb.from("sdr_owners").select("owner_id").eq("email", lower).maybeSingle();
      if (owner && REP_OWNER_IDS.includes(owner.owner_id)) trackedOwnerId = owner.owner_id;
    }
    return decideScope(email, roleRow ?? null, trackedOwnerId, [...REP_OWNER_IDS]);
  } catch (err) {
    console.error("[access] resolveViewer failed:", err);
    return fallback;
  }
}
