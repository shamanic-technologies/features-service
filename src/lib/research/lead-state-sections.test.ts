import { describe, expect, it } from "vitest";
import { LEAD_STATES } from "../lead-states.js";
import type { OutcomeUnitCost } from "../outcome-unit-costs.js";
import { LEAD_STATE_SECTIONS, leadStateCostOverTimeStudy, leadStatePoint, methodDayOf } from "./lead-state-sections.js";
import { MEETING_COST_LEDGER_SLUG } from "./meeting-cost-methods.js";

// RESEARCH-STATE-SECTIONS-1025: one Research section per lead state, each with its price over time.

const unit: OutcomeUnitCost = { outcomeKey: "meeting_booked", produced: 12, byProducts: 0, unitCostUsd: 79.2, ownUnitCostUsd: 3, stages: [], unpricedInputs: [] };
const meeting = LEAD_STATE_SECTIONS.find((s) => s.state === "meeting_booked")!;
const facts = (coveragePct: number | null, daysMissing = 0) => ({ coveragePct, daysMissing, abnormalUsd: 7 });

describe("lead state sections", () => {
  it("every lead state has exactly one section, booked meetings keep the meeting-cost ledger series", () => {
    expect(LEAD_STATE_SECTIONS.map((s) => s.state).sort()).toEqual(LEAD_STATES.map((s) => s.key).sort());
    expect(new Set(LEAD_STATE_SECTIONS.map((s) => s.seriesSlug)).size).toBe(LEAD_STATE_SECTIONS.length);
    expect(meeting.seriesSlug).toBe(MEETING_COST_LEDGER_SLUG);
  });

  it("a day's point: a floor under 95% declared, Learning under the bar, nothing priced while ledger days are recomputed", () => {
    expect(leadStatePoint(meeting, unit, facts(62))).toMatchObject({ indexSlug: MEETING_COST_LEDGER_SLUG, value: 79.2, status: "noise", inputs: { floor: "yes", abnormalUsd: 7 } });
    expect(leadStatePoint(meeting, unit, facts(97))).toMatchObject({ status: "signal", inputs: { floor: "no" } });
    expect(leadStatePoint(meeting, { ...unit, produced: 3 }, facts(97)).status).toBe("noise");
    // MEETING-INDEX-ZERO-1025: 265 days computing read $0.013; a recomputing day prices nothing
    expect(leadStatePoint(meeting, { ...unit, unitCostUsd: 0.01317, produced: 83 }, facts(62.2, 265))).toMatchObject({ value: null, unavailableReason: "ledger_being_recomputed" });
    expect(leadStatePoint(meeting, null, facts(97))).toMatchObject({ value: null, unavailableReason: "nothing_priced_yet" });
    expect(leadStatePoint(meeting, { ...unit, unitCostUsd: 0 }, facts(97)).value).toBeNull();
  });

  it("the price over time draws only priced days, its last point is the figure of the day, vendor basis waits", () => {
    const rows = [
      { ...methodDayOf("2026-10-22", leadStatePoint(meeting, { ...unit, unitCostUsd: 81 }, facts(97))), basis: "recomputed" },
      { ...methodDayOf("2026-10-23", leadStatePoint(meeting, unit, facts(97, 2))), basis: "recomputed" },
      methodDayOf("2026-10-24", leadStatePoint(meeting, unit, facts(97))),
    ];
    const st = leadStateCostOverTimeStudy(meeting, rows, "user");
    expect(st).toMatchObject({ id: "meeting-cost-over-time", outcome: "meeting", topic: "cost", status: "measured" });
    expect(st.charts[0]!.points.map((p) => [p.label, p.display])).toEqual([
      ["Oct 22", "$81"],
      ["Oct 24", "$79"],
    ]);
    expect(st.charts[0]!.points[1]!.note).toContain("waste apart $7.00");
    expect(st.result?.display).toBe("$79");
    expect(leadStateCostOverTimeStudy(meeting, rows, "actual").status).toBe("not_enough_data");
  });
});
