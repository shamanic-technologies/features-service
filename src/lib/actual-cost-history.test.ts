import { describe, it, expect } from "vitest";
import { buildActualCostHistory, vendorSpendLedger } from "./actual-cost-history.js";
import { buildRoiHistory } from "./roi-history.js";

const pipeline = [
  { date: "2026-02-01T10:00:00.000Z", cumulativePipelineUsd: 100 },
  { date: "2026-02-03T10:00:00.000Z", cumulativePipelineUsd: 300 },
];

describe("buildActualCostHistory", () => {
  it("keeps every point when every row has a known vendor cost", () => {
    const vendor = buildRoiHistory(new Map([["2026-02-01", 10], ["2026-02-02", 10]]), pipeline as never, 300);
    const out = buildActualCostHistory(vendor, new Map());
    expect(out.unpricedFromDate).toBeNull();
    expect(out.unpricedBilledCostUsd).toBe(0);
    expect(out.daily.map((p) => p.cumulativeSpendUsd)).toEqual([10, 20, 20]);
    expect(out.daily.at(-1)!.roiMultiple).toBe(15);
  });

  it("nulls spend and return from the first day with unpriced spend, never the billed figure", () => {
    const vendor = buildRoiHistory(new Map([["2026-02-01", 10], ["2026-02-02", 10], ["2026-02-03", 5]]), pipeline as never, 300);
    const out = buildActualCostHistory(vendor, new Map([["2026-02-02", 7], ["2026-02-03", 1]]));
    expect(out.unpricedFromDate).toBe("2026-02-02");
    expect(out.unpricedBilledCostUsd).toBe(8);
    expect(out.daily.map((p) => p.cumulativeSpendUsd)).toEqual([10, null, null]);
    expect(out.daily.map((p) => p.roiMultiple)).toEqual([10, null, null]);
    // The value leg is untouched.
    expect(out.daily.map((p) => p.cumulativePipelineUsd)).toEqual([100, 100, 300]);
    // What IS known stays readable beside it, under its own names — never as the actual cost.
    expect(out.daily.map((p) => p.cumulativePricedVendorCostUsd)).toEqual([10, 20, 25]);
    expect(out.daily.map((p) => p.cumulativeUnpricedBilledCostUsd)).toEqual([0, 7, 8]);
  });
  it("a day carrying ONLY unpriced spend is still a point, so the unknown is visible where it begins", () => {
    const vendor = buildRoiHistory(new Map([["2026-02-01", 10]]), [] as never, 0);
    const out = buildActualCostHistory(vendor, new Map([["2026-02-05", 40]]), ["instantly-account-email-sent"]);
    expect(out.daily.map((p) => p.date)).toEqual(["2026-02-01", "2026-02-05"]);
    expect(out.daily[1]).toEqual({
      date: "2026-02-05", cumulativeSpendUsd: null, cumulativePipelineUsd: 0, roiMultiple: null,
      cumulativePricedVendorCostUsd: 10, cumulativeUnpricedBilledCostUsd: 40,
    });
    expect(out.unpricedCostNames).toEqual(["instantly-account-email-sent"]);
  });
});

describe("vendorSpendLedger", () => {
  it("returns the vendor figure, and subtracts the maturing read's unpriced share from the whole read's", async () => {
    const ledger = vendorSpendLedger(async (...args) =>
      args[6]
        ? new Map([["2026-02-02", { vendorUsd: 1, unpricedBilledUsd: 1, unpricedCostNames: 1 > 0 ? ["instantly-x"] : [] }], ["2026-02-03", { vendorUsd: 0, unpricedBilledUsd: 4, unpricedCostNames: 4 > 0 ? ["instantly-x"] : [] }]])
        : new Map([
            ["2026-02-01", { vendorUsd: 2, unpricedBilledUsd: 0, unpricedCostNames: 0 > 0 ? ["instantly-x"] : [] }],
            ["2026-02-02", { vendorUsd: 1, unpricedBilledUsd: 3, unpricedCostNames: 3 > 0 ? ["instantly-x"] : [] }],
            ["2026-02-03", { vendorUsd: 0, unpricedBilledUsd: 4, unpricedCostNames: 4 > 0 ? ["instantly-x"] : [] }],
          ]),
    );
    const a = await ledger.reader("b", undefined, "s", { orgId: "o" }, "gross");
    await ledger.reader("b", ["c"], "s", { orgId: "o" }, "gross", undefined, "2026-02-02T00:00:00.000Z");
    expect([...a]).toEqual([["2026-02-01", 2], ["2026-02-02", 1], ["2026-02-03", 0]]);
    // 02-02: 3 unpriced of which 1 is the maturing campaigns' (not on the curve) → 2 remain.
    // 02-03: all 4 unpriced are the maturing campaigns', which the curve excludes → nothing unknown.
    expect([...ledger.unpricedByDay()]).toEqual([["2026-02-02", 2]]);
    expect(ledger.unpricedCostNames()).toEqual(["instantly-x"]);
  });
});
