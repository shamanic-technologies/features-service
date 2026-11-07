/**
 * LEDGER-ONLY-1107: per outcome, the scope's TOTAL Units in the ledger, independent of campaign attribution.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { scopeOutcomeLedgerRowOf, scopeOutcomeLedgerRows, ledgerRealizedReturn, type ScopeOutcomeLedgerInput, type OtherFactory } from "./scope-outcome-ledger.js";
import { parseScopeLedgerByDay, parseFleetProducers } from "./scope-outcome-ledger-io.js";

const base = (over: Partial<ScopeOutcomeLedgerInput> = {}): ScopeOutcomeLedgerInput => ({
  producedByDay: new Map([
    ["lead_interested", new Map([["2026-11-01", 2], ["2026-11-03", 1]])],
    ["threads_post_published", new Map([["2026-11-02", 4]])],
    ["post_engaged", new Map([["2026-11-02", 1]])],
  ]),
  ownCostUsd: new Map([["lead_interested", 0], ["threads_post_published", 8], ["post_engaged", 3]]),
  unitCosts: new Map([["lead_interested", { unitCostUsd: 148 }], ["threads_post_published", { unitCostUsd: null }], ["post_engaged", { unitCostUsd: 3 }]]),
  undeclaredConsumptions: new Map([["signup", 5], ["paid_client", 29]]),
  fleetProducers: new Map([["paid_client", ["lead-service"]], ["lead_interested", ["lead-service"]]]),
  daysMissing: [],
  today: "2026-11-04",
  ...over,
});

describe("scopeOutcomeLedgerRowOf", () => {
  it("counts every Unit of the outcome once, dated, with the ledger's every-path $ each", () => {
    const r = scopeOutcomeLedgerRowOf(["lead_interested"], base());
    expect(r).toMatchObject({ units: 3, costPerUnitUsd: 148, costPerUnitBasis: "every_path", productionCostUsd: 444, unitsUnavailableReason: null, producerGap: null });
    expect(r.past.map((p) => [p.date, p.units, p.cumulativeUnits])).toEqual([
      ["2026-11-01", 2, 2],
      ["2026-11-02", 0, 2],
      ["2026-11-03", 1, 3],
      ["2026-11-04", 0, 3],
    ]);
  });

  it("a Unit reached under two campaigns counts ONCE: the brand read has one row per Unit, whatever campaigns its lead met", () => {
    // Two campaigns each attributed the same 3 interested leads to themselves (6 summed); the ledger holds 3 Units.
    const perCampaign = [3, 3];
    const r = scopeOutcomeLedgerRowOf(["lead_interested"], base());
    expect(perCampaign.reduce((a, b) => a + b, 0)).toBe(6);
    expect(r.units).toBe(3);
  });

  it("finer outcomes counted together add their Units; $ each weighted, own production where the outcome is no pipe output", () => {
    const r = scopeOutcomeLedgerRowOf(["post_engaged", "threads_post_published"], base());
    expect(r).toMatchObject({ units: 5, costPerUnitUsd: 2.2, costPerUnitBasis: "own_production", productionCostUsd: 11 });
  });

  it("an outcome the scope consumed but no run declares: null + the producer gap, never 0", () => {
    expect(scopeOutcomeLedgerRowOf(["signup"], base())).toMatchObject({
      units: null,
      unitsUnavailableReason: "outcome_not_declared_in_ledger",
      producerGap: { declaredElsewhereBy: [], undeclaredConsumptions: 5 },
      costPerUnitUsd: null,
      productionCostUsd: null,
      past: [],
    });
    expect(scopeOutcomeLedgerRowOf(["paid_client"], base()).producerGap).toEqual({ declaredElsewhereBy: ["lead-service"], undeclaredConsumptions: 29 });
  });

  it("no Unit, nothing consumed, a producer declares it elsewhere: a measured 0; nobody declares it anywhere: null", () => {
    expect(scopeOutcomeLedgerRowOf(["meeting_booked"], base({ fleetProducers: new Map([["meeting_booked", ["lead-service"]]]) }))).toMatchObject({
      units: 0,
      costPerUnitUsd: null,
      costPerUnitUnavailableReason: "no_unit_yet",
    });
    expect(scopeOutcomeLedgerRowOf(["meeting_booked"], base())).toMatchObject({ units: null, unitsUnavailableReason: "no_producer_declares_outcome" });
  });

  it("rows: one per outcome produced or consumed undeclared", () => {
    expect(scopeOutcomeLedgerRows(base()).map((r) => r.outcomeKey)).toEqual(["lead_interested", "paid_client", "post_engaged", "signup", "threads_post_published"]);
  });
});

describe("ledger wire parsing", () => {
  it("parses the by-day read: Units, own cost on the basis, consumptions of unknown provenance", () => {
    const p = parseScopeLedgerByDay(
      {
        daysMissing: ["2026-11-02"],
        produced: [
          { dimensions: { outcomeKey: "lead_found", day: "2026-11-01" }, occurrences: 3, cost: { grossCents: "300", netCents: "150" } },
          { dimensions: { outcomeKey: "lead_found", day: "2026-11-02" }, occurrences: 1, cost: { grossCents: "100", netCents: "50" } },
        ],
        consumed: [
          { dimensions: { consumingOutcomeKey: null, consumedOutcomeKey: "signup", day: "2026-11-01" }, unknownProvenance: "5.0000000000" },
          { dimensions: { consumingOutcomeKey: "message_written", consumedOutcomeKey: "lead_found", day: "2026-11-01" }, unknownProvenance: "0" },
        ],
      },
      "net",
    );
    expect(p.producedByDay.get("lead_found")?.get("2026-11-01")).toBe(3);
    expect(p.ownCostUsd.get("lead_found")).toBe(2);
    expect([...p.undeclaredConsumptions]).toEqual([["signup", 5]]);
    expect(p.daysMissing).toEqual(["2026-11-02"]);
    expect(() => parseScopeLedgerByDay({ produced: [{ dimensions: { outcomeKey: "x", day: "d" }, occurrences: 1, cost: {} }] }, "net")).toThrow();
  });

  it("parses the fleet producers", () => {
    expect([...parseFleetProducers({ groups: [{ outcomeKey: "paid_client", serviceName: "lead-service", count: 7 }, { outcomeKey: "x", serviceName: "y", count: 0 }] })]).toEqual([["paid_client", ["lead-service"]]]);
  });
});

describe("ledgerRealizedReturn (LEDGER-ONLY-1107)", () => {
  it("counts the ledger's Paid client Units × LTR over actual spend; undeclared = null + reason, never the CRM count", async () => {
    const { ledgerRealizedReturn } = await import("./scope-outcome-ledger.js");
    const declared = scopeOutcomeLedgerRowOf(["paid_client"], base({ producedByDay: new Map([["paid_client", new Map([["2026-11-01", 2]])]]), undeclaredConsumptions: new Map() }));
    expect(ledgerRealizedReturn(declared, 1000, 400)).toEqual({ realizedReturn: { closedWonCount: 2, closedWonRevenueUsd: 2000, spentUsd: 400, roiMultiple: 5 }, unavailableReason: null });
    expect(ledgerRealizedReturn(scopeOutcomeLedgerRowOf(["paid_client"], base()), 1000, 400)).toEqual({ realizedReturn: null, unavailableReason: "outcome_not_declared_in_ledger" });
    expect(ledgerRealizedReturn(null, 1000, 400).unavailableReason).toBe("ledger_unreadable");
  });
});

describe("rebaseSpendChartOnLedger (LEDGER-ONLY-1107)", () => {
  const point = (date: string, cumulativeSpendUsd: number) => ({
    date, spendUsd: 0, cumulativeSpendUsd, cumulativeOutcomes: 99, costPerOutcomeUsd: 1, entered: 9, cohortOutcomes: 9, cohortConversionPct: 9, cohortMature: true,
    cumulativeEntered: 9, cumulativeConverted: 9, conversionRatePct: 9, matureConversionRatePct: 9, matureOutcomes: 9, learning: false, byAction: [], byActionGapUsd: 0,
  });
  const chart = {
    leg: { channelSlug: "cold-email", legKey: "k", fromStep: "lead_found", toStep: "paid_client", maturityDays: 0, learningOutcomesRequired: 10 },
    outcomeStep: "paid_client", outcomeUnavailableReason: null, conversionUnavailableReason: null, spendByActionUnavailableReason: null,
    daily: [point("2026-11-01", 100), point("2026-11-02", 400)],
    totals: { spendUsd: 400, outcomes: 7, costPerOutcomeUsd: 57, entered: 8925, converted: 2, conversionRatePct: 0.02, learning: true },
    expected: { costPerOutcomeUsd: null, costPerOutcomeBasis: null, costPerOutcomeUnavailableReason: null, conversionRatePct: null, conversionBasis: null, conversionSource: null, conversionUnavailableReason: null },
  };
  it("outcomes, conversion and $ each come from the ledger rows: one count with Today's Target row", async () => {
    const { rebaseSpendChartOnLedger } = await import("./spend-charts-ledger.js");
    const i = base({
      producedByDay: new Map([["paid_client", new Map([["2026-11-02", 2]])], ["lead_found", new Map([["2026-11-01", 50], ["2026-11-02", 50]])]]),
      ownCostUsd: new Map([["paid_client", 0], ["lead_found", 5]]),
      unitCosts: new Map([["paid_client", { unitCostUsd: 150 }], ["lead_found", { unitCostUsd: 0.1 }]]),
      today: "2026-11-02",
    });
    const paid = scopeOutcomeLedgerRowOf(["paid_client"], i);
    const r = rebaseSpendChartOnLedger(chart as never, paid, scopeOutcomeLedgerRowOf(["lead_found"], i), 10);
    expect(r.totals).toMatchObject({ outcomes: 2, costPerOutcomeUsd: 200, standardCostPerOutcomeUsd: 150, entered: 100, converted: 2, conversionRatePct: 2, learning: true });
    expect(r.totals.outcomes).toBe(paid.units);
    expect(r.daily.map((p) => [p.cumulativeOutcomes, p.cumulativeEntered, p.cohortOutcomes, p.costPerOutcomeUsd])).toEqual([[0, 50, null, null], [2, 100, null, 200]]);
  });
  it("an outcome the ledger lacks: every outcome figure null + the reason + the producer gap; spend unchanged", async () => {
    const { rebaseSpendChartOnLedger } = await import("./spend-charts-ledger.js");
    const r = rebaseSpendChartOnLedger(chart as never, scopeOutcomeLedgerRowOf(["paid_client"], base()), null, 10);
    expect(r).toMatchObject({ outcomeUnavailableReason: "outcome_not_declared_in_ledger", totals: { spendUsd: 400, outcomes: null, converted: null, costPerOutcomeUsd: null } });
    expect(r.ledger.producerGap).toEqual({ declaredElsewhereBy: ["lead-service"], undeclaredConsumptions: 29 });
    expect(r.daily.every((p) => p.cumulativeOutcomes === null)).toBe(true);
  });
});

describe("withLedgerRealHalf (LEDGER-ONLY-1107 x REVENUE-GENERATED-1107)", () => {
  const rg = {
    realUsd: 7000, paidClientCount: 7, realUnavailableReason: null, undatedRealUsd: 0, spentUsd: 400, expectedToDateUsd: 800, expectedUsd: 900,
    expectedUnavailableReason: null, expectedHorizonDays: 30, dailySpendPaceUsd: 10, expectedFlatReason: null, offerRunning: true, firstDay: "2026-11-02", today: "2026-11-03",
    points: [
      { date: "2026-11-02", kind: "measured" as const, realUsd: 0, realCumulativeUsd: 0, expectedCumulativeUsd: 400 },
      { date: "2026-11-03", kind: "measured" as const, realUsd: 7000, realCumulativeUsd: 7000, expectedCumulativeUsd: 800 },
      { date: "2026-11-04", kind: "expected" as const, realUsd: null, realCumulativeUsd: null, expectedCumulativeUsd: 820 },
    ],
  };
  it("the real half = ledger Paid client Units × LTR per day; Units dated before the chart land on its first day", async () => {
    const { withLedgerRealHalf } = await import("./revenue-generated.js");
    // 2 of OUR Paid clients + 5 another factory made: the real half is ours only (LEDGER-OTHER-FACTORY-1107).
    const paid = { units: 7, ourUnits: 2, unitsUnavailableReason: null, past: [{ date: "2026-11-01", ourUnits: 1, cumulativeOurUnits: 1 }, { date: "2026-11-02", ourUnits: 0, cumulativeOurUnits: 1 }, { date: "2026-11-03", ourUnits: 1, cumulativeOurUnits: 2 }] };
    const r = withLedgerRealHalf(rg, paid, 1000);
    expect(r).toMatchObject({ realUsd: 2000, paidClientCount: 2, realUnavailableReason: null, spentUsd: 400, expectedToDateUsd: 800 });
    expect(r.points.map((p) => [p.realUsd, p.realCumulativeUsd, p.expectedCumulativeUsd])).toEqual([[1000, 1000, 400], [1000, 2000, 800], [null, null, 820]]);
  });
  it("Paid client not declared in the ledger: every real figure null + the reason; the expected half untouched", async () => {
    const { withLedgerRealHalf } = await import("./revenue-generated.js");
    const r = withLedgerRealHalf(rg, { units: null, ourUnits: null, unitsUnavailableReason: "outcome_not_declared_in_ledger", past: [] }, 1000);
    expect(r).toMatchObject({ realUsd: null, paidClientCount: null, realUnavailableReason: "outcome_not_declared_in_ledger", expectedToDateUsd: 800 });
    expect(r.points.every((p) => p.realCumulativeUsd === null)).toBe(true);
    expect(withLedgerRealHalf(rg, null, 1000).realUnavailableReason).toBe("ledger_unreadable");
  });
});

/**
 * LEDGER-OTHER-FACTORY-1107 (owner 2026-11-07, « ON VEUT LE TOTAL ET LES STATS PAR OUTCOME … INDEPENDAMMENT DES SOURCES »):
 * the count = our Units + another factory's; every money figure divides OUR Units only (IAS 2).
 */
describe("another factory's Units (LEDGER-OTHER-FACTORY-1107)", () => {
  const elsewhere = (rows: Array<[string, string, OtherFactory, number]>) => {
    const out = new Map<string, Map<string, Map<OtherFactory, number>>>();
    for (const [k, d, f, n] of rows) {
      const days = out.get(k) ?? out.set(k, new Map()).get(k)!;
      const byF = days.get(d) ?? days.set(d, new Map()).get(d)!;
      byF.set(f, (byF.get(f) ?? 0) + n);
    }
    return out;
  };

  it("total = ours + theirs; $ each and production cost divide OUR Units only", () => {
    // Ours: 3 interested leads at $148 each ($444). Theirs: 2 from the client's CRM + 1 with no proof of ours.
    const r = scopeOutcomeLedgerRowOf(["lead_interested"], base({
      elsewhereByDay: elsewhere([["lead_interested", "2026-11-02", "another_factory", 2], ["lead_interested", "2026-11-03", "no_proof", 1]]),
    }));
    expect(r.units).toBe(6);
    expect(r.ourUnits).toBe(3);
    expect(r.otherFactoryUnits).toEqual({ total: 3, anotherFactory: 2, noProof: 1 });
    expect(r.units).toBe(r.ourUnits! + r.otherFactoryUnits!.total);
    // Denominator = ours: $444 ÷ 3 = $148, never $444 ÷ 6 = $74.
    expect(r.costPerUnitUsd).toBe(148);
    expect(r.productionCostUsd).toBe(444);
    expect(r.past.map((p) => [p.date, p.units, p.ourUnits, p.otherFactoryUnits, p.cumulativeUnits, p.cumulativeOurUnits])).toEqual([
      ["2026-11-01", 2, 2, 0, 2, 2],
      ["2026-11-02", 2, 0, 2, 4, 2],
      ["2026-11-03", 2, 1, 1, 6, 3],
      ["2026-11-04", 0, 0, 0, 6, 3],
    ]);
  });

  it("Distribute.you: 17 Paid clients, none ours (6 another factory, 11 no proof): count 17, no $ each, no return", () => {
    const r = scopeOutcomeLedgerRowOf(["paid_client"], base({
      undeclaredConsumptions: new Map(),
      elsewhereByDay: elsewhere([["paid_client", "2026-10-01", "another_factory", 6], ["paid_client", "2026-10-15", "no_proof", 11]]),
    }));
    expect(r).toMatchObject({ units: 17, ourUnits: 0, otherFactoryUnits: { total: 17, anotherFactory: 6, noProof: 11 }, unitsUnavailableReason: null, costPerUnitUsd: null, costPerUnitUnavailableReason: "no_unit_of_ours_yet", productionCostUsd: null });
    expect(r.past.at(-1)).toMatchObject({ cumulativeUnits: 17, cumulativeOurUnits: 0 });
    // The realized return counts OUR Paid clients only: 0 × LTR.
    expect(ledgerRealizedReturn(r, 1000, 500).realizedReturn).toMatchObject({ closedWonCount: 0, closedWonRevenueUsd: 0, roiMultiple: 0 });
  });

  it("an outcome only another factory made is listed among the scope's outcomes", () => {
    const rows = scopeOutcomeLedgerRows(base({ undeclaredConsumptions: new Map(), elsewhereByDay: elsewhere([["meeting_booked", "2026-11-01", "another_factory", 4]]) }));
    expect(rows.find((x) => x.outcomeKey === "meeting_booked")).toMatchObject({ units: 4, ourUnits: 0 });
  });

  it("parses runs-service's producedElsewhere[] (factory dimension) beside produced[]", () => {
    const p = parseScopeLedgerByDay({
      produced: [{ dimensions: { outcomeKey: "paid_client", day: "2026-11-01" }, occurrences: 1, cost: { grossCents: "1000", netCents: "900", vendorCents: "500" } }],
      producedElsewhere: [
        { dimensions: { factory: "another_factory", outcomeKey: "paid_client", day: "2026-11-01" }, occurrences: 6 },
        { dimensions: { factory: "no_proof", outcomeKey: "paid_client", day: "2026-11-02" }, occurrences: 11 },
      ],
    }, "gross");
    expect(p.elsewhereByDay.get("paid_client")?.get("2026-11-01")?.get("another_factory")).toBe(6);
    expect(p.elsewhereByDay.get("paid_client")?.get("2026-11-02")?.get("no_proof")).toBe(11);
    const r = scopeOutcomeLedgerRowOf(["paid_client"], { ...p, unitCosts: new Map(), fleetProducers: new Map(), today: "2026-11-02" });
    expect(r).toMatchObject({ units: 18, ourUnits: 1, costPerUnitUsd: 10 });
    expect(() => parseScopeLedgerByDay({ producedElsewhere: [{ dimensions: { factory: "mars", outcomeKey: "paid_client", day: "2026-11-01" }, occurrences: 1 }] }, "gross")).toThrow(/unknown factory/);
  });
});
