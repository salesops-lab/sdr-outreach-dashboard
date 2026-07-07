# Phase 2+3: Data Spine + RBAC + Change-Feed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move SDR data into Supabase Postgres with an O(changes) delta sync, retire the committed snapshot, and add HubSpot-teams-derived role scoping (focus model) + an admin page.

**Architecture:** New `sdr_*` tables beside call-scoring's (untouched). Delta runner (npm script, GitHub Actions cron every 15 min) pulls only `hs_lastmodifieddate > watermark`, upserts, re-aggregates using the UNCHANGED `aggregate.ts`, and stores the result as one jsonb row that `getSnapshot()` now reads first. `resolveViewer(email)` maps login → HubSpot owner → team → default scope; everyone keeps org-wide visibility (focus model), leadership/admin get `/admin`.

**Tech stack:** existing only (Next 14, TS, supabase-js, Vitest). No new deps.

**Spec:** `docs/superpowers/specs/2026-07-07-phase23-spine-rbac-changefeed-design.md`
**Branch:** `phase23-spine-rbac` off `main`. Push only at final cutover.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/sdr_schema.sql` (new) | Idempotent DDL + RLS floor + seeds (roles, sync_state). User applies once in SQL editor. |
| `scripts/verify-sdr-schema.ts` (new) | Service-key probe: tables exist, RLS on, anon blocked. |
| `lib/spine/types.ts` (new) | Row shapes (`ActivityRow`, `CompanyRow`, `ContactRow`, …) + `Viewer`. |
| `lib/spine/rows.ts` (new) | Pure mappers row↔domain (TDD). |
| `lib/spine/store.ts` (new) | All Postgres I/O: batched upserts, watermarks, lock, load-for-aggregate, snapshot row. |
| `lib/spine/runner.ts` (new) | `runBackfill` / `runDelta` / `runReconcile` orchestration. |
| `lib/sync/pull.ts` (modify) | Add delta pulls (`pullChangedActivities`, `pullChangedCompanies`) + `pullOwnersTeams`; add `hs_lastmodifieddate` to existing configs. |
| `scripts/spine-{backfill,delta,reconcile}.ts` (new) | CLI entrypoints (`npm run sync:backfill` etc.). |
| `app/api/sync/delta/route.ts` (new) | CRON_SECRET-protected alternative trigger. |
| `.github/workflows/spine-delta.yml`, `spine-reconcile.yml` (new) | 15-min + nightly crons. `sync.yml` deleted at cutover. |
| `lib/snapshot.ts` (modify) | Read order: Postgres → Blob → file → empty. |
| `lib/access/resolve.ts` (new) | `resolveViewer` + pure `decideScope` (TDD). |
| `app/page.tsx`, `components/Dashboard.tsx` (modify) | Viewer prop, scope toggle (My scope / All reps), role badge. |
| `app/admin/page.tsx`, `app/admin/actions.ts` (new) | Roles CRUD + sync health + unassigned-reps warning. |
| `tests/spine-rows.test.ts`, `tests/access.test.ts`, `tests/watermark.test.ts` (new) | Pure-logic coverage. |

Env additions: `CRON_SECRET` (any random string; Vercel + local). GH repo secrets at cutover: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (values = the NEXT_PUBLIC url + service key already in `.env.local`).

---

### Task 1: Schema + verify script

**Files:** Create `supabase/sdr_schema.sql`, `scripts/verify-sdr-schema.ts`; modify `package.json` (script).

- [ ] **Step 1: Create `supabase/sdr_schema.sql`**

```sql
-- ============================================================
-- SDR Dashboard data spine (Phase 2+3). Safe to re-run (IF NOT EXISTS).
-- Lives beside call-scoring's tables; never touches them.
-- Apply in Supabase SQL editor. RLS floor: authenticated spyne.ai may
-- SELECT; all writes are service-role only (no write policies).
-- ============================================================

create table if not exists sdr_activities (
  hs_id              text primary key,
  type               text not null check (type in ('call','email')),
  owner_id           text not null,
  ts_ms              bigint not null,
  disposition        text,
  email_status       text,
  email_opened       boolean not null default false,
  email_replied      boolean not null default false,
  email_clicked      boolean not null default false,
  contact_ids        jsonb not null default '[]',
  company_ids        jsonb not null default '[]',
  hs_lastmodified_ms bigint,
  updated_at         timestamptz not null default now()
);
create index if not exists idx_sdr_act_owner_ts on sdr_activities(owner_id, ts_ms);
create index if not exists idx_sdr_act_ts on sdr_activities(ts_ms);

create table if not exists sdr_companies (
  hs_id              text primary key,
  name               text,
  gd_stage           text,
  owner_id           text,            -- null = not owned by a tracked rep
  gd_id              text,
  is_group           boolean not null default false,
  group_name         text,
  segment            text,
  dealership_type    text,
  hs_lastmodified_ms bigint,
  updated_at         timestamptz not null default now()
);
create index if not exists idx_sdr_co_owner on sdr_companies(owner_id);

create table if not exists sdr_contacts (
  hs_id      text primary key,
  name       text,
  title      text,
  dm         boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists sdr_owners (
  owner_id   text primary key,
  email      text,
  name       text,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists idx_sdr_owners_email on sdr_owners(lower(email));

create table if not exists sdr_teams (
  team_id    text primary key,
  name       text not null,
  updated_at timestamptz not null default now()
);

create table if not exists sdr_team_members (
  team_id  text not null,
  owner_id text not null,
  is_primary boolean not null default false,
  primary key (team_id, owner_id)
);

create table if not exists sdr_roles (
  email   text primary key,
  role    text not null check (role in ('admin','leadership','manager','viewer')),
  team_id text,           -- required for manager
  created_at timestamptz not null default now()
);

create table if not exists sdr_sync_state (
  key              text primary key,
  watermark_ms     bigint not null default 0,
  last_run_at      timestamptz,
  last_duration_ms integer,
  last_counts      jsonb,
  notes            text,
  lock_until       timestamptz
);

create table if not exists sdr_snapshots (
  id           integer primary key check (id = 1),
  data         jsonb not null,
  generated_at timestamptz not null default now()
);

-- Seeds (idempotent)
insert into sdr_sync_state(key) values ('calls'),('emails'),('companies'),('owners'),('lock')
  on conflict (key) do nothing;

insert into sdr_roles(email, role, team_id) values
  ('kaustubh.chauhan@spyne.ai','admin',null),
  ('saarthak.seth@spyne.ai','manager','362172393'),
  ('neelima.tiwari@spyne.ai','manager','362172280'),
  ('archit.gupta@spyne.ai','manager','362172309'),
  ('prince.arora@spyne.ai','manager','362172539'),
  ('david@spyne.ai','manager','365196665')
  on conflict (email) do nothing;

-- RLS floor: SELECT for authenticated spyne.ai; no write policies (service role bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['sdr_activities','sdr_companies','sdr_contacts','sdr_owners',
                           'sdr_teams','sdr_team_members','sdr_roles','sdr_sync_state','sdr_snapshots']
  loop
    execute format('alter table %I enable row level security', t);
    execute format($p$
      do $q$ begin
        create policy %I on %I for select to authenticated
          using ((auth.jwt() ->> 'email') ilike '%%@spyne.ai');
      exception when duplicate_object then null; end $q$;
    $p$, t || '_spyne_select', t);
  end loop;
end $$;
```

- [ ] **Step 2: Create `scripts/verify-sdr-schema.ts`**

```ts
/** Verifies the sdr_* schema was applied: tables reachable via service key,
 *  seeds present, and the anon key CANNOT read (RLS floor). Run: npm run verify:schema */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { supabaseAdmin } from "../lib/supabase/admin";

const TABLES = ["sdr_activities","sdr_companies","sdr_contacts","sdr_owners","sdr_teams",
  "sdr_team_members","sdr_roles","sdr_sync_state","sdr_snapshots"] as const;

async function main() {
  const sb = supabaseAdmin();
  if (!sb) throw new Error("Supabase env missing");
  for (const t of TABLES) {
    const { error } = await sb.from(t).select("*", { count: "exact", head: true });
    if (error) throw new Error(`${t}: ${error.message} — schema not applied?`);
    console.log(`  ✓ ${t}`);
  }
  const { data: seeds } = await sb.from("sdr_sync_state").select("key");
  if (!seeds || seeds.length < 5) throw new Error("sync_state seeds missing");
  const { data: roles } = await sb.from("sdr_roles").select("email,role");
  console.log(`  ✓ seeds: ${seeds.length} sync keys, ${roles?.length ?? 0} roles`);

  // Anon must be blocked (RLS floor). Uses the publishable key with no session.
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/sdr_roles?limit=1`,
    { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                 Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}` } },
  );
  const body = await res.text();
  if (res.ok && body !== "[]") throw new Error(`RLS FLOOR FAILED: anon read sdr_roles: ${body.slice(0, 80)}`);
  console.log("  ✓ anon blocked (RLS floor holds)");
  console.log("Schema verified.");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add script to `package.json`**: `"verify:schema": "tsx scripts/verify-sdr-schema.ts"` (alongside existing scripts).

- [ ] **Step 4: USER ACTION — apply `supabase/sdr_schema.sql`** in Supabase SQL editor, then run `npm run verify:schema`. Expected: all ✓ lines. (Controller pauses execution here until verified.)

- [ ] **Step 5: Commit** — `git add supabase scripts/verify-sdr-schema.ts package.json && git commit -m "feat(spine): sdr_* schema + verify script"`

---

### Task 2: Spine row types + pure mappers (TDD)

**Files:** Create `lib/spine/types.ts`, `lib/spine/rows.ts`; Test `tests/spine-rows.test.ts`.

- [ ] **Step 1: `lib/spine/types.ts`**

```ts
/** Row shapes for the sdr_* Postgres tables + the viewer model. */
import { Activity } from "../sync/types";

export interface ActivityRow {
  hs_id: string;
  type: "call" | "email";
  owner_id: string;
  ts_ms: number;
  disposition: string | null;
  email_status: string | null;
  email_opened: boolean;
  email_replied: boolean;
  email_clicked: boolean;
  contact_ids: string[];
  company_ids: string[];
  hs_lastmodified_ms: number | null;
}

export interface CompanyRow {
  hs_id: string;
  name: string | null;
  gd_stage: string | null;
  owner_id: string | null;
  gd_id: string | null;
  is_group: boolean;
  group_name: string | null;
  segment: string | null;
  dealership_type: string | null;
  hs_lastmodified_ms: number | null;
}

export interface ContactRow {
  hs_id: string;
  name: string | null;
  title: string | null;
  dm: boolean;
}

export interface OwnerRow { owner_id: string; email: string | null; name: string; active: boolean; }
export interface TeamRow { team_id: string; name: string; }
export interface TeamMemberRow { team_id: string; owner_id: string; is_primary: boolean; }

export type Role = "admin" | "leadership" | "manager" | "rep" | "viewer";

export interface Viewer {
  email: string;
  role: Role;
  /** The viewer's DEFAULT scope (focus model — org view remains available to all). */
  defaultOwnerIds: string[];
  isAdmin: boolean; // admin OR leadership → /admin access
}

export type { Activity };
```

- [ ] **Step 2: failing tests `tests/spine-rows.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { activityToRow, rowToActivity, rowToOwnedCompany, nextWatermark } from "../lib/spine/rows";
import { ActivityRow, CompanyRow } from "../lib/spine/types";

const act = { id: "42", type: "call" as const, ownerId: "69016314", timestampMs: 1000,
  disposition: "g", emailStatus: null, emailOpened: false, emailReplied: false,
  emailClicked: false, contactIds: ["c1"], companyIds: ["x"] };

describe("activity mappers", () => {
  it("round-trips through the row shape", () => {
    const row = activityToRow(act, 2000);
    expect(row).toMatchObject({ hs_id: "42", type: "call", owner_id: "69016314", ts_ms: 1000,
      contact_ids: ["c1"], company_ids: ["x"], hs_lastmodified_ms: 2000 });
    expect(rowToActivity(row)).toEqual(act);
  });
  it("tolerates jsonb arrays arriving as null", () => {
    const row = { ...activityToRow(act, 0), contact_ids: null, company_ids: null } as unknown as ActivityRow;
    const a = rowToActivity(row);
    expect(a.contactIds).toEqual([]);
    expect(a.companyIds).toEqual([]);
  });
});

describe("rowToOwnedCompany", () => {
  it("maps a company row to the OwnedCompany shape aggregate() expects", () => {
    const row: CompanyRow = { hs_id: "X", name: "Acme", gd_stage: "In Pipeline", owner_id: "69016314",
      gd_id: "900", is_group: true, group_name: "Big", segment: "mm_group",
      dealership_type: "Franchise", hs_lastmodified_ms: 1 };
    expect(rowToOwnedCompany(row)).toEqual({ id: "X", name: "Acme", gdStage: "In Pipeline",
      gdId: "900", isGroup: true, groupName: "Big", segment: "mm_group", dealershipType: "Franchise" });
  });
  it("falls back name to Company <id>", () => {
    const row: CompanyRow = { hs_id: "9", name: null, gd_stage: null, owner_id: null, gd_id: null,
      is_group: false, group_name: null, segment: null, dealership_type: null, hs_lastmodified_ms: null };
    expect(rowToOwnedCompany(row).name).toBe("Company 9");
  });
});

describe("nextWatermark", () => {
  it("advances to the max lastmodified seen", () => {
    expect(nextWatermark(100, [{ lastModifiedMs: 150 }, { lastModifiedMs: 120 }])).toBe(150);
  });
  it("keeps the previous watermark when nothing changed or fields missing", () => {
    expect(nextWatermark(100, [])).toBe(100);
    expect(nextWatermark(100, [{ lastModifiedMs: undefined }])).toBe(100);
  });
  it("never goes backwards", () => {
    expect(nextWatermark(200, [{ lastModifiedMs: 150 }])).toBe(200);
  });
});
```

- [ ] **Step 3: Run `npx vitest run tests/spine-rows.test.ts` — must FAIL (module missing).**

- [ ] **Step 4: Implement `lib/spine/rows.ts`**

```ts
/** Pure row↔domain mappers + watermark math. No I/O — unit-tested. */
import { Activity } from "../sync/types";
import { OwnedCompany } from "../sync/pull";
import { ActivityRow, CompanyRow, ContactRow } from "./types";
import { ContactMeta } from "../sync/associate";

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function activityToRow(a: Activity, lastModifiedMs: number | null): ActivityRow {
  return {
    hs_id: a.id, type: a.type, owner_id: a.ownerId, ts_ms: a.timestampMs,
    disposition: a.disposition, email_status: a.emailStatus,
    email_opened: a.emailOpened, email_replied: a.emailReplied, email_clicked: a.emailClicked,
    contact_ids: a.contactIds, company_ids: a.companyIds, hs_lastmodified_ms: lastModifiedMs,
  };
}

export function rowToActivity(r: ActivityRow): Activity {
  return {
    id: r.hs_id, type: r.type, ownerId: r.owner_id, timestampMs: Number(r.ts_ms),
    disposition: r.disposition, emailStatus: r.email_status,
    emailOpened: !!r.email_opened, emailReplied: !!r.email_replied, emailClicked: !!r.email_clicked,
    contactIds: arr(r.contact_ids), companyIds: arr(r.company_ids),
  };
}

export function rowToOwnedCompany(r: CompanyRow): OwnedCompany {
  return {
    id: r.hs_id, name: r.name?.trim() || `Company ${r.hs_id}`, gdStage: r.gd_stage,
    gdId: r.gd_id, isGroup: !!r.is_group, groupName: r.group_name,
    segment: r.segment, dealershipType: r.dealership_type,
  };
}

export function rowToContactMeta(r: ContactRow): ContactMeta {
  return { name: r.name?.trim() || `Contact ${r.hs_id}`, title: r.title, dm: !!r.dm };
}

/** Monotonic watermark advance over the batch actually processed. */
export function nextWatermark(prev: number, items: { lastModifiedMs?: number | null }[]): number {
  let max = prev;
  for (const i of items) if (i.lastModifiedMs != null && i.lastModifiedMs > max) max = i.lastModifiedMs;
  return max;
}
```

- [ ] **Step 5: `npx vitest run` all green; commit** — `git add lib/spine tests/spine-rows.test.ts && git commit -m "feat(spine): row types + pure mappers (TDD)"`

---

### Task 3: Store (all Postgres I/O)

**Files:** Create `lib/spine/store.ts`.

- [ ] **Step 1: Implement `lib/spine/store.ts`** (server-only via `supabaseAdmin`; every function throws on error — the runner catches and reports; the WEB read path in Task 6 catches separately)

```ts
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
```

- [ ] **Step 2: `npx tsc --noEmit` (0) then commit** — `git add lib/spine/store.ts && git commit -m "feat(spine): postgres store — upserts, watermarks, lock, aggregate input, snapshot row"`

---

### Task 4: Delta pulls in `lib/sync/pull.ts`

**Files:** Modify `lib/sync/pull.ts` (additive; existing functions untouched except two property-list additions).

- [ ] **Step 1:** Add `"hs_lastmodifieddate"` to `CALL_CONFIG.properties` and `EMAIL_CONFIG.properties`; add it to the `pullOwnedCompanies` select list. Extend `RawActivity` with `lastModifiedMs?: number;` and set it in both mapping loops in `pullActivities` (`lastModifiedMs: toMs(c.properties.hs_lastmodifieddate) || undefined`). Extend `OwnedCompany`… NO — owned companies keep their shape; instead `pullOwnedCompanies` returns unchanged (lastmodified not needed there).

- [ ] **Step 2:** Append delta + owners functions:

```ts
/** One page-loop pull of records modified since `sinceMs`, ascending by lastmodified.
 *  If a 10k window fills, the caller re-calls with the returned `resumeFrom`. */
async function pullModifiedSlice(cfg: PullConfig, sinceMs: number): Promise<{ records: HsRecord[]; sawCeiling: boolean }> {
  const collected: HsRecord[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [
        { propertyName: "hubspot_owner_id", operator: "IN", values: REP_OWNER_IDS },
        { propertyName: cfg.directionProperty, operator: "EQ", value: cfg.directionValue },
        { propertyName: "hs_lastmodifieddate", operator: "GT", value: String(sinceMs) },
      ] }],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      properties: cfg.properties,
      limit: 100,
    };
    if (after) body.after = after;
    const res = await hubspotPost<SearchResponse>(`/crm/v3/objects/${cfg.objectType}/search`, body);
    collected.push(...res.results);
    after = res.paging?.next?.after;
    await delay(RATE_LIMIT_DELAY_MS);
    if (collected.length >= 9800) return { records: collected, sawCeiling: true }; // progressive catch-up
  } while (after);
  return { records: collected, sawCeiling: false };
}

/** Changed outbound activities since watermarks (per type). O(changes). */
export async function pullChangedActivities(
  sinceCallsMs: number, sinceEmailsMs: number, caps: PullCaps,
): Promise<RawActivity[]> {
  const out: HsRecord[] = [];
  const seen = new Set<string>();
  const run = async (cfg: PullConfig, since: number) => {
    let cursor = since;
    for (;;) {
      const { records, sawCeiling } = await pullModifiedSlice(cfg, cursor);
      for (const r of records) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
      if (!sawCeiling) break;
      const last = records[records.length - 1];
      cursor = toMs(last.properties.hs_lastmodifieddate ?? null) || cursor + 1;
      console.warn(`  [${cfg.objectType}] delta hit 10k window — resuming from ${new Date(cursor).toISOString()}`);
    }
  };
  if (caps.calls) await run(CALL_CONFIG, sinceCallsMs);
  if (caps.emails) await run(EMAIL_CONFIG, sinceEmailsMs);
  return normalizeRecords(out);
}

/** Companies owned by tracked reps changed since `sinceMs` (owner moves INTO book, edits). */
export async function pullChangedCompanies(sinceMs: number): Promise<(OwnedCompany & { ownerId: string; lastModifiedMs: number })[]> {
  const out: (OwnedCompany & { ownerId: string; lastModifiedMs: number })[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [
        { propertyName: "hubspot_owner_id", operator: "IN", values: REP_OWNER_IDS },
        { propertyName: "hs_lastmodifieddate", operator: "GT", value: String(sinceMs) },
      ] }],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      properties: ["name","lifecycle_stage_gd_level","gd_id","is_this_is_a_part_of_group_dealership_",
        "dealership_group_name","market_segment","type_of_dealership","hubspot_owner_id","hs_lastmodifieddate"],
      limit: 100,
    };
    if (after) body.after = after;
    const res = await hubspotPost<SearchResponse>(`/crm/v3/objects/companies/search`, body);
    for (const r of res.results) {
      out.push({
        id: r.id, name: r.properties.name?.trim() || `Company ${r.id}`,
        gdStage: r.properties.lifecycle_stage_gd_level?.trim() || null,
        gdId: r.properties.gd_id?.trim() || null,
        isGroup: r.properties.is_this_is_a_part_of_group_dealership_ === "true",
        groupName: r.properties.dealership_group_name?.trim() || null,
        segment: r.properties.market_segment?.trim() || null,
        dealershipType: r.properties.type_of_dealership?.trim() || null,
        ownerId: r.properties.hubspot_owner_id ?? "",
        lastModifiedMs: toMs(r.properties.hs_lastmodifieddate ?? null) || 0,
      });
    }
    after = res.paging?.next?.after;
    await delay(RATE_LIMIT_DELAY_MS);
  } while (after);
  return out;
}

export interface HsOwnerWithTeams {
  id: string; email: string | null; firstName: string; lastName: string; archived: boolean;
  teams?: { id: string; name: string; primary?: boolean }[];
}

/** All owners (+team memberships) — 1-2 GET pages. */
export async function pullOwnersTeams(): Promise<HsOwnerWithTeams[]> {
  const out: HsOwnerWithTeams[] = [];
  let after: string | undefined;
  do {
    const path = `/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`;
    const res = await hubspotGet<{ results: HsOwnerWithTeams[]; paging?: { next?: { after?: string } } }>(path);
    out.push(...res.results);
    after = res.paging?.next?.after;
    await delay(RATE_LIMIT_DELAY_MS);
  } while (after);
  return out;
}
```

Also: extract the existing `RawActivity` normalization in `pullActivities` (the two `for` loops + trackable filter) into a shared `function normalizeRecords(records: HsRecord[]): RawActivity[]` used by BOTH `pullActivities` and `pullChangedActivities` — the call/email branch keyed by presence of `hs_call_direction` in properties (`const isCall = r.properties.hs_call_direction != null`). Add `import { hubspotGet } from "../hubspot/client";`.

- [ ] **Step 3:** `npx tsc --noEmit` + `npx vitest run` (all green — existing tests untouched). Commit: `git add lib/sync/pull.ts && git commit -m "feat(spine): delta pulls (activities/companies) + owners/teams pull"`

---

### Task 5: Runner + CLI scripts + route + workflows

**Files:** Create `lib/spine/runner.ts`, `scripts/spine-backfill.ts`, `scripts/spine-delta.ts`, `scripts/spine-reconcile.ts`, `app/api/sync/delta/route.ts`, `.github/workflows/spine-delta.yml`, `.github/workflows/spine-reconcile.yml`; modify `package.json`.

- [ ] **Step 1: `lib/spine/runner.ts`**

```ts
/** Sync orchestration: backfill (once) → delta (every 15 min) → reconcile (nightly).
 *  All runs are idempotent (PK upserts) and watermark-driven (O(changes)). */
import { makeEtContext, etMidnightUtcMs } from "../sync/buckets";
import { COVERAGE_ANCHOR } from "../../config/hubspot";
import { aggregate } from "../sync/aggregate";
import { resolveAssociations } from "../sync/associate";
import {
  pullActivities, pullChangedActivities, pullChangedCompanies, pullOwnedCompanies,
  pullOwnersTeams, PullCaps, RawActivity,
} from "../sync/pull";
import { activityToRow, nextWatermark } from "./rows";
import {
  getWatermark, loadStoreForAggregate, reconcileOwnedCompanies, replaceOwnersTeams,
  saveSnapshot, setSyncState, tryLock, unlock, upsertActivities, upsertCompanies, upsertContacts,
} from "./store";
import { ContactMeta } from "../sync/associate";

const OVERLAP_MS = 5 * 60_000; // re-read 5 min to absorb clock skew / same-ms writes
const LOCK_TTL_MIN = 12;

function anchorMs(): number {
  const [y, m, d] = COVERAGE_ANCHOR.split("-").map(Number);
  return etMidnightUtcMs(y, m, d);
}

async function refreshOwnersTeams() {
  const owners = await pullOwnersTeams();
  const teams = new Map<string, string>();
  const members: { team_id: string; owner_id: string; is_primary: boolean }[] = [];
  for (const o of owners) for (const t of o.teams ?? []) {
    teams.set(t.id, t.name);
    members.push({ team_id: t.id, owner_id: o.id, is_primary: !!t.primary });
  }
  await replaceOwnersTeams(
    owners.map((o) => ({ owner_id: o.id, email: o.email?.toLowerCase() ?? null,
      name: `${o.firstName} ${o.lastName}`.trim() || o.email || o.id, active: !o.archived })),
    [...teams].map(([team_id, name]) => ({ team_id, name })),
    members,
  );
  return owners.length;
}

async function persistResolved(raw: RawActivity[]) {
  const { activities, companyNames, companyGdStage, contactMeta } = await resolveAssociations(raw);
  const lastMod = new Map(raw.map((r) => [r.id, r.lastModifiedMs ?? null]));
  await upsertActivities(activities.map((a) => activityToRow(a, lastMod.get(a.id) ?? null)));
  await upsertCompanies(Object.keys(companyNames).map((id) => ({
    hs_id: id, name: companyNames[id], gd_stage: companyGdStage[id] ?? null,
  })));
  const metaRows = Object.entries(contactMeta).map(([hs_id, m]: [string, ContactMeta]) => ({
    hs_id, name: m.name, title: m.title, dm: m.dm,
  }));
  await upsertContacts(metaRows);
  return activities.length;
}

async function reaggregate(caps: PullCaps) {
  const store = await loadStoreForAggregate(anchorMs());
  const ctx = makeEtContext(Date.now());
  const snap = aggregate(store.activities, store.companyNames, store.companyGdStage,
    store.contactMeta, store.ownedCompanies, ctx, Date.now(), caps);
  await saveSnapshot(snap);
  return snap.totals;
}

export async function runDelta(caps: PullCaps = { calls: true, emails: true }) {
  if (!(await tryLock(LOCK_TTL_MIN))) { console.log("[delta] another run holds the lock — exiting."); return; }
  const t0 = Date.now();
  try {
    const [wmCalls, wmEmails, wmCompanies] = await Promise.all([
      getWatermark("calls"), getWatermark("emails"), getWatermark("companies")]);
    if (wmCalls === 0 && wmEmails === 0) throw new Error("Watermarks are zero — run `npm run sync:backfill` first.");

    const raw = await pullChangedActivities(Math.max(0, wmCalls - OVERLAP_MS), Math.max(0, wmEmails - OVERLAP_MS), caps);
    const changedCompanies = await pullChangedCompanies(Math.max(0, wmCompanies - OVERLAP_MS));

    let upserted = 0;
    if (raw.length) upserted = await persistResolved(raw);
    if (changedCompanies.length) {
      await upsertCompanies(changedCompanies.map((c) => ({
        hs_id: c.id, name: c.name, gd_stage: c.gdStage, owner_id: c.ownerId, gd_id: c.gdId,
        is_group: c.isGroup, group_name: c.groupName, segment: c.segment,
        dealership_type: c.dealershipType, hs_lastmodified_ms: c.lastModifiedMs,
      })));
    }
    const ownerCount = await refreshOwnersTeams();
    const totals = await reaggregate(caps);

    const calls = raw.filter((r) => r.type === "call");
    const emails = raw.filter((r) => r.type === "email");
    await setSyncState("calls", { watermark_ms: nextWatermark(wmCalls, calls), last_counts: { changed: calls.length } });
    await setSyncState("emails", { watermark_ms: nextWatermark(wmEmails, emails), last_counts: { changed: emails.length } });
    await setSyncState("companies", { watermark_ms: nextWatermark(wmCompanies, changedCompanies), last_counts: { changed: changedCompanies.length } });
    await setSyncState("owners", { last_counts: { owners: ownerCount } });
    await setSyncState("lock", { last_duration_ms: Date.now() - t0, last_counts: { activities: upserted, snapshotCalls: totals.calls }, notes: "delta ok" });
    console.log(`[delta] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${raw.length} changed activities, ${changedCompanies.length} companies.`);
  } catch (err) {
    await setSyncState("lock", { notes: `delta FAILED: ${err instanceof Error ? err.message : err}` }).catch(() => {});
    throw err;
  } finally {
    await unlock().catch(() => {});
  }
}

export async function runBackfill(caps: PullCaps) {
  if (!(await tryLock(120))) throw new Error("locked");
  const t0 = Date.now();
  try {
    const start = anchorMs();
    console.log(`[backfill] full pull from ${COVERAGE_ANCHOR}…`);
    const raw = await pullActivities(start, Date.now(), caps);
    await persistResolved(raw);
    const books = await pullOwnedCompanies();
    const rows = Object.entries(books).flatMap(([ownerId, cos]) => cos.map((c) => ({
      hs_id: c.id, name: c.name, gd_stage: c.gdStage, owner_id: ownerId, gd_id: c.gdId,
      is_group: c.isGroup, group_name: c.groupName, segment: c.segment, dealership_type: c.dealershipType,
    })));
    await reconcileOwnedCompanies(rows as never);
    await refreshOwnersTeams();
    const totals = await reaggregate(caps);
    // Watermark = now − 1h: the next delta re-reads a safe overlap of the tail.
    const wm = Date.now() - 3_600_000;
    for (const k of ["calls", "emails", "companies"]) await setSyncState(k, { watermark_ms: wm });
    await setSyncState("lock", { last_duration_ms: Date.now() - t0, notes: "backfill ok" });
    console.log(`[backfill] done in ${((Date.now() - t0) / 60000).toFixed(1)}m — snapshot totals: ${totals.calls} calls / ${totals.emails} emails.`);
  } finally {
    await unlock().catch(() => {});
  }
}

export async function runReconcile(caps: PullCaps = { calls: true, emails: true }) {
  if (!(await tryLock(60))) { console.log("[reconcile] locked — exiting."); return; }
  const t0 = Date.now();
  try {
    // Full book re-pull: catches owner moves AWAY from tracked reps (delta can't see those).
    const books = await pullOwnedCompanies();
    const rows = Object.entries(books).flatMap(([ownerId, cos]) => cos.map((c) => ({
      hs_id: c.id, name: c.name, gd_stage: c.gdStage, owner_id: ownerId, gd_id: c.gdId,
      is_group: c.isGroup, group_name: c.groupName, segment: c.segment, dealership_type: c.dealershipType,
    })));
    const cleared = await reconcileOwnedCompanies(rows as never);
    // Re-pull last 7 days of activity in full (drift/deletes safety net).
    const since = Date.now() - 7 * 86_400_000;
    const raw = await pullActivities(since, Date.now(), caps);
    await persistResolved(raw);
    await refreshOwnersTeams();
    await reaggregate(caps);
    await setSyncState("lock", { last_duration_ms: Date.now() - t0, notes: `reconcile ok (cleared ${cleared} stale owners)` });
    console.log(`[reconcile] done in ${((Date.now() - t0) / 60000).toFixed(1)}m.`);
  } finally {
    await unlock().catch(() => {});
  }
}
```

- [ ] **Step 2: CLI scripts** — three files, same skeleton; `scripts/spine-delta.ts`:

```ts
import { config } from "dotenv";
config({ path: ".env.local" }); config();
import { runDelta } from "../lib/spine/runner";
runDelta().catch((e) => { console.error(e); process.exit(1); });
```

`scripts/spine-reconcile.ts` → `runReconcile()`. `scripts/spine-backfill.ts` → preflight then backfill:

```ts
import { config } from "dotenv";
config({ path: ".env.local" }); config();
import { runBackfill } from "../lib/spine/runner";
// Reuse the same preflight semantics as scripts/sync.ts (calls/emails caps).
import { hubspotGet } from "../lib/hubspot/client";
async function cap(obj: string, prop: string, expect: string) {
  try { const d = await hubspotGet<{ options?: { value: string }[] }>(`/crm/v3/properties/${obj}/${prop}`);
    return (d.options ?? []).some((o) => o.value === expect); } catch { return false; }
}
(async () => {
  const caps = { calls: await cap("calls", "hs_call_direction", "OUTBOUND"),
                 emails: await cap("emails", "hs_email_direction", "EMAIL") };
  if (!caps.calls && !caps.emails) throw new Error("token can read neither calls nor emails");
  await runBackfill(caps);
})().catch((e) => { console.error(e); process.exit(1); });
```

`package.json` scripts: `"sync:backfill": "tsx scripts/spine-backfill.ts"`, `"sync:delta": "tsx scripts/spine-delta.ts"`, `"sync:reconcile": "tsx scripts/spine-reconcile.ts"`.

- [ ] **Step 3: `app/api/sync/delta/route.ts`** (alt trigger for external pingers; NOT the primary path)

```ts
import { NextRequest, NextResponse } from "next/server";
import { runDelta } from "../../../../lib/spine/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await runDelta();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
```

Also add `/api/sync` to NOTHING in middleware — it must stay GATED? No: external pingers have no session. Add to `middleware.ts` `PUBLIC_PATHS`: `"/api/sync"` — the route self-authorizes via CRON_SECRET (401 without it). One-line change: `const PUBLIC_PATHS = ["/login", "/auth", "/api/sync"];`

- [ ] **Step 4: workflows.** `.github/workflows/spine-delta.yml`:

```yaml
name: Spine delta sync
on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
permissions: {}
concurrency: spine-sync
jobs:
  delta:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run sync:delta
        env:
          HUBSPOT_PAT: ${{ secrets.HUBSPOT_PAT }}
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

`spine-reconcile.yml`: same skeleton, `cron: "30 6 * * *"` (06:30 UTC = 02:30 ET), `timeout-minutes: 60`, `run: npm run sync:reconcile`.

- [ ] **Step 5:** `npx tsc --noEmit`, `npx vitest run`, `npm run build` (route listed). Commit: `git add lib/spine scripts app package.json .github middleware.ts && git commit -m "feat(spine): delta/backfill/reconcile runner, CLI, cron workflows, alt trigger route"`

---

### Task 6: Snapshot loader reads Postgres first

**Files:** Modify `lib/snapshot.ts`.

- [ ] **Step 1:** Add before `loadFromBlob`:

```ts
async function loadFromSpine(): Promise<Snapshot | null> {
  try {
    const { loadSnapshotRow } = await import("./spine/store");
    return await loadSnapshotRow();
  } catch (err) {
    console.error("[snapshot] spine load failed, falling back:", err);
    return null;
  }
}
```

and change `getSnapshot` to:

```ts
export async function getSnapshot(): Promise<Snapshot> {
  return (await loadFromSpine()) ?? (await loadFromBlob()) ?? (await loadFromFile()) ?? emptySnapshot();
}
```

- [ ] **Step 2:** `npm run build` green. Commit: `git commit -am "feat(spine): getSnapshot reads Postgres snapshot row first"`

---

### Task 7: Viewer resolution (TDD)

**Files:** Create `lib/access/resolve.ts`; Test `tests/access.test.ts`.

- [ ] **Step 1: failing tests `tests/access.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { decideScope } from "../lib/access/resolve";

const TRACKED = ["A", "B", "C", "D"];

describe("decideScope", () => {
  it("admin/leadership → all tracked + admin flag", () => {
    const v = decideScope("boss@spyne.ai", { role: "admin", team_id: null }, null, [], TRACKED);
    expect(v).toMatchObject({ role: "admin", isAdmin: true, defaultOwnerIds: TRACKED });
    expect(decideScope("l@spyne.ai", { role: "leadership", team_id: null }, null, [], TRACKED).isAdmin).toBe(true);
  });
  it("manager → own team ∩ tracked", () => {
    const v = decideScope("mgr@spyne.ai", { role: "manager", team_id: "T1" }, null, ["A", "X", "C"], TRACKED);
    expect(v).toMatchObject({ role: "manager", isAdmin: false, defaultOwnerIds: ["A", "C"] });
  });
  it("tracked rep (no role row) → own data", () => {
    const v = decideScope("rep@spyne.ai", null, "B", [], TRACKED);
    expect(v).toMatchObject({ role: "rep", defaultOwnerIds: ["B"] });
  });
  it("everyone else → viewer with org-wide default", () => {
    const v = decideScope("cs@spyne.ai", null, null, [], TRACKED);
    expect(v).toMatchObject({ role: "viewer", isAdmin: false, defaultOwnerIds: TRACKED });
  });
  it("manager row without team falls back to viewer", () => {
    expect(decideScope("m@spyne.ai", { role: "manager", team_id: null }, null, [], TRACKED).role).toBe("viewer");
  });
});
```

- [ ] **Step 2: run — FAIL. Then implement `lib/access/resolve.ts`:**

```ts
/** Login email → role → default scope (focus model: org view stays available to all).
 *  Chain: sdr_roles override → tracked-rep match via sdr_owners → viewer. */
import { supabaseAdmin } from "../supabase/admin";
import { REP_OWNER_IDS } from "../../config/reps";
import { Role, Viewer } from "../spine/types";

/** Pure scope decision — unit-tested. */
export function decideScope(
  email: string,
  roleRow: { role: string; team_id: string | null } | null,
  trackedOwnerId: string | null,
  teamMemberOwnerIds: string[],
  allTracked: string[],
): Viewer {
  if (roleRow?.role === "admin" || roleRow?.role === "leadership") {
    return { email, role: roleRow.role as Role, defaultOwnerIds: allTracked, isAdmin: true };
  }
  if (roleRow?.role === "manager" && roleRow.team_id) {
    const scope = teamMemberOwnerIds.filter((id) => allTracked.includes(id));
    return { email, role: "manager", defaultOwnerIds: scope, isAdmin: false };
  }
  if (trackedOwnerId) return { email, role: "rep", defaultOwnerIds: [trackedOwnerId], isAdmin: false };
  return { email, role: "viewer", defaultOwnerIds: allTracked, isAdmin: false };
}

/** Server-side resolution. NEVER throws — failure degrades to org-wide viewer. */
export async function resolveViewer(email: string): Promise<Viewer> {
  const fallback: Viewer = { email, role: "viewer", defaultOwnerIds: [...REP_OWNER_IDS], isAdmin: false };
  const sb = supabaseAdmin();
  if (!sb) return fallback;
  try {
    const lower = email.toLowerCase();
    const { data: roleRow } = await sb.from("sdr_roles").select("role,team_id").eq("email", lower).maybeSingle();
    let teamMembers: string[] = [];
    if (roleRow?.role === "manager" && roleRow.team_id) {
      const { data } = await sb.from("sdr_team_members").select("owner_id").eq("team_id", roleRow.team_id);
      teamMembers = (data ?? []).map((r) => r.owner_id);
    }
    let trackedOwnerId: string | null = null;
    if (!roleRow) {
      const { data: owner } = await sb.from("sdr_owners").select("owner_id").eq("email", lower).maybeSingle();
      if (owner && REP_OWNER_IDS.includes(owner.owner_id)) trackedOwnerId = owner.owner_id;
    }
    return decideScope(email, roleRow ?? null, trackedOwnerId, teamMembers, [...REP_OWNER_IDS]);
  } catch (err) {
    console.error("[access] resolveViewer failed:", err);
    return fallback;
  }
}
```

- [ ] **Step 3: green + commit** — `git add lib/access tests/access.test.ts && git commit -m "feat(access): viewer resolution from roles + hubspot teams (TDD)"`

---

### Task 8: UI scoping (page + Dashboard)

**Files:** Modify `app/page.tsx`, `components/Dashboard.tsx`.

- [ ] **Step 1: `app/page.tsx`** — resolve the viewer from the session:

```tsx
import { getSnapshot, stripBookUnits } from "../lib/snapshot";
import { getCoachingByRep } from "../lib/callquality/fetch";
import { resolveViewer } from "../lib/access/resolve";
import { supabaseServer } from "../lib/supabase/server";
import Dashboard from "../components/Dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const [snapshot, coaching, viewer] = await Promise.all([
    getSnapshot(), getCoachingByRep(), resolveViewer(user?.email ?? ""),
  ]);
  return <Dashboard snapshot={stripBookUnits(snapshot)} coaching={coaching} viewer={viewer} />;
}
```

- [ ] **Step 2: `components/Dashboard.tsx`** — props gain `viewer: Viewer` (`import { Viewer } from "../lib/spine/types";`). Add scope state after `drawerRep`:

```tsx
  const scoped = viewer.defaultOwnerIds.length > 0 && viewer.defaultOwnerIds.length < Object.keys(snapshot.reps).length;
  const [scopeMode, setScopeMode] = useState<"mine" | "all">(scoped ? "mine" : "all");
```

In `allRows` useMemo, filter first: `Object.entries(snapshot.reps).filter(([id]) => scopeMode === "all" || viewer.defaultOwnerIds.includes(id)).map(…)` (add `scopeMode`, `viewer` to deps). Insert a scope toggle chip-group in the controls row (before the rep `<select>`), rendered only when `scoped`:

```tsx
        {scoped && (
          <div className="flex gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
            {([["mine", viewer.role === "rep" ? "My data" : "My team"], ["all", "All reps"]] as const).map(([m, label]) => (
              <button key={m} onClick={() => setScopeMode(m)}
                className={`rounded-xl px-3 py-1.5 text-sm transition ${scopeMode === m ? "bg-gradient-to-r from-emerald-600 to-teal-600 font-semibold text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
```

Header right side: above `<LogoutButton />` add a role badge line: `<span className="rounded-lg bg-slate-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-slate-500">{viewer.role}</span>` and, when `viewer.isAdmin`, an `<a href="/admin" className="text-blue-600 hover:underline">Admin</a>` link beside it.

- [ ] **Step 3:** `npm run build` + `npx vitest run` green. Commit: `git add app/page.tsx components/Dashboard.tsx && git commit -m "feat(access): viewer scoping — default scope toggle, role badge, admin link"`

---

### Task 9: Admin page

**Files:** Create `app/admin/page.tsx`, `app/admin/actions.ts`.

- [ ] **Step 1: `app/admin/actions.ts`** (server actions; re-verify admin on every call)

```ts
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
```

- [ ] **Step 2: `app/admin/page.tsx`** (server component; redirect non-admins)

```tsx
import { redirect } from "next/navigation";
import { supabaseServer } from "../../lib/supabase/server";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { resolveViewer } from "../../lib/access/resolve";
import { REPS, REP_OWNER_IDS } from "../../config/reps";
import { addRole, removeRole } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  const viewer = await resolveViewer(user?.email ?? "");
  if (!viewer.isAdmin) redirect("/");

  const sb = supabaseAdmin();
  async function rows<T>(q: PromiseLike<{ data: T[] | null }> | undefined): Promise<T[]> {
    if (!q) return [];
    const { data } = await q;
    return data ?? [];
  }
  const roles = await rows(sb?.from("sdr_roles").select("email,role,team_id").order("role"));
  const teams = await rows(sb?.from("sdr_teams").select("team_id,name"));
  const members = await rows(sb?.from("sdr_team_members").select("team_id,owner_id"));
  const syncState = await rows(sb?.from("sdr_sync_state").select("*").order("key"));

  const teamName = new Map((teams as { team_id: string; name: string }[]).map((t) => [t.team_id, t.name]));
  const assigned = new Set((members as { owner_id: string }[]).map((m) => m.owner_id));
  const unassigned = REP_OWNER_IDS.filter((id) => !assigned.has(id));

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-slate-900">Admin</h1>
        <a href="/" className="text-sm text-blue-600 hover:underline">← Dashboard</a>
      </header>

      {unassigned.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          ⚠️ {unassigned.length} tracked reps are in <b>no HubSpot team</b> (invisible to every manager
          scope): {unassigned.map((id) => REPS[id]).join(", ")}. Assign them to teams in HubSpot.
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Roles</h2>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-1">Email</th><th>Role</th><th>Team</th><th /></tr></thead>
          <tbody>
            {(roles as { email: string; role: string; team_id: string | null }[]).map((r) => (
              <tr key={r.email} className="border-b border-slate-100">
                <td className="py-1.5">{r.email}</td>
                <td className="font-semibold">{r.role}</td>
                <td>{r.team_id ? teamName.get(r.team_id) ?? r.team_id : "—"}</td>
                <td className="text-right">
                  <form action={removeRole}><input type="hidden" name="email" value={r.email} />
                    <button className="text-xs text-rose-600 hover:underline">remove</button></form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addRole} className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <input name="email" required placeholder="name@spyne.ai" className="rounded-lg border border-slate-200 px-2 py-1.5" />
          <select name="role" className="rounded-lg border border-slate-200 px-2 py-1.5">
            <option value="viewer">viewer</option><option value="manager">manager</option>
            <option value="leadership">leadership</option><option value="admin">admin</option>
          </select>
          <select name="team_id" className="rounded-lg border border-slate-200 px-2 py-1.5">
            <option value="">no team</option>
            {(teams as { team_id: string; name: string }[]).map((t) => (
              <option key={t.team_id} value={t.team_id}>{t.name}</option>))}
          </select>
          <button className="rounded-lg bg-slate-900 px-3 py-1.5 font-semibold text-white">Add / update</button>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Sync health</h2>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-1">Key</th><th>Watermark</th><th>Last run</th><th>Duration</th><th>Counts</th><th>Notes</th></tr></thead>
          <tbody>
            {(syncState as { key: string; watermark_ms: number; last_run_at: string | null; last_duration_ms: number | null; last_counts: object | null; notes: string | null }[]).map((s) => (
              <tr key={s.key} className="border-b border-slate-100">
                <td className="py-1.5 font-semibold">{s.key}</td>
                <td className="tabular-nums">{s.watermark_ms ? new Date(Number(s.watermark_ms)).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—"}</td>
                <td className="tabular-nums">{s.last_run_at ? new Date(s.last_run_at).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—"}</td>
                <td className="tabular-nums">{s.last_duration_ms ? `${Math.round(s.last_duration_ms / 1000)}s` : "—"}</td>
                <td className="text-xs">{s.last_counts ? JSON.stringify(s.last_counts) : "—"}</td>
                <td className="text-xs text-slate-500">{s.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
```

- [ ] **Step 3:** build + tests green; commit — `git add app/admin && git commit -m "feat(access): admin page — roles CRUD + sync health + unassigned reps"`

---

### Task 10: Docs + cutover

**Files:** Modify `CLAUDE.md`, `README.md`, `data/snapshot.json`, delete `.github/workflows/sync.yml`; GH secrets; run backfill.

- [ ] **Step 1: GH secrets** (values from `.env.local` — never echo):
```bash
gh secret set SUPABASE_URL --body "$(awk -F= '/^NEXT_PUBLIC_SUPABASE_URL=/{print $2}' .env.local)"
gh secret set SUPABASE_SERVICE_ROLE_KEY --body "$(awk -F= '/^SUPABASE_SERVICE_ROLE_KEY=/{print $2}' .env.local)"
```
- [ ] **Step 2: Backfill** — `npm run sync:backfill` (~1 h). Then `npm run sync:delta` TWICE back-to-back; second run must report ~0 changed and finish in seconds (idempotency + watermark proof).
- [ ] **Step 3: Replace `data/snapshot.json` with an empty-snapshot placeholder** (build-time fallback only; real data now lives in Postgres): `npx tsx -e "import('./lib/snapshot').then(m=>console.log(JSON.stringify(m.emptySnapshot())))" > data/snapshot.json`. Delete `.github/workflows/sync.yml` (replaced by spine workflows).
- [ ] **Step 4: Docs** — CLAUDE.md: architecture diagram gains the spine (delta cron → Postgres → snapshot row), commands table gains `sync:backfill/delta/reconcile` + `verify:schema`, conventions gain: watermark/overlap rule, "aggregate() input now comes from `lib/spine/store.ts`", RLS floor note, focus-model access. README: refresh/deploy sections rewritten (no more commit-the-snapshot; GH secrets list; cadence). Remove stale "Refresh commits must NOT include [skip ci]" rule (no more refresh commits).
- [ ] **Step 5: Verify + ship** — `npx vitest run` (all green), `npm run build`, local `next start` smoke (page loads from Postgres — check server log line absence of fallback), `/admin` gated. Merge to `main`, push, verify prod + one full cron cycle in Actions.

---

## Self-review notes

- Spec coverage: schema+RLS floor (T1), change-feed O(changes) w/ watermarks+overlap+lock (T4–T5), reconcile for owner-moves-away + deletes (T5), aggregate reuse (runner `reaggregate`), snapshot retirement (T6+T10), teams-derived RBAC + focus model + toggle (T7–T8), admin (T9), unassigned-reps warning (T9), backfill + idempotency proof (T10).
- Known accepted gaps (in spec): owner-moves-away corrected nightly, not in delta; Actions-minutes budget measured at cutover with documented fallbacks.
