import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";

const { fetchBrandInfoBatch, fetchFleetSpendByDay } = await import("./public-stats-clients.js");

describe("fetchFleetSpendByDay", () => {
  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = "http://runs:3000";
    process.env.RUNS_SERVICE_API_KEY = "runs-key";
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls the timeseries endpoint (interval=day) and maps period → spentUsd (cents/100)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        interval: "day", timezone: "UTC",
        buckets: [
          { period: "2026-07-01", totalCostInUsdCents: "300.0000000000", actualCostInUsdCents: "300", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0", runCount: 2 },
          { period: "2026-07-02", totalCostInUsdCents: "150.0000000000", actualCostInUsdCents: "150", provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0", runCount: 1 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const map = await fetchFleetSpendByDay("sales-cold-email-outreach");

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain("/v1/stats/public/costs/timeseries");
    expect(url).toContain("interval=day");
    expect(url).toContain("featureSlug=sales-cold-email-outreach");
    expect(map.get("2026-07-01")).toBeCloseTo(3, 6); // 300 cents = $3
    expect(map.get("2026-07-02")).toBeCloseTo(1.5, 6);
  });

  it("throws (fail-loud) on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchFleetSpendByDay("x")).rejects.toThrow(/costs\/timeseries failed: 500/);
  });
});

describe("fetchBrandInfoBatch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.BRAND_SERVICE_URL = "http://brand:3000";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("fires exactly ONE batch call for any number of ids ≤ 100", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        brands: [
          { id: "brand-1", name: "Acme", domain: "acme.com" },
          { id: "brand-2", name: "Beta", domain: "beta.io" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const result = await fetchBrandInfoBatch(["brand-1", "brand-2"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe("http://brand:3000/internal/brands?ids=brand-1,brand-2");
    expect(result.get("brand-1")?.name).toBe("Acme");
    expect(result.get("brand-2")?.name).toBe("Beta");
  });

  it("returns empty Map for empty input without any fetch call", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await fetchBrandInfoBatch([]);

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result.size).toBe(0);
  });

  it("chunks into multiple batch calls of ≤100 ids when input exceeds the cap", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ brands: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const ids = Array.from({ length: 150 }, (_, i) => `brand-${i}`);
    await fetchBrandInfoBatch(ids);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstUrl = fetchSpy.mock.calls[0][0] as string;
    const secondUrl = fetchSpy.mock.calls[1][0] as string;
    expect(firstUrl.split("ids=")[1].split(",")).toHaveLength(100);
    expect(secondUrl.split("ids=")[1].split(",")).toHaveLength(50);
  });

  it("returns empty Map and skips fetch when env vars are missing", async () => {
    delete process.env.BRAND_SERVICE_URL;
    delete process.env.BRAND_SERVICE_API_KEY;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchBrandInfoBatch(["brand-1"]);

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result.size).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured"),
    );
  });

  it("returns empty Map without throwing when response is non-OK", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchBrandInfoBatch(["brand-1"]);

    expect(result.size).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("brand-service GET /internal/brands batch failed: 500"),
    );
  });

  it("returns empty Map without throwing when fetch throws", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchBrandInfoBatch(["brand-1"]);

    expect(result.size).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("brand-service GET /internal/brands batch error"),
      expect.anything(),
    );
  });
});
