import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));
vi.mock("../lib/reading-funnels.js", async (orig) => ({
  ...(await orig<typeof import("../lib/reading-funnels.js")>()),
  fetchPricingFunnelsAllOffers: vi.fn(),
}));
vi.mock("../lib/effective-conversion-rates.js", async (orig) => ({
  ...(await orig<typeof import("../lib/effective-conversion-rates.js")>()),
  getBrandEffectiveRates: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { getBrandEffectiveRates } = await import("../lib/effective-conversion-rates.js");
const { fetchPricingFunnelsAllOffers } = await import("../lib/reading-funnels.js");
const app = (await import("../index.js")).default;
const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };

const funnel = (funnelKey: string) => ({
  funnelKey,
  name: funnelKey,
  steps: ["A", "B"],
  arrows: [{
    fromStep: "A", toStep: "B", effectiveRatePct: 40, source: "measured", unresolvedReason: null,
    measured: { fromReached: 20, toReached: 8, ratePct: 40, sufficient: true, gap: null },
    manualRatePct: 70, median: { ratePct: 22, brandCount: 7 },
  }],
});

describe("GET /brands/:brandId/conversion-rates", () => {
  beforeEach(() => {
    vi.mocked(getBrandEffectiveRates).mockReset();
    vi.mocked(getBrandEffectiveRates).mockResolvedValue({
      brandId: "brand-1",
      minMeasuredFromReached: 10,
      contactedRecipients: 400,
      funnels: [funnel("sales_meetings_from_conversation"), funnel("form_magnet"), funnel("website_purchases")] as never,
      legs: [],
    });
    // The brand's offers read two funnels (their campaigns' legs); website_purchases is not one of them.
    vi.mocked(fetchPricingFunnelsAllOffers).mockReset();
    vi.mocked(fetchPricingFunnelsAllOffers).mockResolvedValue([
      { funnelKey: "sales_meetings_from_conversation" },
      { funnelKey: "form_magnet" },
    ] as never);
  });

  it("serves only the funnels the brand's campaigns read, never the whole catalogue", async () => {
    const res = await request(app).get("/brands/brand-1/conversion-rates").set(AUTH);
    expect(res.body.funnels.map((f: { funnelKey: string }) => f.funnelKey)).toEqual(["sales_meetings_from_conversation", "form_magnet"]);
  });

  it("serves the brand's rates under the caller's org, every source beside the effective one", async () => {
    const res = await request(app).get("/brands/brand-1/conversion-rates").set(AUTH);
    expect(res.status).toBe(200);
    expect(vi.mocked(getBrandEffectiveRates)).toHaveBeenCalledWith("brand-1", "org-1");
    expect(res.body.funnels).toHaveLength(2);
    expect(res.body.funnels[0].arrows[0]).toMatchObject({ effectiveRatePct: 40, source: "measured", manualRatePct: 70, median: { ratePct: 22 } });
  });

  it("?funnel= is retired: refused with funnel_retired whatever it names, before any read", async () => {
    for (const word of ["form_magnet", "nope"]) {
      const res = await request(app).get(`/brands/brand-1/conversion-rates?funnel=${word}`).set(AUTH);
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("funnel_retired");
    }
    expect(vi.mocked(getBrandEffectiveRates)).not.toHaveBeenCalled();
  });

  it("a producer failure is a 502, never an empty set of rates", async () => {
    vi.mocked(getBrandEffectiveRates).mockRejectedValue(new Error("lead-service down"));
    const res = await request(app).get("/brands/brand-1/conversion-rates").set(AUTH);
    expect(res.status).toBe(502);
  });
});
