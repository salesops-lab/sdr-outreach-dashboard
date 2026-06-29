import { describe, it, expect } from "vitest";
import { aggregate } from "../lib/sync/aggregate";
import { makeIstContext } from "../lib/sync/buckets";
import { Activity } from "../lib/sync/types";

const NOW = Date.UTC(2026, 5, 29, 6, 30, 0); // noon IST
const REP = "69016314"; // Rajveer Singh (must exist in config/reps.ts)

const CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7"; // "Connected"
const BUSY = "9d9162e7-6cf3-4944-bf63-4dff82258764"; // "Busy" -> not connected

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
  ];
  const snap = aggregate(activities, { X: "Acme" }, ctx, NOW, { calls: true, emails: true });
  const today = snap.reps[REP].periods.today;

  it("counts unique contacts and companies", () => {
    expect(today.unique_contacts).toBe(2); // A, B
    expect(today.unique_companies).toBe(1); // X
    expect(today.companies_with_contact).toBe(1);
    expect(today.avg_contacts_per_company).toBe(2); // A and B both at X
  });

  it("classifies calls and connect rate (human-reached only)", () => {
    expect(today.calls.total).toBe(2);
    expect(today.calls.connected).toBe(1);
    expect(today.calls.not_connected).toBe(1); // Busy is NOT connected
    expect(today.calls.null_disposition).toBe(0);
    expect(today.calls.connect_rate).toBe(0.5);
  });

  it("counts emails", () => {
    expect(today.emails.sent).toBe(1);
    expect(today.emails.bounced).toBe(0);
  });

  it("computes channel mix over contacts", () => {
    // A reached via call+email -> both; B via call only.
    expect(today.channel_mix.both).toBe(1);
    expect(today.channel_mix.call_only).toBe(1);
    expect(today.channel_mix.email_only).toBe(0);
  });

  it("includes a per-company breakdown for narrow periods", () => {
    expect(today.company_breakdown).toBeDefined();
    expect(today.company_breakdown).toHaveLength(1);
    expect(today.company_breakdown![0]).toMatchObject({ name: "Acme", contacts: 2, calls: 2, emails: 1 });
  });

  it("initializes every tracked rep, even with no activity", () => {
    expect(Object.keys(snap.reps)).toHaveLength(28);
    const idle = Object.values(snap.reps).find((r) => r.periods.today.calls.total === 0)!;
    expect(idle.periods.today.unique_contacts).toBe(0);
  });

  it("does not leak today's activity into last_week", () => {
    expect(snap.reps[REP].periods.last_week.calls.total).toBe(0);
  });
});
