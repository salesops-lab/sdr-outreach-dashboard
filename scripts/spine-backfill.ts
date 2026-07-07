// Run via `npm run sync:backfill` — the npm script passes `tsx --conditions=react-server` so the `server-only` guard in lib/supabase/admin.ts resolves to its no-op export.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runBackfill, preflightCaps } from "../lib/spine/runner";

(async () => {
  // 403-only preflight (transient errors rethrow) — same semantics as scripts/sync.ts.
  const caps = await preflightCaps();
  if (!caps.calls && !caps.emails) throw new Error("token can read neither calls nor emails");
  await runBackfill(caps);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
