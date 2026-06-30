/**
 * Pull outbound calls + emails for the tracked owners over the window.
 *
 * Defeats the HubSpot Search API's 10,000-result ceiling by slicing the window
 * into weekly sub-windows sorted ascending by hs_timestamp — each weekly slice
 * is well under 10k at this team's volume, so no slice can silently truncate.
 * Per-slice counts are logged and a slice nearing the ceiling is warned about.
 */

import { hubspotPost, RATE_LIMIT_DELAY_MS, delay } from "../hubspot/client";
import { REP_OWNER_IDS } from "../../config/reps";
import { ActivityType } from "./types";

const DAY_MS = 86_400_000;
const SLICE_MS = 7 * DAY_MS;
const CEILING_WARN = 9000; // warn if a slice approaches the 10k cap

interface HsRecord {
  id: string;
  properties: Record<string, string | null>;
}

interface SearchResponse {
  total?: number;
  results: HsRecord[];
  paging?: { next?: { after?: string } };
}

interface PullConfig {
  objectType: "calls" | "emails";
  directionProperty: string;
  directionValue: string;
  properties: string[];
}

const CALL_CONFIG: PullConfig = {
  objectType: "calls",
  directionProperty: "hs_call_direction",
  directionValue: "OUTBOUND",
  properties: [
    "hs_timestamp",
    "hubspot_owner_id",
    "hs_call_direction",
    "hs_call_disposition",
    "hs_call_status",
    "hs_call_duration",
    "hs_object_id",
  ],
};

const EMAIL_CONFIG: PullConfig = {
  objectType: "emails",
  directionProperty: "hs_email_direction",
  directionValue: "EMAIL", // "Outgoing"
  properties: ["hs_timestamp", "hubspot_owner_id", "hs_email_direction", "hs_email_status", "hs_object_id"],
};

async function pullSlice(cfg: PullConfig, startMs: number, endMs: number): Promise<HsRecord[]> {
  const collected: HsRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            { propertyName: "hubspot_owner_id", operator: "IN", values: REP_OWNER_IDS },
            { propertyName: cfg.directionProperty, operator: "EQ", value: cfg.directionValue },
            { propertyName: "hs_timestamp", operator: "GTE", value: String(startMs) },
            { propertyName: "hs_timestamp", operator: "LT", value: String(endMs) },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
      properties: cfg.properties,
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotPost<SearchResponse>(`/crm/v3/objects/${cfg.objectType}/search`, body);
    collected.push(...res.results);
    after = res.paging?.next?.after;
    await delay(RATE_LIMIT_DELAY_MS);
  } while (after);

  return collected;
}

async function pullObject(cfg: PullConfig, windowStartMs: number, nowMs: number): Promise<HsRecord[]> {
  const all: HsRecord[] = [];
  const seen = new Set<string>();

  for (let sliceStart = windowStartMs; sliceStart < nowMs; sliceStart += SLICE_MS) {
    const sliceEnd = Math.min(sliceStart + SLICE_MS, nowMs);
    const records = await pullSlice(cfg, sliceStart, sliceEnd);

    let added = 0;
    for (const r of records) {
      if (seen.has(r.id)) continue; // de-dupe across slice boundaries
      seen.add(r.id);
      all.push(r);
      added++;
    }

    const from = new Date(sliceStart).toISOString().slice(0, 10);
    const to = new Date(sliceEnd).toISOString().slice(0, 10);
    console.log(`  [${cfg.objectType}] ${from}..${to}: ${records.length} records (+${added} new)`);
    if (records.length >= CEILING_WARN) {
      console.warn(
        `  ⚠️  [${cfg.objectType}] slice ${from}..${to} returned ${records.length} — approaching the 10k Search ceiling. Consider a finer slice.`,
      );
    }
  }

  return all;
}

export interface RawActivity {
  id: string;
  type: ActivityType;
  ownerId: string;
  timestampMs: number;
  disposition: string | null;
  emailStatus: string | null;
}

function toMs(hsTimestamp: string | null): number {
  if (!hsTimestamp) return NaN;
  // hs_timestamp comes back as epoch-ms string or ISO string depending on API.
  const n = Number(hsTimestamp);
  if (!Number.isNaN(n) && n > 0) return n;
  return new Date(hsTimestamp).getTime();
}

export interface OwnedCompany {
  id: string;
  name: string;
}

/**
 * Pull each rep's owned company book (company owner = rep) — the coverage
 * denominator. Searched per-owner so no single query approaches the 10k ceiling,
 * and names come back in the search (no separate name lookup needed).
 */
export async function pullOwnedCompanies(): Promise<Record<string, OwnedCompany[]>> {
  const out: Record<string, OwnedCompany[]> = {};
  console.log("Pulling owned-company books (coverage denominator)…");

  for (const ownerId of REP_OWNER_IDS) {
    const companies: OwnedCompany[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [{ filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }] }],
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        properties: ["name"],
        limit: 100,
      };
      if (after) body.after = after;
      const res = await hubspotPost<SearchResponse>(`/crm/v3/objects/companies/search`, body);
      for (const r of res.results) {
        companies.push({ id: r.id, name: r.properties.name?.trim() || `Company ${r.id}` });
      }
      after = res.paging?.next?.after;
      await delay(RATE_LIMIT_DELAY_MS);
    } while (after);

    out[ownerId] = companies;
    if (companies.length >= CEILING_WARN) {
      console.warn(`  ⚠️  owner ${ownerId} owns ${companies.length} companies — near the 10k Search ceiling.`);
    }
  }

  const total = Object.values(out).reduce((a, c) => a + c.length, 0);
  console.log(`  owned companies: ${total} across ${REP_OWNER_IDS.length} reps.`);
  return out;
}

export interface PullCaps {
  calls: boolean;
  emails: boolean;
}

/** Pull outbound calls + emails (whichever the token can read), normalized. */
export async function pullActivities(
  windowStartMs: number,
  nowMs: number,
  caps: PullCaps,
): Promise<RawActivity[]> {
  let calls: HsRecord[] = [];
  let emails: HsRecord[] = [];

  if (caps.calls) {
    console.log("Pulling outbound calls…");
    calls = await pullObject(CALL_CONFIG, windowStartMs, nowMs);
  } else {
    console.warn("Skipping calls — no read access.");
  }
  if (caps.emails) {
    console.log("Pulling outgoing emails…");
    emails = await pullObject(EMAIL_CONFIG, windowStartMs, nowMs);
  } else {
    console.warn("Skipping emails — no read access (scope: connected-email-data-access).");
  }

  const activities: RawActivity[] = [];

  for (const c of calls) {
    activities.push({
      id: c.id,
      type: "call",
      ownerId: c.properties.hubspot_owner_id ?? "",
      timestampMs: toMs(c.properties.hs_timestamp),
      disposition: c.properties.hs_call_disposition ?? null,
      emailStatus: null,
    });
  }
  for (const e of emails) {
    activities.push({
      id: e.id,
      type: "email",
      ownerId: e.properties.hubspot_owner_id ?? "",
      timestampMs: toMs(e.properties.hs_timestamp),
      disposition: null,
      emailStatus: e.properties.hs_email_status ?? null,
    });
  }

  // Drop anything we can't time-bucket or attribute to a tracked owner.
  const trackable = activities.filter(
    (a) => a.ownerId && Number.isFinite(a.timestampMs) && a.timestampMs > 0,
  );
  console.log(`Pulled ${calls.length} calls + ${emails.length} emails = ${trackable.length} usable activities.`);
  return trackable;
}
