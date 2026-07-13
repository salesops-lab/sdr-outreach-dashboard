// Run via `npm run sync:reconcile` — the npm script passes `tsx --conditions=react-server` so the `server-only` guard in lib/supabase/admin.ts resolves to its no-op export.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runReconcile } from "../lib/spine/runner";

// The advisory lock is usually held by a ~15-min delta heartbeat run, so a single attempt
// frequently no-ops (observed: "successful" 30s reconciles that did nothing). Retry until the
// lock frees — the reconcile MUST actually run once per invocation.
const MAX_ATTEMPTS = 15;
const RETRY_DELAY_MS = 120_000; // 2 min between attempts (≤ ~30 min total)

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { ran } = await runReconcile();
    if (ran) return;
    console.log(`[reconcile] lock held (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${RETRY_DELAY_MS / 1000}s…`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  throw new Error(`[reconcile] could not acquire the sync lock after ${MAX_ATTEMPTS} attempts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
