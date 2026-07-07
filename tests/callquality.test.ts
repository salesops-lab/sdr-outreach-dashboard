import { describe, it, expect } from "vitest";
import { pickLatestSnapshots, aggregateDims, joinCallInsights } from "../lib/callquality/map";
import { CallRow, CoachingRow, InsightRow } from "../lib/callquality/types";

const coach = (p: Partial<CoachingRow>): CoachingRow => ({
  hubspot_owner_id: "69016314", snapshot_date: "2026-07-06", period_type: "weekly", period_end: "2026-07-05",
  scope: "rep", calls_analyzed: 10, meetings_booked: 2,
  avg_bantic_score: 6.5, avg_quality_score: 3.2, weakest_dimension: "budget",
  top_strengths: ["rapport"], top_risks: ["no next step"], coaching_priorities: ["ask budget"],
  suggested_drills: [], manager_summary: "Solid week.", ...p,
});

const call = (p: Partial<CallRow>): CallRow => ({
  hubspot_call_id: "c1", hubspot_owner_id: "69016314", hubspot_company_id: "X",
  call_date: "2026-07-01T15:00:00Z", call_disposition_label: "Connected",
  call_duration_ms: 300000, recording_url: "https://rec/1",
  score_budget: 6, score_authority: 8, score_need: 7, score_timeline: 5,
  score_impact: 6, score_current_process: 4, overall_score: 6.2, ...p,
});

describe("pickLatestSnapshots", () => {
  it("keeps only the latest weekly rep-scope snapshot per owner", () => {
    const out = pickLatestSnapshots([
      coach({ period_end: "2026-06-28", avg_bantic_score: 5 }),
      coach({ period_end: "2026-07-05", avg_bantic_score: 7 }),
      coach({ hubspot_owner_id: "111", period_end: "2026-07-05", avg_bantic_score: 4 }),
      coach({ period_type: "daily", period_end: "2026-07-06", avg_bantic_score: 9 }), // ignored
      coach({ scope: "team", period_end: "2026-07-06" }), // ignored
      coach({ hubspot_owner_id: null }), // ignored
    ]);
    expect(Object.keys(out).sort()).toEqual(["111", "69016314"]);
    expect(out["69016314"].avgBantic).toBe(7);
    expect(out["69016314"].weakestDimension).toBe("budget");
    expect(out["69016314"].priorities).toEqual(["ask budget"]);
  });

  it("breaks period_end ties by snapshot_date (newer generation wins)", () => {
    const out = pickLatestSnapshots([
      coach({ period_end: "2026-07-05", snapshot_date: "2026-07-01", avg_bantic_score: 5 }),
      coach({ period_end: "2026-07-05", snapshot_date: "2026-07-03", avg_bantic_score: 8 }),
    ]);
    expect(out["69016314"].avgBantic).toBe(8);
  });
});

describe("aggregateDims", () => {
  it("averages each BANTIC dim and overall, skipping nulls per-dim", () => {
    const d = aggregateDims([
      call({ score_budget: 6, overall_score: 6 }),
      call({ hubspot_call_id: "c2", score_budget: null, score_authority: 4, overall_score: 8 }),
    ]);
    expect(d.count).toBe(2);
    expect(d.dims.budget).toBe(6); // null skipped, not zero-averaged
    expect(d.dims.authority).toBe(6); // (8+4)/2
    expect(d.overall).toBe(7);
  });

  it("returns nulls for empty input", () => {
    const d = aggregateDims([]);
    expect(d.count).toBe(0);
    expect(d.overall).toBeNull();
    expect(d.dims.need).toBeNull();
  });
});

describe("joinCallInsights", () => {
  it("joins insight by call id, extracting text from object entries", () => {
    const insights: InsightRow[] = [{
      hubspot_call_id: "c1", quality_score: 3.5, discovery_quality: 3,
      objection_handling: 4, next_step_clarity: 2, talk_control: 3, crm_hygiene: 5,
      coachable_moments: [{ moment: "ask open questions", why_it_matters: "x", coaching_move: "y" }, "plain string tip"],
      quote_examples: [{ label: "brushoff", quote: "'just send info'", coaching_point: "z" }],
      recommended_next_action: "Book follow-up",
    }];
    const rows = joinCallInsights([call({}), call({ hubspot_call_id: "c2" })], insights);
    expect(rows[0].quality).toBe(3.5);
    expect(rows[0].coachableMoments).toEqual(["ask open questions", "plain string tip"]);
    expect(rows[0].quotes).toEqual(["'just send info'"]);
    expect(rows[0].dims.authority).toBe(8);
    expect(rows[1].quality).toBeNull();
    expect(rows[1].coachableMoments).toEqual([]);
  });

  it("last insight row per call id wins (fetch orders by updated_at asc)", () => {
    const mk = (q: number): InsightRow => ({
      hubspot_call_id: "c1", quality_score: q, discovery_quality: null,
      objection_handling: null, next_step_clarity: null, talk_control: null, crm_hygiene: null,
      coachable_moments: [], quote_examples: [], recommended_next_action: null,
    });
    const rows = joinCallInsights([call({})], [mk(2), mk(4.5)]);
    expect(rows[0].quality).toBe(4.5);
  });
});
