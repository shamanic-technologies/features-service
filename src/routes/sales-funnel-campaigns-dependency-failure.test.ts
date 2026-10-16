/**
 * SFC-MONEY-SLOW-1016 (prod 2026-10-16: 23.7 s then 43.9 s): with its dependencies FAILING (lead-service's change
 * feed 502, the fleet outcome-prices build never finishing), the Campaigns table still answers from its last values,
 * and a second read is never a full recompute. The money cell is emulated as the Gold layer serves it (last value,
 * refreshed behind); the EXPECTED return runs its real memo over a model computation that fails like prod's.
 */
import { describe, it, expect, vi } from "vitest";
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
            ? { name: "Motivate", face: "/f", type: "reactive", triggerLabel: "Positive replies", shortDescription: "We book meetings with buyers who reply with interest.", shortDescriptionUnavailableReason: null, firstStep: "conversation", path: { items: [], legs: [] } }
            : { name: "Bliss", face: "/f", type: "proactive", triggerLabel: null, shortDescription: "We email new buyers until they reply with interest.", shortDescriptionUnavailableReason: null, firstStep: "lead_found", path: { items: [{ kind: "step", key: "lead_found", label: "Lead found" }], legs: [] } },
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
const funnelCampaignActivity = vi.fn();
vi.mock("./sales-funnel-campaign-activity.js", () => ({ funnelCampaignActivity: (...a: unknown[]) => funnelCampaignActivity(...a) }));
const computeTakeoverReturn = vi.fn();
vi.mock("../lib/value-added-io.js", () => ({ computeTakeoverReturn: (...a: unknown[]) => computeTakeoverReturn(...a) }));
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: vi.fn(async () => {}), BrandOwnershipError: class extends Error {} }));
const fetchWithRetry = vi.fn();
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));
const warmFunnelCampaignReads = vi.fn(async () => ({ urls: [], skippedReason: null }));
vi.mock("../lib/funnel-campaign-warm.js", () => ({ warmFunnelCampaignReads: (...a: unknown[]) => warmFunnelCampaignReads(...(a as [])) }));
const cells = new Map<string, unknown>();
vi.mock("../lib/view-cache.js", () => ({
  servedCached: async (a: { view: string; scopeKey: string; compute: () => Promise<unknown> }) => {
    const key = `${a.view}|${a.scopeKey}`;
    if (cells.has(key)) {
      a.compute().then((v) => cells.set(key, v), () => {}); // refreshed behind; a failure keeps the last value
      return cells.get(key);
    }
    const v = await a.compute();
    cells.set(key, v);
    return v;
  },
  buildScopeKey: (prefix: string) => prefix,
}));
// The real expected-return memo (the suite-wide setup stubs it), over a model whose fleet-cost wait fails.
vi.mock("../lib/expected-return.js", async () => vi.importActual("../lib/expected-return.js"));
const computeOfferSalesPathsModel = vi.fn(
  () => new Promise((_, reject) => setTimeout(() => reject(new Error("fleet leg costs (outcome prices) not computed yet")), 1_500)),
);
vi.mock("./offer-sales-paths.js", () => ({ computeOfferSalesPathsModel: (...a: unknown[]) => computeOfferSalesPathsModel(...(a as [])) }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const router = (await import("./sales-funnel-campaigns.js")).default;
const app = express().use(router);
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };
const unit = (campaignId: string) => ({ campaignId, pipeId: "sourcing-apollo-cold-filters|start_to_lead_found", featureSlug: "sourcing-apollo-cold-filters", legKey: "start_to_lead_found", status: "ongoing", workflowSlug: null, name: campaignId });
const FC = (id: string) => ({
  id, orgId: "o", brandId: "b1", offerId: "of1", salesFunnelId: "f1", salesFunnelName: "Bliss", status: "ongoing", stopReason: null, createdByUserId: null, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", units: [unit(`c-${id}`)],
});
const LEAD_SERVICE_DOWN = 'lead-service /orgs/leads/changes failed (502): {"error":"email-gateway unavailable"}';

describe("the Campaigns table with its dependencies failing (SFC-MONEY-SLOW-1016)", () => {
  it("a second read of the same brand+offer answers in under a second, from the last values", async () => {
    // Five funnel campaigns (the prod brand's count): the rows run three at a time.
    fetchWithRetry.mockImplementation(async () => new Response(JSON.stringify({ salesFunnelCampaigns: ["a", "b", "c", "d", "e"].map(FC) })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    funnelCampaignActivity.mockResolvedValue({ funnel: null, funnelUnavailableReason: "sales_funnel_not_in_catalogue" });
    // The first read computes the money; every compute after it fails as lead-service did, slowly.
    computeFeatureRevenue.mockResolvedValueOnce({ headline: null, costEconomics: { committedCostUsd: 7.5, roiMultiple: null, unmeasuredReason: null }, maturity: null });
    computeFeatureRevenue.mockResolvedValueOnce({ headline: null, costEconomics: { committedCostUsd: 7.5, roiMultiple: null, unmeasuredReason: null }, maturity: null });
    computeFeatureRevenue.mockResolvedValueOnce({ headline: null, costEconomics: { committedCostUsd: 7.5, roiMultiple: null, unmeasuredReason: null }, maturity: null });
    computeFeatureRevenue.mockResolvedValueOnce({ headline: null, costEconomics: { committedCostUsd: 7.5, roiMultiple: null, unmeasuredReason: null }, maturity: null });
    computeFeatureRevenue.mockResolvedValueOnce({ headline: null, costEconomics: { committedCostUsd: 7.5, roiMultiple: null, unmeasuredReason: null }, maturity: null });
    computeFeatureRevenue.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error(LEAD_SERVICE_DOWN)), 1_500)));

    const url = "/brands/b1/sales-funnel-campaigns?offerId=of1&pricing=net";
    let t0 = Date.now();
    const first = await request(app).get(url).set(AUTH);
    expect(first.status).toBe(200);
    // The first read waits on the cold expected-return model once (one row), never once per batch of rows.
    expect(Date.now() - t0).toBeLessThan(2_000);

    t0 = Date.now();
    const second = await request(app).get(url).set(AUTH);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(second.status).toBe(200);
    for (const row of second.body.salesFunnelCampaigns) {
      expect(row.investedUsd).toBe(7.5); // the last value, never a zero or a guess
      expect(row.expectedReturn.unavailableReason).toBe("expected_model_computing"); // visibly missing, with its reason
    }

    // The model's computation fails: the failure is remembered, so the next read neither waits nor restarts it.
    await new Promise((r) => setTimeout(r, 1_600));
    t0 = Date.now();
    const third = await request(app).get(url).set(AUTH);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(third.body.salesFunnelCampaigns.map((r: { investedUsd: number }) => r.investedUsd)).toEqual([7.5, 7.5, 7.5, 7.5, 7.5]);
    for (const row of third.body.salesFunnelCampaigns) expect(row.expectedReturn.unavailableReason).toBe("expected_model_unavailable");
    expect(computeOfferSalesPathsModel).toHaveBeenCalledTimes(1);
  }, 15_000);
});
