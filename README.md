# SDR Outreach Coverage Dashboard

One-stop SDR **activity + performance** dashboard, gated behind **Google SSO (@spyne.ai only)**.
Tracks **outbound** outreach by a fixed set of SDRs from HubSpot — unique contacts/companies
tapped, engagement depth, call-outcome + email breakdowns — across US/Eastern time windows
(Today / Yesterday / Last 3 days / This week / Last week / This month), plus:

- **GD Book Explorer** (per rep): assigned Group-Dealership / Single units → rooftops engaged
  within each GD → who was engaged (top contacts) → activity depth + last touch. Cumulative and
  reconciled with book coverage by construction.
- **Call quality** (read-only from the call-scoring pipeline's Supabase): per-connected-call
  BANTIC scores + drill-down, weekly coaching snapshots, Call Q column in the rep table.

Built to answer: **are all accounts being tapped — and how well are we working them?**

## Architecture

```
spine-delta (cron, every 15 min) ──▶ HubSpot (changed calls/emails/companies since watermark)
       │  runBackfill once, then O(changes) deltas + nightly reconcile
       ▼
  Postgres spine  (sdr_* tables in the call-scoring Supabase — beside, never touching, its tables)
       │  runner re-runs the unchanged aggregate() over the spine → one jsonb snapshot row
       ▼
  Next.js app ── middleware auth gate (Supabase Google SSO, @spyne.ai) ── /login
       │  page load: snapshot row (book units stripped) + resolveViewer() default scope + coaching  ▲
       │  drawer:    /api/rep/[id]/book + /api/rep/[id]/calls (lazy, gated)                          │
       │  /admin:    roles CRUD + sync health (admin/leadership only)                                │
       ▼                                                                                             │
  call-scoring Supabase (read-only, service-role key server-side) ─────────────────────────────────┘
```

The sync runs **outside** Vercel (GitHub Actions cron, or locally) because it can exceed
serverless time limits. The web app never calls HubSpot at request time;
call-quality data is read live from Supabase per request.

## Key definitions

- **Outbound only:** `hs_call_direction=OUTBOUND`, `hs_email_direction=EMAIL`.
- **US/Eastern boundaries:** day/week windows are US/Eastern civil midnight (the HubSpot portal's
  own timezone), DST-aware via `Intl` — **not** a fixed offset; weeks start **Monday**.
- **Connected:** a human was reached. Voicemail / live message / busy count as **not
  connected** (matches the call-scoring pipeline's `is_connected()`).
- **Unique company per activity:** primary company of each associated contact; if an
  activity has no contact, a direct engagement→company association; else unattributed.
- **Book coverage (cumulative):** of the accounts a rep owns, how many they have *ever* tapped —
  rolled up to Group-Dealership / Single units (rooftops grouped by `gd_id`; a GD is tapped if any
  owned rooftop is). Monotonic, and segmented by lifecycle stage, franchise/independent, and market
  segment. Measured back to `COVERAGE_ANCHOR` (`config/hubspot.ts`), which widens the activity pull.

## Setup

```bash
npm install
cp .env.local.example .env.local   # add HUBSPOT_PAT + the three Supabase vars
# one-time: paste supabase/sdr_schema.sql into the Supabase SQL editor, then:
npm run verify:schema              # confirm the sdr_* tables + RLS floor are in place
npm run sync:backfill              # populate the Postgres spine (~1 h)
npm run dev                        # http://localhost:3000
```

Required HubSpot Private App scopes: `crm.objects.contacts.read`,
`crm.objects.companies.read`, and engagement (calls/emails) + associations read.

Supabase (same project as call-scoring-agent) powers **login** (Google SSO, @spyne.ai only),
the **data spine** (`sdr_*` tables + the snapshot row), and the **call-quality merge**
(BANTIC/coaching, read-only). Env vars: `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(auth) and `SUPABASE_SERVICE_ROLE_KEY` (server-only spine + call-quality reads); optional
`CRON_SECRET` for the `/api/sync/delta` alt-trigger route. Without the Supabase vars, local dev
runs ungated with the spine/call-quality disabled; **production fails closed (503)**.

## Commands

| Command | What it does |
|---|---|
| `npm run verify:schema` | Check the `sdr_*` schema is applied (tables, seeds, anon blocked) |
| `npm run sync:backfill` | One-time full pull into the Postgres spine |
| `npm run sync:delta` | Incremental change-feed sync (what the 15-min cron runs) |
| `npm run sync:reconcile` | Nightly drift heal (full book + 7-day activity re-pull) |
| `npm run dev` | Run the dashboard locally |
| `npm run build` | Production build (also typechecks) |
| `npm test` | Unit tests for US/Eastern bucketing (incl. DST) + aggregation + access scope |

## Deploy (Vercel)

1. Import the repo into Vercel.
2. Set env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (**required** — the auth middleware 503s without the first two),
   plus `HUBSPOT_PAT` and optionally `CRON_SECRET` (for the `/api/sync/delta` route).
3. In the Supabase project (call-scoring), enable the **Google provider** (GCP OAuth client;
   redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`) and set the Site URL to the
   Vercel domain. Prefer an **Internal** GCP OAuth app to hard-restrict to the spyne.ai Workspace.
   Do **not** enable the email/password provider — the spine's RLS floor trusts the JWT email only
   alongside `provider=google`.
4. Apply `supabase/sdr_schema.sql` (SQL editor) and confirm with `npm run verify:schema`. Verify
   `anon` cannot read the `sdr_*` tables or the call-scoring tables — the anon key ships to browsers.
5. Add GitHub **repo secrets** for the sync crons: `HUBSPOT_PAT`, `SUPABASE_URL` (= the
   `NEXT_PUBLIC_SUPABASE_URL` value), `SUPABASE_SERVICE_ROLE_KEY`.
6. Deploy, then run `npm run sync:backfill` once. The dashboard reads the `sdr_snapshots` row live;
   call-quality data is read live from Supabase per request.

## Refresh

Fully automated into Postgres — no more commit-the-snapshot.

- **Steady state:** `spine-delta.yml` runs every 15 min; `spine-reconcile.yml` nightly. New data
  appears in the deployed app with no redeploy (it reads the `sdr_snapshots` row live).
- **Manual:** Actions tab → *Spine delta sync* / *Spine reconcile* → **Run workflow**; or
  `GET /api/sync/delta` with `Authorization: Bearer $CRON_SECRET`; or `npm run sync:delta` locally.
- **Recovery:** if the spine is ever wiped, re-run `npm run sync:backfill`.

## Security

The HubSpot token and the Supabase service-role key live only in `.env.local` (gitignored) and
Vercel/GitHub secrets — never in code. Outreach data now lives in Postgres (behind the RLS floor +
the SSO gate), not in a committed file. **Rotate any secret** if it was ever shared.
