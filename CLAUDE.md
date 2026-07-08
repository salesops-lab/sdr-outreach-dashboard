# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An SDR outbound-outreach **coverage** dashboard. It answers one question for sales leadership:
*are all accounts being tapped?* It tracks, per rep and per US/Eastern time window, how many unique
contacts/companies were touched, how deep, the call-outcome + email breakdown, owned-book
coverage, account "temperature", and a composite quality score.

Read `README.md` for product definitions and setup. This file covers architecture and the
non-obvious conventions that span multiple files.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the dashboard locally (http://localhost:3000) |
| `npm run build` | Production build — also runs the TypeScript typecheck (there is no separate `tsc` script) |
| `npm run lint` | ESLint (`next/core-web-vitals`) |
| `npm test` | Run all Vitest unit tests (`vitest run`) |
| `npm run sync` | **Legacy** file-snapshot pull → `data/snapshot.json` (pre-spine; kept for emergencies) |
| `npm run verify:schema` | Probe that `supabase/sdr_schema.sql` is applied (tables reachable, seeds present, anon blocked) |
| `npm run sync:backfill` | One-time full pull → Postgres spine (~1 h; run before the first delta) |
| `npm run sync:delta` | Incremental sync: pull `hs_lastmodifieddate > watermark`, upsert, re-aggregate (O(changes)) |
| `npm run sync:reconcile` | Nightly drift heal: full owned-book re-pull + 7-day activity re-pull |

The three `sync:*` scripts run via `tsx --conditions=react-server` — required so the `server-only`
guard in `lib/supabase/admin.ts` resolves to a no-op under plain Node (same trick as `verify:schema`).

Run a **single test**: `npx vitest run tests/buckets.test.ts` (or add `-t "name"` to filter by
test name; drop `run` for watch mode). Tests live in `tests/` and cover only the pure logic —
US/Eastern bucketing (`buckets.test.ts`, incl. DST-transition cases), aggregation incl. GD book
units (`aggregate.test.ts`), call-quality mappers (`callquality.test.ts`), and the auth domain
rule (`auth-domain.test.ts`). Never import `lib/callquality/fetch.ts` or `lib/supabase/admin.ts`
from a test — the `server-only` guard throws under vitest.

Node 20 (pinned in the GitHub Action; there's no `.nvmrc` or `engines` field). Import alias
`@/*` maps to the repo root (`tsconfig.json`).

## Architecture: change-feed spine → Postgres → snapshot row, behind an auth gate

Two data sources, one gate. **The app never calls HubSpot at request time.** Outreach data lives in
a Postgres "data spine" (`sdr_*` tables in the call-scoring project's Supabase, beside — never
touching — call-scoring's own tables), kept current by an O(changes) delta sync. Call-quality data
is still read **live** from the same Supabase at request time. Every route sits behind Supabase
Google SSO (spyne.ai only), and login → HubSpot owner → team resolves a per-viewer default scope.

```
scripts/spine-{backfill,delta,reconcile}.ts  (local or GitHub Actions cron — NOT on Vercel)
  └─ lib/spine/runner.ts   orchestration (watermark-driven, advisory-locked, idempotent)
       ├─ lib/sync/pull.ts        pullChangedActivities / pullChangedCompanies (hs_lastmodifieddate > watermark)
       ├─ lib/sync/associate.ts   resolve activity → contact → company (v4 batch reads)
       ├─ lib/spine/store.ts      batched upserts into sdr_activities/companies/contacts/owners/teams
       └─ lib/sync/aggregate.ts   UNCHANGED — re-run over the spine to rebuild the Snapshot
             ↓  saveSnapshot()
  sdr_snapshots (one jsonb row, id=1)   ← the delta writes this; getSnapshot reads it first
             ↓
  lib/snapshot.ts   getSnapshot: loadFromSpine → loadFromBlob → loadFromFile → empty  (+ stripBookUnits)
             ↓
  middleware.ts  ── auth gate (session + @spyne.ai domain) ── app/login, app/auth/callback
             ↓
  app/page.tsx   resolveViewer(email) + snapshot (units stripped) + getCoachingByRep()  → Dashboard.tsx
  app/admin      roles CRUD + sync health + unassigned-reps warning  (admin/leadership only)
  app/api/sync/delta   CRON_SECRET-gated alt trigger for runDelta (crons call the npm script directly)
  app/api/rep/[ownerId]/book|calls   lazy per-rep drill-downs (book units from spine, calls from Supabase)
        ↑
  lib/access/resolve.ts (resolveViewer) · lib/callquality/fetch.ts ── lib/supabase/admin.ts (service-role, server-only)
```

The heavy pull runs **outside Vercel** because a sync exceeds serverless time limits; delta runs
every 15 min via `.github/workflows/spine-delta.yml`, reconcile nightly via `spine-reconcile.yml`.
`lib/sync/types.ts` is the shared contract between the sync pipeline and the UI; `lib/spine/types.ts`
holds the `sdr_*` row shapes + the `Viewer` model; `lib/callquality/types.ts` is the read-only
contract for the call-scoring tables (owned by call-scoring-agent).

### Data model
`Snapshot` → `reps[ownerId]` → `{ periods[periodKey]: PeriodMetrics, daily[], book }`. Six US/Eastern
periods: `today`, `yesterday`, `last_3_days`, `this_week`, `last_week`, `this_month`.
`PeriodMetrics` bundles volume (calls/emails/meetings), reach-by-channel, decision-maker reach,
account temperature, and a quality score. The three **narrow periods** (`today`, `yesterday`,
`this_week`) additionally carry a per-company drill-down (`company_breakdown`) with contact lists —
the others omit it to keep the snapshot small. Owned-book **coverage is NOT per-period** — it lives
once per rep on `RepData.book` (see below), because it is cumulative. `book.units` carries the full
GD → rooftop → top-5-contacts drill-down (the Book Explorer's data); it is heavy, so it never
reaches the client with the page — see the `stripBookUnits` rule under Conventions.

## Conventions & gotchas (the load-bearing rules)

- **US/Eastern boundaries, DST-aware.** All period boundaries are US/Eastern civil midnight — the
  HubSpot portal's own timezone, so days line up with HubSpot's UI — and weeks start **Monday**
  (`lib/sync/buckets.ts`). US/Eastern observes DST, so the code uses `Intl.DateTimeFormat` (IANA
  `America/New_York`), **not** a fixed offset; day identity is a civil-calendar ordinal and
  `etMidnightUtcMs` is the one DST-sensitive primitive (offset-lookup + one correction pass). An
  activity can fall into several periods at once.
- **"Connected" is a business rule, not `hs_call_status`.** Only the 11 GUIDs in
  `config/dispositions.ts` `CONNECTED_DISPOSITIONS` count as reaching a human — voicemail / live
  message / busy do **not**. These GUIDs are ported verbatim from
  `call-scoring-agent/config/dispositions.py`; keep them in sync so connect-rate matches that
  pipeline. `connect_rate` excludes null-disposition calls from the denominator.
- **`config/reps.ts` is the single source of truth** for which owner IDs appear (28 SDRs). It's
  also the `IN` filter for the HubSpot searches. To add/remove a rep, edit this file and re-sync.
- **Snapshot loader must use a static `import()`, not `fs`** (`lib/snapshot.ts`). A runtime file
  path is missed by Vercel's output-file-tracing and breaks in the serverless function.
- **The 10k Search ceiling** is defended two ways: the legacy full pull slices into 7-day
  sub-windows (`lib/sync/pull.ts`); the delta pulls (`pullChangedActivities`/`pullChangedCompanies`)
  cut each modified-window at 9,800 results and resume from `lastmodified − 1` (GTE-equivalent —
  the `GT` filter would otherwise skip records sharing the boundary ms; callers dedupe the
  re-reads). A run does at most `MAX_RESUME_WINDOWS` (3) catch-up windows, then defers the rest to
  the next run — the watermark still advances, so backlogs drain across runs without a livelock.
- **Sync degrades gracefully on 403.** `preflightCaps()` (`lib/spine/runner.ts`) probes calls and
  emails independently and returns false **only** on a 403 scope error (other errors rethrow); a
  dropped object type is recorded in the snapshot's `sources`. Emails need the
  `connected-email-data-access` scope specifically.
- **Change-feed sync is watermark-driven and idempotent.** Per-type watermarks live in
  `sdr_sync_state`; each delta re-reads from `watermark − OVERLAP_MS` (5 min, absorbs clock skew /
  same-ms writes) and advances the watermark to the max `hs_lastmodifieddate` actually persisted —
  **only after** the upserts + re-aggregate succeed, so a mid-run crash re-does work rather than
  skipping it (all upserts are PK-idempotent). One run at a time via an advisory lock (the
  `lock` row in `sdr_sync_state`), fenced by a lease token so a stalled runner can't release a
  successor's lock. Owner-moves-AWAY from a tracked rep are invisible to the delta (it only sees
  changed rows) and are corrected by the nightly reconcile's full owned-book re-pull; HubSpot
  **deletions** are not propagated (known accepted gap).
- **`aggregate()`'s input now comes from `lib/spine/store.ts`** (`loadStoreForAggregate`), not the
  live pull. `aggregate.ts` itself is unchanged — the runner reconstructs the same argument shape
  from the `sdr_*` rows and re-runs it to rebuild the one-row jsonb snapshot. Paged reads
  (`fetchAll`) require a unique total order (PK-inclusive) because PostgREST paginates by OFFSET.
- **Company attribution order** (`lib/sync/associate.ts`): primary company of each associated
  contact; if an activity has no contact, a direct engagement→company association; else counted as
  unattributed.
- **Secrets live only in `.env.local` / Vercel / GitHub secrets** — `HUBSPOT_PAT` (required for
  sync), three Supabase vars required by the web app: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (auth) and `SUPABASE_SERVICE_ROLE_KEY` (server-only spine +
  call-quality reads), and `CRON_SECRET` (optional; only the `/api/sync/delta` alt-trigger route
  needs it — the crons call the npm script directly). **In production the middleware fails CLOSED
  (503 on every route) if the two `NEXT_PUBLIC_SUPABASE_*` vars are missing** — set them in Vercel
  before deploying. The GitHub Actions crons need repo secrets `HUBSPOT_PAT`, `SUPABASE_URL` (=
  the `NEXT_PUBLIC_SUPABASE_URL` value) and `SUPABASE_SERVICE_ROLE_KEY`. Never commit any of these.
- **Auth gate + focus-model scoping.** Every route requires a Supabase Google SSO session belonging
  to an `@spyne.ai` account. `middleware.ts` is the single source of truth (session + domain via
  `lib/auth/domain.ts`); `PUBLIC_PATHS` exempts only `/login`, `/auth`, and `/api/sync/delta` (that
  route self-authenticates via a constant-time `CRON_SECRET` Bearer check). `/api/*` gets JSON 401;
  pages redirect to `/login`. Missing env = pass-through in dev, 503 in prod. On top of the gate,
  `resolveViewer` (`lib/access/resolve.ts`) maps login → `sdr_roles` override → HubSpot owner/team
  → a **default** scope (`Viewer.defaultOwnerIds`). This is a **focus model, not confidentiality**:
  everyone keeps org-wide visibility; the "My team / All reps" toggle just picks the default view.
  admin/leadership get `/admin`. The pure decision is `decideScope` in `lib/access/scope.ts`
  (split out so the unit test imports it without the `server-only` guard); `resolveViewer` never
  throws — any failure degrades to an org-wide viewer.
- **RLS floor (defense in depth).** The `sdr_*` tables have RLS enabling `SELECT` only for
  `authenticated` requests whose JWT email is `@spyne.ai` **and** whose provider is `google`
  (`supabase/sdr_schema.sql`); there are no write policies, so all writes go through the
  service-role key (which bypasses RLS). The email claim is only trusted because the shared project
  must not enable email/password signup — see the comment above the schema's policy block.
- **Call-quality merge (read-only).** The app reads the call-scoring project's Supabase tables
  (`rep_coaching_snapshots`, `calls`, `call_quality_insights`) server-side via the service-role
  key (`lib/supabase/admin.ts`, guarded by `server-only`; `lib/callquality/*`). Call-scoring
  itself is never modified. Coaching loads with the page; per-rep calls + book units lazy-load
  via `/api/rep/[ownerId]/calls` and `/api/rep/[ownerId]/book`.
- **`BookCoverage.units` is stripped from the client payload** (`stripBookUnits` in
  `lib/snapshot.ts`) — the full rooftop drill-down would ~5× the page payload. The drawer fetches
  one rep's units from `/api/rep/[ownerId]/book` instead. Keep it that way.

## UI notes

`components/Dashboard.tsx` is the main client component; clicking a rep row opens a slide-over
drawer (`RepDrawer`, children-based to avoid an import cycle) whose centerpiece is the
**GD Book Explorer** (`GdExplorer`: units → rooftops → contacts → activities) with a call-quality
card (`CallQualityCard` + `CallsDrilldown`) below. Shared chip/icon lookups live in
`components/ui-tokens.ts`. **There is no charting library** — the donut, stacked bars, and daily
trend are all pure HTML/CSS (Tailwind + conic-gradient / flex widths). State is local
(`useState` + `useMemo`); no global store. HubSpot deep-links use the builders in
`config/hubspot.ts` (portal `242626590`, app-na2).

## Derived-metric definitions (all in `lib/sync/aggregate.ts`)

- **Quality score** (`computeQuality`): weighted 0–100 → grade A–F, from five sub-scores —
  conversations, depth, persistence, channel balance, deliverability. Adjust weights/thresholds here.
- **Account temperature** (`temperatureOf`): `hot` = meeting/high-intent/reply; `warm` =
  connected/opened/3+ touches; `cold` = touched but no engagement. Each row also carries a
  human-readable `temp_reason`.
- **Coverage** (`computeBookCoverage` → `RepData.book`, type `BookCoverage`) is **cumulative and
  period-independent**: the rep's owned rooftops are rolled up to **Group-Dealership / Single units**
  (rooftops grouped by the `gd_id` company property), and a unit is "tapped" once the **owning rep**
  has ever put outbound activity on any of its rooftops. Monotonic by construction (a set only grows).
  Coverage is measured over a wide activity pull anchored at `COVERAGE_ANCHOR` (`config/hubspot.ts`) —
  the same pulled activities also feed the 6 short periods. Segmented by lifecycle via HubSpot's
  dedicated GD-level property **`lifecycle_stage_gd_level`** (`normalizeGdStage` → Prospect /
  In Pipeline / Contract Closed / Drop Off / Other, read directly — NOT derived from the
  rooftop-level `lifecyclestage`), plus dealership type (`type_of_dealership`), market segment
  (`market_segment`), and GD-vs-single. A group unit requires BOTH
  `is_this_is_a_part_of_group_dealership_` AND a `gd_id`; otherwise the rooftop is counted as a
  single (never dropped).
- **Insights** — two sources: `buildInsights` (per-period activity callouts: single-channel,
  shallow depth, low connect rate, high bounce, DM reach, etc.) and `bookInsights` (coverage
  callouts on `BookCoverage.insights`: low coverage, untapped in-pipeline accounts).

## Refresh workflow

Data now refreshes **automatically into Postgres** — there is no more commit-the-snapshot step.

- **First-time setup:** apply `supabase/sdr_schema.sql` in the Supabase SQL editor, run
  `npm run verify:schema`, then `npm run sync:backfill` once (~1 h) to populate the spine.
- **Steady state:** `.github/workflows/spine-delta.yml` runs `npm run sync:delta` every 15 min and
  `spine-reconcile.yml` runs `npm run sync:reconcile` nightly (06:30 UTC). Both need repo secrets
  `HUBSPOT_PAT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. The delta writes the `sdr_snapshots`
  row; the deployed app reads it live (no redeploy needed to see new data).
- **Manual trigger:** `workflow_dispatch` on either workflow, or `GET /api/sync/delta` with an
  `Authorization: Bearer $CRON_SECRET` header.
- **Legacy:** `data/snapshot.json` is now an empty placeholder kept only as a build-time static
  import + last-ditch fallback; `npm run sync` + the old `sync.yml` are retired.
