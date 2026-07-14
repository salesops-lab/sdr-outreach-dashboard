// Run via `npm run embed:content` — the npm script passes `tsx --conditions=react-server` so the
// `server-only` guards resolve to their no-op exports. Indexes new sdr_activity_content rows into
// sdr_embeddings (pgvector). Idempotent — only rows without a vector are embedded.
// Needs OPENAI_API_KEY + the pgvector migration (sdr_embeddings + sdr_search_content).
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { indexNewContent } from "../lib/agent/embeddings";

const limit = process.env.EMBED_LIMIT ? Number(process.env.EMBED_LIMIT) : undefined;

indexNewContent({ limit }).then((r) => {
  if (r.skipped) process.exit(0);
  process.exit(r.errors > 0 && r.indexed === 0 ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
