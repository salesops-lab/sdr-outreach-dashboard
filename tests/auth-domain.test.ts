import { describe, it, expect } from "vitest";
import { isAllowedEmail } from "../lib/auth/domain";

describe("isAllowedEmail", () => {
  it("accepts spyne.ai emails case-insensitively", () => {
    expect(isAllowedEmail("kaustubh.chauhan@spyne.ai")).toBe(true);
    expect(isAllowedEmail("X@SPYNE.AI ")).toBe(true);
  });
  it("rejects lookalike domains, subdomains, empty and null", () => {
    expect(isAllowedEmail("a@spyne.ai.evil.com")).toBe(false);
    expect(isAllowedEmail("a@sub.spyne.ai")).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail("a@gmail.com")).toBe(false);
  });
});
