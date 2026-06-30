import { describe, it, expect } from "vitest";
import { aggregate } from "../lib/sync/aggregate";
import { makeIstContext } from "../lib/sync/buckets";
import { Activity } from "../lib/sync/types";

const NOW = Date.UTC(2026, 5, 29, 6, 30, 0); // noon IST
const REP = "69016314"; // Rajveer Singh (must exist in config/reps.ts)

const CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7"; // "Connected"
const BUSY = "9d9162e7-6cf3-4944-bf63-4dff82258764"; // "Busy" -> not connected
const MEETING = "243ad062-d38f-40ea-86e2-10040d9ce4bd"; // "C - Meeting Scheduled" -> hot

function act(partial: Partial<Activity>): Activity {
  return {
    id: Math.random().toString(36).slice(2),
    type: "call",
    ownerId: REP,
    timestampMs: NOW,
    disposition: null,
    emailStatus: null,
    contactIds: [],
    companyIds: [],
    ...partial,
  };
}

describe("aggregate", () => {
  const ctx = makeIstContext(NOW);
  const activities: Activity[] = [
    act({ type: "call", disposition: CONNECTED, contactIds: ["A"], companyIds: ["X"] }),
    act({ type: "email", emailStatus: "SENT", contactIds: ["A"], companyIds: ["X"] }),
    act({ type: "call", disposition: BUSY, contactIds: ["B"], companyIds: ["X"] }),
    act({ type: "call", disposition: MEETING, contactIds: ["C"], companyIds: ["Y"] }),
  ];
  const owned = { [REP]: [{ id: "X", name: "Acme" }, { id: "Z", name: "Zeta" }] };
  const snap = aggregate(
    activities,
    { X: "Acme", Y: "Yoyodyne" },
    { A: "Alice Smith", B: "Bob Jones", C: "Carol Lee" },
    owned,
    ctx,
    NOW,
    { calls: true, emails: true },
  );
  const today = snap.reps[REP].periods.today;

  it("reports unique reach split by activity", () => {
    expect(today.contacts.total).toBe(3); // A, B, C
    expect(today.contacts.both).toBe(1); // A reached via call + email
    expect(today.contacts.via_call).toBe(3); // A, B, C all called
    expect(today.contacts.via_email).toBe(1); // A only
    expect(today.companies.total).toBe(2); // X, Y
    expect(today.companies.via_email).toBe(1); // only X got an email
  });

  it("classifies connect rate (human-reached only) and meetings", () => {
    expect(today.calls.total).toBe(3);
    expect(today.calls.connected).toBe(2); // Connected + Meeting Scheduled
    expect(today.calls.not_connected).toBe(1); // Busy
    expect(today.meetings_booked).toBe(1);
  });

  it("classifies account temperature from outcomes", () => {
    // X: connected (Connected) -> warm; Y: meeting -> hot.
    expect(today.temp.hot).toBe(1);
    expect(today.temp.warm).toBe(1);
    expect(today.temp.cold).toBe(0);
  });

  it("computes coverage against the owned book", () => {
    expect(today.coverage.owned_total).toBe(2); // X, Z
    expect(today.coverage.owned_tapped).toBe(1); // only X tapped (Y not owned)
    expect(today.coverage.pct).toBe(0.5);
    expect(today.coverage.untapped_count).toBe(1); // Z
  });

  it("produces a quality score and insights", () => {
    expect(today.quality.score).toBeGreaterThan(0);
    expect(["A", "B", "C", "D", "F"]).toContain(today.quality.grade);
    expect(today.insights.length).toBeGreaterThan(0);
    expect(today.insights.some((i) => i.text.includes("meeting"))).toBe(true);
  });

  it("includes a per-company breakdown with temp, ownership, and named contacts", () => {
    const rows = today.company_breakdown!;
    const acme = rows.find((r) => r.id === "X")!;
    expect(acme).toMatchObject({ name: "Acme", temp: "warm", owned: true });
    expect(acme.contacts_list?.map((c) => c.name).sort()).toEqual(["Alice Smith", "Bob Jones"]);
    const yoyo = rows.find((r) => r.id === "Y")!;
    expect(yoyo).toMatchObject({ temp: "hot", owned: false });
  });

  it("builds a daily series spanning the window", () => {
    const daily = snap.reps[REP].daily;
    const todayPoint = daily[daily.length - 1];
    expect(todayPoint.date).toBe("2026-06-29");
    expect(todayPoint.calls).toBe(3);
    expect(todayPoint.connected).toBe(2);
    expect(todayPoint.emails).toBe(1);
  });

  it("initializes every tracked rep and does not leak into last_week", () => {
    expect(Object.keys(snap.reps)).toHaveLength(28);
    expect(snap.reps[REP].periods.last_week.calls.total).toBe(0);
    expect(snap.reps[REP].periods.last_week.contacts.total).toBe(0);
  });
});
