/**
 * Targeted full-history pull for a single owner id — triggered when an admin adds a new user
 * (a delta only catches recently-modified rows, so a brand-new owner needs their history pulled).
 * Runs on GitHub Actions (spine-pull-owner.yml) so it stays off Vercel's serverless limits.
 *
 * Run:  OWNER_ID=12345 npm run pull:owner   (or: npm run pull:owner -- 12345)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { runOwnerBackfill } from "../lib/spine/runner";

async function main() {
  const ownerId = (process.env.OWNER_ID || process.argv[2] || "").trim();
  if (!ownerId) throw new Error("OWNER_ID is required (env OWNER_ID or first CLI arg).");
  if (!/^\d+$/.test(ownerId)) throw new Error(`OWNER_ID must be numeric HubSpot owner id, got "${ownerId}".`);
  await runOwnerBackfill(ownerId);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
