/**
 * Account temperature engine (v2). A single pure classifier consumed by the aggregator
 * (per-account, per-period AND per owned rooftop) and, later, by the hot-account AI agent.
 *
 * Temperature = buyer intent inferred from call OUTCOMES + engagement, evaluated over the
 * relevant window. Rules (first match wins), per the product spec:
 *
 *   HOT  — Meeting Scheduled | Meeting Rescheduled | Callback High Intent | Callback Low
 *          Intent ×2+ | email reply
 *   WARM — Gave a Referral | Callback Low Intent ×1 | any (neutral) connect | email opened
 *   COLD — touched but never connected · untouched · DISQUALIFIED (a connected-but-negative
 *          outcome — Not Interested / Not a Right POC / bad number / left org — with no MORE
 *          RECENT positive signal). Recency lets a later positive rescue a rejected account.
 *
 * Counts (not the raw GUIDs) are the input, so this module has no HubSpot dependency and is
 * trivially unit-testable. The GUID→bucket mapping lives in config/dispositions.ts.
 */
import { Temperature } from "./types";

export interface TempSignals {
  meetingScheduled: number;
  meetingRescheduled: number;
  callbackHigh: number;
  callbackLow: number;
  gaveReferral: number;
  connected: number; // total connected calls (incl. neutral "Connected" / "Meeting Reminder")
  negative: number; // count of disqualifying outcomes
  opened: number; // emails opened
  replied: number; // emails replied
  calls: number;
  emails: number;
  lastPositiveMs: number | null; // most recent positive/soft-positive/reply signal
  lastNegativeMs: number | null; // most recent disqualifying outcome
  negativeLabel?: string | null; // label of the most recent negative (for the reason string)
  tapped?: boolean; // book context: explicit false => owned rooftop never touched
}

export interface TempResult {
  temp: Temperature;
  reason: string;
  disqualified: boolean;
}

/** Strip the "C - " / "NC - " disposition prefix for a human-readable reason. */
function cleanLabel(label: string | null | undefined): string {
  return (label || "Not interested").replace(/^N?C\s*-\s*/i, "").trim();
}

export function classifyTemperature(s: TempSignals): TempResult {
  const touches = s.calls + s.emails;

  // Untouched (owned rooftop with no activity, or literally nothing).
  if (s.tapped === false || touches === 0) {
    return { temp: "cold", reason: "Untouched", disqualified: false };
  }

  // Disqualification is recency-aware: a rejection sticks unless a positive signal is at least
  // as recent (a later meeting/callback/reply revives the account).
  const rescued = s.lastPositiveMs != null && (s.lastNegativeMs == null || s.lastPositiveMs >= s.lastNegativeMs);
  if (s.negative > 0 && !rescued) {
    return { temp: "cold", reason: `${cleanLabel(s.negativeLabel)} — disqualified`, disqualified: true };
  }

  // HOT — high buyer intent.
  if (s.meetingScheduled > 0) return { temp: "hot", reason: "Meeting scheduled", disqualified: false };
  if (s.meetingRescheduled > 0) return { temp: "hot", reason: "Meeting rescheduled", disqualified: false };
  if (s.callbackHigh > 0) return { temp: "hot", reason: "Callback — high intent", disqualified: false };
  if (s.callbackLow >= 2) return { temp: "hot", reason: `${s.callbackLow}× callback (low intent)`, disqualified: false };
  if (s.replied > 0) return { temp: "hot", reason: `Replied to email${s.replied > 1 ? ` ${s.replied}×` : ""}`, disqualified: false };

  // WARM — moderate engagement.
  if (s.gaveReferral > 0) return { temp: "warm", reason: "Referral given", disqualified: false };
  if (s.callbackLow === 1) return { temp: "warm", reason: "Callback — low intent", disqualified: false };
  if (s.connected > 0) return { temp: "warm", reason: `Connected ${s.connected}×${s.opened > 0 ? `, opened ${s.opened}` : ""}`, disqualified: false };
  if (s.opened > 0) return { temp: "warm", reason: `Opened email${s.opened > 1 ? ` ${s.opened}×` : ""}, no connect`, disqualified: false };

  // COLD — touched, never connected.
  if (touches >= 3) return { temp: "cold", reason: `${touches} touches, no engagement`, disqualified: false };
  if (s.calls > 0 && s.emails > 0) return { temp: "cold", reason: `${s.calls} call${s.calls > 1 ? "s" : ""} + ${s.emails} email${s.emails > 1 ? "s" : ""}, no connect`, disqualified: false };
  if (s.calls > 0) return { temp: "cold", reason: `${s.calls} call${s.calls > 1 ? "s" : ""}, no connect`, disqualified: false };
  return { temp: "cold", reason: "Emailed, no open/reply", disqualified: false };
}
