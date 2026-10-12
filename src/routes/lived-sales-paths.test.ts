/**
 * LIVED SALES PATHS (owner 2026-10-12): the way each person actually came, measured on its people, ranked
 * overall and per sales funnel campaign, beside the catalogue's expected figures of the same path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const fetchBrandJourneys = vi.fn();
vi.mock("../lib/brand-journeys-client.js", () => ({ fetchBrandJourneys: (...a: unknown[]) => fetchBrandJourneys(...a) }));
const fetchRunsCostUsdByCampaign = vi.fn();
vi.mock("../lib/runs-cost-client.js", () => ({ fetchRunsCostUsdByCampaign: (...a: unknown[]) => fetchRunsCostUsdByCampaign(...a) }));
const fetchSalesFunnelCampaigns = vi.fn();
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => fetchSalesFunnelCampaigns(...a) }));
vi.mock("../lib/brand-leg-economics-client.js", () => ({
  fetchBrandLegEconomics: vi.fn(async () => ({ legRates: [], offers: [{ offerId: "o1", lifetimeRevenueUsd: 3000 }, { offerId: "o2", lifetimeRevenueUsd: null }] })),
}));
vi.mock("../lib/offer-lifetime-revenue.js", () => ({ offerLifetimeRevenue: vi.fn(async () => ({ usd: 1200, source: "fleet_median" })) }));
vi.mock("../lib/brand-channels.js", () => ({
  resolveBrandChannels: vi.fn(async () => [{ featureSlug: "sales-cold-email-outreach", campaignIds: [] }, { featureSlug: "social-post", campaignIds: [] }]),
  brandFeatureSlugs: (c: Array<{ featureSlug: string }>) => c.map((x) => x.featureSlug),
  BrandHasNoChannelsError: class extends Error {},
}));
const SOCIAL_PATH = "start_to_industry_update_video+industry_update_video_to_website_visit+website_visit_to_signup+signup_to_paid_client";
vi.mock("./agent-catalogue.js", () => ({
  catalogueForLivedPaths: vi.fn(async () => ({
    stepKeys: ["conversation", "website_visit", "meeting_booked", "meeting_attended", "signup", "form_submitted", "purchase", "paid_client", "lead_found", "industry_update_video"],
    expectedOf: (id: string) => (id === "start_to_lead_found+lead_found_to_conversation+conversation_to_paid_client" ? { salesPathId: id, name: "Rhine", status: "estimated", costUsd: 400, roi: 7.5, roiBasis: "estimated" } : null),
    expectedUnavailableReason: null,
  })),
}));
class BrandOwnershipError extends Error {}
const assertBrandHeld = vi.fn(async () => {});
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: (...a: unknown[]) => assertBrandHeld(...(a as [])), BrandOwnershipError }));
vi.mock("../lib/view-cache.js", () => ({
  servedCachedJson: async (a: { compute: () => unknown }) => ({ json: JSON.stringify(await a.compute()) }),
  sendSnapshotJson: (res: express.Response, body: { json: string }) => res.type("json").send(body.json),
  buildScopeKey: () => "k",
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const router = (await import("./lived-sales-paths.js")).default;
const app = express().use(router);
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const f = (label: string, occurredAt: string | null, extra: Record<string, unknown> = {}) => ({ label, occurredAt, campaignId: null, attributable: null, valueCents: null, ...extra });

beforeEach(() => {
  assertBrandHeld.mockReset().mockResolvedValue(undefined);
  fetchBrandJourneys.mockReset().mockResolvedValue([
    // Marie, on two offers: cold email -> positive reply -> paid on o1; the video -> visit -> signup on o2.
    {
      leadId: "marie",
      offerId: "o1",
      acts: [{ campaignId: "email", firstActedAt: "2026-09-01T00:00:00Z" }],
      facts: [f("interested", "2026-09-02T00:00:00Z", { campaignId: "email" }), f("paid_client", "2026-09-20T00:00:00Z", { campaignId: "email", attributable: true, valueCents: 250000 })],
    },
    {
      leadId: "marie",
      offerId: "o2",
      acts: [],
      facts: [f("industry_update_video", "2026-10-12T10:00:00Z", { campaignId: "video" }), f("website_visit", "2026-10-12T11:00:00Z"), f("signup", "2026-10-12T12:00:00Z")],
    },
    // Paul, cold email, never answered.
    { leadId: "paul", offerId: "o1", acts: [{ campaignId: "email", firstActedAt: "2026-09-01T00:00:00Z" }], facts: [] },
    // A customer of the brand's own CRM nobody of ours touched.
    { leadId: "crm", offerId: null, acts: [], facts: [f("paid_client", "2026-05-01T00:00:00Z", { attributable: false, valueCents: 100 })] },
  ]);
  fetchRunsCostUsdByCampaign.mockReset().mockResolvedValue(
    new Map<string | null, number>([
      ["email", 80],
      ["sourcing", 20],
      ["video", 15],
      [null, 5],
    ]),
  );
  fetchSalesFunnelCampaigns.mockReset().mockResolvedValue([
    { id: "FC-email", offerId: "o1", salesFunnelId: "start_to_lead_found@x+lead_found_to_conversation@y+conversation_to_paid_client@z", salesFunnelName: "Bliss", units: [{ campaignId: "email" }, { campaignId: "sourcing" }] },
    { id: "FC-video", offerId: "o2", salesFunnelId: "start_to_industry_update_video@social-post+industry_update_video_to_paid_client", salesFunnelName: "Glory", units: [{ campaignId: "video" }] },
  ]);
});

describe("GET /brands/:brandId/lived-sales-paths", () => {
  it("one person on two offers lives two journeys, each on its own path; Σ paths = totals; spend + unattributed = the whole spend", async () => {
    const res = await request(app).get("/brands/b1/lived-sales-paths").set(AUTH);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.since).toBe("inception");
    const byId = new Map(body.paths.map((p: { pathId: string }) => [p.pathId, p]));
    const email = byId.get("start_to_lead_found+lead_found_to_conversation+conversation_to_paid_client") as Record<string, unknown>;
    expect(email).toMatchObject({ leads: 1, paidClients: 1, revenueUsd: 2500, costUsd: 50, roi: 50, status: "measured", rank: 1 });
    expect(email.expected).toMatchObject({ name: "Rhine", roi: 7.5 });
    expect(byId.get(SOCIAL_PATH)).toMatchObject({ leads: 1, paidClients: 0, roi: null, status: "learning", costUsd: 15, expected: null });
    expect(byId.get("start_to_lead_found+lead_found_to_paid_client")).toMatchObject({ leads: 1, paidClients: 0, costUsd: 50, status: "learning" });

    const sum = (k: string) => body.paths.reduce((s: number, p: Record<string, number>) => s + p[k], 0);
    expect(sum("leads")).toBe(body.totals.leads);
    expect(sum("revenueUsd")).toBe(body.totals.revenueUsd);
    expect(sum("costUsd")).toBeCloseTo(body.totals.costUsd, 9);
    expect(body.totals).toMatchObject({ leads: 3, paidClients: 1, revenueUsd: 2500, unattributedCostUsd: 5, totalCostUsd: 120, excludedJourneys: 1 });
  });

  it("ranks within each sales funnel campaign; Σ funnels = the overall totals", async () => {
    const res = await request(app).get("/brands/b1/lived-sales-paths").set(AUTH);
    const funnels = res.body.funnels as Array<{ funnelCampaignId: string; salesFunnelName: string; totals: { leads: number; costUsd: number }; paths: Array<{ rank: number }> }>;
    expect(funnels.map((g) => [g.funnelCampaignId, g.salesFunnelName, g.totals.leads])).toEqual([
      ["FC-email", "Bliss", 2],
      ["FC-video", "Glory", 1],
    ]);
    expect(funnels[0].paths.map((p) => p.rank)).toEqual([1, 2]);
    expect(funnels.reduce((s, g) => s + g.totals.costUsd, 0)).toBeCloseTo(res.body.totals.costUsd, 9);
  });

  it("an offer read keeps that offer's people and the spend of the campaigns selling it", async () => {
    const res = await request(app).get("/brands/b1/lived-sales-paths?offerId=o2").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.paths.map((p: { pathId: string }) => p.pathId)).toEqual([SOCIAL_PATH]);
    expect(res.body.totals).toMatchObject({ leads: 1, totalCostUsd: 15, unattributedCostUsd: 0 });
  });

  it("a brand the caller does not hold is a named 404; a bad pricing a 400", async () => {
    assertBrandHeld.mockRejectedValueOnce(new BrandOwnershipError("not held"));
    expect((await request(app).get("/brands/b9/lived-sales-paths").set(AUTH)).body.reason).toBe("brand_not_found");
    expect((await request(app).get("/brands/b1/lived-sales-paths?pricing=cheap").set(AUTH)).status).toBe(400);
  });

  it("an unreadable timeline is a 502, never an empty ranking", async () => {
    fetchBrandJourneys.mockRejectedValueOnce(new Error("lead-service down"));
    const res = await request(app).get("/brands/b1/lived-sales-paths").set(AUTH);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("lived_sales_paths_unavailable");
  });
});
