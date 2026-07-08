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
import "dotenv/config";
import { hubspotPost, delay, RATE_LIMIT_DELAY_MS } from "../lib/hubspot/client";
import { supabaseAdmin } from "../lib/supabase/admin";

const BATCH = 100;
const LOOKBACK_MS = 90 * 86_400_000; // content for the last ~90 days of activity
const CALL_PROPS = ["hs_call_title", "hs_call_body", "hs_call_summary", "nooks_transcript", "transcript"];
const EMAIL_PROPS = ["hs_email_subject"];

interface BatchRead {
  results?: { id: string; properties: Record<string, string | null> }[];
}

async function backfill(type: "call" | "email", object: "calls" | "emails", props: string[]) {
  const db = supabaseAdmin();
  if (!db) throw new Error("Supabase service role not configured");
  const sinceMs = Date.now() - LOOKBACK_MS;
  const { data, error } = await db.from("sdr_activities").select("hs_id").eq("type", type).gte("ts_ms", sinceMs);
  if (error) throw new Error(`load ${type} ids: ${error.message}`);
  const ids = (data ?? []).map((a: { hs_id: string }) => a.hs_id);
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
        updated_at: now,
      }))
      .filter((r) => r.call_title || r.call_body || r.call_summary || r.transcript || r.email_subject);
    if (rows.length) {
      const { error: upErr } = await db.from("sdr_activity_content").upsert(rows, { onConflict: "hs_id" });
      if (upErr) throw new Error(`upsert ${type}: ${upErr.message}`);
      upserted += rows.length;
    }
    console.log(`[content] ${type} ${Math.min(i + BATCH, ids.length)}/${ids.length} (upserted ${upserted})`);
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return upserted;
}

async function main() {
  const calls = await backfill("call", "calls", CALL_PROPS);
  const emails = await backfill("email", "emails", EMAIL_PROPS);
  console.log(`[content] done — ${calls} call rows, ${emails} email rows`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[content] failed:", e); process.exit(1); });
