import { describe, it, expect } from "vitest";
import { buildAccountTimeline, TimelineActivityInput } from "../lib/sync/account-timeline";

const CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7"; // "Connected"

function call(p: Partial<TimelineActivityInput> & { id: string; tsMs: number }): TimelineActivityInput {
  return {
    type: "call", ownerId: "S1", disposition: null, emailStatus: null,
    emailOpened: false, emailReplied: false, contactIds: [], ...p,
  };
}

const NAMES = { S1: "SDR One", A1: "AE One" };
const KINDS = { S1: "sdr" as const, A1: "ae" as const };
const META = { c1: { name: "Carol GM", title: "General Manager", dm: true } };

describe("buildAccountTimeline — unified who → whom → outcome history", () => {
  const items = buildAccountTimeline(
    [
      call({ id: "a1", tsMs: 100, disposition: CONNECTED, contactIds: ["c1"] }),
      call({ id: "a2", tsMs: 300, type: "email", ownerId: "A1", emailStatus: "SENT", emailReplied: true }),
      call({ id: "a3", tsMs: 50, type: "email", ownerId: "X9", emailStatus: "BOUNCED" }), // untracked doer
    ],
    [{ dealId: "d1", stageKey: "discovery_done", enteredMs: 200 }],
    META, NAMES, KINDS,
  );

  it("merges activities + stage entries, newest first", () => {
    expect(items.map((i) => i.ts)).toEqual([300, 200, 100, 50]);
    expect(items.map((i) => i.kind)).toEqual(["email", "stage", "call", "email"]);
  });

  it("labels call outcomes via the disposition vocabulary and attaches contact meta", () => {
    const c = items.find((i) => i.kind === "call")!;
    expect(c).toMatchObject({
      outcome: "Connected", owner_name: "SDR One", owner_kind: "sdr",
      contact: { id: "c1", name: "Carol GM", title: "General Manager", dm: true },
    });
  });

  it("colors doers by roster kind; unknown owners get a null kind + id fallback name", () => {
    const ae = items.find((i) => i.kind === "email" && i.ts === 300)!;
    expect(ae).toMatchObject({ owner_kind: "ae", owner_name: "AE One", outcome: "Sent" });
    if (ae.kind !== "stage") expect(ae.replied).toBe(true);
    const stray = items.find((i) => i.ts === 50)!;
    expect(stray).toMatchObject({ owner_kind: null, owner_name: "ID:X9", outcome: "Bounced" });
  });

  it("renders stage entries with the canonical label", () => {
    const s = items.find((i) => i.kind === "stage")!;
    expect(s).toMatchObject({ deal_id: "d1", stage_key: "discovery_done", label: "Discovery Call Done" });
  });

  it("handles a contact with no meta and an activity with no contacts", () => {
    const out = buildAccountTimeline(
      [call({ id: "b1", tsMs: 10, contactIds: ["ghost"] }), call({ id: "b2", tsMs: 5 })],
      [], {}, {}, {},
    );
    expect(out[0]).toMatchObject({ contact: { id: "ghost", name: "Contact ghost", title: null, dm: false }, outcome: "No disposition" });
    expect(out[1]).toMatchObject({ contact: null });
  });
});
