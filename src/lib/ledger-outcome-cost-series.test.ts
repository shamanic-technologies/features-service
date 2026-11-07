import { describe, expect, it } from "vitest";
import { accountingReturn, expectedRouteFigures, outcomeAccountingOf, yieldToNext } from "./outcome-accounting.js";
import { withLedgerStepSeries } from "./ledger-outcome-cost-series.js";
import type { LedgerCount } from "./ledger-counts.js";
import type { OutcomeCostStepSeries } from "./outcome-cost-series.js";

const route = expectedRouteFigures(
  [
    { fromStep: "lead_found", toStep: "conversation", ratePct: null, rateBasis: null, costPerUnitUsd: 100, costBasis: "workflow" },
    { fromStep: "conversation", toStep: "meeting_booked", ratePct: 30, rateBasis: "default", costPerUnitUsd: 5, costBasis: "default" },
  ],
  "meeting_booked",
  null,
);
const step: OutcomeCostStepSeries = {
  stepKey: "meeting_booked",
  learningOutcomesRequired: 10,
  sinceInception: { spendUsd: 4386.97, outcomes: 1, undatedOutcomes: 0, costPerOutcomeUsd: 4386.97, learning: true },
  expected: { costPerOutcomeUsd: 591.52, basis: "default", combinationKey: null, unavailableReason: null },
  value: { valuePerOutcomeUsd: null, unavailableReason: "no_lifetime_revenue" },
  months: [],
  accounting: outcomeAccountingOf({
    outcomeKey: "meeting_booked",
    step: "meeting_booked",
    route,
    actual: { units: 0, spentUsd: 0 },
    yield: yieldToNext(route.next, null, "not_measured", 0, "2026-11-07"),
    yieldInto: null,
    lifetimeRevenueUsd: null,
    lifetimeRevenueSource: null,
    ret: accountingReturn([], null, null, null),
  }),
};
const count = (units: number | null): LedgerCount => ({ units, reason: units === null ? "outcome_not_declared_in_ledger" : null, producerGap: null, row: null });

describe("withLedgerStepSeries: why the actual cost per Unit is empty (OUTCOME-ACCOUNTING-GAPS-1107)", () => {
  it("the brand holds Units no run of the campaigns making the step declared: declared outside these campaigns", () => {
    // Prod 2026-11-07 Distribute.you: 1 meeting booked on the brand ledger, declared by lead-service's own campaign-less
    // run; the AI Meeting Booking campaigns spent $0.20 and declared none.
    const a = withLedgerStepSeries(step, count(1), count(0), 0.2, null, null).accounting!;
    expect(a.costPerUnit.actualUsd).toBeNull();
    expect(a.costPerUnit.actualUnits).toBe(0);
    expect(a.costPerUnit.actualUnavailableReason).toBe("units_declared_outside_these_campaigns");
  });

  it("no Unit anywhere on the brand ledger: no Unit yet", () => {
    const a = withLedgerStepSeries(step, count(0), count(0), 0.2, null, null).accounting!;
    expect(a.costPerUnit.actualUnavailableReason).toBe("no_unit_yet");
  });

  it("the campaigns' own runs declared the Units: the actual is their spend over those Units", () => {
    const a = withLedgerStepSeries(step, count(2), count(2), 10, null, null).accounting!;
    expect(a.costPerUnit.actualUsd).toBe(5);
    expect(a.costPerUnit.actualUnavailableReason).toBeNull();
  });
});
