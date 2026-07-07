# SDR Outreach Coverage Dashboard

Tracks **outbound** outreach by a fixed set of SDRs from HubSpot — how many **unique
contacts** and **unique companies** each rep tapped, how deep they went per company,
and the full call-outcome + email breakdown — across US/Eastern time windows
(Today / Yesterday / Last 3 days / This week / Last week / This month).

Built to answer one question for sales leadership: **are all accounts being tapped?**

## Architecture

```
scripts/sync.ts ──▶ HubSpot (calls + emails search, v4 batch associations)
       │            weekly-sliced pull (beats the 10k Search ceiling)
       ▼
  data/snapshot.json  (compact per-rep × per-period aggregates + cumulative book coverage)
       │            (also uploaded to Vercel Blob if BLOB_READ_WRITE_TOKEN is set)
       ▼
  Next.js app (app/page.tsx → components/Dashboard.tsx)
       reads the snapshot, filters/sorts client-side. No HubSpot calls at request time.
```

The heavy pull runs **outside** Vercel (locally or via the GitHub Action) because a full
sync can exceed serverless time limits.

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
npm run sync                       # pull from HubSpot → data/snapshot.json
npm run dev                        # http://localhost:3000
```

Required HubSpot Private App scopes: `crm.objects.contacts.read`,
`crm.objects.companies.read`, and engagement (calls/emails) + associations read.

Supabase (same project as call-scoring-agent) powers **login** (Google SSO, @spyne.ai only)
and the **call-quality merge** (BANTIC/coaching, read-only). Env vars: `NEXT_PUBLIC_SUPABASE_URL`
+ `NEXT_PUBLIC_SUPABASE_ANON_KEY` (auth) and `SUPABASE_SERVICE_ROLE_KEY` (server-only reads).
Without them, local dev runs ungated with call-quality disabled; **production fails closed (503)**.

## Commands

| Command | What it does |
|---|---|
| `npm run sync` | Pull from HubSpot, rebuild `data/snapshot.json` |
| `npm run dev` | Run the dashboard locally |
| `npm run build` | Production build (also typechecks) |
| `npm test` | Unit tests for US/Eastern bucketing (incl. DST) + aggregation |

## Deploy (Vercel)

1. Import the repo into Vercel.
2. Set env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (**required** — the auth middleware 503s without the first two),
   plus `HUBSPOT_PAT` (and optionally `BLOB_READ_WRITE_TOKEN`).
3. In the Supabase project (call-scoring), enable the **Google provider** (GCP OAuth client;
   redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`) and set the Site URL to the
   Vercel domain. Prefer an **Internal** GCP OAuth app to hard-restrict to the spyne.ai Workspace.
4. Verify RLS/policies deny `anon` reads on the call-scoring tables (`calls`,
   `call_quality_insights`, `rep_coaching_snapshots`) — the anon key ships to browsers.
5. Deploy. The dashboard reads the committed `data/snapshot.json` (or the newest Vercel
   Blob if configured); call-quality data is read live from Supabase per request.

## Refresh

- **Local / on-demand:** `npm run sync`, then commit & push (Vercel redeploys).
- **GitHub Action:** Actions tab → "Sync HubSpot snapshot" → *Run workflow*. It runs the
  sync and commits the refreshed snapshot. Add `HUBSPOT_PAT` as a repo secret first.
- **Scheduled:** add a `schedule: - cron:` trigger to `.github/workflows/sync.yml`.

## Security

The HubSpot token lives only in `.env.local` (gitignored) and Vercel/GitHub secrets —
never in code or the committed snapshot. **Rotate the token** if it was ever shared.
