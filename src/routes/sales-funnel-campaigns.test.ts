/**
 * THE CAMPAIGNS TABLE READ (owner 2026-10-11): one row per sales funnel campaign, its copy served, its money
 * computed ONCE over its units together (never a sum of unit ROIs), invested = the units' committed spend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const computeFeatureRevenue = vi.fn();
vi.mock("./revenue.js", () => ({
  computeFeatureRevenue: (...a: unknown[]) => computeFeatureRevenue(...a),
  fetchDeclaredFunnelsSoft: vi.fn(async () => []),
  priceOnDeclaredFunnel: vi.fn(() => ({ economics: null, pricedFunnelKeys: [] })),
  pricedFingerprint: vi.fn(() => "fp"),
}));
const distinctChannelFunnels = vi.fn();
vi.mock("./offer-economics.js", () => ({ distinctChannelFunnels: (...a: unknown[]) => distinctChannelFunnels(...a) }));
vi.mock("./agent-catalogue.js", () => ({
  funnelCopiesFor: vi.fn(async (ids: string[]) =>
    new Map(
      ids.map((id) => [
        id,
        id === "unknown"
          ? null
          : { name: "Bliss", face: "/f", line: "x", type: "proactive", description: "We email your buyers until they reply with interest, and your team takes it from there.", typeLabel: "Daily", trigger: null },
      ]),
    ),
  ),
}));
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: vi.fn(async () => {}), BrandOwnershipError: class extends Error {} }));
const fetchWithRetry = vi.fn();
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));
vi.mock("../lib/view-cache.js", () => ({ servedCached: async (a: { compute: () => unknown }) => a.compute(), buildScopeKey: () => "k" }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const router = (await import("./sales-funnel-campaigns.js")).default;
const app = express().use(router);
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const unit = (campaignId: string, featureSlug: string, legKey: string) => ({ campaignId, pipeId: `${featureSlug}|${legKey}`, featureSlug, legKey, status: "ongoing", workflowSlug: null, name: campaignId });
const FC = (id: string, salesFunnelId: string, units: unknown[]) => ({
  id, orgId: "o", brandId: "b1", offerId: "of1", salesFunnelId, salesFunnelName: "Bliss", status: "ongoing", stopReason: null, createdByUserId: null, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", units,
});

beforeEach(() => {
  computeFeatureRevenue.mockReset();
  distinctChannelFunnels.mockReset();
  fetchWithRetry.mockReset();
});

describe("GET /brands/:brandId/sales-funnel-campaigns", () => {
  it("one engine pass over the units together: invested = committed of the units, ROI from the same body, copy served", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [unit("c2", "sales-cold-email-outreach", "lead_found_to_conversation"), unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ costEconomics: { committedCostUsd: 12.34, roiMultiple: 2.5, unmeasuredReason: null }, maturity: { isMature: false, legs: [] } });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH);
    expect(res.status).toBe(200);
    expect(computeFeatureRevenue).toHaveBeenCalledTimes(1);
    const args = computeFeatureRevenue.mock.calls[0];
    expect(args[0]).toEqual(["sales-cold-email-outreach", "sourcing-apollo-cold-filters"]);
    expect(args[2]).toEqual(["c1", "c2"]);
    expect(args[8]).toBe("net");
    expect(args[10]).toBe("of1");
    const row = res.body.salesFunnelCampaigns[0];
    expect(row).toMatchObject({ id: "fc1", name: "Bliss", typeLabel: "Daily", type: "proactive", trigger: null, investedUsd: 12.34, roiMultiple: 2.5, moneyUnavailableReason: null, copyUnavailableReason: null });
    expect(row.description).toMatch(/^We email your buyers/);
    expect(row.maturity).toEqual({ isMature: false, legs: [] });
    expect(fetchWithRetry.mock.calls[0][0]).toBe("http://campaign:3000/sales-funnel-campaigns?brandId=b1");
  });

  it("units pricing on two funnel definitions: invested served, ROI null with a reason (never one funnel picked)", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [unit("c1", "a", "x_to_y")])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "one" }, { key: "two" }]);
    computeFeatureRevenue.mockResolvedValue({ costEconomics: { committedCostUsd: 3, roiMultiple: null, unmeasuredReason: null }, maturity: null });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns").set(AUTH);
    expect(computeFeatureRevenue.mock.calls[0][3]).toBeNull();
    expect(res.body.salesFunnelCampaigns[0]).toMatchObject({ investedUsd: 3, roiMultiple: null, moneyUnavailableReason: "units_price_differently" });
  });

  it("a funnel the catalogue does not know: copy null with a reason; offer filter forwarded", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "unknown", [])] })));
    distinctChannelFunnels.mockReturnValue([]);
    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?offerId=of1").set(AUTH);
    expect(res.body.offerId).toBe("of1");
    expect(fetchWithRetry.mock.calls[0][0]).toContain("offerId=of1");
    expect(res.body.salesFunnelCampaigns[0]).toMatchObject({ description: null, copyUnavailableReason: "sales_funnel_not_in_catalogue", investedUsd: 0, costEconomics: null });
    expect(computeFeatureRevenue).not.toHaveBeenCalled();
  });

  it("campaign-service unreadable = 502, never a guessed row; bad pricing = 400", async () => {
    fetchWithRetry.mockResolvedValue(new Response("boom", { status: 500 }));
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns").set(AUTH)).status).toBe(502);
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=x").set(AUTH)).status).toBe(400);
  });
});
