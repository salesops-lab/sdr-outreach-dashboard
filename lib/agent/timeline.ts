import "server-only";
import { supabaseAdmin } from "../supabase/admin";
import { TimelineEvent } from "./types";
import { ContactRow } from "../spine/types";

export interface DBActivityContentRow {
  hs_id: string;
  type: string | null;
  call_title: string | null;
  call_body: string | null;
  call_summary: string | null;
  transcript: string | null;
  email_subject: string | null;
}

export async function loadTimelineForAccount(companyId: string, limit = 40): Promise<TimelineEvent[]> {
  const db = supabaseAdmin();
  if (!db) return [];

  // 1. Fetch activities for the company (ordered by ts_ms ascending).
  // jsonb contains needs the JSON-string form — a raw JS array renders as a Postgres array
  // literal and errors ("invalid input syntax for type json"), which the catch below used to
  // swallow silently (the agent then reasoned without raw activity context).
  const { data: actRows, error: actErr } = await db
    .from("sdr_activities")
    .select("*")
    .contains("company_ids", JSON.stringify([companyId]))
    .order("ts_ms", { ascending: true })
    .limit(limit);

  if (actErr) {
    console.warn(`[timeline] failed to fetch activities for company ${companyId}:`, actErr.message);
    return [];
  }
  if (!actRows || actRows.length === 0) return [];

  // 2. Gather unique contact IDs
  const contactIds = [...new Set(actRows.flatMap((r) => {
    try {
      const arr = typeof r.contact_ids === "string" ? JSON.parse(r.contact_ids) : r.contact_ids;
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return Array.isArray(r.contact_ids) ? (r.contact_ids as unknown[]).map(String) : [];
    }
  }))];

  // 3. Fetch contact details
  const contactsMap = new Map<string, ContactRow>();
  if (contactIds.length > 0) {
    const { data: ctRows, error: ctErr } = await db
      .from("sdr_contacts")
      .select("*")
      .in("hs_id", contactIds);
    if (ctErr) {
      console.warn(`[timeline] failed to fetch contacts:`, ctErr.message);
    } else if (ctRows) {
      for (const ct of ctRows as ContactRow[]) {
        contactsMap.set(ct.hs_id, ct);
      }
    }
  }

  // 4. Fetch activity content
  const actIds = actRows.map((r) => r.hs_id);
  const contentMap = new Map<string, DBActivityContentRow>();
  if (actIds.length > 0) {
    const { data: contentRows, error: contentErr } = await db
      .from("sdr_activity_content")
      .select("*")
      .in("hs_id", actIds);
    if (contentErr) {
      console.warn(`[timeline] failed to fetch activity content:`, contentErr.message);
    } else if (contentRows) {
      for (const c of contentRows as DBActivityContentRow[]) {
        contentMap.set(c.hs_id, c);
      }
    }
  }

  // 5. Map everything together
  return actRows.map((r) => {
    // Parse contact IDs
    let cIds: string[] = [];
    try {
      cIds = typeof r.contact_ids === "string" ? JSON.parse(r.contact_ids) : r.contact_ids;
      if (!Array.isArray(cIds)) cIds = [];
    } catch {
      cIds = Array.isArray(r.contact_ids) ? r.contact_ids : [];
    }

    const contacts = cIds.map((cid) => {
      const c = contactsMap.get(cid);
      return {
        hsId: cid,
        name: c?.name || null,
        title: c?.title || null,
        dm: !!c?.dm,
      };
    });

    const c = contentMap.get(r.hs_id);
    const content = c
      ? {
          callTitle: c.call_title || null,
          callBody: c.call_body || null,
          callSummary: c.call_summary || null,
          transcript: c.transcript || null,
          emailSubject: c.email_subject || null,
        }
      : null;

    // Convert ts_ms to local string
    const date = new Date(Number(r.ts_ms));
    const dateStr = date.toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " ET";

    return {
      hsId: r.hs_id,
      type: r.type as "call" | "email",
      tsMs: Number(r.ts_ms),
      dateStr,
      disposition: r.disposition || null,
      emailStatus: r.email_status || null,
      emailOpened: !!r.email_opened,
      emailReplied: !!r.email_replied,
      emailClicked: !!r.email_clicked,
      contacts,
      content,
    };
  });
}
