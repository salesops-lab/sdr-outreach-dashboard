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
| `npm run sync` | The HubSpot pull → rebuild `data/snapshot.json` (needs `HUBSPOT_PAT`) |

Run a **single test**: `npx vitest run tests/buckets.test.ts` (or add `-t "name"` to filter by
test name; drop `run` for watch mode). Tests live in `tests/` and cover only the pure logic —
US/Eastern bucketing (`buckets.test.ts`, incl. DST-transition cases) and aggregation (`aggregate.test.ts`).

Node 20 (pinned in the GitHub Action; there's no `.nvmrc` or `engines` field). Import alias
`@/*` maps to the repo root (`tsconfig.json`).

## Architecture: a pre-computed snapshot pipeline

The single most important thing to understand: **the app never calls HubSpot at request time.**
An offline sync produces one JSON snapshot; the web app only reads and filters it.

```
scripts/sync.ts  (run locally or via GitHub Action — NOT on Vercel)
  ├─ lib/sync/pull.ts        pull outbound calls + emails, + each rep's owned-company book
  ├─ lib/sync/associate.ts   resolve activity → contact → company (v4 batch reads)
  ├─ lib/sync/buckets.ts     assign each activity to US/Eastern periods (DST-aware)
  └─ lib/sync/aggregate.ts   per-rep × per-period metrics + cumulative book coverage
        ↓
  data/snapshot.json         (committed to git; optionally also uploaded to Vercel Blob)
        ↓
  lib/snapshot.ts            server-side loader (Blob if configured, else the committed file)
        ↓
  app/page.tsx → components/Dashboard.tsx   read once, filter/sort client-side
```

The heavy pull runs **outside Vercel** because a full sync exceeds serverless time limits.
`lib/sync/types.ts` is the shared contract between the sync pipeline and the UI — change a
metric's shape there and both sides must agree.

### Data model
`Snapshot` → `reps[ownerId]` → `{ periods[periodKey]: PeriodMetrics, daily[], book }`. Six US/Eastern
periods: `today`, `yesterday`, `last_3_days`, `this_week`, `last_week`, `this_month`.
`PeriodMetrics` bundles volume (calls/emails/meetings), reach-by-channel, decision-maker reach,
account temperature, and a quality score. The three **narrow periods** (`today`, `yesterday`,
`this_week`) additionally carry a per-company drill-down (`company_breakdown`) with contact lists —
the others omit it to keep the snapshot small. Owned-book **coverage is NOT per-period** — it lives
once per rep on `RepData.book` (see below), because it is cumulative.

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
- **The 10k Search ceiling is defended by weekly slicing** (`lib/sync/pull.ts`): the window is
  sliced into 7-day sub-windows sorted ascending by timestamp. A slice nearing 9,000 results logs
  a warning — if the team's volume grows, slice finer.
- **Sync degrades gracefully on 403.** `preflight()` probes calls and emails independently; if the
  token lacks a scope, that object type is dropped (snapshot records this in `sources`) instead of
  aborting. Emails need the `connected-email-data-access` scope specifically.
- **Refresh commits must NOT include `[skip ci]`** — Vercel auto-deploys on push, and the whole
  point of the refresh commit is to trigger a redeploy with the new snapshot. `data/snapshot.json`
  is committed (a few MB) and is the fallback data source when Blob isn't configured.
- **Company attribution order** (`lib/sync/associate.ts`): primary company of each associated
  contact; if an activity has no contact, a direct engagement→company association; else counted as
  unattributed.
- **Secrets live only in `.env.local` / Vercel / GitHub secrets** — `HUBSPOT_PAT` (required for
  sync), `BLOB_READ_WRITE_TOKEN` (optional, enables no-redeploy refresh), plus three Supabase vars
  required by the web app: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (auth) and
  `SUPABASE_SERVICE_ROLE_KEY` (server-only call-quality reads). **In production the middleware
  fails CLOSED (503 on every route) if the two `NEXT_PUBLIC_SUPABASE_*` vars are missing** — set
  them in Vercel before deploying. Never commit any of these.
- **Auth gate (Phase 1).** Every route requires a Supabase Google SSO session belonging to an
  `@spyne.ai` account. `middleware.ts` is the single source of truth (session + domain via
  `lib/auth/domain.ts`); the OAuth callback's domain check is belt-and-braces and explicitly
  expires cookies on rejection. `/api/*` gets JSON 401; pages redirect to `/login`. Missing env =
  pass-through in dev, 503 in prod.
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
- **Insights** (`buildInsights`): rule-based good/warn callouts (low coverage, single-channel,
  shallow depth, low connect rate, high bounce, DM reach, etc.).

## Refresh workflow

- **On demand:** `npm run sync`, then commit & push `data/snapshot.json`.
- **GitHub Action:** `.github/workflows/sync.yml` (`workflow_dispatch`) runs the sync and commits
  the refreshed snapshot. It's manual-only today; add a `schedule: - cron:` block to automate.
  Requires the `HUBSPOT_PAT` repo secret.
