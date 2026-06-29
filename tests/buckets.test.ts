import { describe, it, expect } from "vitest";
import { makeIstContext, periodsForActivity, istDateStr, IST_OFFSET_MS } from "../lib/sync/buckets";

const DAY_MS = 86_400_000;
// Noon IST on a fixed day, expressed in UTC: 2026-06-29 12:00 IST = 06:30 UTC.
const NOW = Date.UTC(2026, 5, 29, 6, 30, 0);

// Helper: noon IST for a given IST day index, expressed in UTC ms.
const noonIst = (dayIndex: number) => dayIndex * DAY_MS - IST_OFFSET_MS + 12 * 3600_000;

describe("IST date conversion", () => {
  it("rolls an evening-UTC activity into the next IST day", () => {
    // 2026-06-29 19:00 UTC = 2026-06-30 00:30 IST
    const ms = Date.UTC(2026, 5, 29, 19, 0, 0);
    expect(istDateStr(ms)).toBe("2026-06-30");
  });
});

describe("periodsForActivity", () => {
  const ctx = makeIstContext(NOW);

  it("an activity 'now' is in today, last_3_days, this_week, this_month", () => {
    const ps = periodsForActivity(NOW, ctx);
    expect(ps).toContain("today");
    expect(ps).toContain("last_3_days");
    expect(ps).toContain("this_week");
    expect(ps).toContain("this_month");
    expect(ps).not.toContain("yesterday");
    expect(ps).not.toContain("last_week");
  });

  it("yesterday is yesterday + last_3_days, not today", () => {
    const ps = periodsForActivity(NOW - DAY_MS, ctx);
    expect(ps).toContain("yesterday");
    expect(ps).toContain("last_3_days");
    expect(ps).not.toContain("today");
  });

  it("3 days ago is NOT in last_3_days (today + 2 prior only)", () => {
    const ps = periodsForActivity(NOW - 3 * DAY_MS, ctx);
    expect(ps).not.toContain("last_3_days");
  });

  it("Monday week-start boundary: this-week starts Monday, last-week is the prior Mon-Sun", () => {
    const thisMonday = periodsForActivity(noonIst(ctx.weekStartIndex), ctx);
    expect(thisMonday).toContain("this_week");
    expect(thisMonday).not.toContain("last_week");

    const lastSunday = periodsForActivity(noonIst(ctx.weekStartIndex - 1), ctx);
    expect(lastSunday).toContain("last_week");
    expect(lastSunday).not.toContain("this_week");

    const lastMonday = periodsForActivity(noonIst(ctx.weekStartIndex - 7), ctx);
    expect(lastMonday).toContain("last_week");
  });

  it("window start covers the earliest needed boundary", () => {
    // windowStartMs must be <= last-week start and <= 3-days-ago.
    expect(ctx.windowStartMs).toBeLessThanOrEqual(noonIst(ctx.weekStartIndex - 7));
    expect(ctx.windowStartMs).toBeLessThanOrEqual(NOW - 2 * DAY_MS);
  });
});
