# Phase 1: Login Gate + Call-Quality Merge + Drawer UI — Design

**Date:** 2026-07-06 · **Status:** Approved by Kaustubh (verbal, this session)

## Context

The SDR outreach dashboard (this repo) tracks outbound *coverage*. A sibling project,
[`call-scoring-agent`](https://github.com/kauscodedev/call-scoring-agent) (Python; must remain
untouched and independently runnable), analyzes every **connected** SDR call — BANTIC scores,
call-quality rubric scores, LLM coaching — and stores results in **Supabase Postgres**.

Three problems this phase solves:

1. **The app is publicly exposed** (`sdr-outreach-dashboard.vercel.app`) — rep performance and
   account data are visible to anyone with the URL.
2. **Call quality is invisible here** — leadership sees volume/coverage but not whether connected
   calls were any good. The data already exists in call-scoring's Supabase.
3. **The expanded-rep UI is fragmented** — clicking a row explodes ~10 scattered cards inline into
   the table, causing whitespace, page-scroll fights, and a disjointed feel.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Backend spine | **Supabase** — same project as call-scoring (auth + reads live there; Phase 2 migrates SDR data into it) |
| Sequencing | Value-first: **P1** login gate + call-quality merge + UI drawer/mobile · P2 full RBAC + Postgres migration · P3 incremental sync |
| Call-quality scope (P1) | Per-rep BANTIC scorecard · call-level drill-down · reuse coaching insights. (Per-account call scores: **out**) |
| Rep detail container | **Slide-over drawer** (right panel ~65% width; full-screen sheet on mobile) |
| Aesthetic | Keep current visual language; consolidate into dense grid (no intelly-style reskin) |
| Auth scope (P1) | Google SSO restricted to **@spyne.ai**; all authenticated users see everything (RBAC = P2) |

## Architecture

```
HubSpot ── npm run sync ──▶ data/snapshot.json   (outreach data — UNCHANGED in P1)
call-scoring pipeline (UNTOUCHED) ──▶ Supabase Postgres
                                          │
   Next.js app ── server-side reads ──────┘   (service-role key, never client-exposed)
        ▲
   Supabase Auth (same project) — Google SSO, spyne.ai domain
```

- New deps: `@supabase/supabase-js`, `@supabase/ssr`. No other new libraries (charts stay pure CSS).
- Call-quality reads are **server-side only** using `SUPABASE_SERVICE_ROLE_KEY`. No RLS changes in
  P1 → zero risk to the Python pipeline (RLS arrives with Phase 2).
- The page is already `force-dynamic`, so call-quality data is **live per request** while outreach
  data remains snapshot-based. These two sources stay decoupled.

## Data contracts (read-only; owned by call-scoring)

- **`rep_coaching_snapshots`** — latest `weekly` row per `hubspot_owner_id`: `avg_bantic_score`,
  `avg_quality_score`, `weakest_dimension`, `top_strengths`, `top_risks`, `coaching_priorities`,
  `suggested_drills`, `manager_summary`, `calls_analyzed`, `meetings_booked`.
- **`calls`** — per-rep BANTIC aggregates + drill-down rows (completed analysis only):
  `score_budget/authority/need/timeline/impact/current_process`, `overall_score`,
  `reasoning_*`, `call_date`, `call_disposition_label`, `recording_url`, `hubspot_company_id`.
- **`call_quality_insights`** — joined per call: `discovery_quality`, `objection_handling`,
  `next_step_clarity`, `talk_control`, `crm_hygiene`, `quality_score`, `strengths`, `risks`,
  `coachable_moments`, `quote_examples`, `recommended_next_action`.
- Join key to this repo's world: `hubspot_owner_id` ↔ `config/reps.ts`; `hubspot_company_id` ↔
  coverage company IDs.
- A thin data-access module (`lib/callquality/`) maps rows → typed shapes consumed by the UI, so
  the P2 backend migration never forces a UI rewrite.

## Auth flow

- `middleware.ts` (Next.js) checks the Supabase session cookie on every route; unauthenticated →
  `/login` (single "Continue with Google" button).
- Supabase Auth Google provider; domain restriction to `spyne.ai` configured on the provider
  **plus** a server-side email-domain check after callback (belt-and-braces; non-spyne accounts
  are signed out with an error message).
- Session management via `@supabase/ssr` cookie helpers. Logout button in the header.
- **Manual step (user):** enable Google provider in the Supabase dashboard with Google OAuth
  client credentials; add the Vercel callback URL.

## UI

**Main page**
- Remove inline row expansion entirely. Row click → drawer.
- Add a **Call Quality** column (avg BANTIC, latest coaching snapshot) to the rep table.
- Mobile pass: header condenses, KPI cards stack (already grid-based), table keeps horizontal
  scroll, period selector wraps.

**Drawer** (new `components/RepDrawer.tsx`; table row stays lean)
- Right slide-over, ~65% viewport width (min 640px), backdrop dims table; ESC / ✕ / backdrop
  click closes. Own scroll container. On `< sm` it is a full-screen sheet.
- Single dense 2-column grid (1-column on mobile), current visual language, tighter spacing:
  1. Header — rep name, grade badge, compact KPI strip (calls · emails · connect · open · reply ·
     meetings · DM reach · depth)
  2. Insight chips (period + book insights)
  3. Coverage card + Temperature card
  4. **BANTIC scorecard (new)** — avg overall + 6 dimension bars, weakest dimension callout,
     coaching priorities / strengths / risks chips, manager summary
  5. Reach / Quality-breakdown / Email — consolidated row
  6. Daily activity chart
  7. Dispositions + Accounts (tapped/untapped)
  8. **Calls drill-down (new)** — recent connected calls list; each row expands to BANTIC + rubric
     scores, coachable moments, quote examples, recommended next action, recording link
- Existing card components are reused/adapted; no charting library.

## Failure modes

- Supabase unreachable / env missing → call-quality blocks render a compact "call data
  unavailable" state; the rest of the dashboard works (mirrors the existing 403-degrade pattern).
- Rep with no analyzed calls → BANTIC card shows "no connected calls analyzed yet".
- Auth misconfig (provider off) → login page surfaces the error; no data leaks (middleware still
  blocks).

## Testing & verification

- Vitest for the pure mapping/aggregation functions in `lib/callquality/` (fixtures mirroring the
  three tables), alongside the existing 21 tests.
- `npm run build` (types + lint) green.
- Smoke: unauthenticated request → redirected to `/login`; authenticated (spyne.ai) → dashboard;
  non-spyne Google account → rejected.
- Manual: drawer open/close on desktop + mobile viewport; call-quality blocks render with live
  Supabase data; graceful state with env vars removed.

## Out of scope (later phases)

- P2: full RBAC (rep/manager/leadership), SDR data migrated into Postgres, RLS policies.
- P3: incremental sync (delta by `hs_lastmodifieddate`), replacing the ~1-hour full re-pull.
- Per-account call scores / AE-handoff surfacing; intelly-style visual reskin.

## Amendment (2026-07-06, mid-execution)

User re-focus: the drawer's **centerpiece is a GD Book Explorer** — per rep: assigned GD/Single units →
rooftops within each unit (engaged vs untapped, cumulative owner-scoped) → top-5 engaged contacts per
rooftop (by touches; name/title/DM, call+email counts, HubSpot links) → rooftop activity depth
(calls, emails, connected, last touch, cumulative temperature hot/warm/cold with reason). All figures
derive from the same anchored, owner-scoped activity set as `BookCoverage`, so explorer and coverage
numbers reconcile exactly. Requires sync-side data (`BookCoverage.units`) and a re-sync before live data.
Call-quality (BANTIC scorecard + call drill-down) stays, demoted to a secondary card below the explorer.
