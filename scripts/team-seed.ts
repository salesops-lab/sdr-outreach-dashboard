/**
 * One-time seed: config/reps.ts + config/team-structure.ts → sdr_pods / sdr_managers / sdr_roster.
 * Idempotent AND edit-safe: inserts only rows that don't exist yet (ignoreDuplicates), so re-running
 * never overwrites changes made in the admin UI (e.g. a deactivated user won't be reactivated).
 * Enriches each roster row with the real email + name from sdr_owners.
 *
 * Run once after applying the schema:  npm run team:seed
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config(); // also .env if present

import { supabaseAdmin } from "../lib/supabase/admin";
import { configTeamStructure } from "../lib/team/config-source";

async function main() {
  const sb = supabaseAdmin();
  if (!sb) throw new Error("supabase unavailable — check SUPABASE env in .env.local");
  const ts = configTeamStructure();

  // Pods
  const podRows = ts.pods.map((p, i) => ({ pod_key: p.key, name: p.name, lead_email: p.leadEmail, active: true, sort: i }));
  const { error: pErr } = await sb.from("sdr_pods").upsert(podRows, { onConflict: "pod_key", ignoreDuplicates: true });
  if (pErr) throw new Error(`seed pods: ${pErr.message}`);

  // Managers / TLs
  const mgrRows = Object.values(ts.managers).map((m) => ({
    manager_key: m.key, name: m.name, owner_id: m.ownerId, parent_key: m.parent ?? null, active: true,
  }));
  const { error: mErr } = await sb.from("sdr_managers").upsert(mgrRows, { onConflict: "manager_key", ignoreDuplicates: true });
  if (mErr) throw new Error(`seed managers: ${mErr.message}`);

  // Roster — enrich from sdr_owners, and VALIDATE: only seed owner ids that are real HubSpot
  // owners. Config's 12 AE ids are fabricated (not in sdr_owners) — skip them rather than poison
  // the roster; the admin re-adds AEs by email (correct-by-construction) via the control center.
  const ownerIds = ts.members.map((m) => m.ownerId);
  const { data: owners } = await sb.from("sdr_owners").select("owner_id,email,name").in("owner_id", ownerIds);
  const ownerMap = new Map((owners ?? []).map((o) => [o.owner_id, o]));

  const valid = ts.members.filter((m) => ownerMap.has(m.ownerId));
  const invalid = ts.members.filter((m) => !ownerMap.has(m.ownerId));
  const rosterRows = valid.map((m) => {
    const o = ownerMap.get(m.ownerId)!;
    const fullName = o.name || m.name;
    const parts = fullName.split(/\s+/);
    return {
      owner_id: m.ownerId,
      email: o.email?.toLowerCase() ?? null,
      first_name: parts[0] ?? null,
      last_name: parts.slice(1).join(" ") || null,
      name: fullName,
      kind: m.kind,
      ae_pod: m.aePod,
      manager_key: m.managerKey,
      active: true,
    };
  });
  const { error: rErr } = await sb.from("sdr_roster").upsert(rosterRows, { onConflict: "owner_id", ignoreDuplicates: true });
  if (rErr) throw new Error(`seed roster: ${rErr.message}`);

  console.log(`[team:seed] pods=${podRows.length} managers=${mgrRows.length} roster=${rosterRows.length} valid members seeded.`);
  if (invalid.length) {
    console.warn(`[team:seed] SKIPPED ${invalid.length} member(s) whose config owner id is NOT a real HubSpot owner ` +
      `(re-add them by email in the admin UI): ${invalid.map((m) => `${m.name} (${m.ownerId})`).join(", ")}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
