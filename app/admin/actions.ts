"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { supabaseServer } from "../../lib/supabase/server";
import { resolveViewer } from "../../lib/access/resolve";
import { invalidateTeamCache } from "../../lib/team/load";

async function requireAdmin() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  const viewer = await resolveViewer(user?.email ?? "");
  if (!viewer.isAdmin) throw new Error("forbidden");
}

function str(fd: FormData, key: string): string { return String(fd.get(key) ?? "").trim(); }
/** Stable key from a display name: lowercase first token, alnum only (e.g. "Prabhjeet Kaur" → "prabhjeet"). */
function slug(name: string): string { return name.trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "") || "x"; }

function sb() {
  const c = supabaseAdmin();
  if (!c) throw new Error("supabase unavailable");
  return c;
}

/** Fire the single-owner GitHub backfill so a new user's history appears in a few minutes.
 *  Needs GH_DISPATCH_TOKEN (fine-grained PAT, Actions:write). Degrades gracefully: if the token
 *  is absent it just logs — the nightly reconcile will pull the owner within ~24h. */
async function triggerOwnerPull(ownerId: string): Promise<string> {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO ?? "salesops-lab/sdr-outreach-dashboard";
  if (!token) return "no GH_DISPATCH_TOKEN — history fills on the next nightly reconcile";
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/spine-pull-owner.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { owner_id: ownerId } }),
    });
    if (res.status === 204) return "targeted pull dispatched";
    return `pull dispatch failed (${res.status})`;
  } catch (e) {
    return `pull dispatch error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Roster (users) ──────────────────────────────────────────────────────────

/** Result surfaced to the admin UI after an add/update — read back from the DB, not optimistic. */
type UserResult = { ok: boolean; message: string };

/** Add or update a user (React `useFormState` action → returns a DB-verified result banner).
 *  Resolves the email → HubSpot owner id via sdr_owners (no live HubSpot call), upserts sdr_roster,
 *  sets the access role, kicks a targeted history pull, then RE-READS the row and reports what the
 *  database actually holds. Never throws — errors come back as `{ ok: false, message }`. */
export async function addUser(_prev: UserResult | null, formData: FormData): Promise<UserResult> {
  try {
    await requireAdmin();
    const first = str(formData, "first_name");
    const last = str(formData, "last_name");
    const email = str(formData, "email").toLowerCase();
    const role = str(formData, "role") || "user";            // user | manager | admin  (ACCESS level)
    const kind = str(formData, "kind") || "sdr";             // sdr | ae | access  (rep TYPE — independent of role)
    const managerKey = str(formData, "manager_key") || null; // SDR team (manager/TL)
    const aePod = str(formData, "ae_pod") || null;           // AE pod
    if (!email || !email.endsWith("@spyne.ai")) return { ok: false, message: "Email must be a @spyne.ai address." };
    if (!["user", "manager", "admin"].includes(role)) return { ok: false, message: "Invalid role." };
    if (!["sdr", "ae", "access"].includes(kind)) return { ok: false, message: "Invalid type." };

    const c = sb();

    // Access role → sdr_roles (set first so it works even for access-only / non-HubSpot users).
    // manager carries a (vestigial) team_id to satisfy the legacy check constraint.
    if (role === "admin") await c.from("sdr_roles").upsert({ email, role: "admin", team_id: null }, { onConflict: "email" });
    else if (role === "manager") await c.from("sdr_roles").upsert({ email, role: "manager", team_id: aePod || managerKey || "team" }, { onConflict: "email" });
    else await c.from("sdr_roles").delete().eq("email", email);

    // "access" = an admin/viewer who is NOT a tracked rep (no book). Never put them in the roster;
    // remove any prior roster row (fixes people mistakenly added as a rep). Admins need no team.
    if (kind === "access") {
      await c.from("sdr_roster").delete().eq("email", email);
      invalidateTeamCache();
      revalidatePath("/admin");
      const { data: roleRow } = await c.from("sdr_roles").select("role").eq("email", email).maybeSingle();
      const { data: stillRep } = await c.from("sdr_roster").select("owner_id").eq("email", email).maybeSingle();
      if (stillRep) return { ok: false, message: `Could not remove ${email} from the tracked roster — please retry.` };
      return { ok: true, message: `✓ ${email} saved as access-only — DB confirms role='${roleRow?.role ?? "user"}', no roster row (not a tracked rep, no team needed).` };
    }

    // Tracked rep (SDR or AE): resolve the email → real HubSpot owner id (no live HubSpot call).
    const { data: owner } = await c.from("sdr_owners").select("owner_id,email,name").eq("email", email).maybeSingle();
    if (!owner) {
      return { ok: false, message: `No HubSpot user found for ${email}. Check the email, or run a reconcile to refresh the owner list, then retry.` };
    }
    const existed = (await c.from("sdr_roster").select("owner_id").eq("owner_id", owner.owner_id).maybeSingle()).data != null;
    const name = [first, last].filter(Boolean).join(" ") || owner.name || email;
    const { error } = await c.from("sdr_roster").upsert({
      owner_id: owner.owner_id, email, first_name: first || null, last_name: last || null,
      name, kind, ae_pod: aePod, manager_key: kind === "sdr" ? managerKey : null, // AEs don't report to an SDR manager
      active: true, updated_at: new Date().toISOString(),
    }, { onConflict: "owner_id" });
    if (error) return { ok: false, message: `Database write failed: ${error.message}` };

    invalidateTeamCache();
    const pull = await triggerOwnerPull(owner.owner_id);
    revalidatePath("/admin");

    // Verify the write actually landed by re-reading it back from the DB.
    const { data: row } = await c.from("sdr_roster")
      .select("name,kind,ae_pod,manager_key,active").eq("owner_id", owner.owner_id).maybeSingle();
    if (!row || !row.active) return { ok: false, message: `Write did not persist for ${email} — please retry.` };
    const parts = [`type ${row.kind.toUpperCase()}`];
    if (row.ae_pod) parts.push(`pod ${row.ae_pod}`);
    if (row.manager_key) parts.push(`mgr ${row.manager_key}`);
    if (role !== "user") parts.push(`role ${role}`);
    return { ok: true, message: `✓ ${row.name} ${existed ? "updated" : "added"} — verified in DB (${parts.join(" · ")}). History pull: ${pull}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Soft-delete: drop a user from the pull filter + dashboard, keep historical spine data. */
export async function setUserActive(formData: FormData) {
  await requireAdmin();
  const ownerId = str(formData, "owner_id");
  const active = str(formData, "active") === "true";
  const { error } = await sb().from("sdr_roster").update({ active, updated_at: new Date().toISOString() }).eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
  invalidateTeamCache();
  revalidatePath("/admin");
}

// ── Pods (AE pods) ────────────────────────────────────────────────────────────

export async function savePod(formData: FormData) {
  await requireAdmin();
  const name = str(formData, "name");
  if (!name) throw new Error("pod name required");
  const key = str(formData, "pod_key") || slug(name);
  const leadEmail = str(formData, "lead_email").toLowerCase() || null;
  if (leadEmail && !leadEmail.endsWith("@spyne.ai")) throw new Error("lead email must be @spyne.ai");
  const { error } = await sb().from("sdr_pods").upsert({
    pod_key: key, name, lead_email: leadEmail, active: true, updated_at: new Date().toISOString(),
  }, { onConflict: "pod_key" });
  if (error) throw new Error(error.message);
  invalidateTeamCache();
  revalidatePath("/admin");
}

export async function removePod(formData: FormData) {
  await requireAdmin();
  const key = str(formData, "pod_key");
  const { error } = await sb().from("sdr_pods").update({ active: false, updated_at: new Date().toISOString() }).eq("pod_key", key);
  if (error) throw new Error(error.message);
  invalidateTeamCache();
  revalidatePath("/admin");
}

// ── Managers / TLs ─────────────────────────────────────────────────────────────

/** Add/update a manager or TL. Resolves the manager's email → owner id (so their login is matched
 *  as a player-coach) when provided. parent_key rolls a TL up to a parent manager. */
export async function saveManager(formData: FormData) {
  await requireAdmin();
  const name = str(formData, "name");
  if (!name) throw new Error("manager name required");
  const key = str(formData, "manager_key") || slug(name);
  const parentKey = str(formData, "parent_key") || null;
  const email = str(formData, "email").toLowerCase();
  let ownerId: string | null = null;
  if (email) {
    if (!email.endsWith("@spyne.ai")) throw new Error("manager email must be @spyne.ai");
    const { data: owner } = await sb().from("sdr_owners").select("owner_id").eq("email", email).maybeSingle();
    ownerId = owner?.owner_id ?? null;
  }
  const { error } = await sb().from("sdr_managers").upsert({
    manager_key: key, name, owner_id: ownerId, parent_key: parentKey, active: true, updated_at: new Date().toISOString(),
  }, { onConflict: "manager_key" });
  if (error) throw new Error(error.message);
  invalidateTeamCache();
  revalidatePath("/admin");
}

export async function removeManager(formData: FormData) {
  await requireAdmin();
  const key = str(formData, "manager_key");
  const { error } = await sb().from("sdr_managers").update({ active: false, updated_at: new Date().toISOString() }).eq("manager_key", key);
  if (error) throw new Error(error.message);
  invalidateTeamCache();
  revalidatePath("/admin");
}

// ── Legacy role CRUD (kept: raw sdr_roles editing for edge cases) ───────────────

export async function addRole(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "viewer");
  const team_id = String(formData.get("team_id") ?? "").trim() || null;
  if (!email.endsWith("@spyne.ai")) throw new Error("spyne.ai emails only");
  if (!["admin", "leadership", "manager", "viewer"].includes(role)) throw new Error("bad role");
  if (role === "manager" && !team_id) throw new Error("manager needs a team_id");
  const { error } = await sb().from("sdr_roles").upsert({ email, role, team_id }, { onConflict: "email" });
  if (error) throw new Error(error.message);
  invalidateTeamCache();
  revalidatePath("/admin");
}

export async function removeRole(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "");
  const { error } = await sb().from("sdr_roles").delete().eq("email", email);
  if (error) throw new Error(error.message);
  invalidateTeamCache();
  revalidatePath("/admin");
}
