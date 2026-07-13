// Run via `npm run agent:briefs` — the npm script passes `tsx --conditions=react-server` so the
// `server-only` guards resolve to their no-op exports. Refreshes grounded account briefs for the
// accounts the agent is watching (needs OPENAI_API_KEY).
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runBriefs } from "../lib/agent/briefs";

const limit = process.env.BRIEFS_LIMIT ? Number(process.env.BRIEFS_LIMIT) : undefined;

runBriefs({ limit }).then((r) => {
  if (r.skipped) process.exit(0);
  console.log(`[briefs] done — ${r.generated}/${r.candidates} generated, ${r.errors} errors`);
  process.exit(r.errors > 0 && r.generated === 0 ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
