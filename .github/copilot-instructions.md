# Copilot Instructions: SDR Outreach Dashboard

This document guides Copilot sessions working in this repository. For deeper architecture context, see [CLAUDE.md](../CLAUDE.md).

## Quick Reference

| Command | What it does |
|---|---|
| `npm run dev` | Run the dashboard locally on http://localhost:3000 |
| `npm run build` | Production build (includes TypeScript typecheck) |
| `npm run lint` | ESLint on `next/core-web-vitals` config |
| `npm test` | Run all Vitest tests |
| `npm test -- --run tests/temperature.test.ts` | Run a single test file |
| `npm test -- --run -t "pattern"` | Run tests matching a name pattern |
| `npm run sync:delta` | Incremental HubSpot sync (O(changes); runs every 15 min in production) |
| `npm run sync:backfill` | One-time full pull (~1 h; required on first setup) |
| `npm run sync:reconcile` | Nightly drift heal (full book + 7-day activity re-pull) |
| `npm run sync:reaggregate` | Rebuild snapshot from spine without HubSpot (recovery tool) |
| `npm run verify:schema` | Verify the Supabase schema is applied |
| `npm run agent:run` | One hot-account agent pass (needs `OPENAI_API_KEY`) |
| `npm run content:backfill` | Opt-in: pull call notes/transcripts/email subjects |

## Project Stack

- **Framework:** Next.js 14 (App Router, React 18)
- **Database:** Supabase Postgres
- **Auth:** Supabase Google SSO (@spyne.ai only)
- **Type checking:** TypeScript (strict mode)
- **Testing:** Vitest (Node environment)
- **Styling:** Tailwind CSS + CSS variables
- **Icons:** Lucide React
- **External API:** HubSpot (change-feed sync), OpenAI (agent reasoning)
- **Node version:** 22+ (hard floor for WebSocket support)

## Build, Test, Lint

- **Dev server:** `npm run dev` → Next.js hot reload on http://localhost:3000
- **Build:** `npm run build` runs the full TypeScript check; there is no separate `tsc` script
- **Linting:** `npm run lint` uses ESLint with `next/core-web-vitals` config
- **Testing:** 
  - Full suite: `npm test`
  - Single file: `npm test -- --run tests/temperature.test.ts`
  - By name: `npm test -- --run -t "temperature"`
  - Watch mode: `npx vitest tests/temperature.test.ts` (drop the `--run`)
- **Test coverage:** `tests/` covers pure logic only (US/Eastern bucketing with DST, aggregation, temperature classification, call-quality mapping, RBAC scope decision, auth domain). Never import `server-only` modules in tests; they throw under Vitest.

## Architecture Overview

**Data flow:** HubSpot (change-feed) → Postgres spine (`sdr_*` tables) → aggregate snapshot → snapshot row (cached) → Next.js middleware → authenticated pages

```
GitHub Actions cron (15-min delta / nightly reconcile)
  ↓
lib/spine/runner.ts (orchestrates watermark-driven, advisory-locked, idempotent sync)
  ├─ lib/sync/pull.ts (HubSpot v4 API: activities & companies since watermark)
  ├─ lib/sync/associate.ts (resolve activity→contact→company)
  ├─ lib/spine/store.ts (batch upsert + saveSnapshot)
  └─ lib/sync/aggregate.ts (build Snapshot: reach, temperature, coverage, quality)
       ↓
sdr_snapshots (one jsonb row, id=1) — ONE snapshot, period-independent data model
       ↓
getSnapshot() in lib/snapshot.ts (tries: spine → Vercel Blob → file → empty)
       ↓
middleware.ts (auth gate: Supabase SSO + @spyne.ai domain)
       ↓
app/page.tsx → components/Dashboard.tsx (reads snapshot + resolves viewer scope)
app/admin/*, app/attention/*, app/api/rep/[ownerId]/*
```

**Key constraint:** The app **never** calls HubSpot at request time. All outreach data is pre-computed and stored in Postgres. Call-quality is read live per request (separate, read-only Supabase tables). Sync runs outside Vercel (GitHub Actions) because it can exceed serverless timeouts.

## Key Conventions

### Snapshot & Time Windows

- **Six US/Eastern periods:** `today`, `yesterday`, `this_week`, `this_month`, `last_week`, `last_month` (DST-aware, weeks start Monday)
- **Snapshot shape:** `Snapshot` → `reps[ownerId]` → `{ periods[periodKey]: PeriodMetrics, daily[], book, monthly[] }`
- **Narrow vs. wide periods:** `today`, `yesterday`, `this_week` include `company_breakdown` (detailed accounts); others omit it to keep the snapshot under 6 MB
- **Book coverage:** cumulative, owner-attributed, monotonic (how many of an owner's accounts have ever been tapped)
- **Monthly new-unique:** per account/contact, first-tap tracked over all history

### Temperature Classification

Located in `lib/sync/temperature.ts` and applied during aggregation. Rules (first match wins):
- **HOT:** meeting scheduled/rescheduled, callback-high, callback-low ×2, email reply
- **WARM:** referral, callback-low ×1, any connect, email open
- **COLD:** no-connect / untouched / disqualified (negative outcome without recent positive signal)

"Connected" is a business rule: only the 11 GUIDs in `config/dispositions.ts` `CONNECTED_DISPOSITIONS` count as reaching a human. Ported verbatim from `call-scoring-agent`; keep in sync.

### Coverage Attribution

**Load-bearing rule:** Coverage is attributed to the **account owner, not the activity doer** (`lib/sync/aggregate.ts`). An owned account is "tapped" when ANY tracked SDR works it. Per-rep period metrics (touches, reach, daily breakdown) stay per activity-doer; book coverage rolls up to owner.

### Single Source of Truth: config/reps.ts

`config/reps.ts` defines which owner IDs appear in HubSpot searches (30 SDRs). Adding a rep requires a `sync:backfill` or `sync:reconcile` to pull their history; a delta only catches recently-modified rows.

### RBAC & Scope

`config/team-structure.ts` defines SDR → AE pod → Manager hierarchy (local, not HubSpot teams). `lib/access/scope.ts` `decideScope()` is a pure, unit-tested 3-level focus model:
- Admin/leadership → all reps
- AE pod lead (by email) → the pod's SDRs
- Manager/TL (by owner id) → their subtree + self
- Individual SDR → own book
- Else → org-wide (no error; focus model, not confidentiality)

### Snapshot Size Constraint

`sdr_snapshots` is ONE jsonb row (~6 MB with 30 reps). The plain upsert can trip Postgres `statement_timeout`. Mitigations:
- `ROOFTOP_CONTACT_CAP` (12 in `aggregate.ts`) bounds contacts per rooftop
- `saveSnapshot()` prefers the `sdr_save_snapshot(jsonb)` RPC (has `SET LOCAL statement_timeout`)
- Falls back to retrying upsert on RPC failure
- If aggregate changes enlarge the snapshot: use `npm run sync:reaggregate` (spine-only, logs size)

### 10k Search Ceiling

HubSpot Search API caps results at 10k per call. `lib/sync/pull.ts` handles this by slicing into 7-day windows, resuming from `lastmodified − 1` when a window maxes out. At most `MAX_RESUME_WINDOWS` (3) defers the rest (watermark still advances, no livelock).

### Change-Feed Sync: Watermark-Driven + Idempotent

- **Watermarks** per type in `sdr_sync_state` table
- Each delta re-reads from `watermark − OVERLAP_MS` (5 min overlap)
- All upserts are PK-idempotent (can re-run safely)
- Advances watermark only after upserts + re-aggregate succeed
- Advisory lock (`lock` row) ensures one sync at a time, fenced by lease token
- Nightly reconcile corrects owner-moves; HubSpot deletions are not propagated

### Data Types & Contracts

Shared types across modules:
- `lib/sync/types.ts` — sync ↔ UI contract (activities, companies, contacts)
- `lib/spine/types.ts` — Postgres rows + `Viewer` type (who sees what)
- `lib/callquality/types.ts` — read-only call-scoring merge (BANTIC, coaching snapshots)
- `lib/agent/types.ts` — AI agent I/O (hot-account detection, reasoning, watches)

## Environment & Secrets

Secrets live **only in `.env.local` (gitignored) and Vercel/GitHub secrets** — never in code.

Required:
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (auth)
- `SUPABASE_SERVICE_ROLE_KEY` (server-only: spine + call-quality + agent)
- `HUBSPOT_PAT` (sync scripts)

Optional:
- `CRON_SECRET` (for `/api/sync/delta` route, constant-time check)
- `OPENAI_API_KEY` (agent reasoning; optional model override: `OPENAI_MODEL`)
- `BLOB_READ_WRITE_TOKEN` (Vercel Blob fallback for snapshot storage)

**Production fails closed (503)** if `NEXT_PUBLIC_SUPABASE_*` vars are missing. Local dev without them runs ungated, spine/call-quality disabled.

## Development Workflow

1. **Local setup:**
   ```bash
   npm install
   cp .env.local.example .env.local     # add secrets
   npm run verify:schema                # one-time schema check
   npm run sync:backfill                # one-time full pull (~1 h)
   npm run dev
   ```

2. **Making changes:**
   - **Schema/config:** No breaking changes to `config/reps.ts` or `config/dispositions.ts` without a reconcile
   - **Aggregate logic:** Changes enlarge snapshot → test locally + watch `npm run sync:reaggregate` output
   - **UI:** Next.js hot reload; snapshots are read live from DB
   - **Auth/RBAC:** Modify `config/team-structure.ts` + `lib/access/scope.ts`; test against `tests/access.test.ts`

3. **Pull requests:**
   - TypeScript must pass: `npm run build`
   - ESLint must pass: `npm run lint`
   - Tests should pass: `npm test`
   - Use descriptive commits with Copilot co-author trailer

## HubSpot API

- **Portal:** 242626590 (app-na2)
- **Deep-link builders:** `config/hubspot.ts` (`companyUrl`, `contactUrl`, `dealUrl`, `meetingUrl`, `callUrl`)
- **Required Private App scopes:** `crm.objects.contacts.read`, `crm.objects.companies.read`, engagement + association read
- **Sync pulls:** outbound calls/emails only (`hs_call_direction=OUTBOUND`, `hs_email_direction=EMAIL`)

## AI Agent Features

The hot-account agent runs every 2 hours (GitHub Actions), reads-only on HubSpot:
- **Detection:** `lib/agent/detect.ts` (pure, unit-tested) — newly-hot / stale / intent-shift accounts
- **Reasoning:** `lib/agent/openai.ts` — OpenAI reasoning over snapshot + call-scoring distilled text
- **Storage:** `sdr_agent_watches` / `sdr_agent_notes` / `sdr_activity_content` tables
- **UI:** `/attention` (AttentionBoard) + `/api/agent/watches`
- **Activation:** one-time: apply `supabase/sdr_schema.sql` + set `OPENAI_API_KEY`

## Common Debugging

| Issue | Solution |
|---|---|
| Snapshot timeout on write | `npm run sync:reaggregate` (spine-only, logs size) |
| New rep has no history | `npm run sync:backfill` or `npm run sync:reconcile` (delta only catches modified rows) |
| Dispositions out of sync | Check `config/dispositions.ts` vs. `call-scoring-agent/config/dispositions.py` |
| Auth gate 503 | Verify `NEXT_PUBLIC_SUPABASE_*` env vars in Vercel |
| Sync stuck | Check advisory lock row + lease token in `sdr_sync_state` |

## File Structure Highlights

- `app/` — Next.js App Router (pages, API routes, auth callback)
- `components/` — React client components (Dashboard, RepDrawer, AccountsTable, charts)
- `lib/` — Shared logic
  - `lib/spine/` — data spine orchestration + store
  - `lib/sync/` — HubSpot pull + associate + aggregate + temperature
  - `lib/snapshot.ts` — load from spine / Blob / file
  - `lib/access/` — RBAC scope decision
  - `lib/callquality/` — read-only call-scoring merge
  - `lib/agent/` — AI agent (detect, reason, store)
  - `lib/auth/` — auth domain rule
  - `lib/supabase/` — Supabase client (admin = server-only)
- `config/` — single-source-of-truth: reps, dispositions, HubSpot portal, team structure
- `tests/` — Vitest (buckets, aggregate, temperature, access, auth-domain, agent-detect, spine-rows, callquality)
- `scripts/` — CLI scripts (sync, agent, verify-schema)
- `supabase/` — SQL schema + RLS floor

## Integration Points

- **HubSpot:** Change-feed via v4 Search API (watermark-driven)
- **Supabase:** Postgres spine + call-scoring tables + Google SSO
- **OpenAI:** Agent reasoning (gpt-4o-mini by default)
- **Vercel:** Deployment + optional Blob snapshot fallback

---

**For deeper context:** See [CLAUDE.md](../CLAUDE.md) for full architecture, data model, and conventions.
