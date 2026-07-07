import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runDelta } from "../../../../lib/spine/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Constant-time bearer check: sha256-digest both sides (equal length by construction)
 *  and timingSafeEqual the digests. Still 401 when CRON_SECRET is unset. */
function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { ran } = await runDelta();
    return NextResponse.json({ ok: true, skipped: !ran });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
