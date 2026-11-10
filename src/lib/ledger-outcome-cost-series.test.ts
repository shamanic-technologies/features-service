import { describe, expect, it } from "vitest";
import { accountingReturn, expectedRouteFigures, outcomeAccountingOf, yieldToNext } from "./outcome-accounting.js";
import { withLedgerStepSeries } from "./ledger-outcome-cost-series.js";
import { ledgerOurUnitDays, ledgerTotalUnitCount, type LedgerCount } from "./ledger-counts.js";
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
  spendAttribution: { ownSpendUsd: 0, aboveStepKey: "signup", tracedCostUsd: 0, cumulativeShare: 1 },
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
const count = (units: number | null, ourUnits: number | null = units): LedgerCount => ({
  units,
  ourUnits,
  otherFactoryUnits: units === null || ourUnits === null ? null : { total: units - ourUnits, anotherFactory: units - ourUnits, noProof: 0 },
  reason: units === null ? "outcome_not_declared_in_ledger" : null,
  producerGap: null,
  row: null,
});

describe("withLedgerStepSeries: why the actual cost per Unit is empty (OUTCOME-ACCOUNTING-GAPS-1107)", () => {
  it("the brand holds Units no run of the campaigns making the step declared: declared outside these campaigns", () => {
    // Prod 2026-11-07 Distribute.you: 1 meeting booked on the brand ledger, declared by lead-service's own campaign-less
    // run; the AI Meeting Booking campaigns spent $0.20 and declared none.
    const a = withLedgerStepSeries(step, count(1), count(0), 0.2, null, null).accounting!;
    expect(a.costPerUnit.actualUsd).toBeNull();
    expect(a.costPerUnit.actualUnits).toBe(0);
    expect(a.costPerUnit.actualUnavailableReason).toBe("units_declared_outside_these_campaigns");
  });

  it("every Unit on the brand ledger was made by another factory (the client's CRM or team): not proven ours", () => {
    const a = withLedgerStepSeries(step, count(3, 0), count(0), 0.2, null, null).accounting!;
    expect(a.costPerUnit.actualUnavailableReason).toBe("units_not_proven_ours");
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

describe("withLedgerStepSeries: totalOutcomes (OUTCOME-TOTAL-UNITS-1110)", () => {
  const withPast = (past: Array<{ date: string; units: number; ourUnits: number }>): LedgerCount => {
    const units = past.reduce((a, p) => a + p.units, 0);
    const ours = past.reduce((a, p) => a + p.ourUnits, 0);
    return { ...count(units, ours), row: { past: past.map((p) => ({ ...p, cumulativeUnits: 0, cumulativeOurUnits: 0, otherFactoryUnits: p.units - p.ourUnits })) } as unknown as LedgerCount["row"] };
  };

  it("counts every Unit of the step, ours + another factory's, never below ours", () => {
    const c = withPast([
      { date: "2026-11-01", units: 3, ourUnits: 1 },
      { date: "2026-11-02", units: 2, ourUnits: 2 },
    ]);
    const s = withLedgerStepSeries({ ...step, sinceInception: { ...step.sinceInception, outcomes: 3 } }, c, null, null, null, null);
    expect(s.sinceInception.totalOutcomes).toBe(5);
    expect(s.sinceInception.outcomes).toBe(3);
    expect(s.sinceInception.totalOutcomes!).toBeGreaterThanOrEqual(s.sinceInception.outcomes!);
  });

  it("0 when the ledger holds no Unit of the step (as ours is 0)", () => {
    const s = withLedgerStepSeries({ ...step, sinceInception: { ...step.sinceInception, outcomes: 0 } }, withPast([]), null, null, null, null);
    expect(s.sinceInception.totalOutcomes).toBe(0);
  });

  it("null exactly when ours is null (the ledger lacks the outcome)", () => {
    const s = withLedgerStepSeries(step, count(null), null, null, null, null);
    expect(s.sinceInception.outcomes).toBeNull();
    expect(s.sinceInception.totalOutcomes).toBeNull();
  });
});

describe("ledgerOurUnitDays / ledgerTotalUnitCount: withdrawn Units (OUTCOME-TOTAL-UNITS-1110)", () => {
  const row = (past: Array<[string, number, number]>): LedgerCount =>
    ({ ...count(0, 0), row: { past: past.map(([date, ourUnits, otherFactoryUnits]) => ({ date, units: ourUnits + otherFactoryUnits, ourUnits, otherFactoryUnits, cumulativeUnits: 0, cumulativeOurUnits: 0 })) } }) as unknown as LedgerCount;

  it("a negative day takes back the latest Units before it (prod 2026-11-10: lead-service withdrew signups)", () => {
    const c = row([["2026-11-01", 5, 0], ["2026-11-02", 3, 2], ["2026-11-09", -4, 0]]);
    expect(ledgerOurUnitDays(c)).toEqual(["2026-11-01", "2026-11-01", "2026-11-01", "2026-11-01"]);
    expect(ledgerTotalUnitCount(c)).toBe(6);
  });

  it("more withdrawn than made never reads below zero, and the total stays >= ours", () => {
    const c = row([["2026-11-01", 480, 0], ["2026-11-09", -222, 0], ["2026-11-10", -398, 1]]);
    expect(ledgerOurUnitDays(c)).toEqual([]);
    expect(ledgerTotalUnitCount(c)).toBe(1);
  });
});
