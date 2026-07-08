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

-- Seeds (idempotent)
insert into sdr_sync_state(key) values ('calls'),('emails'),('companies'),('owners'),('lock'),('agent')
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
-- email claim is trusted only alongside provider=google; this project must not enable email/password signup.
do $$
declare t text;
begin
  foreach t in array array['sdr_activities','sdr_companies','sdr_contacts','sdr_owners',
                           'sdr_teams','sdr_team_members','sdr_roles','sdr_sync_state','sdr_snapshots',
                           'sdr_activity_content','sdr_agent_watches','sdr_agent_notes']
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
