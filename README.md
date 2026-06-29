# SDR Outreach Coverage Dashboard

Tracks **outbound** outreach by a fixed set of SDRs from HubSpot — how many **unique
contacts** and **unique companies** each rep tapped, how deep they went per company,
and the full call-outcome + email breakdown — across IST time windows
(Today / Yesterday / Last 3 days / This week / Last week / This month).

Built to answer one question for sales leadership: **are all accounts being tapped?**

## Architecture

```
scripts/sync.ts ──▶ HubSpot (calls + emails search, v4 batch associations)
       │            weekly-sliced pull (beats the 10k Search ceiling)
       ▼
  data/snapshot.json  (compact per-rep × per-period aggregates)
       │            (also uploaded to Vercel Blob if BLOB_READ_WRITE_TOKEN is set)
       ▼
  Next.js app (app/page.tsx → components/Dashboard.tsx)
       reads the snapshot, filters/sorts client-side. No HubSpot calls at request time.
```

The heavy pull runs **outside** Vercel (locally or via the GitHub Action) because a full
sync can exceed serverless time limits.

## Key definitions

- **Outbound only:** `hs_call_direction=OUTBOUND`, `hs_email_direction=EMAIL`.
- **IST boundaries:** fixed UTC+5:30; weeks start **Monday**.
- **Connected:** a human was reached. Voicemail / live message / busy count as **not
  connected** (matches the call-scoring pipeline's `is_connected()`).
- **Unique company per activity:** primary company of each associated contact; if an
  activity has no contact, a direct engagement→company association; else unattributed.

## Setup

```bash
npm install
cp .env.local.example .env.local   # add your HUBSPOT_PAT
npm run sync                       # pull from HubSpot → data/snapshot.json
npm run dev                        # http://localhost:3000
```

Required HubSpot Private App scopes: `crm.objects.contacts.read`,
`crm.objects.companies.read`, and engagement (calls/emails) + associations read.

## Commands

| Command | What it does |
|---|---|
| `npm run sync` | Pull from HubSpot, rebuild `data/snapshot.json` |
| `npm run dev` | Run the dashboard locally |
| `npm run build` | Production build (also typechecks) |
| `npm test` | Unit tests for IST bucketing + aggregation |

## Deploy (Vercel)

1. Import the repo into Vercel.
2. Set env var `HUBSPOT_PAT` (and optionally `BLOB_READ_WRITE_TOKEN`).
3. Deploy. The dashboard reads the committed `data/snapshot.json` (or the newest Vercel
   Blob if configured).

## Refresh

- **Local / on-demand:** `npm run sync`, then commit & push (Vercel redeploys).
- **GitHub Action:** Actions tab → "Sync HubSpot snapshot" → *Run workflow*. It runs the
  sync and commits the refreshed snapshot. Add `HUBSPOT_PAT` as a repo secret first.
- **Scheduled:** add a `schedule: - cron:` trigger to `.github/workflows/sync.yml`.

## Security

The HubSpot token lives only in `.env.local` (gitignored) and Vercel/GitHub secrets —
never in code or the committed snapshot. **Rotate the token** if it was ever shared.
