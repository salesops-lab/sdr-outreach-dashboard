/**
 * Hot-account agent pass. Reads the spine + call-scoring tables, produces grounded next-step
 * verdicts for hot accounts, and persists them to sdr_agent_watches/notes. HubSpot read-only.
 * Needs OPENAI_API_KEY (+ optional OPENAI_MODEL) and SUPABASE_SERVICE_ROLE_KEY in the env.
 * Run: npm run agent:run
 */
import "dotenv/config";
import { runAgent } from "../lib/agent/runner";

runAgent()
  .then((r) => {
    console.log("[agent] run complete:", r);
    process.exit(0);
  })
  .catch((e) => {
    console.error("[agent] run failed:", e);
    process.exit(1);
  });
