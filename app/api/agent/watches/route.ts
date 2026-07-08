import { NextResponse } from "next/server";
import { listWatches } from "../../../../lib/agent/store";

export const dynamic = "force-dynamic";

/** All hot-account agent watches (auth-gated by middleware). */
export async function GET() {
  const watches = await listWatches();
  return NextResponse.json({ watches });
}
