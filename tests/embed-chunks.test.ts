import { describe, it, expect } from "vitest";
import { composeChunk, cleanEmailBody, CHUNK_CAP, EMAIL_BODY_CAP } from "../lib/agent/embed-chunks";

const base = { type: "call", call_title: null, call_body: null, call_summary: null, transcript: null, email_subject: null };

describe("composeChunk — what earns a vector", () => {
  it("composes title + summary + notes + transcript for calls", () => {
    const c = composeChunk({ ...base, call_title: "Disco w/ Matt", call_summary: "Asked about pricing.", call_body: "GM engaged", transcript: "SDR: hi..." })!;
    expect(c).toContain("Disco w/ Matt");
    expect(c).toContain("Summary: Asked about pricing.");
    expect(c).toContain("Notes: GM engaged");
    expect(c).toContain("Transcript: SDR: hi...");
  });

  it("skips title-only calls and duplicate body==summary", () => {
    expect(composeChunk({ ...base, call_title: "Call with John" })).toBeNull();
    const dup = composeChunk({ ...base, call_summary: "Same text", call_body: "Same text" })!;
    expect(dup.match(/Same text/g)).toHaveLength(1);
  });

  it("embeds email subjects only when substantive", () => {
    expect(composeChunk({ ...base, type: "email", email_subject: "Spyne AI photography for Southern Ford" }))
      .toBe("Email subject: Spyne AI photography for Southern Ford");
    expect(composeChunk({ ...base, type: "email", email_subject: "Re: hi" })).toBeNull();
  });

  it("caps long transcripts at CHUNK_CAP", () => {
    const c = composeChunk({ ...base, transcript: "x".repeat(10_000) })!;
    expect(c.length).toBe(CHUNK_CAP);
  });

  it("includes the email BODY (cleaned + capped), not just the subject", () => {
    const body = "Hi Matt,\n\nSharing the per-rooftop pricing we discussed.\n\nOn Jul 10, 2026 Matt Davis wrote:\n> old thread junk";
    const c = composeChunk({ ...base, type: "email", email_subject: "Pricing for Schepel", email_body: body })!;
    expect(c).toContain("Email subject: Pricing for Schepel");
    expect(c).toContain("per-rooftop pricing");
    expect(c).not.toContain("old thread junk"); // reply chain stripped
    const long = composeChunk({ ...base, type: "email", email_body: "y".repeat(9_000) })!;
    expect(long.length).toBeLessThanOrEqual(EMAIL_BODY_CAP + "Body: ".length);
  });
});

describe("cleanEmailBody", () => {
  it("cuts at reply-chain markers and collapses whitespace", () => {
    expect(cleanEmailBody("New part.\nFrom: someone@x.com\nOld part")).toBe("New part.");
    expect(cleanEmailBody("Keep.\n\n\n\nAlso keep.")).toBe("Keep.\n\nAlso keep.");
  });
});
