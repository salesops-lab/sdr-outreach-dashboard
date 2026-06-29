/**
 * Authenticated HubSpot API client with backoff on 429s, transient 5xx, and
 * network errors. Adapted from tam-dashboard-1/lib/hubspot/client.ts — the
 * network-error retry matters for long batch pulls: a single dropped socket
 * (ETIMEDOUT/ECONNRESET) makes fetch() throw, which would otherwise abort the run.
 *
 * Reads HUBSPOT_PAT from the environment.
 */

export const HUBSPOT_API_BASE = "https://api.hubapi.com";

/** Spacing between sequential requests — matches orchestrator.py RATE_LIMIT_DELAY. */
export const RATE_LIMIT_DELAY_MS = 300;

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function hubspotFetch(
  path: string,
  options: RequestInit = {},
  retries = 5,
): Promise<Response> {
  const pat = process.env.HUBSPOT_PAT;
  if (!pat) throw new Error("HUBSPOT_PAT environment variable is not set");

  let res: Response;
  try {
    res = await fetch(`${HUBSPOT_API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (err) {
    // Network-level failure — fetch() throws. Retry with backoff.
    if (retries > 0) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[HubSpot] Network error on ${path} (${msg}). Retrying in 5s (${retries} left)`);
      await delay(5000);
      return hubspotFetch(path, options, retries - 1);
    }
    throw err;
  }

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
    const backoffMs = Math.min(retryAfter * 1000, 60_000);
    console.warn(`[HubSpot] Rate limited on ${path}. Backing off ${backoffMs}ms (${retries} left)`);
    await delay(backoffMs);
    if (retries > 0) return hubspotFetch(path, options, retries - 1);
    throw new Error("HubSpot rate limit exceeded after all retries");
  }

  if (res.status >= 500 && retries > 0) {
    console.warn(`[HubSpot] Server error ${res.status} on ${path}. Retrying in 5s (${retries} left)`);
    await delay(5000);
    return hubspotFetch(path, options, retries - 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot API error ${res.status} on ${path}: ${body}`);
  }

  return res;
}

/** POST JSON and parse the response. */
export async function hubspotPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await hubspotFetch(path, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as T;
}

/** GET JSON. */
export async function hubspotGet<T = unknown>(path: string): Promise<T> {
  const res = await hubspotFetch(path, { method: "GET" });
  return (await res.json()) as T;
}
