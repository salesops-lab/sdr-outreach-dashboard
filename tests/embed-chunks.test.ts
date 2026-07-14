import { describe, it, expect } from "vitest";
import { composeChunk, CHUNK_CAP } from "../lib/agent/embed-chunks";

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
});
