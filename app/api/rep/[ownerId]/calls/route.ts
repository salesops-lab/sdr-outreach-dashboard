import { NextRequest, NextResponse } from "next/server";
import { REPS } from "../../../../../config/reps";
import { getRepCalls } from "../../../../../lib/callquality/fetch";

export const dynamic = "force-dynamic";

/** Recent analyzed calls + BANTIC dim averages for one rep (lazy-loaded by the drawer). */
export async function GET(_req: NextRequest, { params }: { params: { ownerId: string } }) {
  if (!(params.ownerId in REPS)) {
    return NextResponse.json({ error: "unknown rep" }, { status: 404 });
  }
  const payload = await getRepCalls(params.ownerId);
  return NextResponse.json(payload);
}
