/** Verifies the sdr_* schema was applied: tables reachable via service key,
 *  seeds present, and the anon key CANNOT read (RLS floor). Run: npm run verify:schema
 *  Must run with `--conditions=react-server` (the npm script passes it) so the
 *  `server-only` guard inside lib/supabase/admin.ts resolves to its no-op export. */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { supabaseAdmin } from "../lib/supabase/admin";

const TABLES: [table: string, col: string][] = [
  ["sdr_activities","hs_id"],["sdr_companies","hs_id"],["sdr_contacts","hs_id"],
  ["sdr_owners","owner_id"],["sdr_teams","team_id"],["sdr_team_members","team_id"],
  ["sdr_roles","email"],["sdr_sync_state","key"],["sdr_snapshots","id"],
];

async function main() {
  const sb = supabaseAdmin();
  if (!sb) throw new Error("Supabase env missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  for (const [t, col] of TABLES) {
    const { error } = await sb.from(t).select(col).limit(1);
    if (error) throw new Error(`${t}: ${error.message} — schema not applied?`);
    console.log(`  ✓ ${t}`);
  }
  const { data: seeds, error: seedsErr } = await sb.from("sdr_sync_state").select("key");
  if (seedsErr) throw new Error(`sdr_sync_state: ${seedsErr.message}`);
  if (!seeds || seeds.length < 5) throw new Error("sync_state seeds missing");
  const { data: roles, error: rolesErr } = await sb.from("sdr_roles").select("email,role");
  if (rolesErr) throw new Error(`sdr_roles: ${rolesErr.message}`);
  if (!roles || roles.length < 1) throw new Error("sdr_roles seeds missing — anon RLS probe needs a non-empty table");
  console.log(`  ✓ seeds: ${seeds.length} sync keys, ${roles.length} roles`);

  // Anon must be blocked (RLS floor). Uses the publishable key with no session.
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY missing — cannot probe RLS floor");
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/sdr_roles?limit=1`,
    { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                 Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}` } },
  );
  const body = await res.text();
  if (res.ok && body !== "[]") throw new Error(`RLS FLOOR FAILED: anon read sdr_roles: ${body.slice(0, 80)}`);
  console.log(`  ✓ anon blocked (RLS floor holds, status ${res.status})`);
  console.log("Schema verified.");
}
main().catch((e) => { console.error(e); process.exit(1); });
