/**
 * Resolve engagement -> contact -> company associations using HubSpot v4 batch
 * reads (up to 1000 ids/request) instead of one GET per activity. For a month of
 * activity this is ~tens of requests rather than tens of thousands.
 *
 * Company attribution per activity:
 *   primary company of each associated contact; if an activity has no contact,
 *   fall back to a direct engagement->company association; else "unattributed".
 */

import { hubspotPost, RATE_LIMIT_DELAY_MS, delay } from "../hubspot/client";
import { Activity } from "./types";
import { RawActivity } from "./pull";

const ASSOC_BATCH = 1000; // v4 batch read input limit
const OBJ_BATCH = 100; // v3 objects batch read input limit

interface V4Target {
  toObjectId?: number | string;
  associationTypes?: { category?: string; typeId?: number; label?: string | null }[];
}
interface V4Result {
  from: { id: string };
  to?: V4Target[];
}
interface V4Response {
  results?: V4Result[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface AssocTarget {
  toId: string;
  primary: boolean;
}

/** Generic v4 batch read: fromId -> [{toId, primary}]. */
async function batchReadAssociations(
  fromType: string,
  toType: string,
  fromIds: string[],
): Promise<Map<string, AssocTarget[]>> {
  const map = new Map<string, AssocTarget[]>();
  if (fromIds.length === 0) return map;

  for (const ids of chunk(fromIds, ASSOC_BATCH)) {
    const body = { inputs: ids.map((id) => ({ id })) };
    const res = await hubspotPost<V4Response>(
      `/crm/v4/associations/${fromType}/${toType}/batch/read`,
      body,
    );
    for (const r of res.results ?? []) {
      const targets: AssocTarget[] = (r.to ?? [])
        .map((t) => {
          const toId = t.toObjectId != null ? String(t.toObjectId) : "";
          // Contact's primary company association is HUBSPOT_DEFINED typeId 1,
          // or carries a "Primary" label.
          const primary = (t.associationTypes ?? []).some(
            (a) =>
              (a.typeId === 1 && (a.category ?? "").toUpperCase() === "HUBSPOT_DEFINED") ||
              /primary/i.test(a.label ?? ""),
          );
          return { toId, primary };
        })
        .filter((t) => t.toId);
      if (targets.length) map.set(r.from.id, targets);
    }
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return map;
}

/** Resolve names for a set of company ids via v3 objects batch read. */
async function resolveCompanyNames(companyIds: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  if (companyIds.length === 0) return names;

  interface ObjResp {
    results?: { id: string; properties?: Record<string, string | null> }[];
  }
  for (const ids of chunk(companyIds, OBJ_BATCH)) {
    const body = { properties: ["name"], inputs: ids.map((id) => ({ id })) };
    const res = await hubspotPost<ObjResp>(`/crm/v3/objects/companies/batch/read`, body);
    for (const r of res.results ?? []) {
      names[r.id] = r.properties?.name?.trim() || `Company ${r.id}`;
    }
    await delay(RATE_LIMIT_DELAY_MS);
  }
  return names;
}

function pickPrimaryCompany(targets: AssocTarget[] | undefined): string | null {
  if (!targets || targets.length === 0) return null;
  const primary = targets.find((t) => t.primary);
  return (primary ?? targets[0]).toId; // deterministic first-company fallback
}

export interface ResolveResult {
  activities: Activity[];
  companyNames: Record<string, string>;
}

export async function resolveAssociations(raw: RawActivity[]): Promise<ResolveResult> {
  const callIds = raw.filter((a) => a.type === "call").map((a) => a.id);
  const emailIds = raw.filter((a) => a.type === "email").map((a) => a.id);

  console.log(`Resolving associations: ${callIds.length} calls, ${emailIds.length} emails…`);
  const callContacts = await batchReadAssociations("calls", "contacts", callIds);
  const emailContacts = await batchReadAssociations("emails", "contacts", emailIds);

  // activityId -> contactIds (all associated contacts count toward "tapped")
  const activityContacts = new Map<string, string[]>();
  const allContactIds = new Set<string>();
  for (const [id, targets] of [...callContacts, ...emailContacts]) {
    const contactIds = targets.map((t) => t.toId);
    activityContacts.set(id, contactIds);
    contactIds.forEach((c) => allContactIds.add(c));
  }

  // contactId -> primary companyId
  console.log(`Resolving primary companies for ${allContactIds.size} contacts…`);
  const contactCompanyTargets = await batchReadAssociations(
    "contacts",
    "companies",
    [...allContactIds],
  );
  const contactCompany = new Map<string, string>();
  for (const [contactId, targets] of contactCompanyTargets) {
    const co = pickPrimaryCompany(targets);
    if (co) contactCompany.set(contactId, co);
  }

  // Fallback: activities with NO contact may still carry a direct company.
  const noContactCalls = callIds.filter((id) => !(activityContacts.get(id)?.length));
  const noContactEmails = emailIds.filter((id) => !(activityContacts.get(id)?.length));
  console.log(
    `Direct-company fallback for ${noContactCalls.length} calls + ${noContactEmails.length} emails with no contact…`,
  );
  const callCompanies = await batchReadAssociations("calls", "companies", noContactCalls);
  const emailCompanies = await batchReadAssociations("emails", "companies", noContactEmails);
  const directCompany = new Map<string, string[]>();
  for (const [id, targets] of [...callCompanies, ...emailCompanies]) {
    directCompany.set(id, targets.map((t) => t.toId));
  }

  // Build normalized activities.
  const usedCompanyIds = new Set<string>();
  const activities: Activity[] = raw.map((a) => {
    const contactIds = activityContacts.get(a.id) ?? [];
    let companyIds: string[];
    if (contactIds.length) {
      const set = new Set<string>();
      for (const c of contactIds) {
        const co = contactCompany.get(c);
        if (co) set.add(co);
      }
      companyIds = [...set];
    } else {
      companyIds = directCompany.get(a.id) ?? [];
    }
    companyIds.forEach((c) => usedCompanyIds.add(c));
    return {
      id: a.id,
      type: a.type,
      ownerId: a.ownerId,
      timestampMs: a.timestampMs,
      disposition: a.disposition,
      emailStatus: a.emailStatus,
      contactIds,
      companyIds,
    };
  });

  console.log(`Resolving ${usedCompanyIds.size} company names…`);
  const companyNames = await resolveCompanyNames([...usedCompanyIds]);

  return { activities, companyNames };
}
