/**
 * HubSpot call disposition GUID -> label map for portal 242626590.
 * Ported verbatim from call-scoring-agent/config/dispositions.py so this
 * dashboard's "connect rate" matches the existing SDR call-scoring pipeline.
 *
 * Business rule (confirmed with the user):
 *   "Connected" = actually reached a human.
 *   Voicemail / live message / busy are NOT connected.
 */

// Connected dispositions (11) — a human was reached.
export const CONNECTED_DISPOSITIONS: Record<string, string> = {
  "243ad062-d38f-40ea-86e2-10040d9ce4bd": "C - Meeting Scheduled",
  "f240bbac-87c9-4f6e-bf70-924b57d47db7": "Connected",
  "af20b15f-39a5-4a40-94e4-63cbe341cf1b": "C - Callback High Intent",
  "c7480f13-6eba-48d0-b203-40715b7ffc4d": "C - Callback Low Intent",
  "0332dadf-c9c9-4207-979e-e0fd7b030425": "C - Call Drop",
  "f4c8fab8-d5d3-4c90-aab8-4deb4b62cfca": "C - Meeting Reminder",
  "2aa923e7-3887-4e12-a944-cb7871fe09e3": "C - Meeting Rescheduled",
  "09a2d1c9-49ef-4371-8968-0af01bca7893": "C - Not Interested",
  "3fcb6e84-4d51-45e4-8907-4c8cfa8c3818": "C - Not a Right POC",
  "69252e11-115b-4049-89cd-4952b899a4fc": "C - Gave a Referral",
  "196a54fe-96e2-4323-9af4-3f5cc1d9483b": "C - Language Barrier",
};

// Not-connected dispositions (14) — no human reached (incl. voicemail/busy).
export const NOT_CONNECTED_DISPOSITIONS: Record<string, string> = {
  "9afcb440-c2c4-44a7-9eb5-8f63e4896aeb": "NC - No Answer",
  "a93bb776-a9ea-4370-8b05-4bf421728952": "NC - Call Drop",
  "47339f4e-b036-4bf5-aa35-e573b7ed8b0b": "NC - Bad Number",
  "6272bc41-a712-4a53-87dc-a75ebd401268": "NC - Wrong Number",
  "a349977a-6e2e-4bd7-84bf-3d8c09225879": "NC - Reached ICP Voicemail",
  "3199e77a-26ce-40b0-b834-0ed139dca374": "NC - Reached Boardline Voicemail",
  "7e39b35f-aa3a-4dd8-b3e4-757a10c4c195": "NC - Prospect Unavailable",
  "28044bce-b123-4ab4-b1a4-9bbce6f57e14": "NC - Stuck at Operator",
  "676f88b6-8b37-487f-98e6-583ee3124b97": "NC - Incorrect/Irrelevant Account",
  "f642a1f6-bb8a-4320-9bd5-49652079c6d2": "NC - Prospect Left Organisation",
  "a5156977-06f0-41b6-963c-cc8bb165f557": "NC - Language Barrier",
  "b2cf5968-551e-4856-9783-52b3da59a7d0": "Left Voicemail",
  "a4c4c377-d246-4b32-a13b-75a56a4cd0ff": "Left Live Message",
  "9d9162e7-6cf3-4944-bf63-4dff82258764": "Busy",
};

export const ALL_DISPOSITIONS: Record<string, string> = {
  ...CONNECTED_DISPOSITIONS,
  ...NOT_CONNECTED_DISPOSITIONS,
};

/** Individual outcome GUIDs used by the temperature engine. */
export const MEETING_SCHEDULED_GUID = "243ad062-d38f-40ea-86e2-10040d9ce4bd";
export const MEETING_RESCHEDULED_GUID = "2aa923e7-3887-4e12-a944-cb7871fe09e3";
export const CALLBACK_HIGH_GUID = "af20b15f-39a5-4a40-94e4-63cbe341cf1b";
export const CALLBACK_LOW_GUID = "c7480f13-6eba-48d0-b203-40715b7ffc4d";
export const GAVE_REFERRAL_GUID = "69252e11-115b-4049-89cd-4952b899a4fc";

/**
 * High-intent outcomes that make an account "hot" on a single occurrence.
 * NOTE: "Meeting Reminder" is intentionally EXCLUDED — it's a logistics touch, not buyer
 * intent (it counts as a neutral connect instead, landing an account "warm").
 */
export const HIGH_INTENT_GUIDS = new Set<string>([
  MEETING_SCHEDULED_GUID, // C - Meeting Scheduled
  MEETING_RESCHEDULED_GUID, // C - Meeting Rescheduled
  CALLBACK_HIGH_GUID, // C - Callback High Intent
]);

/**
 * Disqualifying outcomes — a human was reached (or the account is a dead end) and the signal
 * is NEGATIVE. These pull an account to COLD (flagged "disqualified"), unless a more recent
 * positive signal revives it. Mixes connected rejections (Not Interested / Not a Right POC /
 * Language Barrier) with data-quality dead ends (bad/wrong number, left org, wrong account).
 */
export const NEGATIVE_GUIDS = new Set<string>([
  "09a2d1c9-49ef-4371-8968-0af01bca7893", // C - Not Interested
  "3fcb6e84-4d51-45e4-8907-4c8cfa8c3818", // C - Not a Right POC
  "196a54fe-96e2-4323-9af4-3f5cc1d9483b", // C - Language Barrier
  "f642a1f6-bb8a-4320-9bd5-49652079c6d2", // NC - Prospect Left Organisation
  "47339f4e-b036-4bf5-aa35-e573b7ed8b0b", // NC - Bad Number
  "6272bc41-a712-4a53-87dc-a75ebd401268", // NC - Wrong Number
  "676f88b6-8b37-487f-98e6-583ee3124b97", // NC - Incorrect/Irrelevant Account
]);

/** True if a human was reached (disposition is in the connected set). */
export function isConnected(guid: string | null | undefined): boolean {
  if (!guid) return false;
  return guid in CONNECTED_DISPOSITIONS;
}

export function isHighIntent(guid: string | null | undefined): boolean {
  return !!guid && HIGH_INTENT_GUIDS.has(guid);
}

export function isMeeting(guid: string | null | undefined): boolean {
  return guid === MEETING_SCHEDULED_GUID;
}

export function isMeetingRescheduled(guid: string | null | undefined): boolean {
  return guid === MEETING_RESCHEDULED_GUID;
}

export function isCallbackHigh(guid: string | null | undefined): boolean {
  return guid === CALLBACK_HIGH_GUID;
}

export function isCallbackLow(guid: string | null | undefined): boolean {
  return guid === CALLBACK_LOW_GUID;
}

export function isGaveReferral(guid: string | null | undefined): boolean {
  return guid === GAVE_REFERRAL_GUID;
}

/** A disqualifying outcome (buyer rejection or dead-end contact data). */
export function isNegative(guid: string | null | undefined): boolean {
  return !!guid && NEGATIVE_GUIDS.has(guid);
}

/** Human label for a disposition GUID (or a readable "Unknown" fallback). */
export function dispositionLabel(guid: string | null | undefined): string {
  if (!guid) return "No disposition";
  return ALL_DISPOSITIONS[guid] ?? `Unknown (${guid.slice(0, 8)}…)`;
}
