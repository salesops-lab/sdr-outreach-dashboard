import { getSnapshot, stripBookUnits } from "../../lib/snapshot";
import { resolveViewer } from "../../lib/access/resolve";
import { supabaseServer } from "../../lib/supabase/server";
import AccountsView from "../../components/Accounts";

// Read the latest snapshot at request time; per-rep book units are fetched lazily client-side.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AccountsPage() {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const [snapshot, viewer] = await Promise.all([getSnapshot(), resolveViewer(user?.email ?? "")]);
  return <AccountsView snapshot={stripBookUnits(snapshot)} viewer={viewer} />;
}
