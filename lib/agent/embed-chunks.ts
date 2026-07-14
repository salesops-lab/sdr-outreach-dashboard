/**
 * Chunk composition for the embeddings index — pure. One chunk per content-bearing activity:
 * calls compose title + AI summary + notes + transcript excerpt; emails embed the subject.
 * Rows with no real signal (title-only calls, empty subjects) return null and are NOT indexed —
 * a vector of "Call with John" only pollutes retrieval. v1 is one chunk per activity (transcript
 * front-capped); multi-chunk splitting of long transcripts is a later upgrade.
 */

export interface ContentFields {
  type: string | null;
  call_title: string | null;
  call_body: string | null;
  call_summary: string | null;
  transcript: string | null;
  email_subject: string | null;
}

export const CHUNK_CAP = 1800; // chars ≈ 450 tokens per vector

export function composeChunk(c: ContentFields): string | null {
  if (c.type === "email") {
    const s = (c.email_subject ?? "").trim();
    return s.length >= 8 ? `Email subject: ${s}` : null;
  }
  const title = (c.call_title ?? "").trim();
  const summary = (c.call_summary ?? "").trim();
  const body = (c.call_body ?? "").trim();
  const transcript = (c.transcript ?? "").trim();
  const parts: string[] = [];
  if (summary) parts.push(`Summary: ${summary}`);
  if (body && body !== summary) parts.push(`Notes: ${body}`);
  if (transcript) parts.push(`Transcript: ${transcript}`);
  if (parts.length === 0) return null; // no substance → no vector
  const text = (title ? `${title}\n` : "") + parts.join("\n");
  return text.length > CHUNK_CAP ? text.slice(0, CHUNK_CAP) : text;
}
