/** All sdr_* Postgres I/O. Server-only (service role). Batched, idempotent upserts. */
import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../supabase/admin";
import { Snapshot } from "../sync/types";
import { OwnedCompany } from "../sync/pull";
import { ContactMeta } from "../sync/associate";
import { ActivityRow, CompanyRow, ContactRow, OwnerRow, TeamMemberRow, TeamRow } from "./types";
import { rowToActivity, rowToContactMeta, rowToOwnedCompany } from "./rows";
import { REP_OWNER_IDS } from "../../config/reps";
import { Activity } from "../sync/types";

const BATCH = 500;
const PAGE = 1000;

function sb(): SupabaseClient {
  const c = supabaseAdmin();
  if (!c) throw new Error("[spine] Supabase env missing");
  return c;
}

async function upsertBatched(table: string, rows: object[], onConflict: string) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await sb().from(table).upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) throw new Error(`[spine] upsert ${table}: ${error.message}`);
  }
}

export const upsertActivities = (rows: ActivityRow[]) => upsertBatched("sdr_activities", rows, "hs_id");
export const upsertCompanies = (rows: Partial<CompanyRow>[]) => upsertBatched("sdr_companies", rows as object[], "hs_id");
export const upsertContacts = (rows: ContactRow[]) => upsertBatched("sdr_contacts", rows, "hs_id");

/** Owners+teams are small (~100 rows): replace-all semantics for memberships. */
export async function replaceOwnersTeams(owners: OwnerRow[], teams: TeamRow[], members: TeamMemberRow[]) {
  await upsertBatched("sdr_owners", owners, "owner_id");
  await upsertBatched("sdr_teams", teams, "team_id");
  const { error: delErr } = await sb().from("sdr_team_members").delete().neq("team_id", "");
  if (delErr) throw new Error(`[spine] clear team_members: ${delErr.message}`);
  await upsertBatched("sdr_team_members", members, "team_id,owner_id");
}

/** Owned-book reconcile: upsert current books, null out owner on rooftops no longer owned. */
export async function reconcileOwnedCompanies(current: (CompanyRow & { owner_id: string })[]) {
  await upsertCompanies(current);
  const { data, error } = await sb().from("sdr_companies").select("hs_id").not("owner_id", "is", null);
  if (error) throw new Error(`[spine] owned ids: ${error.message}`);
  const keep = new Set(current.map((c) => c.hs_id));
  const stale = (data ?? []).map((r) => r.hs_id).filter((id) => !keep.has(id));
  for (let i = 0; i < stale.length; i += 200) {
    const { error: e } = await sb().from("sdr_companies").update({ owner_id: null })
      .in("hs_id", stale.slice(i, i + 200));
    if (e) throw new Error(`[spine] clear stale owners: ${e.message}`);
  }
  return stale.length;
}

// ── sync state ────────────────────────────────────────────────────────────────
export async function getWatermark(key: string): Promise<number> {
  const { data, error } = await sb().from("sdr_sync_state").select("watermark_ms").eq("key", key).single();
  if (error) throw new Error(`[spine] watermark ${key}: ${error.message}`);
  return Number(data.watermark_ms) || 0;
}

export async function setSyncState(key: string, patch: {
  watermark_ms?: number; last_duration_ms?: number; last_counts?: object; notes?: string;
}) {
  const { error } = await sb().from("sdr_sync_state")
    .update({ ...patch, last_run_at: new Date().toISOString() }).eq("key", key);
  if (error) throw new Error(`[spine] setSyncState ${key}: ${error.message}`);
}

/** Advisory lock via the 'lock' row. Returns true if acquired. */
export async function tryLock(ttlMinutes: number): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const { data, error } = await sb().from("sdr_sync_state")
    .update({ lock_until: until }).eq("key", "lock")
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
    .select("key");
  if (error) throw new Error(`[spine] lock: ${error.message}`);
  return (data ?? []).length > 0;
}
export async function unlock() {
  await sb().from("sdr_sync_state").update({ lock_until: null }).eq("key", "lock");
}

// ── aggregate input + snapshot ───────────────────────────────────────────────
async function fetchAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb().from(table).select(select).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`[spine] fetch ${table}: ${error.message}`);
    out.push(...(data as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

export interface StoreForAggregate {
  activities: Activity[];
  companyNames: Record<string, string>;
  companyGdStage: Record<string, string | null>;
  contactMeta: Record<string, ContactMeta>;
  ownedCompanies: Record<string, OwnedCompany[]>;
}

export async function loadStoreForAggregate(anchorMs: number): Promise<StoreForAggregate> {
  const actRows = await fetchAll<ActivityRow>("sdr_activities",
    "hs_id,type,owner_id,ts_ms,disposition,email_status,email_opened,email_replied,email_clicked,contact_ids,company_ids",
    (q) => q.gte("ts_ms", anchorMs).order("ts_ms", { ascending: true }));
  const coRows = await fetchAll<CompanyRow>("sdr_companies",
    "hs_id,name,gd_stage,owner_id,gd_id,is_group,group_name,segment,dealership_type");
  const ctRows = await fetchAll<ContactRow>("sdr_contacts", "hs_id,name,title,dm");

  const companyNames: Record<string, string> = {};
  const companyGdStage: Record<string, string | null> = {};
  const ownedCompanies: Record<string, OwnedCompany[]> = {};
  for (const id of REP_OWNER_IDS) ownedCompanies[id] = [];
  for (const r of coRows) {
    companyNames[r.hs_id] = r.name?.trim() || `Company ${r.hs_id}`;
    companyGdStage[r.hs_id] = r.gd_stage;
    if (r.owner_id && ownedCompanies[r.owner_id]) ownedCompanies[r.owner_id].push(rowToOwnedCompany(r));
  }
  const contactMeta: Record<string, ContactMeta> = {};
  for (const r of ctRows) contactMeta[r.hs_id] = rowToContactMeta(r);

  return { activities: actRows.map(rowToActivity), companyNames, companyGdStage, contactMeta, ownedCompanies };
}

export async function saveSnapshot(snap: Snapshot) {
  const { error } = await sb().from("sdr_snapshots")
    .upsert({ id: 1, data: snap as unknown as object, generated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(`[spine] saveSnapshot: ${error.message}`);
}

export async function loadSnapshotRow(): Promise<Snapshot | null> {
  const { data, error } = await sb().from("sdr_snapshots").select("data").eq("id", 1).maybeSingle();
  if (error) throw new Error(`[spine] loadSnapshot: ${error.message}`);
  return (data?.data as Snapshot) ?? null;
}
