import { describe, expect, it } from "vitest";
import { meetingCostStudy, type ReportingBrand } from "./meetings.js";
import {
  ledgerHistoryDays,
  ledgerHistoryPoint,
  ledgerChart,
  ledgerPoint,
  medianChart,
  methodLines,
  MEETING_COST_LEDGER_SLUG,
  MEETING_COST_OUTCOME_PRICES_SLUG,
  outcomePricesChart,
  outcomePricesPoint,
  withToday,
  type MeetingCostMethods,
  type MethodDay,
} from "./meeting-cost-methods.js";
import type { OutcomeUnitCost } from "../outcome-unit-costs.js";

// MEETING-COST-METHODS-1024: every way we compute a booked meeting's cost, one row each on the meeting-cost study.

const brands: ReportingBrand[] = [
  { brandId: "cheap", meetingsByMonth: { "2026-09": 4, "2026-10": 6 }, spendByMonth: { "2026-09": 200, "2026-10": 300 } },
  { brandId: "dear", meetingsByMonth: { "2026-10": 1 }, spendByMonth: { "2026-09": 1_000, "2026-10": 1_000 } },
  { brandId: "mid", meetingsByMonth: { "2026-10": 2 }, spendByMonth: { "2026-10": 400 } },
  { brandId: "none", meetingsByMonth: {}, spendByMonth: { "2026-10": 50 } },
];

const day = (d: string, value: number | null, inputs: Record<string, unknown> = {}, status = "noise", outcomes = 3): MethodDay => ({ day: d, value, status, outcomes, unavailableReason: null, inputs });

const methods: MeetingCostMethods = {
  outcomePrices: [day("2026-10-24", 794.46, { replyCostUsd: 182.96, meetingRatePct: 23.08, meetingLegCostUsd: 1.61, meetingsBooked: 3, maturity: "early" })],
  ledger: [day("2026-10-24", 79.2, { floor: "yes", coveragePct: 62, daysMissing: 0 }, "noise", 12)],
};

describe("meeting-cost study, every method (MEETING-COST-METHODS-1024)", () => {
  it("keeps the measured average row byte for byte and adds one row per method after it", () => {
    const alone = meetingCostStudy(brands, 10, "2026-10-24");
    const all = meetingCostStudy(brands, 10, "2026-10-24", methods);
    expect(all.charts[0]).toEqual(alone.charts[0]);
    expect(all.headline).toBe(alone.headline);
    expect(all.result).toEqual(alone.result);
    expect(all.charts.map((c) => c.title)).toEqual([
      alone.charts[0]!.title,
      "Measured, median client: cost per meeting booked by month",
      "Expected, outcome prices: cost per meeting booked, day by day from Oct 24",
      "Ledger, production cost every path (= the public Cold Email Cost Per Meeting Index): day by day from Oct 24",
    ]);
    expect(all.charts.every((c) => c.kind === "months")).toBe(true);
  });

  it("the median client is the middle brand, a brand that spent with no meeting the most expensive", () => {
    // to date: cheap $50, mid $200, dear $2,000, none Infinity -> median of 4 = ($200 + $2,000) / 2
    const c = medianChart(brands, ["2026-09", "2026-10"], "2026-10", 10)!;
    const today = c.cumulative!.points.at(-1)!;
    expect(today.value).toBe(1100);
    expect(today.note).toContain("4 brands spent to date, 1 with no meeting");
    expect(today.partial).toBe(true);
    // September: cheap $50, dear Infinity -> median lands between: no finite median, no bar
    expect(c.points.map((p) => p.label)).toEqual(["Oct"]);
    // October bar: cheap $50, mid $200, dear $1,000, none Infinity -> ($200 + $1,000) / 2
    expect(c.points[0]!.value).toBe(600);
    expect(c.points[0]!.thin).toBe(true); // 9 meetings that month, under the bar of 10
    expect(today.thin).toBe(false);
  });

  it("a recorded day replaces nothing but its own day, and is never back-filled", () => {
    const rows = [day("2026-10-23", 1), day("2026-10-24", 2)];
    expect(withToday(rows, day("2026-10-24", 3)).map((r) => r.value)).toEqual([1, 3]);
    expect(withToday([], day("2026-10-24", 3)).map((r) => r.day)).toEqual(["2026-10-24"]);
  });

  it("the ledger point is a floor while coverage is under the bar, and nothing is recorded when nothing is priced", () => {
    const unit: OutcomeUnitCost = { outcomeKey: "meeting_booked", produced: 12, byProducts: 0, unitCostUsd: 79.2, ownUnitCostUsd: 3, stages: [], unpricedInputs: [] };
    const p = ledgerPoint(unit, 62, 0, 10)!;
    expect(p).toMatchObject({ indexSlug: MEETING_COST_LEDGER_SLUG, value: 79.2, status: "noise", inputs: { floor: "yes" } });
    expect(ledgerPoint(unit, 97, 0, 10)!.inputs.floor).toBe("no");
    expect(ledgerPoint(unit, 97, 0, 10)!.status).toBe("signal");
    expect(ledgerPoint({ ...unit, unitCostUsd: null }, 97, 0, 10)).toBeNull();
    expect(ledgerPoint(null, 97, 0, 10)).toBeNull();
    const chart = ledgerChart([day("2026-10-24", 79.2, { floor: "yes", coveragePct: 62, daysMissing: 0 }, "signal", 12)])!;
    expect(chart.points[0]).toMatchObject({ display: "≥ $79", thin: true });
  });

  it("the outcome prices point carries the arithmetic it was built from", () => {
    const p = outcomePricesPoint({
      maturity: "early",
      priceUsd: 794.4553575196351,
      unmeasuredReason: null,
      arithmetic: { replyCostUsd: 182.96, meetingRatePct: 23.08, repliesCostPerMeetingUsd: 792.84, meetingLegCostUsd: 1.61 },
      legs: [
        { workflowDynastySlug: "sales-cold-email-outreach-ballad", figures: { outcomes: 45 } },
        { workflowDynastySlug: "ai-meeting-booking-avior", figures: { outcomes: 3 } },
      ],
    })!;
    expect(p).toMatchObject({ indexSlug: MEETING_COST_OUTCOME_PRICES_SLUG, value: 794.4553575196351, status: "noise", outcomes: 3 });
    expect(p.inputs).toMatchObject({ replyCostUsd: 182.96, replyWorkflowDynastySlug: "sales-cold-email-outreach-ballad", meetingWorkflowDynastySlug: "ai-meeting-booking-avior", costBasis: "incurred" });
    expect(outcomePricesPoint(null)).toBeNull();
    expect(outcomePricesChart(methods.outcomePrices!)!.points[0]!.note).toContain("$183 per positive reply ÷ 23.1% booked + $1.61 per meeting");
  });

  it("states each method's figure today, and the gap between the two expected ones", () => {
    const lines = methodLines(methods);
    expect(lines[0]).toBe("Expected, outcome prices: $794 per meeting booked today (2026-10-24).");
    expect(lines[1]).toContain("(the public Cold Email Cost Per Meeting Index): at least $79 per meeting booked today");
    expect(methodLines({ outcomePrices: null, ledger: null })).toEqual([
      "Expected, outcome prices: not readable right now.",
      "Ledger: not readable right now.",
    ]);
  });

  it("the ledger history starts on the ledger's first booked meeting and recomputes each past day once per UTC day", () => {
    const stored: MethodDay[] = [
      { ...day("2026-10-20", 700), basis: "recomputed", recordedAt: "2026-10-24T08:00:00.000Z" },
      { ...day("2026-10-21", 710), basis: "recomputed", recordedAt: "2026-10-23T08:00:00.000Z" },
      { ...day("2026-10-23", 866), basis: "recorded", recordedAt: "2026-10-23T23:00:00.000Z" },
    ];
    expect(ledgerHistoryDays("2026-10-19", "2026-10-24", stored)).toEqual(["2026-10-19", "2026-10-21", "2026-10-22"]);
    expect(ledgerHistoryDays(null, "2026-10-24", stored)).toEqual([]);
    expect(ledgerHistoryDays("2026-10-24", "2026-10-24", stored)).toEqual([]);
    const none = ledgerHistoryPoint(null, 90, 0, 10);
    expect(none).toMatchObject({ indexSlug: MEETING_COST_LEDGER_SLUG, value: null, unavailableReason: "no_meeting_priced_yet" });
    const chart = ledgerChart([{ ...day("2026-10-22", null), basis: "recomputed" }, { ...day("2026-10-23", 866.47, { floor: "yes", coveragePct: 90.5, daysMissing: 0 }, "noise", 8), basis: "recomputed" }])!;
    expect(chart.title).toContain("from Oct 23");
    expect(chart.points).toHaveLength(1);
    expect(chart.points[0]!.note).toContain("recomputed as of that day");
  });
});
