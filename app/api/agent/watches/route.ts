import { NextResponse } from "next/server";
import { listWatches } from "../../../../lib/agent/store";
import { resolveViewer } from "../../../../lib/access/resolve";
import { supabaseServer } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

/** Hot-account agent watches filtered by viewer's RBAC scope. */
export async function GET() {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const [watches, viewer] = await Promise.all([
    listWatches(),
    resolveViewer(user?.email ?? ""),
  ]);

  // Filter watches by viewer's scope (RBAC)
  const scopeSet = new Set(viewer.defaultOwnerIds);
  const filteredWatches = watches.filter(w => scopeSet.has(w.repId ?? ""));

  return NextResponse.json({ watches: filteredWatches });
}
