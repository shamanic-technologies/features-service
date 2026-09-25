import { describe, it, expect } from "vitest";
import { mergeCostAnswers, splitLifetimeCostUrl } from "./runs-cost-split.js";

const g = (dims: Record<string, string>, total: string, runs: number, min: string, max: string) => ({
  dimensions: dims,
  totalCostInUsdCents: total,
  actualCostInUsdCents: total,
  netTotalCostInUsdCents: total,
  runCount: runs,
  minStartedAt: min,
  maxStartedAt: max,
});

describe("past + today split of a lifetime runs cost read", () => {
  it("partitions the ledger at today's UTC midnight with no gap and no overlap", () => {
    const split = splitLifetimeCostUrl(
      "http://runs:8080/v1/stats/costs?groupBy=workflowSlug&brandId=b",
      new Date("2026-09-24T15:00:00Z"),
    )!;
    expect(new URL(split.past).searchParams.get("startedBefore")).toBe("2026-09-23T23:59:59.999999Z");
    expect(new URL(split.today).searchParams.get("startedAfter")).toBe("2026-09-24T00:00:00.000Z");
    expect(new URL(split.past).searchParams.get("groupBy")).toBe("workflowSlug");
  });

  it("leaves a bounded read, and every other path, alone", () => {
    expect(splitLifetimeCostUrl("http://runs/v1/stats/costs?startedAfter=2026-01-01")).toBeNull();
    expect(splitLifetimeCostUrl("http://runs/v1/stats/public/costs?groupBy=campaignId")).toBeNull();
    expect(splitLifetimeCostUrl("http://runs/v1/stats/costs/timeseries?x=1")).toBeNull();
  });

  it("sums money exactly in the producer's 10-decimal text, adds runs, combines the bounds", () => {
    const merged = mergeCostAnswers(
      { groups: [g({ w: "a" }, "100.1234567891", 3, "2026-01-01", "2026-09-23"), g({ w: "b" }, "5.0000000000", 1, "2026-02-01", "2026-02-01")] },
      { groups: [g({ w: "a" }, "0.0000000009", 2, "2026-09-24", "2026-09-24"), g({ w: "c" }, "900.0000000000", 1, "2026-09-24", "2026-09-24")] },
    );
    expect(merged.groups.map((x) => x.dimensions)).toEqual([{ w: "c" }, { w: "a" }, { w: "b" }]);
    const a = merged.groups.find((x) => (x.dimensions as Record<string, string>).w === "a")!;
    expect(a.totalCostInUsdCents).toBe("100.1234567900");
    expect(a.runCount).toBe(5);
    expect(a.minStartedAt).toBe("2026-01-01");
    expect(a.maxStartedAt).toBe("2026-09-24");
  });

  it("sums a quantity at its own precision", () => {
    const merged = mergeCostAnswers(
      { groups: [{ dimensions: { c: "x" }, totalQuantity: "196158.000000", totalCostInUsdCents: "1.0000000000" }] },
      { groups: [{ dimensions: { c: "x" }, totalQuantity: "0.500000", totalCostInUsdCents: "2.0000000000" }] },
    );
    expect(merged.groups[0]!.totalQuantity).toBe("196158.500000");
    expect(merged.groups[0]!.totalCostInUsdCents).toBe("3.0000000000");
  });

  it("refuses a field it does not know how to combine", () => {
    expect(() => mergeCostAnswers({ groups: [{ dimensions: {}, weird: 1 }] }, { groups: [{ dimensions: {}, weird: 2 }] })).toThrow(/weird/);
  });
});
