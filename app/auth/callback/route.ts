import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isAllowedEmail } from "../../../lib/auth/domain";

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

  // Belt-and-braces: middleware is the authoritative domain gate; this check
  // stops non-spyne sessions at mint time. signOut() cannot clear cookies that
  // weren't in the REQUEST, so explicitly expire everything set on `res`.
  if (!isAllowedEmail(data.user?.email)) {
    await supabase.auth.signOut();
    const reject = NextResponse.redirect(`${origin}/login?error=domain`);
    res.cookies.getAll().forEach((c) =>
      reject.cookies.set(c.name, "", { maxAge: 0, expires: new Date(0), path: "/" }),
    );
    return reject;
  }
  return res;
}
