import { describe, it, expect } from "vitest";
import { aggregate } from "../lib/sync/aggregate";
import { makeEtContext } from "../lib/sync/buckets";
import { Activity } from "../lib/sync/types";
import { OwnedCompany } from "../lib/sync/pull";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 5, 29, 16, 0, 0); // 2026-06-29 12:00 EDT (US/Eastern, UTC-4)
const REP = "69016314"; // Rajveer Singh (must exist in config/reps.ts)

const CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7"; // "Connected"
const BUSY = "9d9162e7-6cf3-4944-bf63-4dff82258764"; // "Busy" -> not connected
const MEETING = "243ad062-d38f-40ea-86e2-10040d9ce4bd"; // "C - Meeting Scheduled" -> hot

function act(partial: Partial<Activity>): Activity {
  return {
    id: Math.random().toString(36).slice(2),
    type: "call", ownerId: REP, timestampMs: NOW,
    disposition: null, emailStatus: null,
    emailOpened: false, emailReplied: false, emailClicked: false,
    contactIds: [], companyIds: [],
    ...partial,
  };
}

function own(p: Partial<OwnedCompany> & { id: string }): OwnedCompany {
  return {
    name: p.id, gdStage: null, gdId: null, isGroup: false,
    groupName: null, segment: null, dealershipType: null, ...p,
  };
}

describe("aggregate", () => {
  const ctx = makeEtContext(NOW);
  const activities: Activity[] = [
    act({ type: "call", disposition: CONNECTED, contactIds: ["A"], companyIds: ["X"] }),
    act({ type: "email", emailStatus: "SENT", emailOpened: true, contactIds: ["A"], companyIds: ["X"] }),
    act({ type: "call", disposition: BUSY, contactIds: ["B"], companyIds: ["X"] }),
    act({ type: "call", disposition: MEETING, contactIds: ["C"], companyIds: ["Y"] }),
    // Taps group rooftop G1 60 days ago: cumulative-only, in NO period. Proves book != period.
    act({ type: "call", disposition: CONNECTED, companyIds: ["G1"], timestampMs: NOW - 60 * DAY_MS }),
  ];
  // Owned book: two singles (X tapped, Z untapped) + one GD of two rooftops (G1 tapped, G2 not).
  const owned = {
    [REP]: [
      own({ id: "X", name: "Acme", gdStage: "In Pipeline", segment: "mm_single", dealershipType: "Independent" }),
      own({ id: "Z", name: "Zeta", gdStage: "Prospect", segment: "mm_single" }),
      // GD-level stage is consistent across a group's rooftops.
      own({ id: "G1", name: "Group A", gdStage: "In Pipeline", gdId: "900", isGroup: true, groupName: "Big Auto Group", segment: "mm_group", dealershipType: "Franchise" }),
      own({ id: "G2", name: "Group B", gdStage: "In Pipeline", gdId: "900", isGroup: true, groupName: "Big Auto Group", segment: "mm_group", dealershipType: "Franchise" }),
    ],
  };
  const contactMeta = {
    A: { name: "Alice Owner", title: "Owner", dm: true },
    B: { name: "Bob Rep", title: "Sales Rep", dm: false },
    C: { name: "Carol", title: null, dm: false },
  };
  const snap = aggregate(
    activities,
    { X: "Acme", Y: "Yoyodyne", G1: "Group A" },
    { X: "In Pipeline", Y: "Prospect" }, // companyGdStage (drives per-account chip)
    contactMeta,
    owned,
    ctx, NOW, { calls: true, emails: true },
  );
  const today = snap.reps[REP].periods.today;
  const book = snap.reps[REP].book;

  it("reports unique reach split by activity (period-scoped, ignores the old G1 tap)", () => {
    expect(today.contacts.total).toBe(3);
    expect(today.contacts.both).toBe(1); // A via call + email
    expect(today.companies.total).toBe(2); // X, Y only
  });

  it("tracks email engagement", () => {
    expect(today.emails.sent).toBe(1);
    expect(today.emails.opened).toBe(1);
    expect(today.emails.open_rate).toBe(1);
  });

  it("computes decision-maker reach", () => {
    expect(today.titled_contacts).toBe(2); // Owner + Sales Rep
    expect(today.dm_contacts).toBe(1); // Owner
  });

  it("classifies account temperature with reasons", () => {
    expect(today.temp.hot).toBe(1); // Y: meeting
    expect(today.temp.warm).toBe(1); // X: connected
    const rows = today.company_breakdown!;
    expect(rows.find((r) => r.id === "Y")!.temp_reason).toMatch(/meeting/i);
    expect(rows.find((r) => r.id === "X")!.temp_reason).toMatch(/connected/i);
  });

  it("produces a quality score and period insights", () => {
    expect(today.quality.score).toBeGreaterThan(0);
    expect(today.insights.some((i) => i.text.toLowerCase().includes("meeting"))).toBe(true);
  });

  it("attaches title/dm to per-account contacts", () => {
    const acme = today.company_breakdown!.find((r) => r.id === "X")!;
    const alice = acme.contacts_list!.find((c) => c.id === "A")!;
    expect(alice).toMatchObject({ name: "Alice Owner", title: "Owner", dm: true });
  });

  it("builds a daily series and does not leak into last_week (old tap excluded)", () => {
    const daily = snap.reps[REP].daily;
    expect(daily[daily.length - 1]).toMatchObject({ date: "2026-06-29", calls: 3, connected: 2, emails: 1 });
    expect(snap.reps[REP].periods.last_week.calls.total).toBe(0);
  });

  it("computes cumulative book coverage at GD/Single unit level", () => {
    expect(book.rooftops_total).toBe(4);
    expect(book.units_total).toBe(3); // X, Z, and the GD (G1+G2 collapsed)
    expect(book.gds).toBe(1);
    expect(book.singles).toBe(2);
    expect(book.units_tapped).toBe(2); // X (single) + GD (via G1)
    expect(book.pct).toBe(0.667);
  });

  it("rolls a GD up to one unit — tapped if ANY owned rooftop is tapped", () => {
    expect(book.by_group_kind.group).toEqual({ total: 1, tapped: 1 }); // GD tapped via G1 only
    expect(book.by_group_kind.single).toEqual({ total: 2, tapped: 1 }); // X tapped, Z not
  });

  it("segments coverage by GD-level lifecycle stage (lifecycle_stage_gd_level)", () => {
    expect(book.by_stage["In Pipeline"]).toEqual({ total: 2, tapped: 2 }); // X + GD900
    expect(book.by_stage["Prospect"]).toEqual({ total: 1, tapped: 0 }); // Z only
  });

  it("segments coverage by dealership type and market segment", () => {
    expect(book.by_dealership.Franchise).toEqual({ total: 1, tapped: 1 }); // GD
    expect(book.by_dealership.Independent).toEqual({ total: 1, tapped: 1 }); // X
    expect(book.by_dealership.Unknown).toEqual({ total: 1, tapped: 0 }); // Z
    expect(book.by_segment.mm_group).toEqual({ total: 1, tapped: 1 }); // GD
    expect(book.by_segment.mm_single).toEqual({ total: 2, tapped: 1 }); // X, Z
  });

  it("lists untapped units and emits a coverage insight", () => {
    expect(book.untapped_sample.map((u) => u.name)).toContain("Zeta");
    expect(book.insights.some((i) => i.text.toLowerCase().includes("tapped"))).toBe(true);
  });

  it("builds GD/single units with rooftop drill-down that reconciles with coverage", () => {
    expect(book.units).toHaveLength(3);
    expect(book.units.filter((u) => u.tapped)).toHaveLength(book.units_tapped);
    const gd = book.units[0]; // groups sort first
    expect(gd.key).toBe("gd:900");
    expect(gd.isGroup).toBe(true);
    expect(gd.tapped).toBe(true);
    expect(gd.rooftops.map((r) => r.id)).toEqual(["G1", "G2"]); // tapped first
    const g1 = gd.rooftops[0];
    expect(g1).toMatchObject({ tapped: true, calls: 1, connected: 1, emails: 0, last_ms: NOW - 60 * DAY_MS });
    expect(g1.temp).toBe("warm"); // connected but no meeting/reply
    expect(g1.contacts).toEqual([]); // that call carried no contacts
    const g2 = gd.rooftops[1];
    expect(g2).toMatchObject({ tapped: false, temp: "cold", temp_reason: "Untouched", last_ms: null });
  });

  it("ranks engaged contacts per rooftop (top-5 by touches, meta attached)", () => {
    const acme = book.units.find((u) => u.key === "single:X")!;
    expect(acme.rooftops).toHaveLength(1);
    const contacts = acme.rooftops[0].contacts;
    expect(contacts.map((c) => c.id)).toEqual(["A", "B"]); // A: 2 touches, B: 1
    expect(contacts[0]).toMatchObject({ name: "Alice Owner", title: "Owner", dm: true, calls: 1, emails: 1 });
    expect(contacts[1]).toMatchObject({ name: "Bob Rep", calls: 1, emails: 0 });
  });

  it("sorts units groups-first then singles by name", () => {
    expect(book.units.map((u) => u.key)).toEqual(["gd:900", "single:X", "single:Z"]);
  });

  it("caps rooftop contacts at top-5 by touches", () => {
    const many: Activity[] = ["P1", "P2", "P3", "P4", "P5", "P6"].flatMap((c, i) =>
      Array.from({ length: i + 1 }, () => act({ type: "call", disposition: BUSY, contactIds: [c], companyIds: ["X"] })),
    );
    const snap2 = aggregate(
      [...activities, ...many],
      { X: "Acme" }, {}, contactMeta, owned, ctx, NOW, { calls: true, emails: true },
    );
    const roof = snap2.reps[REP].book.units.find((u) => u.key === "single:X")!.rooftops[0];
    expect(roof.contacts).toHaveLength(5);
    expect(roof.contacts[0].id).toBe("P6"); // 6 touches, most engaged
    expect(roof.contacts.map((c) => c.id)).not.toContain("P1"); // 1 touch + A/B outweighed — dropped
  });
});
