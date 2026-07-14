/**
 * Embeddings over the activity-content corpus (blueprint §7.1) — semantic recall across an
 * account's WHOLE history, not just the last-25 timeline window. One vector per content-bearing
 * activity (composeChunk decides what earns one), stored in sdr_embeddings (pgvector, 1536-dim
 * text-embedding-3-small). Search goes through the sdr_search_content RPC (cosine); everything
 * degrades gracefully pre-migration (missing table/RPC → empty results, never an error).
 */
import "server-only";
import { supabaseAdmin } from "../supabase/admin";
import { embedTexts, isConfigured } from "./openai";
import { composeChunk, ContentFields } from "./embed-chunks";

const EMBED_BATCH = 96; // texts per embeddings request
const WRITE_BATCH = 8; // rows per DB upsert — HNSW insert cost grows with the graph, and large
// vector writes start tripping statement_timeout once the index has tens of thousands of nodes
const PAGE = 1000;

export interface ContentHit {
  hs_id: string;
  account_id: string | null;
  ts_ms: number | null;
  kind: string | null;
  chunk: string;
  similarity: number;
}

/** Semantic search over indexed content. accountId scopes to one account; null = whole corpus. */
export async function searchAccountContent(query: string, accountId: string | null, limit = 8): Promise<ContentHit[]> {
  const db = supabaseAdmin();
  if (!db || !isConfigured()) return [];
  try {
    const [vec] = await embedTexts([query.slice(0, 500)]);
    const { data, error } = await db.rpc("sdr_search_content", {
      p_query: vec, p_account_id: accountId, p_limit: limit,
    });
    if (error) { console.warn("[embed] search:", error.message); return []; }
    return ((data ?? []) as ContentHit[]).map((h) => ({ ...h, ts_ms: h.ts_ms == null ? null : Number(h.ts_ms) }));
  } catch (e) {
    console.warn("[embed] search failed:", (e as Error).message);
    return [];
  }
}

/** Does this account have ANY indexed content? Gates the tool loop — searching an empty index
 *  just burns model steps (observed: 32 futile retries pre-guard). */
export async function hasIndexedContent(accountId: string): Promise<boolean> {
  const db = supabaseAdmin();
  if (!db) return false;
  const { count, error } = await db.from("sdr_embeddings")
    .select("*", { count: "exact", head: true }).eq("account_id", accountId);
  return !error && (count ?? 0) > 0;
}

export interface IndexRunResult { skipped: boolean; scanned: number; indexed: number; errors: number }

/**
 * Index all content rows that don't have a vector yet. Idempotent — re-runs only touch new rows.
 * ~$0.02/1M tokens on text-embedding-3-small: the full 65k-row corpus costs well under $1.
 */
export async function indexNewContent(opts: { limit?: number } = {}): Promise<IndexRunResult> {
  const db = supabaseAdmin();
  if (!db) return { skipped: true, scanned: 0, indexed: 0, errors: 0 };
  if (!isConfigured()) {
    console.warn("[embed] OPENAI_API_KEY not set — skipping");
    return { skipped: true, scanned: 0, indexed: 0, errors: 0 };
  }
  const cap = opts.limit ?? Number.MAX_SAFE_INTEGER;

  // Already-indexed ids (paged — the set fits comfortably in memory).
  const existing = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("sdr_embeddings").select("hs_id").order("hs_id").range(from, from + PAGE - 1);
    if (error) {
      console.warn(`[embed] sdr_embeddings unavailable (${error.message}) — apply the pgvector migration first`);
      return { skipped: true, scanned: 0, indexed: 0, errors: 0 };
    }
    for (const r of data ?? []) existing.add(String(r.hs_id));
    if (!data || data.length < PAGE) break;
  }

  let scanned = 0, indexed = 0, errors = 0;
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await db.from("sdr_activity_content")
      .select("hs_id,type,call_title,call_body,call_summary,transcript,email_subject")
      .order("hs_id").range(from, from + PAGE - 1);
    if (error) throw new Error(`[embed] read content: ${error.message}`);
    const page = rows ?? [];
    scanned += page.length;

    // New content-bearing rows on this page.
    const fresh: { hs_id: string; chunk: string }[] = [];
    for (const r of page) {
      if (existing.has(String(r.hs_id))) continue;
      const chunk = composeChunk(r as ContentFields);
      if (chunk) fresh.push({ hs_id: String(r.hs_id), chunk });
    }

    if (fresh.length) {
      // Activity meta (account, timestamp, kind) for attribution.
      const meta = new Map<string, { account_id: string | null; ts_ms: number | null; kind: string | null }>();
      for (let i = 0; i < fresh.length; i += 500) {
        const ids = fresh.slice(i, i + 500).map((f) => f.hs_id);
        const { data: acts } = await db.from("sdr_activities").select("hs_id,type,ts_ms,company_ids").in("hs_id", ids);
        for (const a of acts ?? []) {
          const companies = Array.isArray(a.company_ids) ? a.company_ids.map(String) : [];
          meta.set(String(a.hs_id), { account_id: companies[0] ?? null, ts_ms: a.ts_ms == null ? null : Number(a.ts_ms), kind: a.type ?? null });
        }
      }

      for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
        if (indexed >= cap) break;
        const batch = fresh.slice(i, i + EMBED_BATCH);
        try {
          const vectors = await embedTexts(batch.map((b) => b.chunk));
          const upserts = batch.map((b, j) => ({
            hs_id: b.hs_id,
            account_id: meta.get(b.hs_id)?.account_id ?? null,
            ts_ms: meta.get(b.hs_id)?.ts_ms ?? null,
            kind: meta.get(b.hs_id)?.kind ?? null,
            chunk: b.chunk,
            embedding: vectors[j],
          }));
          // Small retried writes: one embeddings request fans out into WRITE_BATCH-row upserts
          // so HNSW maintenance per statement stays under the pooler's statement_timeout.
          for (let k = 0; k < upserts.length; k += WRITE_BATCH) {
            const slice = upserts.slice(k, k + WRITE_BATCH);
            let lastErr = "";
            let wrote = false;
            for (let attempt = 1; attempt <= 4 && !wrote; attempt++) {
              const { error: upErr } = await db.from("sdr_embeddings").upsert(slice, { onConflict: "hs_id" });
              if (!upErr) { wrote = true; break; }
              lastErr = upErr.message;
              await new Promise((r) => setTimeout(r, 800 * attempt));
            }
            if (!wrote) throw new Error(lastErr);
            indexed += slice.length;
          }
        } catch (e) {
          errors++;
          console.warn(`[embed] batch failed:`, (e as Error).message);
        }
      }
    }

    if (scanned % 10_000 < PAGE) console.log(`[embed] scanned ${scanned} · indexed ${indexed}`);
    if (!rows || rows.length < PAGE || indexed >= cap) break;
  }
  console.log(`[embed] done — scanned ${scanned}, indexed ${indexed}, errors ${errors}`);
  return { skipped: false, scanned, indexed, errors };
}
