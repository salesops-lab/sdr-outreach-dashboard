import { Flame } from "lucide-react";
import { listWatches } from "../../lib/agent/store";
import AttentionBoard from "../../components/AttentionBoard";
import LogoutButton from "../../components/LogoutButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AttentionPage() {
  const watches = await listWatches();
  return (
    <main className="mx-auto max-w-[1100px] px-4 py-7 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-hot text-white shadow-card">
            <Flame className="h-5 w-5" strokeWidth={2.4} />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">Needs attention</h1>
            <p className="mt-0.5 text-sm text-ink-muted">Hot accounts the agent is tracking, with a recommended next step. Read-only on HubSpot.</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <a href="/" className="font-semibold text-primary hover:underline">← Dashboard</a>
          <LogoutButton />
        </div>
      </header>
      <AttentionBoard watches={watches} />
    </main>
  );
}
