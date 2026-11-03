import { describe, expect, it } from "vitest";
import { buildCostEconomics } from "./cost-economics.js";

// ROI-CONSISTENCY-1103 (owner 2026-11-03): a return exists only where a value LANDS. The realized
// return of a scope is the revenue of the Paid clients our outreach caused, over every dollar the scope
// actually SPENT (runs that ran), whole history: never the mature cohort, never the committed spend
// (follow-ups reserved but not yet sent are no cost incurred).
describe("realizedReturn: Paid clients' revenue over money actually spent, whole history", () => {
  it("divides closed-won revenue by actual spend, not by the mature committed cohort", () => {
    const ce = buildCostEconomics({
      committedCostInUsdCents: 23365,
      actualCostInUsdCents: 9356,
      totalPipelineUsd: 6960,
      lifetimeRevenueUsd: 75000,
      maturity: { days: 21, committedCostInUsdCents: 402, totalPipelineUsd: 3750 },
      realized: { closedWonCount: 1, closedWonRevenueUsd: 25000 },
    });
    expect(ce.realizedReturn).toEqual({
      closedWonCount: 1,
      closedWonRevenueUsd: 25000,
      spentUsd: 93.56,
      roiMultiple: 25000 / 93.56,
    });
  });

  it("is measured even when maturity is unknown (it reads no cohort)", () => {
    const ce = buildCostEconomics({
      committedCostInUsdCents: 1000,
      actualCostInUsdCents: 800,
      totalPipelineUsd: 100,
      maturity: { unknown: true },
      realized: { closedWonCount: 0, closedWonRevenueUsd: 0 },
    });
    expect(ce.realizedReturn).toEqual({ closedWonCount: 0, closedWonRevenueUsd: 0, spentUsd: 8, roiMultiple: 0 });
  });

  it("reads a null multiple when nothing was spent yet, never a fabricated 0x", () => {
    const ce = buildCostEconomics({
      committedCostInUsdCents: 500,
      actualCostInUsdCents: 0,
      totalPipelineUsd: 0,
      realized: { closedWonCount: 0, closedWonRevenueUsd: 0 },
    });
    expect(ce.realizedReturn?.roiMultiple).toBeNull();
    expect(ce.realizedReturn?.spentUsd).toBe(0);
  });

  it("stays null when no source of closed deals was read", () => {
    const ce = buildCostEconomics({ committedCostInUsdCents: 500, actualCostInUsdCents: 500, totalPipelineUsd: 0, realized: null });
    expect(ce.realizedReturn).toBeNull();
  });
});
