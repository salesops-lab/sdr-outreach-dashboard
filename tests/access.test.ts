import { describe, it, expect } from "vitest";
import { decideScope } from "../lib/access/scope";
import { REP_OWNER_IDS } from "../config/reps";
import { sdrOwnersInPod, sdrOwnersUnderManager } from "../config/team-structure";

const ALL = [...REP_OWNER_IDS];

// Real owner ids from config/team-structure.
const PRABHJEET = "160955299"; // manager (player-coach)
const VAIBHAV = "159458371"; // top manager over TLs Shikhar + Kshitij
const SHIKHAR = "79785093"; // TL under Vaibhav
const SANAMDEEP = "66975998"; // plain SDR (not a manager), in Rajveer's team / archit pod
const AE_SAARTHAK = "saarthak.seth@spyne.ai";

describe("decideScope", () => {
  it("admin/leadership → all tracked + admin flag", () => {
    expect(decideScope("boss@spyne.ai", { role: "admin", team_id: null }, null, ALL)).toMatchObject({ role: "admin", isAdmin: true, defaultOwnerIds: ALL });
    expect(decideScope("l@spyne.ai", { role: "leadership", team_id: null }, null, ALL).isAdmin).toBe(true);
  });

  it("AE pod lead (by email) → the pod's tracked SDRs", () => {
    const v = decideScope(AE_SAARTHAK, { role: "manager", team_id: "T" }, null, ALL);
    const expected = sdrOwnersInPod("saarthak").filter((id) => ALL.includes(id));
    expect(v.role).toBe("manager");
    expect(new Set(v.defaultOwnerIds)).toEqual(new Set(expected));
    expect(v.defaultOwnerIds.length).toBeGreaterThan(1);
  });

  it("player-coach manager (by owner id) → their team incl. self", () => {
    const v = decideScope("prabhjeet@spyne.ai", null, PRABHJEET, ALL);
    expect(v.role).toBe("manager");
    expect(v.defaultOwnerIds).toContain(PRABHJEET); // self included
    expect(v.defaultOwnerIds).toContain("163855147"); // Gagandeep, on her team
  });

  it("top manager sees TLs' teams too (recursive subtree)", () => {
    const v = decideScope("vaibhav@spyne.ai", null, VAIBHAV, ALL);
    const shikharTeam = sdrOwnersUnderManager("shikhar").filter((id) => ALL.includes(id));
    for (const id of shikharTeam) expect(v.defaultOwnerIds).toContain(id); // Vaibhav ⊇ Shikhar's team
    expect(v.defaultOwnerIds.length).toBeGreaterThan(sdrOwnersUnderManager("shikhar").length);
  });

  it("a TL sees only their own sub-team, not the whole org", () => {
    const v = decideScope("shikhar@spyne.ai", null, SHIKHAR, ALL);
    expect(v.defaultOwnerIds).toContain("164014269"); // Palak, on Shikhar's team
    expect(v.defaultOwnerIds).not.toContain("164380450"); // Shubham reports to TL Kshitij, not Shikhar
    expect(v.defaultOwnerIds).not.toContain("160353848"); // Utsav reports to Vaibhav directly
  });

  it("plain tracked SDR → own data", () => {
    expect(decideScope("sana@spyne.ai", null, SANAMDEEP, ALL)).toMatchObject({ role: "rep", defaultOwnerIds: [SANAMDEEP] });
  });

  it("everyone else → viewer with org-wide default", () => {
    expect(decideScope("cs@spyne.ai", null, null, ALL)).toMatchObject({ role: "viewer", isAdmin: false, defaultOwnerIds: ALL });
  });
});
