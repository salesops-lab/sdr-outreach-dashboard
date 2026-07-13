import { describe, it, expect } from "vitest";
import { teamFilterOptions } from "../lib/team/helpers";
import { TeamStructure } from "../lib/team/types";

// Hand-built org: one pod with an AE + an SDR, one manager with an SDR + a TL rolling up,
// one empty pod (dropped), one inactive member (excluded).
const TS: TeamStructure = {
  pods: [
    { key: "alpha", name: "Alpha Pod", leadEmail: "lead@spyne.ai" },
    { key: "empty", name: "Empty Pod", leadEmail: null },
  ],
  managers: {
    vaibhav: { key: "vaibhav", name: "Vaibhav", ownerId: "M1" },
    tl1: { key: "tl1", name: "TL One", ownerId: "T1", parent: "vaibhav" },
  },
  members: [
    { ownerId: "A1", email: null, name: "AE One", kind: "ae", aePod: "alpha", managerKey: null, active: true },
    { ownerId: "S1", email: null, name: "SDR One", kind: "sdr", aePod: "alpha", managerKey: "vaibhav", active: true },
    { ownerId: "S2", email: null, name: "SDR Two", kind: "sdr", aePod: null, managerKey: "tl1", active: true },
    { ownerId: "S3", email: null, name: "SDR Gone", kind: "sdr", aePod: "alpha", managerKey: "vaibhav", active: false },
  ],
};

describe("teamFilterOptions — pod/SDR-team filter groups", () => {
  const { pods, teams } = teamFilterOptions(TS);

  it("builds pod options from ACTIVE members (SDRs + AEs) and drops empty pods", () => {
    expect(pods).toHaveLength(1);
    expect(pods[0]).toMatchObject({ key: "pod:alpha", name: "Alpha Pod" });
    expect([...pods[0].ownerIds].sort()).toEqual(["A1", "S1"]); // S3 inactive → excluded
  });

  it("builds team options as the manager's SDR subtree + the player-coach's own id", () => {
    const vaibhav = teams.find((t) => t.key === "team:vaibhav")!;
    // S1 (direct) + S2 (via TL rollup) + M1 (player-coach self)
    expect([...vaibhav.ownerIds].sort()).toEqual(["M1", "S1", "S2"]);
    const tl = teams.find((t) => t.key === "team:tl1")!;
    expect([...tl.ownerIds].sort()).toEqual(["S2", "T1"]);
  });

  it("namespaces keys so pods and teams can share one <select>", () => {
    const keys = [...pods, ...teams].map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.startsWith("pod:") || k.startsWith("team:"))).toBe(true);
  });
});
