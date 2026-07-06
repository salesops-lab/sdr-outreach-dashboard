import "server-only";
/**
 * Server-only Supabase client using the SERVICE ROLE key — read-only use against
 * the call-scoring project's tables (calls, call_quality_insights,
 * rep_coaching_snapshots). Never import from client components.
 * Returns null when env is missing so the dashboard degrades gracefully.
 * Note: module-level cache means tests must vi.resetModules() between env changes.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

export function supabaseAdmin(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cached = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  if (!cached) console.warn("[callquality] Supabase env missing — call-quality disabled.");
  return cached;
}
