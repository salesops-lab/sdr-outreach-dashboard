/**
 * Auth gate: every route requires a Supabase session belonging to an
 * @spyne.ai account. Middleware is the single source of truth for BOTH
 * session presence and domain membership (the OAuth callback's check is
 * belt-and-braces only).
 *
 * Env handling: missing Supabase env FAILS CLOSED in production (503) and
 * passes through only in local dev, so a misconfigured deploy can never
 * silently publish the dashboard.
 */
import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { isAllowedEmail } from "./lib/auth/domain";

// "/api/sync/delta" is public because external pingers have no session — the route
// self-authenticates via a CRON_SECRET Bearer check. Any future sync route must be
// added here explicitly (exact path) and must self-authenticate the same way.
const PUBLIC_PATHS = ["/login", "/auth", "/api/sync/delta"];

export async function middleware(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Auth not configured", { status: 503 });
    }
    return NextResponse.next(); // local dev without auth config
  }

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
  const allowed = !!user && isAllowedEmail(user.email);
  const path = req.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!allowed && !isPublic) {
    // API callers get a clean 401 instead of a redirect-to-HTML.
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const login = req.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return NextResponse.redirect(login);
  }
  if (allowed && path === "/login") {
    const home = req.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }
  return res;
}

export const config = {
  // Gate everything except Next internals + favicon. Deliberately NO file-extension
  // exclusions: they could exempt crafted /api/... paths from the gate.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
