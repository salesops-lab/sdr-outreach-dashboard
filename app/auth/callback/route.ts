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
