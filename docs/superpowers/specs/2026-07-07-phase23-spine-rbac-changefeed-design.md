# Phase 2+3: Postgres Data Spine + RBAC + Change-Feed Sync — Design

**Date:** 2026-07-07 · **Status:** Approved by Kaustubh (verbal, this session)

## Context

Phase 1 shipped the auth gate, GD Book Explorer, and call-quality merge. Two structural problems
remain:

1. **Sync is O(everything)** — every refresh re-pulls ~18 months of activity (~195k records,
   ~50–60 min) and commits an ~8 MB snapshot to git. The user requires a **change-feed**: each
   refresh must touch only what changed ("we can't refresh lakhs of records on every turn").
2. **No role-based views** — every authenticated user sees everything. Access should derive from
   **HubSpot teams** (verified: 5 SDR teams — Saarthak/Neelima/Archit/Prince/Dave — cover 25 of
   28 tracked reps; `/crm/v3/owners` exposes `email` + `teams` with the existing PAT, giving a
   complete login-email → ownerId → team → scope chain with zero manual mapping).

Also discovered and already fixed: the GitHub repo was **public** (committed snapshot = world-
readable rep data). Repo is now private; retiring the committed snapshot (this design) removes
the data from git going forward.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Rollout | **Combined** P2+P3 build (one data spine) |
| Sync model | **Change-feed**: delta by `hs_lastmodifieddate` watermark (O(changes) per run); webhooks are a possible later upgrade, not the foundation (engagement-object webhook support with a PAT is unreliable) |
| Access model | **Focus-based defaults, not confidentiality walls**: rep → own data by default, manager → their team by default, leadership/admin → all + admin; **any other @spyne.ai login → view-all** (user-chosen). An org-view toggle is available to reps/managers, so scoping guides attention rather than hiding data. RLS enforces the floor (authenticated spyne.ai only); flipping to hard confidentiality later = policy change only. |
| Manager mapping | Team **membership** auto-syncs from HubSpot; **who is a manager** is one explicit 5-row seed (Saarthak Seth, Neelima Tiwari, Archit Gupta, Prince Arora, Dave Purgason → their teams), editable in the admin page |
| Storage | New `sdr_*` tables in the **same Supabase project** as call-scoring (its tables untouched) |
| Snapshot file | **Retired** — aggregate stored as a row in Postgres; `data/snapshot.json` and the refresh-commit workflow removed after cutover |

## Architecture

```
HubSpot ──(delta: hs_lastmodifieddate > watermark)──▶ sync runner (npm run sync:delta)
   ▲                                                     │ upsert changed rows
   └─(nightly reconcile sweep: drift/deletes/merges)     ▼
                                        Supabase Postgres (sdr_* tables)
                                          activities · companies · owners · teams ·
                                          team_members · roles · sync_state · snapshots
                                                         │
                              aggregate() (UNCHANGED logic) reads store → writes
                              sdr_snapshots (one jsonb row = the old snapshot.json)
                                                         │
   Next.js app ── auth gate ── resolveViewer(email) ──▶ scoped snapshot → Dashboard
                                                         └▶ /api/rep/* guards + /admin
```

- **Runner scheduling:** plain npm scripts callable from any scheduler. Primary: GitHub Actions
  cron **every 15 min** (`sync:delta`, ~1–2 min/run incl. re-aggregation) + nightly
  (`sync:reconcile`). Repo is now private → Actions minutes are metered; if the monthly pace
  exceeds the free tier, options (documented, not built): 30-min cadence, or move the runner to
  a Supabase Edge Function + pg_cron. A `/api/sync/delta` route (CRON_SECRET-protected) exists as
  an alternative trigger for external pingers/Vercel cron.
- **Delta semantics:** watermark per object type stored in `sdr_sync_state`; each run pulls
  `hs_lastmodifieddate > (watermark − 5 min overlap)`, upserts by HubSpot ID (idempotent),
  advances the watermark. Associations/contact-meta are resolved **only for changed activities**.
  Owners + teams refresh on every run (2 API pages). Company changes (owner moves, gd/stage/segment
  edits) arrive through the same delta — the book stays current automatically.
- **Reconcile (nightly):** re-pulls ID sets per recent windows to catch deletes/merges/missed
  events; recomputes any drifted rows; logs discrepancies to `sdr_sync_state.notes`.
- **Backfill (one-time):** full pull (existing pipeline) → bulk upsert → first aggregate row.
- **Aggregation:** `lib/sync/aggregate.ts` is reused byte-for-byte; only its INPUT changes
  (rows loaded from Postgres instead of a live HubSpot pull). Output `Snapshot` (same type) is
  written to `sdr_snapshots`; `getSnapshot()` reads Postgres first (then Blob, then file, then
  empty — transition fallbacks).

## RBAC

- **Identity:** session email → `sdr_owners.email` → ownerId → `sdr_team_members` → team(s).
- **Roles** (`sdr_roles`: email, role, team_id?): `admin` ⊇ `leadership` (all reps + /admin page),
  `manager` (team default scope), none-but-tracked-rep → `rep` (own default scope), any other
  spyne.ai → `viewer` (org-wide view).
- **Resolution:** `resolveViewer(email)` (server-side, service key) returns
  `{ role, defaultOwnerIds, canSeeAll: true }` under the focus model. `app/page.tsx` filters the
  snapshot to the viewer's ACTIVE scope (default scope, or org-wide when toggled); drawer API
  routes re-validate the requested ownerId against the same resolution.
- **RLS floor:** all `sdr_*` tables get RLS: SELECT allowed only to `authenticated` requests whose
  JWT email ends `@spyne.ai`; INSERT/UPDATE/DELETE service-role only. (App reads currently go
  through the service key server-side; the RLS floor protects against direct PostgREST access with
  the browser-shipped publishable key — the same hole found on call-scoring's tables.)
- **Unassigned tracked reps** (currently Rajveer, Ashish Baweja, Jayant Trivedi — in no HubSpot
  team): visible under leadership/viewer scopes; surfaced as a warning on /admin so managers get
  them assigned in HubSpot.

## Admin page (`/admin`, leadership/admin only)

Role management (list/add/remove `sdr_roles` rows), sync health (per-object watermarks, last run
at/duration/counts, error notes), unassigned-tracked-reps warning.

## Schema application

No Supabase management token exists on this machine → DDL ships as one SQL file
(`supabase/sdr_schema.sql`, idempotent `IF NOT EXISTS` + seeds), applied by the user in the
Supabase SQL editor once (same workflow call-scoring uses). A verify script confirms tables +
RLS from the service key before any sync runs.

## Failure modes

- Runner failure → watermark unchanged → next run picks up the same delta (at-least-once,
  idempotent upserts). Snapshot row is only replaced after a successful aggregate.
- Postgres unreachable at request time → `getSnapshot()` falls back Blob → file → empty (Phase 1
  behavior); call-quality already degrades independently.
- `resolveViewer` failure → treat as `viewer` (org-view, no admin) — never lock the app.
- Duplicate/overlapping runs → advisory lock via `sdr_sync_state` row lock; second run exits.

## Testing & verification

- Vitest (pure): watermark math (overlap, advance rules), row↔type mappers, `resolveViewer`
  role/scope resolution, snapshot scope filtering.
- Integration (scripted, service key): schema verify; delta run against live HubSpot with a
  narrow window; aggregate-from-store equals aggregate-from-pull on identical inputs.
- E2E: backfill → delta → page shows fresh data; rep/manager/viewer scoping; /admin gated;
  anon PostgREST probe against `sdr_*` tables returns zero rows (RLS floor).

## Out of scope

- Hard-confidentiality RLS (per-row scoping by viewer) — the focus model makes this a later
  policy-only change.
- Webhooks; Supabase Edge Function runner (documented as follow-ups).
- Call-scoring repo changes of any kind (incl. its RLS gap — tracked separately).
- Git history rewrite for the previously-public snapshot (repo is private; accepted).
