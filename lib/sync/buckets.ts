/**
 * IST (UTC+5:30) period bucketing.
 *
 * HubSpot stores hs_timestamp as UTC epoch-ms. The SDR team is in India, so all
 * "today / yesterday / this week …" boundaries are defined at IST midnight.
 * IST has NO daylight saving, so a fixed +5:30 offset is exact — no tz database
 * needed. (This deliberately differs from call-scoring-agent, which buckets in UTC.)
 */

import { PeriodKey } from "./types";

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // +5:30

const DAY_MS = 86_400_000;

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  dayIndex: number; // whole IST days since epoch
}

/** Civil IST date for a UTC epoch-ms value. */
export function istParts(utcMs: number): IstParts {
  const shifted = utcMs + IST_OFFSET_MS;
  const d = new Date(shifted);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dayIndex: Math.floor(shifted / DAY_MS),
  };
}

/** "YYYY-MM-DD" for a UTC epoch-ms value, in IST. */
export function istDateStr(utcMs: number): string {
  const p = istParts(utcMs);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** IST day index for the 1st of an IST month. */
function monthStartIndex(year: number, month1to12: number): number {
  // Date.UTC gives the epoch-ms for that civil date at UTC midnight, which is
  // exactly the IST-shifted value for IST midnight of the same civil date.
  return Math.floor(Date.UTC(year, month1to12 - 1, 1) / DAY_MS);
}

/** Weekday with Monday = 0 for an IST day index. */
function weekdayMon(dayIndex: number): number {
  // dayIndex 0 (1970-01-01) is a Thursday. getUTCDay on the shifted ms gives
  // IST weekday with Sunday=0; convert to Monday=0.
  const sunBased = new Date(dayIndex * DAY_MS).getUTCDay(); // 0=Sun
  return (sunBased + 6) % 7;
}

/** Everything derived once from "now", reused for every activity. */
export interface IstContext {
  nowMs: number;
  today: IstParts;
  todayIndex: number;
  weekStartIndex: number; // Monday of the current IST week
  monthStartIndex: number; // 1st of the current IST month
  windowStartMs: number; // earliest UTC ms we must pull from
  windowStartDate: string; // YYYY-MM-DD (IST)
  windowEndDate: string; // YYYY-MM-DD (IST) = today
}

export function makeIstContext(nowMs: number): IstContext {
  const today = istParts(nowMs);
  const todayIndex = today.dayIndex;
  const weekStartIndex = todayIndex - weekdayMon(todayIndex);
  const monthIdx = monthStartIndex(today.year, today.month);

  // Pull window = earliest boundary across the 6 periods:
  //   last-week start, last-3-days start, this-month start.
  const lastWeekStartIndex = weekStartIndex - 7;
  const last3StartIndex = todayIndex - 2;
  const windowStartIndex = Math.min(lastWeekStartIndex, last3StartIndex, monthIdx);

  // IST midnight of a day index, expressed back in UTC ms.
  const windowStartMs = windowStartIndex * DAY_MS - IST_OFFSET_MS;

  return {
    nowMs,
    today,
    todayIndex,
    weekStartIndex,
    monthStartIndex: monthIdx,
    windowStartMs,
    // windowStartMs is IST-midnight expressed in UTC; istDateStr re-applies the
    // offset to recover the civil IST date.
    windowStartDate: istDateStr(windowStartMs),
    windowEndDate: istDateStr(nowMs),
  };
}

/** Which periods does an activity (UTC ms) fall into? An activity can match several. */
export function periodsForActivity(utcMs: number, ctx: IstContext): PeriodKey[] {
  const p = istParts(utcMs);
  const di = p.dayIndex;
  const out: PeriodKey[] = [];

  if (di === ctx.todayIndex) out.push("today");
  if (di === ctx.todayIndex - 1) out.push("yesterday");
  if (di >= ctx.todayIndex - 2 && di <= ctx.todayIndex) out.push("last_3_days");
  if (di >= ctx.weekStartIndex && di <= ctx.todayIndex) out.push("this_week");
  if (di >= ctx.weekStartIndex - 7 && di <= ctx.weekStartIndex - 1) out.push("last_week");
  if (p.year === ctx.today.year && p.month === ctx.today.month) out.push("this_month");

  return out;
}
