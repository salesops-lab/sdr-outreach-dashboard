/** DB-backed org structure loader (server-only: pulls in supabaseAdmin). Reads sdr_pods /
 *  sdr_managers / sdr_roster; falls back to the config-derived structure when the roster is
 *  empty (not seeded yet) or on any error — so the sync + RBAC never break mid-migration.
 *  Used by both the sync (tsx) and the Next server. NEVER import from a client component. */
import { supabaseAdmin } from "../supabase/admin";
import { configTeamStructure } from "./config-source";
import { TeamStructure } from "./types";

let cache: { ts: TeamStructure; at: number } | null = null;
const TTL_MS = 30_000; // brief cache: heavy on request paths, admin edits reflect within 30s

/** Invalidate the in-process cache after an admin write so the next read is fresh. */
export function invalidateTeamCache() { cache = null; }

export async function loadTeamStructure(opts?: { fresh?: boolean }): Promise<TeamStructure> {
  if (!opts?.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.ts;
  const fallback = configTeamStructure();
  const sb = supabaseAdmin();
  if (!sb) return fallback;
  try {
    const [pods, mgrs, roster] = await Promise.all([
      sb.from("sdr_pods").select("pod_key,name,lead_email,active,sort").order("sort"),
      sb.from("sdr_managers").select("manager_key,name,owner_id,parent_key,active"),
      sb.from("sdr_roster").select("owner_id,email,first_name,last_name,name,kind,ae_pod,manager_key,active"),
    ]);
    const rosterRows = roster.data ?? [];
    if (rosterRows.length === 0) return fallback; // table exists but not seeded → keep config
    const ts: TeamStructure = {
      pods: (pods.data ?? []).filter((p) => p.active).map((p) => ({ key: p.pod_key, name: p.name, leadEmail: p.lead_email })),
      managers: Object.fromEntries(
        (mgrs.data ?? []).filter((m) => m.active).map((m) => [m.manager_key,
          { key: m.manager_key, name: m.name, ownerId: m.owner_id, parent: m.parent_key ?? undefined }]),
      ),
      members: rosterRows.map((r) => ({
        ownerId: r.owner_id,
        email: r.email,
        name: r.name || [r.first_name, r.last_name].filter(Boolean).join(" ") || r.owner_id,
        firstName: r.first_name,
        lastName: r.last_name,
        kind: (r.kind === "ae" ? "ae" : "sdr"),
        aePod: r.ae_pod,
        managerKey: r.manager_key,
        active: r.active,
      })),
    };
    cache = { ts, at: Date.now() };
    return ts;
  } catch (e) {
    console.error("[team] loadTeamStructure failed — using config fallback:", e);
    return fallback;
  }
}

/** Active tracked owner ids — the runtime successor to REP_OWNER_IDS. */
export async function getTrackedOwnerIds(): Promise<string[]> {
  const ts = await loadTeamStructure();
  return ts.members.filter((m) => m.active).map((m) => m.ownerId);
}

/** owner id → display name (successor to the REPS map), for the sync/aggregate. */
export async function getRosterNames(): Promise<Record<string, string>> {
  const ts = await loadTeamStructure();
  const out: Record<string, string> = {};
  for (const m of ts.members) out[m.ownerId] = m.name;
  return out;
}
