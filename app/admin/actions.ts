"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { supabaseServer } from "../../lib/supabase/server";
import { resolveViewer } from "../../lib/access/resolve";

async function requireAdmin() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  const viewer = await resolveViewer(user?.email ?? "");
  if (!viewer.isAdmin) throw new Error("forbidden");
}

export async function addRole(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "viewer");
  const team_id = String(formData.get("team_id") ?? "").trim() || null;
  if (!email.endsWith("@spyne.ai")) throw new Error("spyne.ai emails only");
  if (!["admin", "leadership", "manager", "viewer"].includes(role)) throw new Error("bad role");
  if (role === "manager" && !team_id) throw new Error("manager needs a team_id");
  const sb = supabaseAdmin();
  if (!sb) throw new Error("supabase unavailable");
  const { error } = await sb.from("sdr_roles").upsert({ email, role, team_id }, { onConflict: "email" });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}

export async function removeRole(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "");
  const sb = supabaseAdmin();
  if (!sb) throw new Error("supabase unavailable");
  const { error } = await sb.from("sdr_roles").delete().eq("email", email);
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}
