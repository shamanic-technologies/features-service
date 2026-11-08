import { describe, it, expect } from "vitest";
import { brandLedgerOutcomes, LEDGER_OUTCOME_MIN_DAYS } from "./brand-ledger-outcomes.js";
import type { ScopeOutcomeLedgerInput } from "./scope-outcome-ledger.js";

const ledger = (over: Partial<ScopeOutcomeLedgerInput> = {}): ScopeOutcomeLedgerInput => ({
  producedByDay: new Map([
    ["google_search_click", new Map([["2026-11-05", 7], ["2026-11-07", 3]])],
    ["paid_client", new Map()],
  ]),
  ownCostUsd: new Map([["google_search_click", 0]]),
  unitCosts: new Map(),
  undeclaredConsumptions: new Map([["meeting_booked", 2]]),
  fleetProducers: new Map([["google_search_click", ["google-service"]]]),
  daysMissing: ["2026-11-08"],
  today: "2026-11-08",
  ...over,
});

describe("brandLedgerOutcomes (GSC-CONNECTOR-1108)", () => {
  it("serves any outcome key the ledger holds Units of, with a daily series equal to the ledger", () => {
    const rows = brandLedgerOutcomes(ledger());
    expect(rows.map((r) => r.outcomeKey)).toEqual(["google_search_click"]);
    const gsc = rows[0]!;
    expect(gsc.units).toBe(10);
    expect(gsc.ourUnits).toBe(10);
    expect(gsc.productionCostUsd).toBe(0);
    expect(gsc.costPerUnitUsd).toBe(0);
    expect(gsc.daily).toHaveLength(LEDGER_OUTCOME_MIN_DAYS);
    expect(gsc.daily[0]!.date).toBe("2026-10-12");
    expect(gsc.daily.find((d) => d.date === "2026-11-05")!.units).toBe(7);
    expect(gsc.daily.find((d) => d.date === "2026-11-06")!.units).toBe(0);
    expect(gsc.daily.find((d) => d.date === "2026-11-07")!.units).toBe(3);
    // A day runs-service has not computed is null, never a stated 0.
    expect(gsc.daily.at(-1)).toEqual({ date: "2026-11-08", units: null, ourUnits: null, otherFactoryUnits: null });
    expect(gsc.daily.reduce((a, d) => a + (d.units ?? 0), 0)).toBe(gsc.units);
  });

  it("starts at the first Unit when it is older than the 28-day window", () => {
    const rows = brandLedgerOutcomes(ledger({ producedByDay: new Map([["google_search_click", new Map([["2026-09-01", 1]])]]), daysMissing: [] }));
    expect(rows[0]!.daily[0]!.date).toBe("2026-09-01");
    expect(rows[0]!.daily.at(-1)!.date).toBe("2026-11-08");
  });

  it("counts another factory's Units in the total, never in OUR Units", () => {
    const rows = brandLedgerOutcomes(
      ledger({ producedByDay: new Map(), elsewhereByDay: new Map([["paid_client", new Map([["2026-11-01", new Map([["another_factory" as const, 2]])]])]]), daysMissing: [] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcomeKey: "paid_client", units: 2, ourUnits: 0, costPerUnitUsd: null, costPerUnitUnavailableReason: "no_unit_of_ours_yet" });
  });

  it("a ledger with no Unit serves no row (a gap of unknown provenance is not a Unit)", () => {
    expect(brandLedgerOutcomes(ledger({ producedByDay: new Map() }))).toEqual([]);
  });
});
