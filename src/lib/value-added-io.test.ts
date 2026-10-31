/**
 * computeTakeoverReturn on an outcome with NO value of its own (P5.1 follow-up, owner 2026-10-31): Client WhatsApp takes
 * paying clients over at Paid client and produces Client Satisfied, a step the engine values at nothing. Prod served
 * value added -$30,000 and ROI -111111x; it is now null with `outcome_unvalued`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("./runs-cost-client.js", () => ({ fetchRunsCostCents: vi.fn(async () => ({ committedCents: 27, actualCents: 27 })) }));
vi.mock("./followup-actions-client.js", () => ({ fetchFollowupActedLeads: vi.fn(async () => new Map([["c1", new Set(["l1", "l2"])]])) }));
vi.mock("./leads-client.js", () => ({
  fetchLeadsForRevenue: vi.fn(async () => [
    { leadId: "l1", email: null, campaignId: "c1", signals: { contacted: true }, signalDates: {} },
    { leadId: "l2", email: null, campaignId: "c1", signals: { contacted: true }, signalDates: {} },
  ]),
}));
vi.mock("./observed-steps.js", () => ({ fetchObservedStepFacts: vi.fn(async () => null) }));
vi.mock("./qualifications-client.js", () => ({ fetchQualifications: vi.fn(async () => null) }));

const { computeTakeoverReturn } = await import("./value-added-io.js");

const priced = { economics: { economics: { lifetimeRevenueUsd: 500 }, unpricedReason: null }, pricedFunnelKeys: [] } as never;

describe("computeTakeoverReturn", () => {
  it("an outcome with no value of its own (Client Satisfied): no value added, no ROI, a reason; spend still served", async () => {
    const t = await computeTakeoverReturn({
      brandId: "b",
      unitCampaignIds: ["c1"],
      featureSlugs: ["cold-whatsapp-outreach"],
      takeoverStep: "paid_client",
      takeoverLeg: { legKey: "paid_client_to_client_satisfied", toStep: "client_satisfied" },
      priced,
      pricing: "net",
      headers: { orgId: "o" },
    });
    expect(t.headline).toEqual({ totalPipelineUsd: null, unpricedReason: "outcome_unvalued" });
    expect(t.valueAdded).toBeNull();
    expect(t.costEconomics.roiMultiple).toBeNull();
    expect(t.costEconomics.committedCostUsd).toBe(0.27);
  });
});
