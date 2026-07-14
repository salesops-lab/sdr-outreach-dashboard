/**
 * OPT-IN content ingestion for the hot-account agent. Batch-reads call content
 * (hs_call_body / hs_call_summary / nooks_transcript / hs_call_title) and email subjects from
 * HubSpot for recent spine activities, and upserts them into sdr_activity_content.
 *
 * Kept SEPARATE from the 15-min delta so the production sync path stays lean and untouched.
 * Run manually (or on its own cron) once the sdr_activity_content table exists:
 *   npm run content:backfill
 * Needs HUBSPOT_PAT + SUPABASE_SERVICE_ROLE_KEY (+ NEXT_PUBLIC_SUPABASE_URL) in the env.
 */
// Load .env.local first (local secrets), then .env — same order as the other spine scripts.
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { hubspotPost, delay, RATE_LIMIT_DELAY_MS } from "../lib/hubspot/client";
import { supabaseAdmin } from "../lib/supabase/admin";

const BATCH = 100;
const LOOKBACK_MS = 90 * 86_400_000; // content for the last ~90 days of activity
const CALL_PROPS = ["hs_call_title", "hs_call_body", "hs_call_summary", "nooks_transcript", "transcript"];
const EMAIL_PROPS = ["hs_email_subject", "hs_email_text"]; // subject + full plain-text body

interface BatchRead {
  results?: { id: string; properties: Record<string, string | null> }[];
}

async function backfill(type: "call" | "email", object: "calls" | "emails", props: string[]) {
  const db = supabaseAdmin();
  if (!db) throw new Error("Supabase service role not configured");
  const sinceMs = Date.now() - LOOKBACK_MS;
  // Timestamp-keyset id read: gte(ts_ms) + order(ts_ms) walks idx_sdr_act_ts and only ever
  // scans the lookback slice (a PK-ordered keyset had to filter the WHOLE table and timed out
  // under concurrent load). Boundary re-reads are deduped via the Set; pages retry on
  // transient timeouts.
  const seen = new Set<string>();
  let cursorTs = sinceMs;
  for (;;) {
    let page: { hs_id: string; ts_ms: number }[] | null = null;
    let lastErr = "";
    for (let attempt = 1; attempt <= 4 && page == null; attempt++) {
      const { data, error } = await db.from("sdr_activities").select("hs_id,ts_ms")
        .eq("type", type).gte("ts_ms", cursorTs).order("ts_ms").limit(1000);
      if (!error) { page = (data ?? []) as { hs_id: string; ts_ms: number }[]; break; }
      lastErr = error.message;
      await delay(1500 * attempt);
    }
    if (page == null) throw new Error(`load ${type} ids: ${lastErr}`);
    let added = 0;
    for (const a of page) { if (!seen.has(a.hs_id)) { seen.add(a.hs_id); added++; } }
    if (page.length < 1000) break;
    const lastTs = Number(page[page.length - 1].ts_ms);
    cursorTs = added === 0 && lastTs === cursorTs ? lastTs + 1 : lastTs;
  }
  const ids = [...seen];
  console.log(`[content] ${type}: ${ids.length} activities to read`);

  let upserted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const res = await hubspotPost<BatchRead>(`/crm/v3/objects/${object}/batch/read`, {
      properties: props,
      inputs: chunk.map((id) => ({ id })),
    });
    const now = new Date().toISOString();
    const rows = (res.results ?? [])
      .map((r) => ({
        hs_id: r.id,
        type,
        call_title: r.properties.hs_call_title ?? null,
        call_body: r.properties.hs_call_body ?? null,
        call_summary: r.properties.hs_call_summary ?? null,
        transcript: r.properties.nooks_transcript || r.properties.transcript || null,
        email_subject: r.properties.hs_email_subject ?? null,
        email_body: r.properties.hs_email_text ?? null,
        updated_at: now,
      }))
      .filter((r) => r.call_title || r.call_body || r.call_summary || r.transcript || r.email_subject || r.email_body);
    if (rows.length) {
      // Retried upsert — a single transient network blip used to kill the whole run.
      let lastErr = "";
      let wrote = false;
      for (let attempt = 1; attempt <= 4 && !wrote; attempt++) {
        try {
          const { error: upErr } = await db.from("sdr_activity_content").upsert(rows, { onConflict: "hs_id" });
          if (!upErr) { wrote = true; break; }
          lastErr = upErr.message;
        } catch (e) {
          lastErr = (e as Error).message;
        }
        await delay(1000 * attempt);
      }
      if (!wrote) throw new Error(`upsert ${type}: ${lastErr}`);
      upserted += rows.length;
    }
    console.log(`[content] ${type} ${Math.min(i + BATCH, ids.length)}/${ids.length} (upserted ${upserted})`);
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return upserted;
}

async function main() {
  // CONTENT_TYPES=email (or call) limits the run to one object type — used for targeted re-pulls.
  const types = (process.env.CONTENT_TYPES ?? "call,email").split(",").map((t) => t.trim());
  const calls = types.includes("call") ? await backfill("call", "calls", CALL_PROPS) : 0;
  const emails = types.includes("email") ? await backfill("email", "emails", EMAIL_PROPS) : 0;
  console.log(`[content] done — ${calls} call rows, ${emails} email rows`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[content] failed:", e); process.exit(1); });
