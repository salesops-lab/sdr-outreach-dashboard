import { describe, it, expect } from "vitest";
import { unitKeyFor } from "../lib/sync/aggregate";
import { OwnedCompany } from "../lib/sync/pull";

function oc(p: Partial<OwnedCompany> & { id: string }): OwnedCompany {
  return {
    name: p.id, gdStage: null, lifecycleStage: null, gdId: null, isGroup: false,
    groupName: null, segment: null, dealershipType: null,
    lastActivityMs: null, rooftopLastActivityMs: null, ...p,
  };
}

describe("unitKeyFor — GD/Single classification by group association", () => {
  it("groups by gd_id when present, regardless of the is_group boolean", () => {
    expect(unitKeyFor(oc({ id: "1", gdId: "900", isGroup: true }))).toEqual({ key: "gd:900", isGroup: true });
    // The bug: is_group boolean is false but a gd_id exists → it's still a GD member.
    expect(unitKeyFor(oc({ id: "2", gdId: "900", isGroup: false }))).toEqual({ key: "gd:900", isGroup: true });
  });

  it("groups by dealership_group_name when gd_id is missing (the Auto Credit Solutions bug)", () => {
    // Associated to a Group Dealership (has a group name) but is_group=false and no gd_id.
    // OLD logic mislabelled this "single"; now it's correctly a GD member.
    expect(unitKeyFor(oc({ id: "3", isGroup: false, gdId: null, groupName: "Auto Credit Solutions" })))
      .toEqual({ key: "gd:name:auto credit solutions", isGroup: true });
  });

  it("merges rooftops sharing a group name (no gd_id) into ONE GD unit (Dan Wolf case)", () => {
    const a = unitKeyFor(oc({ id: "10", groupName: "Dan Wolf Automotive Group" }));
    const b = unitKeyFor(oc({ id: "11", groupName: "dan wolf automotive group" })); // case-insensitive merge
    expect(a.key).toBe(b.key);
    expect(a.isGroup).toBe(true);
  });

  it("is a single unit only when there is NO group association at all", () => {
    expect(unitKeyFor(oc({ id: "5", gdId: null, groupName: null, isGroup: false }))).toEqual({ key: "single:5", isGroup: false });
    // is_group flagged true but nothing to group with (no gd_id, no name) → single, never dropped.
    expect(unitKeyFor(oc({ id: "6", gdId: null, groupName: null, isGroup: true }))).toEqual({ key: "single:6", isGroup: false });
    // A blank/whitespace group name is not an association.
    expect(unitKeyFor(oc({ id: "7", groupName: "   " }))).toEqual({ key: "single:7", isGroup: false });
  });
});
