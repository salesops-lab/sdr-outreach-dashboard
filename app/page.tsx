import { getSnapshot, stripBookUnits } from "../lib/snapshot";
import { getCoachingByRep } from "../lib/callquality/fetch";
import { resolveViewer } from "../lib/access/resolve";
import { supabaseServer } from "../lib/supabase/server";
import { loadTeamStructure } from "../lib/team/load";
import { teamFilterOptions } from "../lib/team/helpers";
import Dashboard from "../components/Dashboard";

// Always read the latest snapshot at request time (Postgres spine, then Blob/file).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const [snapshot, coaching, viewer, ts] = await Promise.all([
    getSnapshot(), getCoachingByRep(), resolveViewer(user?.email ?? ""), loadTeamStructure(),
  ]);
  return <Dashboard snapshot={stripBookUnits(snapshot)} coaching={coaching} viewer={viewer} teamFilters={teamFilterOptions(ts)} />;
}
