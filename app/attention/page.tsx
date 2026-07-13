import { Sparkles } from "lucide-react";
import { listWatches } from "../../lib/agent/store";
import { listBriefs } from "../../lib/agent/briefs";
import { resolveViewer } from "../../lib/access/resolve";
import { loadTeamStructure } from "../../lib/team/load";
import { nameMap } from "../../lib/team/helpers";
import { supabaseServer } from "../../lib/supabase/server";
import AttentionBoardEnhanced from "../../components/AttentionBoardEnhanced";
import AppNav from "../../components/AppNav";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function IntelligencePage() {
  const { data: { user } } = await supabaseServer().auth.getUser().catch(() => ({ data: { user: null } }));
  const [watches, briefs, viewer, ts] = await Promise.all([
    listWatches(),
    listBriefs(),
    resolveViewer(user?.email ?? ""),
    loadTeamStructure(),
  ]);

  // Filter watches by viewer's scope (RBAC focus model)
  const scopeSet = new Set(viewer.defaultOwnerIds);
  const filteredWatches = watches.filter(w => scopeSet.has(w.repId ?? ""));

  return (
    <>
      <AppNav active="attention" viewer={viewer} />
      <main className="mx-auto max-w-[1500px] px-4 py-7 sm:px-6">
        <header className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-fg shadow-card">
            <Sparkles className="h-5 w-5" strokeWidth={2.4} />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">Intelligence</h1>
            <p className="mt-0.5 text-sm text-ink-muted">
              The agent&rsquo;s watchlist with grounded account briefs — every claim cites its activity evidence. Read-only on HubSpot.
            </p>
          </div>
        </header>
        <AttentionBoardEnhanced watches={filteredWatches} names={nameMap(ts)} briefs={briefs} />
      </main>
    </>
  );
}
