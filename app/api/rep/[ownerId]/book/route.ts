import { NextRequest, NextResponse } from "next/server";
import { REPS } from "../../../../../config/reps";
import { getSnapshot } from "../../../../../lib/snapshot";

export const dynamic = "force-dynamic";

/** One rep's GD/Single units with rooftop drill-down (lazy-loaded by the drawer). */
export async function GET(_req: NextRequest, { params }: { params: { ownerId: string } }) {
  if (!(params.ownerId in REPS)) {
    return NextResponse.json({ error: "unknown rep" }, { status: 404 });
  }
  const snapshot = await getSnapshot();
  const units = snapshot.reps[params.ownerId]?.book.units ?? [];
  return NextResponse.json({ units });
}
