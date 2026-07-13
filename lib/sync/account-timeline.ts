/**
 * Account timeline — pure assembly of the per-account activity + stage-event history that the
 * /api/account/[companyId]/timeline route serves and the Accounts side panel renders.
 * Calls/emails carry WHO (owner, SDR/AE kind) → WHOM (contact) → OUTCOME (disposition label);
 * deal stage entries interleave chronologically (newest first). No I/O — unit-tested.
 */
import { dispositionLabel } from "../../config/dispositions";
import { stageLabel, DealStageKey } from "../../config/deal-stages";
import { ContactMeta } from "./associate";

export interface TimelineActivityInput {
  id: string;
  type: "call" | "email";
  ownerId: string;
  tsMs: number;
  disposition: string | null;
  emailStatus: string | null;
  emailOpened: boolean;
  emailReplied: boolean;
  contactIds: string[];
}

export interface TimelineStageInput {
  dealId: string;
  stageKey: DealStageKey;
  enteredMs: number;
}

export type TimelineItem =
  | {
      kind: "call" | "email";
      ts: number;
      owner_id: string;
      owner_name: string;
      owner_kind: "sdr" | "ae" | null; // null = not a tracked rep (kind unknown)
      contact: { id: string; name: string; title: string | null; dm: boolean } | null;
      outcome: string;
      opened: boolean;
      replied: boolean;
    }
  | { kind: "stage"; ts: number; deal_id: string; stage_key: DealStageKey; label: string };

export function buildAccountTimeline(
  activities: TimelineActivityInput[],
  stageEvents: TimelineStageInput[],
  contactMeta: Record<string, ContactMeta>,
  ownerNames: Record<string, string>,
  ownerKinds: Record<string, "sdr" | "ae">,
): TimelineItem[] {
  const items: TimelineItem[] = activities.map((a) => {
    const cid = a.contactIds[0] ?? null;
    const meta = cid ? contactMeta[cid] : undefined;
    return {
      kind: a.type,
      ts: a.tsMs,
      owner_id: a.ownerId,
      owner_name: ownerNames[a.ownerId] ?? `ID:${a.ownerId}`,
      owner_kind: ownerKinds[a.ownerId] ?? null,
      contact: cid
        ? { id: cid, name: meta?.name ?? `Contact ${cid}`, title: meta?.title ?? null, dm: !!meta?.dm }
        : null,
      outcome:
        a.type === "call"
          ? dispositionLabel(a.disposition)
          : (a.emailStatus ?? "").toUpperCase() === "BOUNCED" ? "Bounced" : "Sent",
      opened: a.emailOpened,
      replied: a.emailReplied,
    };
  });
  for (const e of stageEvents) {
    items.push({ kind: "stage", ts: e.enteredMs, deal_id: e.dealId, stage_key: e.stageKey, label: stageLabel(e.stageKey) });
  }
  return items.sort((a, b) => b.ts - a.ts);
}

/** One deal's journey (for the panel's stage-flow strip). */
export interface DealJourney {
  id: string;
  stage_key: DealStageKey; // current canonical stage
  stage_label: string;
  amount: number | null;
  events: { stage_key: DealStageKey; label: string; entered_ms: number }[]; // entered_ms asc
}

/** The /api/account/[companyId]/timeline response contract (shared route ↔ panel). */
export interface AccountTimelinePayload {
  account: {
    id: string;
    name: string;
    owner_id: string | null;
    owner_name: string | null;
    gd_stage: string | null;
    group_name: string | null;
  };
  deals: DealJourney[];
  items: TimelineItem[];
  activity_capped: boolean; // true when older activities exist beyond the cap
  watch: { status: string; reason: string | null; next_step: string | null; priority: string | null } | null;
}
