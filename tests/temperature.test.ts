import { describe, it, expect } from "vitest";
import { classifyTemperature, TempSignals } from "../lib/sync/temperature";

/** Build a signals object with all-zero defaults; override just what a case needs. */
function sig(partial: Partial<TempSignals>): TempSignals {
  return {
    meetingScheduled: 0, meetingRescheduled: 0, callbackHigh: 0, callbackLow: 0,
    gaveReferral: 0, connected: 0, negative: 0, opened: 0, replied: 0,
    calls: 0, emails: 0, lastPositiveMs: null, lastNegativeMs: null, negativeLabel: null,
    ...partial,
  };
}

describe("classifyTemperature", () => {
  describe("cold — untouched / no connect", () => {
    it("untapped owned rooftop is cold/Untouched", () => {
      const r = classifyTemperature(sig({ tapped: false }));
      expect(r).toMatchObject({ temp: "cold", reason: "Untouched" });
    });

    it("zero touches is cold/Untouched", () => {
      expect(classifyTemperature(sig({})).temp).toBe("cold");
    });

    it("three unconnected calls is cold with a touch-count reason", () => {
      const r = classifyTemperature(sig({ calls: 3 }));
      expect(r.temp).toBe("cold");
      expect(r.reason).toMatch(/3 touches/i);
    });

    it("one unconnected call is cold", () => {
      expect(classifyTemperature(sig({ calls: 1 })).temp).toBe("cold");
    });
  });

  describe("hot — high buyer intent", () => {
    it("meeting scheduled is hot", () => {
      expect(classifyTemperature(sig({ calls: 1, connected: 1, meetingScheduled: 1 }))).toMatchObject({ temp: "hot" });
    });
    it("meeting rescheduled is hot", () => {
      expect(classifyTemperature(sig({ calls: 1, connected: 1, meetingRescheduled: 1 })).temp).toBe("hot");
    });
    it("callback high intent is hot", () => {
      expect(classifyTemperature(sig({ calls: 1, connected: 1, callbackHigh: 1 })).temp).toBe("hot");
    });
    it("callback low intent TWICE is hot", () => {
      const r = classifyTemperature(sig({ calls: 2, connected: 2, callbackLow: 2 }));
      expect(r.temp).toBe("hot");
      expect(r.reason).toMatch(/callback/i);
    });
    it("email reply is hot", () => {
      expect(classifyTemperature(sig({ emails: 1, replied: 1 })).temp).toBe("hot");
    });
  });

  describe("warm — moderate engagement", () => {
    it("callback low intent ONCE is warm (not hot)", () => {
      expect(classifyTemperature(sig({ calls: 1, connected: 1, callbackLow: 1 })).temp).toBe("warm");
    });
    it("gave a referral is warm", () => {
      const r = classifyTemperature(sig({ calls: 1, connected: 1, gaveReferral: 1 }));
      expect(r.temp).toBe("warm");
      expect(r.reason).toMatch(/referral/i);
    });
    it("a neutral connect is warm with a 'connected' reason", () => {
      const r = classifyTemperature(sig({ calls: 1, connected: 1 }));
      expect(r.temp).toBe("warm");
      expect(r.reason).toMatch(/connected/i);
    });
    it("email opened but no connect is warm", () => {
      expect(classifyTemperature(sig({ emails: 1, opened: 1 })).temp).toBe("warm");
    });
  });

  describe("disqualification — a rejection must not read as warm", () => {
    it("connected-but-not-interested is cold and flagged disqualified", () => {
      const r = classifyTemperature(sig({ calls: 1, connected: 1, negative: 1, lastNegativeMs: 100, negativeLabel: "C - Not Interested" }));
      expect(r.temp).toBe("cold");
      expect(r.disqualified).toBe(true);
      expect(r.reason).toMatch(/disqualified/i);
    });

    it("a LATER positive signal rescues a disqualified account back to hot", () => {
      // Rejected at t=100, then booked a meeting at t=200 → recency says it's live again.
      const r = classifyTemperature(sig({
        calls: 2, connected: 2, negative: 1, meetingScheduled: 1,
        lastNegativeMs: 100, lastPositiveMs: 200,
      }));
      expect(r.temp).toBe("hot");
      expect(r.disqualified).toBe(false);
    });

    it("a negative AFTER a positive disqualifies (latest word wins)", () => {
      const r = classifyTemperature(sig({
        calls: 2, connected: 2, negative: 1, meetingScheduled: 1,
        lastPositiveMs: 100, lastNegativeMs: 200, negativeLabel: "C - Not a Right POC",
      }));
      expect(r.temp).toBe("cold");
      expect(r.disqualified).toBe(true);
    });
  });
});
