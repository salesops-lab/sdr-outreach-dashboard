/** Login email → role → default scope (focus model: org view stays available to all).
 *  Chain: sdr_roles override → tracked-rep match via sdr_owners → viewer.
 *  The org structure (pods/managers/roster) is loaded from DB (lib/team/load) with a config
 *  fallback; the pure decision lives in ./scope (unit-tested). */
import { supabaseAdmin } from "../supabase/admin";
import { loadTeamStructure } from "../team/load";
import { Viewer } from "../spine/types";
import { decideScope } from "./scope";

/** Server-side resolution. NEVER throws — failure degrades to org-wide viewer. */
export async function resolveViewer(email: string): Promise<Viewer> {
  const ts = await loadTeamStructure();
  const allTracked = ts.members.filter((m) => m.active).map((m) => m.ownerId);
  const fallback: Viewer = { email, role: "viewer", defaultOwnerIds: allTracked, isAdmin: false };
  const sb = supabaseAdmin();
  if (!sb) return fallback;
  try {
    const lower = email.toLowerCase();
    const { data: roleRow } = await sb.from("sdr_roles").select("role,team_id").eq("email", lower).maybeSingle();
    // Always resolve the login's tracked owner id: pods + manager tree are keyed by owner id / lead
    // email, and decideScope's precedence (admin → pod lead → player-coach manager → individual)
    // orders it. Resolving unconditionally means a manager who also has an sdr_roles row is still
    // matched as a player-coach (the old `if (!roleRow)` guard silently dropped that case).
    let trackedOwnerId: string | null = null;
    const { data: owner } = await sb.from("sdr_owners").select("owner_id").eq("email", lower).maybeSingle();
    if (owner && allTracked.includes(owner.owner_id)) trackedOwnerId = owner.owner_id;
    return decideScope(email, roleRow ?? null, trackedOwnerId, allTracked, ts);
  } catch (err) {
    console.error("[access] resolveViewer failed:", err);
    return fallback;
  }
}
