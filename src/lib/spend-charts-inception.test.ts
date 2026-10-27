/**
 * SPEND-CHARTS-INCEPTION-1027: the offer chart covers EVERY campaign the offer ran since its first activity (the
 * legacy campaigns from before the funnel-campaign era included) plus the brand's campaign-less work, so its totals
 * are the brand offers read's for that offer, and its series starts on the offer's first spend day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const spendByDay = vi.fn();
const brandLevel = vi.fn();
const leads = vi.fn();
vi.mock("./brand-spend-by-day-client.js", () => ({ fetchBrandCommittedSpendByDay: (...a: unknown[]) => spendByDay(...a), RUNS_CAMPAIGN_IDS_PER_REQUEST: 500 }));
vi.mock("./brand-level-spend.js", async (orig) => ({ ...(await orig<typeof import("./brand-level-spend.js")>()), fetchBrandLevelSpend: (...a: unknown[]) => brandLevel(...a) }));
vi.mock("./spend-by-task-day-client.js", () => ({ fetchSpendByTaskDay: async () => [] }));
vi.mock("./leads-client.js", async (orig) => ({ ...(await orig<typeof import("./leads-client.js")>()), fetchLeadsForRevenue: (...a: unknown[]) => leads(...a) }));
vi.mock("./email-status-client.js", () => ({ fetchEventTimestamps: async () => null }));
vi.mock("./observed-steps.js", () => ({ fetchObservedStepFacts: async () => null }));
vi.mock("./signal-overlays.js", () => ({ applySignalOverlays: () => undefined }));

import { computeSpendChart } from "./spend-charts-io.js";
import { groupScope } from "../routes/spend-charts.js";
import type { SalesFunnelCampaignRow } from "./sales-funnel-campaigns-client.js";
import type { ExpectedReturn } from "./expected-return.js";

const coldEmail = { channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", fromStep: "lead_found", toStep: "conversation" };

const funnelRow = {
  id: "sfc1",
  brandId: "b1",
  offerId: "o1",
  salesFunnelId: "f1",
  createdAt: "2026-10-14T00:00:00Z",
  units: [
    { campaignId: "unit-src", pipeId: "lead-sourcing|start_to_lead_found", featureSlug: "lead-sourcing", legKey: "start_to_lead_found", status: "ongoing" },
    { campaignId: "unit-ce", pipeId: "sales-cold-email-outreach|lead_found_to_conversation", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", status: "ongoing" },
  ],
} as unknown as SalesFunnelCampaignRow;

const offerChannels = [
  { featureSlug: "lead-sourcing", campaignIds: ["unit-src"] },
  { featureSlug: "sales-cold-email-outreach", campaignIds: ["legacy-1", "legacy-2", "unit-ce"] },
  { featureSlug: "feedback-request-cold-email-outreach", campaignIds: ["legacy-3"] },
];

const person = (leadId: string, campaignId: string, sent: string, reply: string | null) => ({
  leadId,
  campaignId,
  email: `${leadId}@x.com`,
  signals: { contacted: true, positiveReply: reply !== null },
  signalDates: { contacted: sent, positiveReply: reply },
});

const expected = { roiMultiple: null, basis: null, assumptions: [], combinationKey: null, costPerOutcome: null, unavailableReason: "x" } as unknown as ExpectedReturn;

describe("offer spend chart since inception (legacy + funnel campaigns)", () => {
  beforeEach(() => {
    spendByDay.mockReset();
    brandLevel.mockReset();
    leads.mockReset();
  });

  it("the offer scope holds every campaign and channel of the offer, funnel units and legacy campaigns alike", () => {
    const scope = groupScope([funnelRow], coldEmail, offerChannels);
    expect(scope.campaignIds).toEqual(["legacy-1", "legacy-2", "legacy-3", "unit-ce", "unit-src"]);
    expect(scope.personCampaignIds).toEqual(scope.campaignIds);
    expect(scope.featureSlugs).toEqual(["feedback-request-cold-email-outreach", "lead-sourcing", "sales-cold-email-outreach"]);
    expect(scope.brandLevelSpend).toBe(true);
    // A funnel campaign's own chart stays its own units, no brand-level work.
    const own = groupScope([funnelRow], coldEmail);
    expect(own.campaignIds).toEqual(["unit-ce", "unit-src"]);
    expect(own.brandLevelSpend).toBe(false);
  });

  it("starts on the offer's first spend day (July), counts legacy replies, and adds the brand-level spend per day", async () => {
    spendByDay.mockResolvedValue(
      new Map([
        ["2026-07-01", 100],
        ["2026-10-14", 50],
      ]),
    );
    brandLevel.mockResolvedValue({
      brandCampaignLessTotalCents: 1000,
      sources: [],
      totalCents: 1000,
      actualCents: 1000,
      byDay: new Map([["2026-08-01", { totalCents: 1000, actualCents: 1000 }]]),
    });
    leads.mockResolvedValue([
      person("a", "legacy-1", "2026-07-01T09:00:00Z", "2026-07-03T09:00:00Z"),
      person("b", "legacy-3", "2026-07-02T09:00:00Z", null),
      person("c", "unit-ce", "2026-10-14T09:00:00Z", "2026-10-15T09:00:00Z"),
    ]);
    const scope = groupScope([funnelRow], coldEmail, offerChannels);
    const chart = await computeSpendChart({
      brandId: "b1",
      scope,
      handedRows: [],
      expected,
      fleetConversions: new Map(),
      brandRateOf: () => null,
      pricing: "net",
      headers: { orgId: "org1" },
      today: "2026-10-20",
    });
    // Every campaign of the offer is read, on every channel, with the brand-level part on the offer grain.
    expect(spendByDay.mock.calls[0][1]).toEqual(scope.campaignIds);
    expect(brandLevel.mock.calls[0][0]).toMatchObject({ campaignScoped: true, pricing: "net", featureScope: scope.featureSlugs });
    expect(leads.mock.calls[0][1]).toEqual(scope.campaignIds);

    expect(chart.daily[0].date).toBe("2026-07-01");
    expect(chart.totals.spendUsd).toBe(160);
    expect(chart.totals.outcomes).toBe(2);
    expect(chart.totals.costPerOutcomeUsd).toBe(80);
    expect(chart.totals.entered).toBe(3);
    expect(chart.daily.find((d) => d.date === "2026-08-01")?.spendUsd).toBe(10);
  });
});
