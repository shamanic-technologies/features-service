import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchBrandVendorSpendByDay } from "./vendor-spend-by-day-client.js";

process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";

const bucket = (period: string, v: string, u: string, vr = "0", ur = "0") => ({
  period, totalCostInUsdCents: "999", vendorTotalCostInUsdCents: v, unpricedTotalCostInUsdCents: u,
  vendorRefundedCostInUsdCents: vr, unpricedRefundedCostInUsdCents: ur, unpricedCostNames: u === "0" ? [] : ["instantly-account-email-sent"], runCount: 1,
});

afterEach(() => vi.restoreAllMocks());

describe("fetchBrandVendorSpendByDay", () => {
  it("reads the SERVICE-AUTH vendor route, keeps priced and unpriced apart, and counts comped rows as real cost", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (u: string) => {
      seen.push(u);
      return new Response(JSON.stringify({ buckets: [bucket("2026-02-01T00:00:00Z", "100", "0", "50"), bucket("2026-02-02", "20", "300", "0", "7")] }));
    }) as never);
    const out = await fetchBrandVendorSpendByDay("b1", "c1", "sales-cold-email-outreach", { orgId: "o1" }, "gross", "dawn");
    expect(seen[0]).toContain("/internal/stats/costs/timeseries/vendor?");
    expect(seen[0]).toContain("campaignId=c1");
    expect(seen[0]).toContain("workflowDynastySlug=dawn");
    expect([...out]).toEqual([
      ["2026-02-01", { vendorUsd: 1.5, unpricedBilledUsd: 0, unpricedCostNames: [] }],
      ["2026-02-02", { vendorUsd: 0.2, unpricedBilledUsd: 3.07, unpricedCostNames: ["instantly-account-email-sent"] }],
    ]);
  });

  it("fails loud when a vendor field is missing — never reads it as zero", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ buckets: [{ period: "2026-02-01", totalCostInUsdCents: "5" }] }))) as never);
    await expect(fetchBrandVendorSpendByDay("b1", undefined, "s", { orgId: "o1" }, "gross")).rejects.toThrow(/vendorTotalCostInUsdCents/);
  });

  it("a campaign family is one campaignIds request, summed", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (u: string) => {
      seen.push(u);
      return new Response(JSON.stringify({ buckets: [bucket("2026-02-01", "100", "0")] }));
    }) as never);
    const out = await fetchBrandVendorSpendByDay("b1", ["a", "b"], "s", { orgId: "o1" }, "gross");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("campaignIds=a%2Cb");
    expect(out.get("2026-02-01")).toEqual({ vendorUsd: 1, unpricedBilledUsd: 0, unpricedCostNames: [] });
  });
});
