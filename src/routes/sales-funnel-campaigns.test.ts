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
const REACTIVE = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended";
vi.mock("./agent-catalogue.js", () => ({
  funnelCopiesFor: vi.fn(async (ids: string[]) => ({
    copies: new Map(
      ids.map((id) => [
        id,
        id === "unknown"
          ? null
          : id === REACTIVE
            ? { name: "Motivate", face: "/f", type: "reactive", triggerLabel: "Positive replies", firstStep: "conversation", path: { items: [], legs: [] } }
            : { name: "Bliss", face: "/f", type: "proactive", triggerLabel: null, firstStep: "lead_found", path: { items: [{ kind: "step", key: "lead_found", label: "Lead found" }], legs: [] } },
      ]),
    ),
    pipeSteps: new Map([
      ["sales-cold-email-outreach|lead_found_to_conversation", { fromStep: "lead_found", toStep: "conversation" }],
      ["sourcing-apollo-cold-filters|start_to_lead_found", { fromStep: null, toStep: "lead_found" }],
      ["ai-meeting-booking|conversation_to_meeting_booked", { fromStep: "conversation", toStep: "meeting_booked" }],
    ]),
    // The campaign's path is its funnel's (one channel per leg, owner 2026-10-11): asked by funnel id only.
    pathOf: (id: string, ...extra: unknown[]) =>
      id === "unknown" || extra.length > 0 ? null : { items: [{ kind: "step", key: "start", label: "Start" }, { kind: "channel", slug: `of:${id}`, name: "Lead Sourcing", runByUs: true }], legs: [] },
  })),
}));
const computeTakeoverReturn = vi.fn();
vi.mock("../lib/value-added-io.js", () => ({ computeTakeoverReturn: (...a: unknown[]) => computeTakeoverReturn(...a) }));
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
  computeTakeoverReturn.mockReset();
  computeFeatureRevenue.mockReset();
  distinctChannelFunnels.mockReset();
  fetchWithRetry.mockReset();
});

describe("GET /brands/:brandId/sales-funnel-campaigns", () => {
  it("one engine pass over the units together: invested = committed of the units, ROI from the same body, copy served", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [unit("c2", "sales-cold-email-outreach", "lead_found_to_conversation"), unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: { totalPipelineUsd: 30, unpricedReason: null }, costEconomics: { committedCostUsd: 12.34, roiMultiple: 2.5, unmeasuredReason: null }, maturity: { isMature: false, legs: [] } });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH);
    expect(res.status).toBe(200);
    expect(computeFeatureRevenue).toHaveBeenCalledTimes(1);
    const args = computeFeatureRevenue.mock.calls[0];
    expect(args[0]).toEqual(["sales-cold-email-outreach", "sourcing-apollo-cold-filters"]);
    expect(args[2]).toEqual(["c1", "c2"]);
    expect(args[8]).toBe("net");
    expect(args[10]).toBe("of1");
    const row = res.body.salesFunnelCampaigns[0];
    expect(row).toMatchObject({ id: "fc1", name: "Bliss", typeLabel: "Daily", type: "proactive", triggerLabel: null, investedUsd: 12.34, roiMultiple: 2.5, moneyUnavailableReason: null, copyUnavailableReason: null });
    expect(row).not.toHaveProperty("description");
    expect(row.maturity).toEqual({ isMature: false, legs: [] });
    expect(row.headline).toEqual({ totalPipelineUsd: 30, unpricedReason: null });
    expect(row.path.items[0]).toEqual({ kind: "step", key: "start", label: "Start" });
    // The path is the funnel's own (one channel per leg), never re-drawn from the campaign's units.
    expect(row.path.items.slice(1).map((i: { slug: string }) => i.slug)).toEqual(["of:f1"]);
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
    expect(res.body.salesFunnelCampaigns[0]).toMatchObject({ path: null, copyUnavailableReason: "sales_funnel_not_in_catalogue", investedUsd: 0, costEconomics: null });
    expect(computeFeatureRevenue).not.toHaveBeenCalled();
  });

  it("campaign-service unreadable = 502, never a guessed row; bad pricing = 400", async () => {
    fetchWithRetry.mockResolvedValue(new Response("boom", { status: 500 }));
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns").set(AUTH)).status).toBe(502);
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=x").set(AUTH)).status).toBe(400);
  });

  it("a campaign that TOOK its people over is credited the value it adds; one that found them keeps the engine's figures", async () => {
    fetchWithRetry.mockResolvedValue(
      new Response(
        JSON.stringify({
          salesFunnelCampaigns: [
            FC("bliss", "lead_found_to_conversation@sales-cold-email-outreach", [unit("c2", "sales-cold-email-outreach", "lead_found_to_conversation"), unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")]),
            FC("motivate", REACTIVE, [unit("c3", "ai-meeting-booking", "conversation_to_meeting_booked")]),
          ],
        }),
      ),
    );
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: { totalPipelineUsd: 30, unpricedReason: null }, costEconomics: { committedCostUsd: 12, roiMultiple: 2.5, unmeasuredReason: null }, maturity: null });
    computeTakeoverReturn.mockResolvedValue({
      headline: { totalPipelineUsd: 500, unpricedReason: null },
      costEconomics: { committedCostUsd: 10, roiMultiple: 50, unmeasuredReason: null },
      maturity: { isMature: false, legs: [] },
      valueAdded: { people: 3, valueNowUsd: 950, valueAtTakeoverUsd: 450, valueAddedUsd: 500, takeoverStep: "conversation" },
    });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH);
    const [bliss, motivate] = res.body.salesFunnelCampaigns;
    // Bliss's sourcing unit produces Lead found: it took its people from nothing, the engine's figures stand.
    expect(bliss).toMatchObject({ takeoverStep: null, roiMultiple: 2.5, investedUsd: 12, valueAdded: null });
    // Motivate answers Positive replies it did not produce: 2 x ($400 - $150) style value added over its spend.
    expect(motivate).toMatchObject({ takeoverStep: "conversation", roiMultiple: 50, investedUsd: 10, headline: { totalPipelineUsd: 500 } });
    expect(computeFeatureRevenue).toHaveBeenCalledTimes(1);
    expect(computeTakeoverReturn.mock.calls[0][0]).toMatchObject({ takeoverStep: "conversation", unitCampaignIds: ["c3"], takeoverLeg: { legKey: "conversation_to_meeting_booked", toStep: "meeting_booked" } });
  });
});
