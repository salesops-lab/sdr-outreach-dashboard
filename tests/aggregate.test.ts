import { describe, it, expect } from "vitest";
import { aggregate, demoScheduledMs, demoCompletedMs, computeRepPipeline } from "../lib/sync/aggregate";
import { makeEtContext } from "../lib/sync/buckets";
import { Activity, Deal } from "../lib/sync/types";
import { OwnedCompany } from "../lib/sync/pull";
import { DealStageKey, AUTO_PIPELINE_ID } from "../config/deal-stages";
import { configTeamStructure } from "../lib/team/config-source";
import { trackedOwnerIds, nameMap } from "../lib/team/helpers";

// Full config-derived roster (= the pre-DB behavior: aggregate iterated all REP_OWNER_IDS).
const TS = configTeamStructure();
const ROSTER = { ownerIds: trackedOwnerIds(TS), names: nameMap(TS) };

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
    name: p.id, gdStage: null, lifecycleStage: null, gdId: null, isGroup: false,
    groupName: null, segment: null, dealershipType: null,
    lastActivityMs: null, rooftopLastActivityMs: null, ...p,
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
    ctx, NOW, { calls: true, emails: true }, ROSTER,
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

  it("marks a GD tapped when activity is present on any company-level rooftop", () => {
    const gdOnly = aggregate(
      [act({ type: "email", companyIds: ["G2"], timestampMs: NOW - 10 * DAY_MS })],
      { G2: "Group B" }, {}, contactMeta, owned, ctx, NOW, { calls: true, emails: true }, ROSTER,
    ).reps[REP].book;

    const gd = gdOnly.units.find((u) => u.key === "gd:900")!;
    expect(gd).toMatchObject({ tapped: true, temp: "cold" });
    expect(gdOnly.units_tapped).toBe(1);
    expect(gd.rooftops.find((r) => r.id === "G2")).toMatchObject({ tapped: true, emails: 1 });
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
    expect(gd).toMatchObject({ temp: "warm", temp_reason: expect.stringMatching(/connected/i) });
    expect(gd.rooftops.map((r) => r.id)).toEqual(["G1", "G2"]); // tapped first
    const g1 = gd.rooftops[0];
    expect(g1).toMatchObject({ tapped: true, calls: 1, connected: 1, emails: 0, last_ms: NOW - 60 * DAY_MS });
    expect(g1.temp).toBe("warm"); // connected but no meeting/reply
    expect(g1.contacts).toEqual([]); // that call carried no contacts
    const g2 = gd.rooftops[1];
    expect(g2).toMatchObject({ tapped: false, temp: "cold", temp_reason: "Untouched", last_ms: null });
    const zeta = book.units.find((u) => u.key === "single:Z")!;
    expect(zeta).toMatchObject({ tapped: false, temp: "cold", temp_reason: "Untouched" });
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

  it("ranks all engaged rooftop contacts by touches (cap raised above 5 for the contacts table)", () => {
    const many: Activity[] = ["P1", "P2", "P3", "P4", "P5", "P6"].flatMap((c, i) =>
      Array.from({ length: i + 1 }, () => act({ type: "call", disposition: BUSY, contactIds: [c], companyIds: ["X"] })),
    );
    const snap2 = aggregate(
      [...activities, ...many],
      { X: "Acme" }, {}, contactMeta, owned, ctx, NOW, { calls: true, emails: true }, ROSTER,
    );
    const roof = snap2.reps[REP].book.units.find((u) => u.key === "single:X")!.rooftops[0];
    expect(roof.contacts[0].id).toBe("P6"); // 6 touches, most engaged
    expect(roof.contacts.length).toBeGreaterThan(5); // no longer truncated at 5
    expect(roof.contacts.map((c) => c.id)).toContain("P1"); // low-touch contacts still listed
  });

  it("gives each rooftop contact its own recency + temperature", () => {
    const g1 = book.units[0].rooftops[0]; // G1: one connected call, no contacts
    const acme = book.units.find((u) => u.key === "single:X")!.rooftops[0];
    const alice = acme.contacts.find((c) => c.id === "A")!;
    expect(alice.last_ms).toBe(NOW); // A's latest touch (call + email both at NOW)
    expect(["call", "email"]).toContain(alice.last_type);
    expect(alice.temp).toBe("warm"); // A got a connected call → warm
    expect(g1.contacts).toEqual([]);
  });
});

// ── Temperature engine v2: outcome-driven rules + disqualification ──────────────────
describe("temperature engine v2 (outcome-driven)", () => {
  const ctx = makeEtContext(NOW);
  const CALLBACK_HIGH = "af20b15f-39a5-4a40-94e4-63cbe341cf1b";
  const CALLBACK_LOW = "c7480f13-6eba-48d0-b203-40715b7ffc4d";
  const REFERRAL = "69252e11-115b-4049-89cd-4952b899a4fc";
  const NOT_INTERESTED = "09a2d1c9-49ef-4371-8968-0af01bca7893"; // connected but negative
  const HR = 3_600_000;

  /** Run aggregate over some activities and return today's company_breakdown keyed by id. */
  function tempOf(activities: Activity[]): Record<string, { temp: string; reason: string; disqualified: boolean }> {
    const snap = aggregate(activities, {}, {}, {}, {}, ctx, NOW, { calls: true, emails: true }, ROSTER);
    const rows = snap.reps[REP].periods.today.company_breakdown ?? [];
    return Object.fromEntries(rows.map((r) => [r.id, { temp: r.temp, reason: r.temp_reason, disqualified: r.disqualified }]));
  }

  it("callback low intent ×2 is hot; ×1 is warm", () => {
    const r = tempOf([
      act({ disposition: CALLBACK_LOW, companyIds: ["C1"], timestampMs: NOW - 2 * HR }),
      act({ disposition: CALLBACK_LOW, companyIds: ["C1"], timestampMs: NOW - HR }),
      act({ disposition: CALLBACK_LOW, companyIds: ["C2"] }),
    ]);
    expect(r.C1.temp).toBe("hot");
    expect(r.C2.temp).toBe("warm");
  });

  it("callback high intent is hot; a referral is warm", () => {
    const r = tempOf([
      act({ disposition: CALLBACK_HIGH, companyIds: ["C1"] }),
      act({ disposition: REFERRAL, companyIds: ["C2"] }),
    ]);
    expect(r.C1.temp).toBe("hot");
    expect(r.C2).toMatchObject({ temp: "warm", reason: expect.stringMatching(/referral/i) });
  });

  it("a connected-but-not-interested account is cold and disqualified", () => {
    const r = tempOf([act({ disposition: NOT_INTERESTED, companyIds: ["C1"] })]);
    expect(r.C1).toMatchObject({ temp: "cold", disqualified: true });
    expect(r.C1.reason).toMatch(/disqualified/i);
  });

  it("a later positive signal rescues a disqualified account; a later negative re-disqualifies", () => {
    const rescued = tempOf([
      act({ disposition: NOT_INTERESTED, companyIds: ["C1"], timestampMs: NOW - 2 * HR }),
      act({ disposition: MEETING, companyIds: ["C1"], timestampMs: NOW - HR }),
    ]);
    expect(rescued.C1).toMatchObject({ temp: "hot", disqualified: false });

    const lost = tempOf([
      act({ disposition: MEETING, companyIds: ["C2"], timestampMs: NOW - 2 * HR }),
      act({ disposition: NOT_INTERESTED, companyIds: ["C2"], timestampMs: NOW - HR }),
    ]);
    expect(lost.C2).toMatchObject({ temp: "cold", disqualified: true });
  });
});

// ── Owner != activity-doer: a teammate's work is "worked by others", NOT owner-tapped ─────
describe("owner != activity-doer coverage (60-day owner-recency model)", () => {
  const ctx = makeEtContext(NOW);
  const OWNER = "69016314"; // Rajveer Singh (owns the account)
  const TEAMMATE = "66975998"; // Sanamdeep — a different tracked rep does the work

  it("classifies a teammate's activity on an owned account as WORKED-BY-OTHER, not tapped", () => {
    const owned = { [OWNER]: [own({ id: "W", name: "Westside Auto", gdStage: "Prospect", segment: "mm_single" })] };
    const snap = aggregate(
      [act({ ownerId: TEAMMATE, type: "call", disposition: CONNECTED, contactIds: ["Z"], companyIds: ["W"] })],
      { W: "Westside Auto" }, {}, { Z: { name: "Zed", title: "GM", dm: true } }, owned, ctx, NOW, { calls: true, emails: true }, ROSTER,
    );
    const book = snap.reps[OWNER].book;
    expect(book.units_tapped).toBe(0); // the OWNER did not work it → not tapped
    expect(book.units_worked_by_other).toBe(1); // a different tracked rep did → its own bucket
    const w = book.units.find((u) => u.key === "single:W")!;
    expect(w).toMatchObject({ tapped: false, coverage: "worked_by_other" });
    expect(w.rooftops[0]).toMatchObject({ coverage: "worked_by_other", calls: 1, connected: 1 });
    expect(w.temp).not.toBe("cold"); // connected → warm: the account IS engaged, not "untouched"
    expect(snap.reps[TEAMMATE].book.units_total).toBe(0); // teammate owns nothing here
  });

  it("counts the OWNER's own recent activity as tapped", () => {
    const owned = { [OWNER]: [own({ id: "W2", name: "Owner-worked Auto", segment: "mm_single" })] };
    const snap = aggregate(
      [act({ ownerId: OWNER, type: "call", disposition: CONNECTED, companyIds: ["W2"], timestampMs: NOW - 5 * DAY_MS })],
      { W2: "Owner-worked Auto" }, {}, {}, owned, ctx, NOW, { calls: true, emails: true }, ROSTER,
    );
    const book = snap.reps[OWNER].book;
    expect(book.units_tapped).toBe(1);
    expect(book.units.find((u) => u.key === "single:W2")!).toMatchObject({ tapped: true, coverage: "tapped" });
  });

  it("treats the owner's OLD activity (>60 days) as untapped (recency window)", () => {
    const owned = { [OWNER]: [own({ id: "W3", name: "Stale Auto", segment: "mm_single" })] };
    const snap = aggregate(
      [act({ ownerId: OWNER, type: "call", disposition: CONNECTED, companyIds: ["W3"], timestampMs: NOW - 75 * DAY_MS })],
      { W3: "Stale Auto" }, {}, {}, owned, ctx, NOW, { calls: true, emails: true }, ROSTER,
    );
    const book = snap.reps[OWNER].book;
    expect(book.units_tapped).toBe(0); // owner touched it, but >60d ago → untapped
    expect(book.units.find((u) => u.key === "single:W3")!.coverage).toBe("untapped");
  });

  it("flags a GD as mixed-owner when its rooftops span >1 tracked owner", () => {
    const owned = {
      [OWNER]: [own({ id: "R1", name: "Group X - A", gdId: "500", isGroup: true, groupName: "Group X" })],
      [TEAMMATE]: [own({ id: "R2", name: "Group X - B", gdId: "500", isGroup: true, groupName: "Group X" })],
    };
    const snap = aggregate([], {}, {}, {}, owned, ctx, NOW, { calls: true, emails: true }, ROSTER);
    const gdForOwner = snap.reps[OWNER].book.units.find((u) => u.key === "gd:500")!;
    expect(gdForOwner.mixed_owner).toBe(true); // OWNER owns only part of the GD → flagged
    expect(snap.reps[OWNER].book.units_mixed_owner).toBe(1);
    expect(snap.reps[TEAMMATE].book.units.find((u) => u.key === "gd:500")!.mixed_owner).toBe(true);
  });
});

// ── Monthly new-unique tapped (owned book, last 3 US/Eastern months) ─────────────────
describe("monthly new-unique (owned book)", () => {
  const ctx = makeEtContext(NOW); // NOW = 2026-06-29 → current ET month 2026-06
  const OWNER = "69016314";
  const LAST_MONTH = Date.UTC(2026, 4, 15, 16); // 2026-05-15 (ET May)
  const owned = { [OWNER]: [own({ id: "X", name: "Xco" }), own({ id: "Y", name: "Yco" })] };
  const snap = aggregate(
    [
      act({ ownerId: OWNER, companyIds: ["X"], contactIds: ["c1"], timestampMs: LAST_MONTH }), // X first worked last month
      act({ ownerId: OWNER, companyIds: ["X"], contactIds: ["c1"], timestampMs: NOW }), // X again this month (not new)
      act({ ownerId: OWNER, companyIds: ["Y"], contactIds: ["c2"], timestampMs: NOW }), // Y first worked this month (new)
    ],
    { X: "Xco", Y: "Yco" }, {}, {}, owned, ctx, NOW, { calls: true, emails: true }, ROSTER,
  );
  const monthly = snap.reps[OWNER].monthly;

  it("returns the last 3 months, newest first", () => {
    expect(monthly).toHaveLength(3);
    expect(monthly.map((m) => m.month)).toEqual(["2026-06", "2026-05", "2026-04"]);
  });

  it("separates NEW rooftops from ones worked in a prior month", () => {
    expect(monthly[0]).toMatchObject({ rooftops_engaged: 2, rooftops_new: 1 }); // X+Y engaged; only Y new
    expect(monthly[1]).toMatchObject({ rooftops_engaged: 1, rooftops_new: 1 }); // X engaged + new last month
  });

  it("separates NEW contacts too", () => {
    expect(monthly[0].contacts_engaged).toBe(2); // c1 (X) + c2 (Y) touched this month
    expect(monthly[0].contacts_new).toBe(1); // c2 new; c1 first engaged last month
  });
});

describe("aggregate — deals (V2)", () => {
  const ctx = makeEtContext(NOW);
  function deal(p: Partial<Deal> & { id: string; companyId: string; stageKey: DealStageKey }): Deal {
    return {
      pipeline: AUTO_PIPELINE_ID, dealstage: null, dealOwnerId: null, sdrOwnerId: null,
      contactIds: [], amount: null, demoScheduledForMs: null, discoveryDoneMs: null, demoDoneMs: null, ...p,
    };
  }
  // Owned book: X (touched, has a scheduled deal), Y (a completed-demo deal), Z (no deal).
  const owned = { [REP]: [own({ id: "X", name: "Xco" }), own({ id: "Y", name: "Yco" }), own({ id: "Z", name: "Zco" })] };
  const acts = [act({ companyIds: ["X"], disposition: CONNECTED, contactIds: ["c1"] })];
  const deals = [
    deal({ id: "d1", companyId: "X", stageKey: "discovery_done", demoScheduledForMs: NOW + DAY_MS }),
    deal({ id: "d2", companyId: "Y", stageKey: "demo_done" }),
  ];
  const snap = aggregate(
    acts, { X: "Xco", Y: "Yco", Z: "Zco" }, {}, { c1: { name: "C1", title: null, dm: false } },
    owned, ctx, NOW, { calls: true, emails: true }, { ...ROSTER, kinds: { [REP]: "sdr" } }, deals,
  );
  const rep = snap.reps[REP];

  it("funnel segments owned rooftops (no deal → pending)", () => {
    expect(rep.funnel.demo_scheduled).toBe(1); // X
    expect(rep.funnel.demo_done).toBe(1); // Y
    expect(rep.funnel.demo_pending).toBe(1); // Z (no deal)
  });

  it("attaches deal block + Deal Health to the rooftop with a live advanced deal", () => {
    const roofX = rep.book.units.flatMap((u) => u.rooftops).find((r) => r.id === "X");
    expect(roofX?.deal?.demo_status).toBe("demo_scheduled");
    expect(roofX?.deal?.health).toBe("green"); // upcoming demo date
  });

  it("leaves demo-pending accounts without a deal block (Temperature governs)", () => {
    const roofZ = rep.book.units.flatMap((u) => u.rooftops).find((r) => r.id === "Z");
    expect(roofZ?.deal).toBeUndefined();
  });

  it("exposes owner_kinds for the SDR/AE toggle", () => {
    expect(snap.owner_kinds[REP]).toBe("sdr");
  });
});

// ── V3 funnel truth: event-driven demo metrics + active/inactive pipeline ────────────
describe("aggregate — funnel truth (V3: stage-event demos + pipeline)", () => {
  const ctx = makeEtContext(NOW); // NOW = Monday 2026-06-29 12:00 EDT
  const HR = 3_600_000;
  const AE = "66975998"; // Sanamdeep — designated AE via the kinds map for this test
  function deal(p: Partial<Deal> & { id: string; stageKey: DealStageKey }): Deal {
    return {
      pipeline: AUTO_PIPELINE_ID, dealstage: null, dealOwnerId: null, sdrOwnerId: null,
      companyId: null, contactIds: [], amount: null,
      demoScheduledForMs: null, discoveryDoneMs: null, demoDoneMs: null, ...p,
    };
  }
  const deals = [
    // Scheduled + completed TODAY per the ledger; AE lens sees it via hubspot_owner_id.
    deal({ id: "e1", stageKey: "demo_accepted", sdrOwnerId: REP, dealOwnerId: AE, stageEvents: [
      { stageKey: "discovery_done", enteredMs: NOW - HR, exitedMs: NOW },
      { stageKey: "demo_accepted", enteredMs: NOW, exitedMs: null },
    ] }),
    // Scheduled 90 days ago — in NO period (event truth: old events don't inflate periods).
    deal({ id: "e2", stageKey: "discovery_done", sdrOwnerId: REP, stageEvents: [
      { stageKey: "discovery_done", enteredMs: NOW - 90 * DAY_MS, exitedMs: null },
    ] }),
    // Pre-migration deal (no ledger) — falls back to the stage-date columns. Yesterday = Sunday.
    deal({ id: "e3", stageKey: "demo_done", sdrOwnerId: REP,
      discoveryDoneMs: NOW - DAY_MS, demoDoneMs: NOW - DAY_MS }),
    // Pipeline segregation fodder (current stage).
    deal({ id: "e4", stageKey: "future_prospect", sdrOwnerId: REP }), // parked (locked decision)
    deal({ id: "e5", stageKey: "drop_off_sales", sdrOwnerId: REP }), // lost
    deal({ id: "e6", stageKey: "transferred_cs", sdrOwnerId: REP }), // won (successful exit)
    deal({ id: "e7", stageKey: "mql", sdrOwnerId: REP }), // active, pre-demo
  ];
  const snap = aggregate([], {}, {}, {}, {}, ctx, NOW, { calls: true, emails: true },
    { ...ROSTER, kinds: { [REP]: "sdr", [AE]: "ae" } }, deals);
  const rep = snap.reps[REP];

  it("counts demos scheduled/completed by WHEN the stage was entered (not current stage)", () => {
    expect(rep.periods.today.demos).toEqual({ scheduled: 1, completed: 1 }); // e1 only
    expect(rep.periods.this_month.demos).toEqual({ scheduled: 2, completed: 2 }); // e1 + e3; e2 too old
    expect(rep.periods.last_week.demos).toEqual({ scheduled: 1, completed: 1 }); // e3 (Sunday = last ET week)
  });

  it("falls back to the stage-date columns for deals without a ledger (pre-V3)", () => {
    expect(rep.periods.yesterday.demos).toEqual({ scheduled: 1, completed: 1 }); // e3 via columns
  });

  it("attributes the AE lens via hubspot_owner_id (same deal, two lenses, never summed)", () => {
    const ae = snap.reps[AE];
    expect(ae.periods.today.demos).toEqual({ scheduled: 1, completed: 1 }); // e1
    expect(ae.pipeline).toMatchObject({ total: 1, active: 1, active_post_demo: 1, active_pre_demo: 0 });
  });

  it("segregates the rep's deals into active(pre/post) / parked / won / lost by current stage", () => {
    expect(rep.pipeline).toEqual({
      total: 7,
      active: 4, active_pre_demo: 2, active_post_demo: 2, // e2+e7 pre; e1+e3 post
      parked: 1, // e4 Future Prospect
      won: 1, // e6 Transferred to CS counts as a successful exit
      lost: 1, // e5
      by_stage: { demo_accepted: 1, demo_done: 1, discovery_done: 1, mql: 1 },
    });
  });
});

describe("demoScheduledMs / demoCompletedMs (pure, ledger-first)", () => {
  const base: Deal = {
    id: "d", pipeline: AUTO_PIPELINE_ID, dealstage: null, stageKey: "in_discussion",
    dealOwnerId: null, sdrOwnerId: null, companyId: null, contactIds: [], amount: null,
    demoScheduledForMs: null, discoveryDoneMs: 500, demoDoneMs: 900,
  };

  it("completed = FIRST entry into Demo Done / Accepted / In Discussion (all three count)", () => {
    const d = { ...base, stageEvents: [
      { stageKey: "demo_done" as const, enteredMs: 100, exitedMs: 150 },
      { stageKey: "demo_accepted" as const, enteredMs: 150, exitedMs: 200 },
      { stageKey: "in_discussion" as const, enteredMs: 200, exitedMs: null },
    ] };
    expect(demoCompletedMs(d)).toBe(100); // first of the set, not the latest
  });

  it("scheduled = entry into Discovery Call Done; ledger wins over the column", () => {
    const d = { ...base, stageEvents: [{ stageKey: "discovery_done" as const, enteredMs: 42, exitedMs: null }] };
    expect(demoScheduledMs(d)).toBe(42);
    expect(demoScheduledMs(base)).toBe(500); // no ledger → discovery_call_done_stage_date column
    expect(demoCompletedMs(base)).toBe(900); // no ledger → demo_done_stage_date column
  });

  it("returns null when neither ledger nor columns carry a date", () => {
    expect(demoScheduledMs({ ...base, discoveryDoneMs: null })).toBeNull();
    expect(demoCompletedMs({ ...base, demoDoneMs: null })).toBeNull();
  });

  it("computeRepPipeline ignores out-of-funnel deals except in total", () => {
    expect(computeRepPipeline([{ ...base, stageKey: "other" }])).toEqual({
      total: 1, active: 0, active_pre_demo: 0, active_post_demo: 0,
      parked: 0, won: 0, lost: 0, by_stage: {},
    });
  });
});
