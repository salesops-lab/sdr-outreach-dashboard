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
-- V3 P2d: per-account timeline lookups do a jsonb contains on company_ids — GIN keeps
-- /api/account/[companyId]/timeline off a sequential scan (route works without it, just slower).
create index if not exists idx_sdr_act_companies on sdr_activities using gin (company_ids jsonb_path_ops);

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

-- V2: company-level lifecycle stage + last-activity timestamps. Added via ALTER so existing
-- installs pick them up (the CREATE above only fires on a fresh database).
--   lifecycle_stage          = HubSpot `lifecyclestage` (company-level; gd_stage holds the GD-level one)
--   last_activity_ms         = HubSpot `notes_last_updated` (Last Activity Date, any activity type)
--   rooftop_last_activity_ms = HubSpot `rooftop_last_activity` (GD/rooftop-level last activity)
alter table sdr_companies add column if not exists lifecycle_stage text;
alter table sdr_companies add column if not exists last_activity_ms bigint;
alter table sdr_companies add column if not exists rooftop_last_activity_ms bigint;

create table if not exists sdr_contacts (
  hs_id      text primary key,
  name       text,
  title      text,
  dm         boolean not null default false,
  updated_at timestamptz not null default now()
);

-- V2: deals (Auto Pipeline only; scoped to tracked owners on pull). One primary company per deal.
-- stage_key is the canonical (pipeline, dealstage) normalization (config/deal-stages.ts); the raw
-- dealstage id is kept alongside because the same id-space is reused across pipelines.
create table if not exists sdr_deals (
  hs_id                 text primary key,
  pipeline              text,
  dealstage             text,             -- raw HubSpot stage id
  stage_key             text,             -- canonical DealStageKey (denormalized for filtering)
  deal_owner_id         text,             -- hubspot_owner_id (the AE)
  sdr_owner_id          text,             -- sdr_owner (the SDR)
  company_id            text,             -- primary associated company
  contact_ids           jsonb not null default '[]',
  amount                numeric,
  demo_scheduled_for_ms bigint,           -- demo_scheduled_for_date (the meeting date)
  discovery_done_ms     bigint,           -- discovery_call_done_stage_date
  demo_done_ms          bigint,           -- demo_done_stage_date
  is_closed_won         boolean not null default false,
  is_closed_lost        boolean not null default false,
  hs_lastmodified_ms    bigint,
  updated_at            timestamptz not null default now()
);
create index if not exists idx_sdr_deals_company on sdr_deals(company_id);
create index if not exists idx_sdr_deals_owner on sdr_deals(deal_owner_id);
create index if not exists idx_sdr_deals_sdr on sdr_deals(sdr_owner_id);
create index if not exists idx_sdr_deals_stage on sdr_deals(stage_key);

-- V3.1: deal windowing + commitment dates. created_ms (createdate) windows the funnel (90d
-- default — historical all-stage pulls are noise); demo_scheduled_for is the SDR's commitment
-- date (already a column above), expected_close_ms (expected_contract_closure_date) is the AE's.
alter table sdr_deals add column if not exists created_ms bigint;
alter table sdr_deals add column if not exists expected_close_ms bigint;

-- V3: deal stage-event ledger — WHEN each deal entered/exited each canonical stage. This is the
-- event-truth layer under the period funnel metrics ("demos scheduled/completed in period P"),
-- stage velocity, and forecasting. Populated from HubSpot's built-in calculated properties
-- hs_v2_date_entered_<stageId> / hs_v2_date_exited_<stageId> on the same deals pull — no
-- property-history API. hs_v2 carries the LATEST entry per stage; re-entries append a new row
-- (new entered_ms) and old rows are kept, so the ledger is append-mostly.
create table if not exists sdr_deal_stage_events (
  deal_id    text not null,
  stage_key  text not null,   -- canonical DealStageKey (config/deal-stages.ts)
  entered_ms bigint not null,
  exited_ms  bigint,          -- null = still in this stage
  updated_at timestamptz not null default now(),
  primary key (deal_id, stage_key, entered_ms)
);
create index if not exists idx_sdr_dse_stage_entered on sdr_deal_stage_events(stage_key, entered_ms);

-- V3: contact ↔ company junction (contacts link to MULTIPLE rooftops). Until now the mapping
-- existed only implicitly via activity contact_ids/company_ids arrays; this makes it explicit.
-- Fed from the v4 contact→company association reads the delta already performs, so it grows
-- with activity — no extra HubSpot calls.
create table if not exists sdr_contact_companies (
  contact_id text not null,
  company_id text not null,
  is_primary boolean not null default false,   -- HubSpot-defined primary company association
  updated_at timestamptz not null default now(),
  primary key (contact_id, company_id)
);
create index if not exists idx_sdr_cc_company on sdr_contact_companies(company_id);

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
  created_at timestamptz not null default now(),
  check (role <> 'manager' or team_id is not null),
  check (email = lower(email))
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

-- ── Hot-account AI agent (Phase 4) ──────────────────────────────────────────
-- Raw activity CONTENT (call notes/transcript/summary, email subject), pulled by the opt-in
-- content-backfill and read by the agent for reasoning. Kept OUT of sdr_activities so the
-- aggregation hot-path stays lean. hs_id matches sdr_activities.hs_id.
create table if not exists sdr_activity_content (
  hs_id         text primary key,
  type          text,
  call_title    text,
  call_body     text,   -- hs_call_body (Nooks notes)
  call_summary  text,   -- hs_call_summary (AI summary of the transcript)
  transcript    text,   -- nooks_transcript / transcript
  email_subject text,
  updated_at    timestamptz not null default now()
);
-- V3 P3: full email BODY (hs_email_text) — reading what's inside the email, not just the
-- subject line. Added via ALTER so existing installs pick it up.
alter table sdr_activity_content add column if not exists email_body text;

-- One watch per hot account. The agent maintains status until a meeting is booked or the
-- account drops off; reason/next_step/priority are the SDR-facing task fields.
create table if not exists sdr_agent_watches (
  account_id       text primary key,   -- rooftop company id
  account_name     text,
  rep_id           text,               -- owning rep
  status           text not null default 'watching' check (status in ('watching','meeting_booked','drop_off','closed')),
  temp             text,
  reason           text,               -- why it's hot (agent)
  next_step        text,               -- recommended next action (agent)
  priority         text check (priority in ('high','medium','low')),
  confidence       real,
  entered_hot_at   timestamptz,
  last_signal_ms   bigint,             -- recency of the account's latest activity
  last_reviewed_at timestamptz,
  model            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_sdr_watch_rep on sdr_agent_watches(rep_id);
create index if not exists idx_sdr_watch_status on sdr_agent_watches(status);

-- V3 P3: semantic recall (blueprint §7.1) — pgvector embeddings over the activity-content
-- corpus. One 1536-dim vector (text-embedding-3-small) per content-bearing activity
-- (composeChunk in lib/agent/embed-chunks.ts decides what earns one). Indexed nightly by
-- `npm run embed:content` (reconcile workflow); searched via sdr_search_content (cosine).
create extension if not exists vector;

create table if not exists sdr_embeddings (
  hs_id      text primary key,   -- activity id (matches sdr_activities / sdr_activity_content)
  account_id text,               -- the activity's primary company (per-account recall filter)
  ts_ms      bigint,             -- activity timestamp
  kind       text,               -- 'call' | 'email'
  chunk      text not null,      -- the embedded text
  embedding  vector(1536) not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_sdr_emb_account on sdr_embeddings(account_id);
create index if not exists idx_sdr_emb_vec on sdr_embeddings using hnsw (embedding vector_cosine_ops);

-- Cosine similarity search (PostgREST can't express vector operators — RPC required).
-- p_account_id null = whole corpus; else scoped to one account's history.
create or replace function sdr_search_content(
  p_query vector(1536),
  p_account_id text default null,
  p_limit int default 8
) returns table (hs_id text, account_id text, ts_ms bigint, kind text, chunk text, similarity float)
language sql stable as $$
  select e.hs_id, e.account_id, e.ts_ms, e.kind, e.chunk,
         1 - (e.embedding <=> p_query) as similarity
  from sdr_embeddings e
  where p_account_id is null or e.account_id = p_account_id
  order by e.embedding <=> p_query
  limit p_limit;
$$;
grant execute on function sdr_search_content(vector, text, int) to service_role;

-- V3 P3: grounded account briefs (blueprint §7.2) — summary, stakeholders, buying signals,
-- objections, next step (each signal/objection with dated evidence), synthesized from the
-- timeline + sdr_activity_content by scripts/agent-briefs.ts. One row per account, refreshed
-- when stale (~20h). Rendered on /attention (Intelligence) and in the account History panel.
create table if not exists sdr_agent_briefs (
  account_id   text primary key,
  account_name text,
  rep_id       text,
  brief        jsonb not null,
  model        text,
  generated_at timestamptz not null default now()
);

-- Append-only reasoning log (audit trail of what the agent said and when).
create table if not exists sdr_agent_notes (
  id         bigint generated always as identity primary key,
  account_id text not null,
  kind       text,   -- 'reason' | 'next_step' | 'status_change' | 'system'
  note       text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sdr_note_account on sdr_agent_notes(account_id, created_at);

-- Snapshot write helper: raises statement_timeout for the large (~6 MB) single-row jsonb upsert,
-- which otherwise intermittently trips the default per-request timeout from CI runners. Called by
-- saveSnapshot(); a plain upsert is used as a fallback until this function is applied.
create or replace function sdr_save_snapshot(p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  set local statement_timeout = '120s';
  insert into sdr_snapshots(id, data, generated_at)
  values (1, p_data, now())
  on conflict (id) do update set data = excluded.data, generated_at = excluded.generated_at;
end;
$$;
grant execute on function sdr_save_snapshot(jsonb) to service_role;

-- ── Team management (admin-editable roster + org structure) ─────────────────
-- Source of truth for WHO is tracked and HOW they roll up, replacing the hard-coded
-- config/reps.ts + config/team-structure.ts. The sync pull-filter, aggregation, and RBAC
-- scope all read these; if a table is empty or unreachable they fall back to the config
-- files (so the app never breaks mid-migration). Seed from config with `npm run team:seed`.

-- AE pods (middle layer). lead_email drives an AE pod lead's default scope (sees the pod).
create table if not exists sdr_pods (
  pod_key    text primary key,            -- e.g. 'saarthak'
  name       text not null,
  lead_email text,                         -- pod lead login email (null = shared pool, no lead)
  active     boolean not null default true,
  sort       integer not null default 0,
  updated_at timestamptz not null default now(),
  check (lead_email is null or lead_email = lower(lead_email))
);

-- Managers / TLs (player-coaches). parent_key: a TL rolls up to its parent manager (self-ref).
create table if not exists sdr_managers (
  manager_key text primary key,            -- e.g. 'vaibhav', 'shikhar'
  name        text not null,
  owner_id    text,                         -- the player-coach's own HubSpot owner id (nullable)
  parent_key  text,                         -- TL → parent manager key (nullable)
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- The tracked roster: every SDR/AE on the dashboard + the HubSpot pull filter.
-- active=false is a soft-delete: drops from the pull + dashboard, keeps historical spine data.
create table if not exists sdr_roster (
  owner_id    text primary key,            -- HubSpot owner id (must exist in sdr_owners)
  email       text,
  first_name  text,
  last_name   text,
  name        text,                         -- display fallback ("First Last")
  kind        text not null default 'sdr' check (kind in ('sdr','ae')),
  ae_pod      text,                         -- → sdr_pods.pod_key (nullable)
  manager_key text,                         -- → sdr_managers.manager_key (SDRs; null for AEs)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_sdr_roster_active on sdr_roster(active);
create index if not exists idx_sdr_roster_email on sdr_roster(lower(email));

-- Seeds (idempotent)
insert into sdr_sync_state(key) values ('calls'),('emails'),('companies'),('deals'),('owners'),('lock'),('agent')
  on conflict (key) do nothing;

insert into sdr_roles(email, role, team_id) values
  ('salesops@spyne.ai','admin',null),
  ('kaustubh.chauhan@spyne.ai','admin',null),
  ('saarthak.seth@spyne.ai','manager','362172393'),
  ('neelima.tiwari@spyne.ai','manager','362172280'),
  ('archit.gupta@spyne.ai','manager','362172309'),
  ('prince.arora@spyne.ai','manager','362172539'),
  ('david@spyne.ai','manager','365196665')
  on conflict (email) do nothing;

-- RLS floor: SELECT for authenticated spyne.ai; no write policies (service role bypasses RLS).
-- email claim is trusted only alongside provider=google; this project must not enable email/password signup.
do $$
declare t text;
begin
  foreach t in array array['sdr_activities','sdr_companies','sdr_contacts','sdr_deals','sdr_owners',
                           'sdr_teams','sdr_team_members','sdr_roles','sdr_sync_state','sdr_snapshots',
                           'sdr_activity_content','sdr_agent_watches','sdr_agent_notes',
                           'sdr_pods','sdr_managers','sdr_roster',
                           'sdr_deal_stage_events','sdr_contact_companies','sdr_agent_briefs',
                           'sdr_embeddings']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_spyne_select', t);
    execute format($p$
      create policy %I on %I for select to authenticated
        using ((auth.jwt() ->> 'email') ilike '%%@spyne.ai'
               and coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google')
    $p$, t || '_spyne_select', t);
  end loop;
end $$;
