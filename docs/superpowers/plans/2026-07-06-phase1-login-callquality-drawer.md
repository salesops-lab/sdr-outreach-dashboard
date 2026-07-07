# Phase 1: Login Gate + Call-Quality Merge + Drawer UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the dashboard behind Google SSO (spyne.ai only), surface call-scoring's BANTIC/coaching data per rep, and replace the fragmented inline rep expansion with a slide-over drawer (mobile-ready).

**Architecture:** Outreach data stays snapshot-based (unchanged). Call-quality data is read server-side from the call-scoring Supabase project (service-role key; call-scoring itself untouched). Supabase Auth (same project) + Next.js middleware gate every route. The rep detail moves from inline table expansion to a right slide-over drawer; drawer-only call data loads via an auth-protected API route when the drawer opens.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Tailwind, Vitest, `@supabase/supabase-js`, `@supabase/ssr`. No charting libraries (pure CSS, per existing convention).

**Spec:** `docs/superpowers/specs/2026-07-06-phase1-login-callquality-drawer-design.md`

**Working branch:** create `phase1-auth-callquality` off `main` (deploys happen from `main`; push only at final verification).

---

## File map

| File | Responsibility |
|---|---|
| `lib/supabase/admin.ts` (new) | Server-only service-role client for reading call-scoring tables. Null-safe when env missing. |
| `lib/supabase/server.ts` (new) | SSR cookie-bound auth client (for middleware/route handlers/server components). |
| `lib/supabase/client.ts` (new) | Browser auth client (login button, logout). |
| `lib/callquality/types.ts` (new) | Typed shapes: `CoachingSnapshot`, `CallDims`, `CallDrillRow`, raw row types. |
| `lib/callquality/map.ts` (new) | Pure mappers/aggregators (TDD): latest-snapshot pick, BANTIC dim averaging, insight join. |
| `lib/callquality/fetch.ts` (new) | Server-only queries: coaching snapshots (page load), per-rep calls + insights (drawer). |
| `tests/callquality.test.ts` (new) | Vitest coverage for `map.ts`. |
| `middleware.ts` (new, repo root) | Session check on every route; redirect unauthenticated → `/login`. |
| `app/login/page.tsx` (new) | Google sign-in page. |
| `app/auth/callback/route.ts` (new) | OAuth code exchange + spyne.ai domain enforcement. |
| `app/api/rep/[ownerId]/calls/route.ts` (new) | Drawer data: recent analyzed calls + dims for one rep. |
| `app/page.tsx` (modify) | Also fetch coaching snapshots; pass to Dashboard. |
| `components/Dashboard.tsx` (modify) | Remove inline expansion; drawer state; Call-Q column; header logout; mobile pass. |
| `components/RepDrawer.tsx` (new) | Slide-over shell + consolidated dense grid (reuses existing cards). |
| `components/CallQualityCard.tsx` (new) | BANTIC scorecard + coaching (snapshot props + dims fetched). |
| `components/CallsDrilldown.tsx` (new) | Recent analyzed calls list with expandable detail. |
| `.env.local.example` (modify) | New Supabase env vars. |

Env vars (add to `.env.local`, Vercel, and `.env.local.example`):
- `NEXT_PUBLIC_SUPABASE_URL` — call-scoring Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — anon key (auth only)
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, reads call-scoring tables

---

### Task 0: Branch + dependencies + env scaffolding

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `.env.local.example`

- [ ] **Step 1: Branch and install**

```bash
git checkout -b phase1-auth-callquality
npm install @supabase/supabase-js @supabase/ssr
```

Expected: both packages land in `dependencies`; lockfile updates.

- [ ] **Step 2: Append to `.env.local.example`**

```bash
# Supabase (call-scoring project) — auth + call-quality reads
# URL + anon key are safe to expose (client auth); service role key is SERVER-ONLY.
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Also add the three real values to your local `.env.local` (from Supabase dashboard → Settings → API).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .env.local.example
git commit -m "chore: add supabase deps + env scaffolding for auth/call-quality"
```

---

### Task 1: Supabase clients

**Files:**
- Create: `lib/supabase/admin.ts`
- Create: `lib/supabase/server.ts`
- Create: `lib/supabase/client.ts`

- [ ] **Step 1: Create `lib/supabase/admin.ts`** (service-role reads; null when unconfigured → graceful degradation)

```ts
/**
 * Server-only Supabase client using the SERVICE ROLE key — read-only use against
 * the call-scoring project's tables (calls, call_quality_insights,
 * rep_coaching_snapshots). Never import from client components.
 * Returns null when env is missing so the dashboard degrades gracefully.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

export function supabaseAdmin(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cached = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  if (!cached) console.warn("[callquality] Supabase env missing — call-quality disabled.");
  return cached;
}
```

- [ ] **Step 2: Create `lib/supabase/server.ts`** (SSR cookie client for auth checks)

```ts
/** Cookie-bound Supabase auth client for server contexts (route handlers, RSC). */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function supabaseServer() {
  const store = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (all) => {
          try {
            all.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            /* Server Components can't set cookies — middleware refreshes sessions. */
          }
        },
      },
    },
  );
}
```

- [ ] **Step 3: Create `lib/supabase/client.ts`**

```ts
"use client";
/** Browser Supabase auth client (login / logout). */
import { createBrowserClient } from "@supabase/ssr";

export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

- [ ] **Step 4: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/supabase
git commit -m "feat: supabase admin + ssr auth clients"
```

Expected: tsc exit 0.

---

### Task 2: Call-quality types + pure mappers (TDD)

**Files:**
- Create: `lib/callquality/types.ts`
- Create: `lib/callquality/map.ts`
- Test: `tests/callquality.test.ts`

- [ ] **Step 1: Create `lib/callquality/types.ts`**

```ts
/** Typed shapes for call-scoring data (tables owned by call-scoring-agent — read-only). */

/** Raw row: rep_coaching_snapshots (subset we read). */
export interface CoachingRow {
  hubspot_owner_id: string | null;
  period_type: "daily" | "weekly";
  period_end: string; // ISO date
  scope: string;
  calls_analyzed: number;
  meetings_booked: number;
  avg_bantic_score: number | null;
  avg_quality_score: number | null;
  weakest_dimension: string | null;
  top_strengths: string[];
  top_risks: string[];
  coaching_priorities: string[];
  suggested_drills: string[];
  manager_summary: string | null;
}

/** Latest weekly coaching snapshot per rep — drives the table column + drawer card. */
export interface CoachingSnapshot {
  ownerId: string;
  periodEnd: string;
  callsAnalyzed: number;
  meetingsBooked: number;
  avgBantic: number | null; // 0–10
  avgQuality: number | null; // 0–5
  weakestDimension: string | null;
  strengths: string[];
  risks: string[];
  priorities: string[];
  drills: string[];
  managerSummary: string | null;
}

/** Raw row: calls (analyzed subset). */
export interface CallRow {
  hubspot_call_id: string;
  hubspot_owner_id: string | null;
  hubspot_company_id: string | null;
  call_date: string | null;
  call_disposition_label: string | null;
  call_duration_ms: number | null;
  recording_url: string | null;
  score_budget: number | null;
  score_authority: number | null;
  score_need: number | null;
  score_timeline: number | null;
  score_impact: number | null;
  score_current_process: number | null;
  overall_score: number | null;
}

/** Raw row: call_quality_insights (subset). */
export interface InsightRow {
  hubspot_call_id: string;
  quality_score: number | null; // 0–5
  discovery_quality: number | null;
  objection_handling: number | null;
  next_step_clarity: number | null;
  talk_control: number | null;
  crm_hygiene: number | null;
  coachable_moments: string[];
  quote_examples: string[];
  recommended_next_action: string | null;
}

export const BANTIC_DIMS = [
  "budget", "authority", "need", "timeline", "impact", "current_process",
] as const;
export type BanticDim = (typeof BANTIC_DIMS)[number];

/** Averaged BANTIC dimensions over a rep's recent analyzed calls. */
export interface CallDims {
  count: number; // calls averaged
  overall: number | null;
  dims: Record<BanticDim, number | null>;
}

/** One drill-down row: a call joined with its quality insight (if any). */
export interface CallDrillRow {
  callId: string;
  date: string | null;
  companyId: string | null;
  disposition: string | null;
  durationMs: number | null;
  recordingUrl: string | null;
  overall: number | null;
  dims: Record<BanticDim, number | null>;
  quality: number | null;
  coachableMoments: string[];
  quotes: string[];
  nextAction: string | null;
}

/** Payload of GET /api/rep/[ownerId]/calls. */
export interface RepCallsPayload {
  dims: CallDims;
  calls: CallDrillRow[];
}
```

- [ ] **Step 2: Write failing tests — `tests/callquality.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { pickLatestSnapshots, aggregateDims, joinCallInsights } from "../lib/callquality/map";
import { CallRow, CoachingRow, InsightRow } from "../lib/callquality/types";

const coach = (p: Partial<CoachingRow>): CoachingRow => ({
  hubspot_owner_id: "69016314", period_type: "weekly", period_end: "2026-07-05",
  scope: "rep", calls_analyzed: 10, meetings_booked: 2,
  avg_bantic_score: 6.5, avg_quality_score: 3.2, weakest_dimension: "budget",
  top_strengths: ["rapport"], top_risks: ["no next step"], coaching_priorities: ["ask budget"],
  suggested_drills: [], manager_summary: "Solid week.", ...p,
});

const call = (p: Partial<CallRow>): CallRow => ({
  hubspot_call_id: "c1", hubspot_owner_id: "69016314", hubspot_company_id: "X",
  call_date: "2026-07-01T15:00:00Z", call_disposition_label: "Connected",
  call_duration_ms: 300000, recording_url: "https://rec/1",
  score_budget: 6, score_authority: 8, score_need: 7, score_timeline: 5,
  score_impact: 6, score_current_process: 4, overall_score: 6.2, ...p,
});

describe("pickLatestSnapshots", () => {
  it("keeps only the latest weekly rep-scope snapshot per owner", () => {
    const out = pickLatestSnapshots([
      coach({ period_end: "2026-06-28", avg_bantic_score: 5 }),
      coach({ period_end: "2026-07-05", avg_bantic_score: 7 }),
      coach({ hubspot_owner_id: "111", period_end: "2026-07-05", avg_bantic_score: 4 }),
      coach({ period_type: "daily", period_end: "2026-07-06", avg_bantic_score: 9 }), // ignored
      coach({ scope: "team", period_end: "2026-07-06" }), // ignored
      coach({ hubspot_owner_id: null }), // ignored
    ]);
    expect(Object.keys(out).sort()).toEqual(["111", "69016314"]);
    expect(out["69016314"].avgBantic).toBe(7);
    expect(out["69016314"].weakestDimension).toBe("budget");
    expect(out["69016314"].priorities).toEqual(["ask budget"]);
  });
});

describe("aggregateDims", () => {
  it("averages each BANTIC dim and overall, skipping nulls per-dim", () => {
    const d = aggregateDims([
      call({ score_budget: 6, overall_score: 6 }),
      call({ hubspot_call_id: "c2", score_budget: null, score_authority: 4, overall_score: 8 }),
    ]);
    expect(d.count).toBe(2);
    expect(d.dims.budget).toBe(6); // null skipped, not zero-averaged
    expect(d.dims.authority).toBe(6); // (8+4)/2
    expect(d.overall).toBe(7);
  });

  it("returns nulls for empty input", () => {
    const d = aggregateDims([]);
    expect(d.count).toBe(0);
    expect(d.overall).toBeNull();
    expect(d.dims.need).toBeNull();
  });
});

describe("joinCallInsights", () => {
  it("joins insight by call id and tolerates missing insight", () => {
    const insights: InsightRow[] = [{
      hubspot_call_id: "c1", quality_score: 3.5, discovery_quality: 3,
      objection_handling: 4, next_step_clarity: 2, talk_control: 3, crm_hygiene: 5,
      coachable_moments: ["ask open questions"], quote_examples: ["'just send info'"],
      recommended_next_action: "Book follow-up",
    }];
    const rows = joinCallInsights([call({}), call({ hubspot_call_id: "c2" })], insights);
    expect(rows[0].quality).toBe(3.5);
    expect(rows[0].coachableMoments).toEqual(["ask open questions"]);
    expect(rows[0].dims.authority).toBe(8);
    expect(rows[1].quality).toBeNull();
    expect(rows[1].coachableMoments).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
npx vitest run tests/callquality.test.ts
```

Expected: FAIL — `map.ts` module not found.

- [ ] **Step 4: Implement `lib/callquality/map.ts`**

```ts
/** Pure mappers/aggregators for call-scoring rows. No I/O — unit-tested. */
import {
  BANTIC_DIMS, BanticDim, CallDims, CallDrillRow, CallRow, CoachingRow,
  CoachingSnapshot, InsightRow,
} from "./types";

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Latest weekly rep-scope snapshot per owner (input order-independent). */
export function pickLatestSnapshots(rows: CoachingRow[]): Record<string, CoachingSnapshot> {
  const out: Record<string, CoachingSnapshot> = {};
  for (const r of rows) {
    if (!r.hubspot_owner_id || r.period_type !== "weekly" || r.scope !== "rep") continue;
    const prev = out[r.hubspot_owner_id];
    if (prev && prev.periodEnd >= r.period_end) continue;
    out[r.hubspot_owner_id] = {
      ownerId: r.hubspot_owner_id,
      periodEnd: r.period_end,
      callsAnalyzed: r.calls_analyzed ?? 0,
      meetingsBooked: r.meetings_booked ?? 0,
      avgBantic: r.avg_bantic_score,
      avgQuality: r.avg_quality_score,
      weakestDimension: r.weakest_dimension,
      strengths: arr(r.top_strengths),
      risks: arr(r.top_risks),
      priorities: arr(r.coaching_priorities),
      drills: arr(r.suggested_drills),
      managerSummary: r.manager_summary,
    };
  }
  return out;
}

const SCORE_KEY: Record<BanticDim, keyof CallRow> = {
  budget: "score_budget", authority: "score_authority", need: "score_need",
  timeline: "score_timeline", impact: "score_impact", current_process: "score_current_process",
};

/** Per-dim averages over analyzed calls; nulls are skipped per-dim (not zeroed). */
export function aggregateDims(calls: CallRow[]): CallDims {
  const dims = {} as Record<BanticDim, number | null>;
  for (const d of BANTIC_DIMS) {
    const vals = calls.map((c) => c[SCORE_KEY[d]] as number | null).filter((v): v is number => v != null);
    dims[d] = vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  const overalls = calls.map((c) => c.overall_score).filter((v): v is number => v != null);
  return {
    count: calls.length,
    overall: overalls.length ? round1(overalls.reduce((a, b) => a + b, 0) / overalls.length) : null,
    dims,
  };
}

function dimsOf(c: CallRow): Record<BanticDim, number | null> {
  const d = {} as Record<BanticDim, number | null>;
  for (const k of BANTIC_DIMS) d[k] = c[SCORE_KEY[k]] as number | null;
  return d;
}

/** Join calls with their quality insight (by call id); missing insight → empty fields. */
export function joinCallInsights(calls: CallRow[], insights: InsightRow[]): CallDrillRow[] {
  const byId = new Map(insights.map((i) => [i.hubspot_call_id, i]));
  return calls.map((c) => {
    const i = byId.get(c.hubspot_call_id);
    return {
      callId: c.hubspot_call_id,
      date: c.call_date,
      companyId: c.hubspot_company_id,
      disposition: c.call_disposition_label,
      durationMs: c.call_duration_ms,
      recordingUrl: c.recording_url,
      overall: c.overall_score,
      dims: dimsOf(c),
      quality: i?.quality_score ?? null,
      coachableMoments: arr(i?.coachable_moments),
      quotes: arr(i?.quote_examples),
      nextAction: i?.recommended_next_action ?? null,
    };
  });
}
```

- [ ] **Step 5: Run tests — verify pass; run full suite**

```bash
npx vitest run
```

Expected: all files pass (21 existing + new callquality tests).

- [ ] **Step 6: Commit**

```bash
git add lib/callquality tests/callquality.test.ts
git commit -m "feat: call-quality types + pure mappers (TDD)"
```

---

### Task 3: Server-side fetchers

**Files:**
- Create: `lib/callquality/fetch.ts`

- [ ] **Step 1: Create `lib/callquality/fetch.ts`**

```ts
/**
 * Server-only reads from the call-scoring Supabase project. Every function
 * returns a safe empty value when Supabase is unconfigured or errors —
 * the dashboard must keep working without call data.
 */
import { supabaseAdmin } from "../supabase/admin";
import { REP_OWNER_IDS } from "../../config/reps";
import { pickLatestSnapshots, aggregateDims, joinCallInsights } from "./map";
import { CallRow, CoachingRow, CoachingSnapshot, InsightRow, RepCallsPayload } from "./types";

const DRILL_LIMIT = 15; // calls shown in the drawer drill-down
const DIMS_WINDOW_DAYS = 90;

/** Latest weekly coaching snapshot per tracked rep. Empty map on failure. */
export async function getCoachingByRep(): Promise<Record<string, CoachingSnapshot>> {
  const sb = supabaseAdmin();
  if (!sb) return {};
  const { data, error } = await sb
    .from("rep_coaching_snapshots")
    .select(
      "hubspot_owner_id,period_type,period_end,scope,calls_analyzed,meetings_booked," +
      "avg_bantic_score,avg_quality_score,weakest_dimension,top_strengths,top_risks," +
      "coaching_priorities,suggested_drills,manager_summary",
    )
    .eq("period_type", "weekly")
    .eq("scope", "rep")
    .in("hubspot_owner_id", REP_OWNER_IDS)
    .order("period_end", { ascending: false })
    .limit(300);
  if (error) {
    console.error("[callquality] coaching fetch failed:", error.message);
    return {};
  }
  return pickLatestSnapshots((data ?? []) as CoachingRow[]);
}

/** Recent analyzed calls + dim averages for one rep (drawer payload). */
export async function getRepCalls(ownerId: string): Promise<RepCallsPayload> {
  const empty: RepCallsPayload = {
    dims: aggregateDims([]),
    calls: [],
  };
  const sb = supabaseAdmin();
  if (!sb) return empty;

  const since = new Date(Date.now() - DIMS_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: callRows, error } = await sb
    .from("calls")
    .select(
      "hubspot_call_id,hubspot_owner_id,hubspot_company_id,call_date,call_disposition_label," +
      "call_duration_ms,recording_url,score_budget,score_authority,score_need,score_timeline," +
      "score_impact,score_current_process,overall_score",
    )
    .eq("hubspot_owner_id", ownerId)
    .eq("analysis_status", "completed")
    .gte("call_date", since)
    .order("call_date", { ascending: false })
    .limit(400);
  if (error) {
    console.error("[callquality] calls fetch failed:", error.message);
    return empty;
  }
  const calls = (callRows ?? []) as CallRow[];
  const recent = calls.slice(0, DRILL_LIMIT);

  let insights: InsightRow[] = [];
  if (recent.length) {
    const { data: insightRows, error: iErr } = await sb
      .from("call_quality_insights")
      .select(
        "hubspot_call_id,quality_score,discovery_quality,objection_handling,next_step_clarity," +
        "talk_control,crm_hygiene,coachable_moments,quote_examples,recommended_next_action",
      )
      .in("hubspot_call_id", recent.map((c) => c.hubspot_call_id));
    if (iErr) console.error("[callquality] insights fetch failed:", iErr.message);
    else insights = (insightRows ?? []) as InsightRow[];
  }

  return { dims: aggregateDims(calls), calls: joinCallInsights(recent, insights) };
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc --noEmit
git add lib/callquality/fetch.ts
git commit -m "feat: server-side call-quality fetchers (graceful on missing env)"
```

---

### Task 4: Auth — middleware, login, callback, logout

**Files:**
- Create: `middleware.ts` (repo root)
- Create: `app/login/page.tsx`
- Create: `app/auth/callback/route.ts`

- [ ] **Step 1: Create `middleware.ts`**

```ts
/**
 * Auth gate: every route requires a Supabase session except /login, /auth/*,
 * and static assets. Also refreshes the session cookie on each request.
 * If Supabase env is missing entirely (e.g. fresh clone), requests pass through
 * so local dev without auth config still works.
 */
import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/auth"];

export async function middleware(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next(); // unconfigured → no gate (dev fallback)

  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (all) => {
        all.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        all.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  const path = req.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const login = req.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return NextResponse.redirect(login);
  }
  if (user && path === "/login") {
    const home = req.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }
  return res;
}

export const config = {
  // Everything except Next internals and common static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp)$).*)"],
};
```

- [ ] **Step 2: Create `app/login/page.tsx`**

```tsx
"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "../../lib/supabase/client";

function LoginInner() {
  const [busy, setBusy] = useState(false);
  const params = useSearchParams();
  const error = params.get("error");

  async function signIn() {
    setBusy(true);
    const supabase = supabaseBrowser();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { hd: "spyne.ai", prompt: "select_account" },
      },
    });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 bg-clip-text text-2xl font-black tracking-tight text-transparent">
          SDR Outreach Coverage
        </h1>
        <p className="mt-2 text-sm text-slate-500">Sign in with your Spyne account to continue.</p>
        {error === "domain" && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
            Access is limited to @spyne.ai accounts.
          </p>
        )}
        {error === "auth" && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
            Sign-in failed. Try again.
          </p>
        )}
        <button
          onClick={signIn}
          disabled={busy}
          className="mt-6 w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-95 disabled:opacity-60"
        >
          {busy ? "Redirecting…" : "Continue with Google"}
        </button>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
```

- [ ] **Step 3: Create `app/auth/callback/route.ts`** (code exchange + domain enforcement)

```ts
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const origin = req.nextUrl.origin;
  if (!code) return NextResponse.redirect(`${origin}/login?error=auth`);

  const res = NextResponse.redirect(`${origin}/`);
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (all) => all.forEach(({ name, value, options }) => res.cookies.set(name, value, options)),
      },
    },
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=auth`);

  // Belt-and-braces: the hd hint is client-side only — enforce the domain here.
  const email = data.user?.email ?? "";
  if (!email.toLowerCase().endsWith("@spyne.ai")) {
    await supabase.auth.signOut();
    const reject = NextResponse.redirect(`${origin}/login?error=domain`);
    // signOut clears cookies on `res`; copy them onto the reject response.
    res.cookies.getAll().forEach((c) => reject.cookies.set(c.name, c.value));
    return reject;
  }
  return res;
}
```

- [ ] **Step 4: Build check + commit**

```bash
npm run build
git add middleware.ts app/login app/auth
git commit -m "feat: auth gate — middleware, Google login, callback with spyne.ai enforcement"
```

Expected: build green. (Middleware behavior verified end-to-end in Task 8.)

---

### Task 5: Page wiring + Call-Quality column + drawer state

**Files:**
- Modify: `app/page.tsx`
- Modify: `components/Dashboard.tsx`

- [ ] **Step 1: Update `app/page.tsx`** — fetch coaching alongside snapshot

```tsx
import { getSnapshot } from "../lib/snapshot";
import { getCoachingByRep } from "../lib/callquality/fetch";
import Dashboard from "../components/Dashboard";

// Always read the latest snapshot at request time (Blob or committed file).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const [snapshot, coaching] = await Promise.all([getSnapshot(), getCoachingByRep()]);
  return <Dashboard snapshot={snapshot} coaching={coaching} />;
}
```

- [ ] **Step 2: `components/Dashboard.tsx` — props, state, and sort**

Change the component signature and replace the `expanded` state with drawer state:

```tsx
import { CoachingSnapshot } from "../lib/callquality/types";
// (keep existing imports)

export default function Dashboard({ snapshot, coaching }: { snapshot: Snapshot; coaching: Record<string, CoachingSnapshot> }) {
  const [period, setPeriod] = useState<PeriodKey>("this_week");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("touches");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [drawerRep, setDrawerRep] = useState<string | null>(null); // was: expanded
```

Extend `SortKey` and the sort value map:

```tsx
type SortKey = "name" | "quality" | "callq" | "touches" | "contacts" | "companies" | "coverage" | "connect" | "reply" | "meetings" | "hot";
```

In the `val()` map inside `rows` useMemo add:

```tsx
      callq: coaching[r.ownerId]?.avgBantic ?? -1,
```

(and add `coaching` to that useMemo's dependency array).

- [ ] **Step 3: Table header + row cell**

Add a header cell after Quality:

```tsx
              <Th onClick={() => toggleSort("callq")} a={sortKey === "callq"} d={sortDir}>Call Q</Th>
```

Update the table `min-w` from `min-w-[1080px]` to `min-w-[1160px]`.

In `RepRow`, change the signature and add the cell after the Quality badge cell — and remove the expansion row entirely:

```tsx
function RepRow({ row, coach, onOpen }: { row: Row; coach?: CoachingSnapshot; onOpen: () => void }) {
  const m = row.m;
  const dim = row.touches === 0;
  return (
    <tr onClick={onOpen} className={`cursor-pointer border-b border-slate-100 transition hover:bg-blue-50/50 ${dim ? "opacity-50" : ""}`}>
      <td className="px-3 py-2.5 font-semibold text-slate-800">{row.name}</td>
      <td className="px-3 py-2.5"><GradeBadge grade={m.quality.grade} score={m.quality.score} /></td>
      <td className="px-3 py-2.5">
        {coach?.avgBantic != null
          ? <span className="rounded-lg bg-indigo-50 px-2 py-0.5 text-xs font-bold tabular-nums text-indigo-700 ring-1 ring-indigo-200">{coach.avgBantic.toFixed(1)}<span className="font-medium opacity-60">/10</span></span>
          : <span className="text-xs text-slate-300">—</span>}
      </td>
      {/* ...existing Touches / Contacts / Cos / Coverage / Connect / Reply / 🎯 / 🔥 cells unchanged... */}
    </tr>
  );
}
```

Update `<tbody>` to pass the new props (and drop `isOpen`/`onToggle`/`period` from RepRow):

```tsx
            {rows.map((r) => (
              <RepRow key={r.ownerId} row={r} coach={coaching[r.ownerId]} onOpen={() => setDrawerRep(r.ownerId)} />
            ))}
```

The old `{isOpen && <tr>…<Scorecard/>…}` row is deleted; `colSpan` bumps from 10 to 11 anywhere it remains. Keep the `Scorecard` component — the drawer reuses it (Task 6).

- [ ] **Step 4: Render the drawer + CSV/header tweaks**

At the bottom of the returned JSX in `Dashboard` (after the footer `<p>`), render:

```tsx
      {drawerRep && (() => {
        const r = allRows.find((x) => x.ownerId === drawerRep);
        return r ? (
          <RepDrawer
            row={r}
            period={period}
            coach={coaching[drawerRep]}
            onClose={() => setDrawerRep(null)}
          />
        ) : null;
      })()}
```

Add the import (component built in Task 6):

```tsx
import RepDrawer from "./RepDrawer";
```

Add `CallQ` to the CSV export: header gains `"CallQ"` after `"Grade"`, and each line gains `coaching[r.ownerId]?.avgBantic ?? ""` in the matching position.

- [ ] **Step 5: Typecheck (expect one known failure)**

```bash
npx tsc --noEmit
```

Expected: only "Cannot find module './RepDrawer'" — resolved by Task 6. Do NOT commit yet; Tasks 5+6 commit together.

---

### Task 6: RepDrawer + CallQualityCard + CallsDrilldown

**Files:**
- Create: `components/RepDrawer.tsx`
- Create: `components/CallQualityCard.tsx`
- Create: `components/CallsDrilldown.tsx`
- Create: `app/api/rep/[ownerId]/calls/route.ts`
- Modify: `components/Dashboard.tsx` (export shared bits)

- [ ] **Step 1: Export reusable pieces from `Dashboard.tsx`**

The drawer reuses the existing cards. Export them (change `function X` → `export function X`) for: `Scorecard`, `GradeBadge`. `Scorecard` keeps its current signature `{ data, m, period, name }`.

Inside `Scorecard`, add the two new call-quality blocks (props threaded from the drawer):

```tsx
export function Scorecard({ data, m, period, name, coach, ownerId }: { data: RepData; m: PeriodMetrics; period: PeriodKey; name: string; coach?: CoachingSnapshot; ownerId: string }) {
  return (
    <div className="space-y-5">
      <InsightChips insights={m.insights} />
      <KpiStrip m={m} />
      <div className="grid gap-5 lg:grid-cols-2">
        <CoverageCard book={data.book} />
        <TempCard m={m} />
      </div>
      <CallQualityCard coach={coach} ownerId={ownerId} />
      <div className="grid gap-5 lg:grid-cols-3">
        <ReachCard m={m} />
        <QualityCard m={m} />
        <EmailCard m={m} />
      </div>
      <DailyChart daily={data.daily} name={name} />
      <div className="grid gap-5 lg:grid-cols-2">
        <DispositionCard m={m} />
        <CompaniesCard m={m} period={period} book={data.book} />
      </div>
    </div>
  );
}
```

Add imports at the top of `Dashboard.tsx`:

```tsx
import CallQualityCard from "./CallQualityCard";
```

- [ ] **Step 2: Create `components/RepDrawer.tsx`**

```tsx
"use client";

/**
 * Slide-over rep detail: right panel on desktop (~2/3 width), full-screen sheet
 * on mobile. Own scroll container — the page behind never scrolls or reflows.
 */
import { useEffect } from "react";
import { PeriodKey, PERIOD_LABELS } from "../lib/sync/types";
import { CoachingSnapshot } from "../lib/callquality/types";
import { Scorecard, GradeBadge, Row } from "./Dashboard";

export default function RepDrawer({ row, period, coach, onClose }: {
  row: Row; period: PeriodKey; coach?: CoachingSnapshot; onClose: () => void;
}) {
  // ESC to close + lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full flex-col bg-slate-50 shadow-2xl sm:w-[min(66vw,1100px)] sm:min-w-[640px]">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="truncate text-lg font-black text-slate-900">{row.name}</h2>
            <GradeBadge grade={row.m.quality.grade} score={row.m.quality.score} />
            <span className="hidden rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500 sm:inline">{PERIOD_LABELS[period]}</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">✕</button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <Scorecard data={row.data} m={row.m} period={period} name={row.name} coach={coach} ownerId={row.ownerId} />
        </div>
      </aside>
    </div>
  );
}
```

Also export the `Row` interface from `Dashboard.tsx` (`export interface Row { … }`).

- [ ] **Step 3: Create `app/api/rep/[ownerId]/calls/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { REPS } from "../../../../../config/reps";
import { getRepCalls } from "../../../../../lib/callquality/fetch";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { ownerId: string } }) {
  // Only tracked reps are queryable (middleware already enforces auth).
  if (!(params.ownerId in REPS)) {
    return NextResponse.json({ error: "unknown rep" }, { status: 404 });
  }
  const payload = await getRepCalls(params.ownerId);
  return NextResponse.json(payload);
}
```

- [ ] **Step 4: Create `components/CallQualityCard.tsx`**

```tsx
"use client";

/**
 * BANTIC scorecard + coaching. Snapshot data (avg, weakest dim, coaching lists)
 * arrives via props from the page load; the 6 dim averages + drill-down calls
 * load lazily from /api/rep/[id]/calls when the drawer opens.
 */
import { useEffect, useState } from "react";
import { BANTIC_DIMS, CoachingSnapshot, RepCallsPayload } from "../lib/callquality/types";
import CallsDrilldown from "./CallsDrilldown";

const DIM_LABEL: Record<(typeof BANTIC_DIMS)[number], string> = {
  budget: "Budget", authority: "Authority", need: "Need",
  timeline: "Timeline", impact: "Impact", current_process: "Current process",
};

const fmt1 = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(1));

export default function CallQualityCard({ coach, ownerId }: { coach?: CoachingSnapshot; ownerId: string }) {
  const [payload, setPayload] = useState<RepCallsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/rep/${ownerId}/calls`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => live && setPayload(d))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [ownerId]);

  const noData = !coach && failed;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Call quality (BANTIC · connected calls)</h3>
        {coach?.avgBantic != null && (
          <span className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-2.5 py-1 text-sm font-black text-white">
            {coach.avgBantic.toFixed(1)}<span className="text-xs font-medium opacity-80">/10 avg</span>
          </span>
        )}
      </div>

      {noData ? (
        <p className="text-sm text-slate-400">Call data unavailable.</p>
      ) : !coach && !payload ? (
        <p className="text-sm text-slate-400">Loading call quality…</p>
      ) : (
        <div className="space-y-4">
          {payload && payload.dims.count > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <span>BANTIC dimensions (last 90 days · {payload.dims.count} calls)</span>
                {coach?.weakestDimension && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-600 ring-1 ring-rose-200">weakest: {coach.weakestDimension}</span>}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {BANTIC_DIMS.map((d) => {
                  const v = payload.dims.dims[d];
                  return (
                    <div key={d} className="text-xs">
                      <div className="flex justify-between"><span className="text-slate-600">{DIM_LABEL[d]}</span><span className="tabular-nums text-slate-500">{fmt1(v)}</span></div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${((v ?? 0) / 10) * 100}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {coach && (
            <div className="grid gap-3 sm:grid-cols-3">
              <CoachList title="Strengths" tone="good" items={coach.strengths} />
              <CoachList title="Risks" tone="warn" items={coach.risks} />
              <CoachList title="Coaching priorities" tone="info" items={coach.priorities} />
            </div>
          )}
          {coach?.managerSummary && (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs italic text-slate-600 ring-1 ring-slate-100">{coach.managerSummary}</p>
          )}

          <CallsDrilldown payload={payload} failed={failed} />
        </div>
      )}
    </div>
  );
}

function CoachList({ title, tone, items }: { title: string; tone: "good" | "warn" | "info"; items: string[] }) {
  if (!items.length) return null;
  const chip = tone === "good" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : tone === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-blue-50 text-blue-700 ring-blue-200";
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <ul className="space-y-1">
        {items.slice(0, 4).map((t, i) => <li key={i} className={`rounded-lg px-2 py-1 text-xs ring-1 ${chip}`}>{t}</li>)}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Create `components/CallsDrilldown.tsx`**

```tsx
"use client";

/** Recent analyzed connected calls with expandable BANTIC + coaching detail. */
import { useState } from "react";
import { BANTIC_DIMS, RepCallsPayload } from "../lib/callquality/types";
import { companyUrl } from "../config/hubspot";

const fmt1 = (n: number | null) => (n == null ? "—" : n.toFixed(1));

function etDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return iso; }
}

const mins = (ms: number | null) => (ms == null ? "—" : `${Math.round(ms / 60000)}m`);

export default function CallsDrilldown({ payload, failed }: { payload: RepCallsPayload | null; failed: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (failed) return <p className="text-sm text-slate-400">Recent calls unavailable.</p>;
  if (!payload) return <p className="text-sm text-slate-400">Loading recent calls…</p>;
  if (!payload.calls.length) return <p className="text-sm text-slate-400">No analyzed connected calls in the last 90 days.</p>;

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Recent analyzed calls ({payload.calls.length})</div>
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {payload.calls.map((c) => {
          const isOpen = open === c.callId;
          return (
            <div key={c.callId} className="rounded-xl border border-slate-100">
              <button onClick={() => setOpen(isOpen ? null : c.callId)} className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-slate-400">{isOpen ? "▾" : "▸"}</span>
                  <span className="shrink-0 rounded-lg bg-indigo-50 px-1.5 py-0.5 text-xs font-bold tabular-nums text-indigo-700">{fmt1(c.overall)}</span>
                  <span className="truncate text-xs text-slate-600">{etDate(c.date)} · {c.disposition ?? "—"} · {mins(c.durationMs)}</span>
                </span>
                {c.quality != null && <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">rubric {fmt1(c.quality)}/5</span>}
              </button>
              {isOpen && (
                <div className="space-y-2 border-t border-slate-100 px-3 py-2 text-xs">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {BANTIC_DIMS.map((d) => (
                      <span key={d} className="tabular-nums text-slate-500">{d.replace("_", " ")}: <b className="text-slate-700">{fmt1(c.dims[d])}</b></span>
                    ))}
                  </div>
                  {c.coachableMoments.length > 0 && (
                    <ul className="space-y-1">{c.coachableMoments.slice(0, 3).map((m, i) => <li key={i} className="rounded-lg bg-amber-50 px-2 py-1 text-amber-800 ring-1 ring-amber-200">💡 {m}</li>)}</ul>
                  )}
                  {c.quotes.length > 0 && <p className="italic text-slate-500">“{c.quotes[0]}”</p>}
                  {c.nextAction && <p className="text-slate-600">→ <b>Next:</b> {c.nextAction}</p>}
                  <div className="flex gap-3 pt-1">
                    {c.recordingUrl && <a href={c.recordingUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">▶ Recording</a>}
                    {c.companyId && <a href={companyUrl(c.companyId)} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Company ↗</a>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Full check + run all tests + commit**

```bash
npx tsc --noEmit && npx vitest run && npm run build
git add components app/api app/page.tsx
git commit -m "feat: rep slide-over drawer with BANTIC scorecard + calls drill-down; Call Q column"
```

Expected: tsc 0, all tests pass, build green.

---

### Task 7: Header logout + mobile pass

**Files:**
- Create: `components/LogoutButton.tsx`
- Modify: `components/Dashboard.tsx` (header + responsive tweaks)

- [ ] **Step 1: Create `components/LogoutButton.tsx`**

```tsx
"use client";

import { supabaseBrowser } from "../lib/supabase/client";

export default function LogoutButton() {
  async function signOut() {
    await supabaseBrowser().auth.signOut();
    window.location.href = "/login";
  }
  return (
    <button onClick={signOut} className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm hover:bg-slate-100">
      Sign out
    </button>
  );
}
```

- [ ] **Step 2: Wire into the Dashboard header + condense on mobile**

In `Dashboard.tsx` header (the `<header>` block): import and render `<LogoutButton />` inside the right-side `<div className="text-right …">`, above the "Refreshed" line; change the `<h1>` classes `text-3xl` → `text-2xl sm:text-3xl`; and on the subtitle `<p>` add `hidden sm:block`.

```tsx
import LogoutButton from "./LogoutButton";
// header right side becomes:
        <div className="flex flex-col items-end gap-1 text-right text-xs text-slate-500">
          <LogoutButton />
          <div>Refreshed <span className="font-semibold text-blue-600">{etStamp(snapshot.generated_at_utc)}</span></div>
          <div>{snapshot.window.start_et || "—"} → {snapshot.window.end_et || "—"} · {fmt(snapshot.totals.calls)} calls + {fmt(snapshot.totals.emails)} emails</div>
        </div>
```

- [ ] **Step 3: Mobile audit of the main page**

Verify (and fix if needed) at 375px width:
- Period selector: parent already `flex-wrap` — confirm buttons wrap, no horizontal overflow.
- KPI cards: grid is `grid-cols-2 sm:grid-cols-3 lg:grid-cols-6` — already stacks; no change.
- Table: wrapped in `.scroll-x` — horizontal scroll retained; no change.
- Drawer: full-screen at `<sm` (Task 6 classes `w-full sm:w-[min(66vw,1100px)]`).

Run dev and check with browser devtools mobile viewport:

```bash
npm run dev
```

Expected: no horizontal page overflow at 375px except inside `.scroll-x`.

- [ ] **Step 4: Commit**

```bash
git add components/LogoutButton.tsx components/Dashboard.tsx
git commit -m "feat: logout button + mobile header/layout pass"
```

---

### Task 8: End-to-end verification + deploy

**Files:** none (verification, env config, merge)

- [ ] **Step 1: Manual Supabase/Google setup (user does this once)**

1. Google Cloud Console → OAuth client (Web): authorized redirect URI = `https://<supabase-project-ref>.supabase.co/auth/v1/callback`. If the GCP app can be **Internal** (Workspace), that hard-restricts to spyne.ai at Google's side.
2. Supabase dashboard (call-scoring project) → Authentication → Providers → Google: paste client ID/secret, enable.
3. Supabase → Authentication → URL Configuration: Site URL = `https://sdr-outreach-dashboard.vercel.app`; add `http://localhost:3000` to additional redirect URLs.
4. Vercel project → Settings → Environment Variables: add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 2: Local smoke test**

```bash
npm run build && PORT=3944 npx next start &
sleep 5
curl -s -o /dev/null -w "unauthenticated → %{http_code} %{redirect_url}\n" http://localhost:3944/
```

Expected: `307` (or `302`) redirecting to `/login`. Then in a real browser: sign in with a spyne.ai account → dashboard renders; Call Q column populated (or "—" if no snapshots); open a rep → drawer slides in, BANTIC dims + recent calls load; ESC closes; non-spyne Google account → bounced to `/login?error=domain`.

- [ ] **Step 3: Degradation check**

Temporarily comment out the three Supabase vars in `.env.local`, restart dev:
Expected: no login gate (dev fallback), dashboard renders, Call Q column shows "—", drawer call-quality card shows "Call data unavailable." Restore vars after.

- [ ] **Step 4: Run everything, merge, push**

```bash
npx vitest run && npm run build
git checkout main && git merge --no-ff phase1-auth-callquality -m "Phase 1: login gate + call-quality merge + rep drawer"
git push origin main
```

Expected: tests green, build green, Vercel deploys. Verify production: unauthenticated visit redirects to login; spyne.ai sign-in works end-to-end.

---

## Self-review notes

- Spec coverage: auth gate (T4, T8), spyne.ai enforcement (T4 S3), call-quality reads server-side w/ service key (T1, T3), BANTIC scorecard + coaching (T6 S4), call drill-down (T6 S5), Call Q table column (T5), drawer container + mobile sheet (T6 S2), main-page mobile pass (T7), graceful degradation (T1 S1, T3, T6, T8 S3), tests (T2), call-scoring untouched (read-only queries only). Out-of-scope items from spec not implemented — correct.
- Types used in later tasks (`CoachingSnapshot`, `RepCallsPayload`, `BANTIC_DIMS`, `Row`) are all defined in T2/T5-6 exports.

## Amendment (2026-07-06, mid-execution)

Scope reshape after Batch B: Tasks 5–6 are superseded by:
- **Task 5′ (sync-side GD book units):** extend `lib/sync/types.ts` (`RooftopDetail`, `BookUnitDetail`,
  `BookCoverage.units`), accumulate per-rooftop cumulative stats + per-contact touches (owner-scoped,
  anchored) in `lib/sync/aggregate.ts`, top-5 contacts per rooftop, cumulative rooftop temperature;
  extend `tests/aggregate.test.ts`.
- **Task 6′ (UI):** `RepDrawer` centerpiece = `GdExplorer` (units → rooftops → contacts → activities);
  `CallQualityCard` + `CallsDrilldown` kept as secondary card below; Call Q column + API route unchanged.
Batches: C = Task 4 (auth, unchanged) → D = 5′+6′ → E = Task 7 (unchanged) → final review → Task 8 (+ re-sync).
