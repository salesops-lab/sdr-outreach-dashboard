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
  const repo = process.env.GH_REPO ?? "kauscodedev/sdr-outreach-dashboard";
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

/** Add or update a tracked user. Resolves the email → HubSpot owner id via sdr_owners (no live
 *  HubSpot call), upserts sdr_roster, sets the access role, and kicks a targeted history pull. */
export async function addUser(formData: FormData) {
  await requireAdmin();
  const first = str(formData, "first_name");
  const last = str(formData, "last_name");
  const email = str(formData, "email").toLowerCase();
  const role = str(formData, "role") || "user";            // user | manager | admin
  const managerKey = str(formData, "manager_key") || null; // SDR team (manager/TL); "" = AE
  const aePod = str(formData, "ae_pod") || null;           // AE pod
  if (!email.endsWith("@spyne.ai")) throw new Error("spyne.ai emails only");
  if (!["user", "manager", "admin"].includes(role)) throw new Error("bad role");

  const c = sb();
  const { data: owner } = await c.from("sdr_owners").select("owner_id,email,name").eq("email", email).maybeSingle();
  if (!owner) {
    throw new Error(`No HubSpot user found for ${email}. Confirm the email, or they may be new in ` +
      `HubSpot — run a reconcile to refresh the owner list, then try again.`);
  }

  const kind = managerKey ? "sdr" : "ae"; // "None" in the SDR-team field means this person is an AE
  const name = [first, last].filter(Boolean).join(" ") || owner.name || email;
  const { error } = await c.from("sdr_roster").upsert({
    owner_id: owner.owner_id, email, first_name: first || null, last_name: last || null,
    name, kind, ae_pod: aePod, manager_key: managerKey, active: true, updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id" });
  if (error) throw new Error(error.message);

  // Access role → sdr_roles. manager carries a (vestigial) team_id to satisfy the legacy check.
  if (role === "admin") await c.from("sdr_roles").upsert({ email, role: "admin", team_id: null }, { onConflict: "email" });
  else if (role === "manager") await c.from("sdr_roles").upsert({ email, role: "manager", team_id: aePod || managerKey || "team" }, { onConflict: "email" });
  else await c.from("sdr_roles").delete().eq("email", email);

  invalidateTeamCache();
  await triggerOwnerPull(owner.owner_id);
  revalidatePath("/admin");
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
