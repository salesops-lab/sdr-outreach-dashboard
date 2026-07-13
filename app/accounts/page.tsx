import { getSnapshot, stripBookUnits } from "../../lib/snapshot";
import { resolveViewer } from "../../lib/access/resolve";
import { supabaseServer } from "../../lib/supabase/server";
import { loadTeamStructure } from "../../lib/team/load";
import { teamFilterOptions } from "../../lib/team/helpers";
import AccountsView from "../../components/Accounts";

// Read the latest snapshot at request time; per-rep book units are fetched lazily client-side.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AccountsPage() {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const [snapshot, viewer, ts] = await Promise.all([
    getSnapshot(), resolveViewer(user?.email ?? ""), loadTeamStructure(),
  ]);
  return <AccountsView snapshot={stripBookUnits(snapshot)} viewer={viewer} teamFilters={teamFilterOptions(ts)} />;
}
