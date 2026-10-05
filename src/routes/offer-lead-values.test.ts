/**
 * The offer grain of deals value and contacted value: the brand reads' semantics, over ONLY the leads
 * the offer's campaigns served — never the brand's numbers under the offer's name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const CAMPAIGNS: Record<string, string[]> = { "offer-a": ["camp-a1", "camp-a2"], "offer-b": ["camp-b1"] };

vi.mock("../lib/offer-channels.js", async (orig) => {
  const real = await orig<typeof import("../lib/offer-channels.js")>();
  return {
    ...real,
    resolveOfferChannels: vi.fn(async (offerId: string, brandId: string) => {
      const ids = CAMPAIGNS[offerId];
      if (!ids) throw new real.OfferHasNoChannelsError(offerId, brandId);
      return [{ featureSlug: "sales-cold-email-outreach", campaignIds: ids }];
    }),
  };
});
vi.mock("../lib/brand-channels.js", async (orig) => {
  const real = await orig<typeof import("../lib/brand-channels.js")>();
  return {
    ...real,
    resolveBrandChannels: vi.fn(async () => [
      { featureSlug: "sales-cold-email-outreach", campaignIds: ["camp-a1", "camp-a2", "camp-b1"] },
    ]),
  };
});
// The offer's terms are the ONLY pricing input (owner 2026-10-05): the brand reads the funnels stating
// exactly the terms it used to read off a brand-wide record (`declaredFromEconomics`).
// Mocked at its home (lib/offer-pricing), not on ./revenue.js: revenue.ts and contacted-value.ts import
// each other, so a ./revenue.js factory would hand contacted-value the REAL function.
vi.mock("../lib/offer-pricing.js", async (orig) => {
  const { declaredFromEconomics } = await import("../lib/leg-economics-fixture.js");
  const funnels = declaredFromEconomics({
    lifetimeRevenueUsd: 1000,
    replyToMeetingPct: 40,
    visitToMeetingPct: 5,
    meetingToClosePct: 30,
    visitToSignupPct: 20,
    signupToPaidClientPct: 10,
  }).map((f) => ({
    funnelKey: f.funnelKey,
    name: f.funnelKey,
    steps: [],
    rates: f.rates ?? {},
    lifetimeRevenueUsd: f.lifetimeRevenueUsd ?? null,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-09-25T00:00:00Z",
  }));
  return {
    ...(await orig<typeof import("../lib/offer-pricing.js")>()),
    fetchDeclaredFunnelsSoft: vi.fn(async () => funnels),
  };
});
// The ownership check the retired economics read used to make: every brand here is held.
vi.mock("../lib/brand-ownership.js", async (orig) => ({
  ...(await orig<typeof import("../lib/brand-ownership.js")>()),
  assertBrandHeld: vi.fn(async () => undefined),
}));

const OLD = "2026-07-01T10:00:00Z";
const RECENT = new Date(Date.now() - 2 * 86400_000).toISOString();
type Row = { leadId: string; campaignId: string; positiveReply?: boolean; orgId?: string };
// Brand: offer A has 1 interested + 20 contacted-only; offer B has 1 interested + 10 contacted-only.
const ROWS: Row[] = [
  { leadId: "int-a", campaignId: "camp-a1", positiveReply: true },
  { leadId: "int-b", campaignId: "camp-b1", positiveReply: true },
  ...Array.from({ length: 20 }, (_, i) => ({ leadId: `ca-${i}`, campaignId: i % 2 ? "camp-a1" : "camp-a2" })),
  ...Array.from({ length: 10 }, (_, i) => ({ leadId: `cb-${i}`, campaignId: "camp-b1" })),
];

vi.mock("../lib/leads-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/leads-client.js")>()),
  fetchLeadsForRevenue: vi.fn(async (_brandId: string, scope: string | string[] | undefined) => {
    const ids = scope === undefined ? null : new Set(typeof scope === "string" ? [scope] : scope);
    return ROWS.filter((r) => !ids || ids.has(r.campaignId)).map((r) => ({
      leadId: r.leadId,
      email: `${r.leadId}@x.com`,
      orgId: r.orgId ?? `org-${r.leadId}`,
      campaignId: r.campaignId,
      workflowSlug: "wf-1",
      servedAt: OLD,
      signals: { contacted: true, sent: true, delivered: true, ...(r.positiveReply ? { positiveReply: true } : {}) },
      signalDates: { contacted: OLD, lastSent: RECENT },
    }));
  }),
  fetchLeadIdsByStanding: vi.fn(async (_b: string, standing: string) =>
    new Set(standing === "sales_interest" ? ["int-a", "int-b"] : []),
  ),
}));
vi.mock("../lib/email-status-client.js", () => ({ fetchEventTimestamps: vi.fn(async () => null) }));
vi.mock("../lib/observed-steps.js", () => ({ fetchObservedStepFacts: vi.fn(async () => null) }));
vi.mock("../lib/qualifications-client.js", () => ({ fetchQualifications: vi.fn(async () => null) }));
vi.mock("../lib/conversion-emails-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/conversion-emails-client.js")>()),
  fetchConversionEmails: vi.fn(async () => new Set<string>()),
}));
// Contacted-value pricing inputs: every campaign spent $0.50 per contacted person on workflow wf-1
// (dynasty wf), whose ladder prices a visit at $25 and a positive reply at $100 → P = 2% / 0.5%.
// Each campaign is bought for ONE leg, and its spend buys that leg's outcome only.
const CAMPAIGN_LEG: Record<string, string> = {
  "camp-a1": "start_to_conversation",
  "camp-a2": "start_to_website_visit",
  "camp-b1": "start_to_conversation",
};
const CONTACTED_PER_CAMPAIGN: Record<string, number> = { "camp-a1": 11, "camp-a2": 10, "camp-b1": 11 };
vi.mock("../lib/public-stats-clients.js", async (orig) => ({
  ...(await orig<typeof import("../lib/public-stats-clients.js")>()),
  fetchPublicWorkflows: vi.fn(async () => [{ workflowSlug: "wf-1", workflowDynastySlug: "wf" }]),
}));
vi.mock("../lib/campaign-identity-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/campaign-identity-client.js")>()),
  fetchBrandCampaignRows: vi.fn(async () =>
    Object.entries(CAMPAIGNS).flatMap(([offerId, ids]) =>
      ids.map((id) => ({ id, offerId, featureSlug: "sales-cold-email-outreach", legKey: CAMPAIGN_LEG[id] })),
    ),
  ),
}));
vi.mock("../lib/runs-cost-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/runs-cost-client.js")>()),
  fetchRunsCommittedCentsByCampaignWorkflow: vi.fn(
    async () => new Map(Object.entries(CONTACTED_PER_CAMPAIGN).map(([id, n]) => [`${id}|wf-1`, n * 50])),
  ),
}));
vi.mock("../lib/leg-ladder.js", async (orig) => ({
  ...(await orig<typeof import("../lib/leg-ladder.js")>()),
  runLadder: vi.fn(async (_identity: unknown, _slug: string, query: Record<string, string>) => ({
    status: 200,
    body: {
      rows: [
        {
          audienceId: null,
          workflow: { workflowDynastySlug: "wf" },
          resolved: { grain: "brand", costPerOutcomeUsd: query.leg === "start_to_website_visit" ? 25 : 100 },
        },
      ],
    },
  })),
}));

const offerRoutes = (await import("./offer-lead-values.js")).default;
const dealsRoutes = (await import("./deals-value.js")).default;
const contactedRoutes = (await import("./contacted-value.js")).default;
const app = express();
app.use(offerRoutes, dealsRoutes, contactedRoutes);
const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const get = (path: string) => request(app).get(path).set(AUTH);
const column = (body: { columns: Array<{ standing: string; valueUsd: number | null; leads: Array<{ leadId: string }> }> }, s: string) =>
  body.columns.find((c) => c.standing === s)!;

beforeEach(() => vi.clearAllMocks());

describe("GET /offers/:offerId/deals-value", () => {
  it("puts only the offer's own people on its board, and the two offers add up to the brand", async () => {
    const [a, b, brand] = await Promise.all([
      get("/offers/offer-a/deals-value?brandId=brand-1&pricing=net"),
      get("/offers/offer-b/deals-value?brandId=brand-1&pricing=net"),
      get("/brands/brand-1/deals-value"),
    ]);
    expect(a.status).toBe(200);
    expect(a.body.offerId).toBe("offer-a");
    expect(column(a.body, "sales_interest").leads.map((l) => l.leadId)).toEqual(["int-a"]);
    expect(column(b.body, "sales_interest").leads.map((l) => l.leadId)).toEqual(["int-b"]);
    expect(column(a.body, "sales_interest").valueUsd).toBeGreaterThan(0);
    expect(column(a.body, "sales_interest").valueUsd! + column(b.body, "sales_interest").valueUsd!).toBeCloseTo(
      column(brand.body, "sales_interest").valueUsd!,
      6,
    );
  });

  it("an offer no campaign sells is a named 404, never the brand's numbers", async () => {
    const res = await get("/offers/offer-none/deals-value?brandId=brand-1");
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_has_no_channels");
  });

  it("brandId is required, pricing is validated", async () => {
    expect((await get("/offers/offer-a/deals-value")).status).toBe(400);
    expect((await get("/offers/offer-a/deals-value?brandId=brand-1&pricing=x")).status).toBe(400);
  });
});

describe("GET /offers/:offerId/contacted-value", () => {
  it("prices only the offer's contacted leads, on the BRAND's entry rates, adding up to the brand", async () => {
    const [a, b, brand] = await Promise.all([
      get("/offers/offer-a/contacted-value?brandId=brand-1&pricing=net"),
      get("/offers/offer-b/contacted-value?brandId=brand-1&pricing=net"),
      get("/brands/brand-1/contacted-value"),
    ]);
    expect(a.status).toBe(200);
    expect(a.body.population.contactedOnly).toBe(20);
    expect(b.body.population.contactedOnly).toBe(10);
    expect(a.body.leads.every((l: { leadId: string }) => l.leadId.startsWith("ca-"))).toBe(true);
    expect(a.body.entryRatesFrom).toBe("brand");
    expect(a.body.brandEntryRatesUnavailableReason).toBeNull();
    // The brand's rates, copied (the offer's own 1 reply in 21 would read differently).
    expect(a.body.routes).toEqual(brand.body.routes);
    expect(a.body.workflows.map((w: { campaignId: string }) => w.campaignId).sort()).toEqual(["camp-a1", "camp-a2"]);
    expect(a.body.workflows).toEqual(
      brand.body.workflows.filter((w: { campaignId: string }) => w.campaignId !== "camp-b1"),
    );
    // A campaign's spend buys its OWN leg's outcome only: the reply campaign prices no click, the
    // website-visit campaign prices no reply (owner 2026-10-05; a leg's outcome is its toStep).
    type W = { campaignId: string; routes: Array<{ signal: string; entryRatePct: number | null; unpricedReason: string | null }> };
    const rates = (campaignId: string) =>
      (brand.body.workflows as W[]).find((w) => w.campaignId === campaignId)!.routes.map((r) => [r.signal, r.entryRatePct, r.unpricedReason]);
    expect(rates("camp-a1")).toEqual([["clicked", null, "not_the_campaigns_leg"], ["positiveReply", 0.5, null]]);
    expect(rates("camp-a2")).toEqual([["clicked", 2, null], ["positiveReply", null, "not_the_campaigns_leg"]]);
    expect(brand.body.unmeasuredReason).toBeNull();
    expect(a.body.totalExpectedValueUsd + b.body.totalExpectedValueUsd).toBeCloseTo(brand.body.totalExpectedValueUsd, 6);
  });

  it("an offer no campaign sells is a named 404", async () => {
    const res = await get("/offers/offer-none/contacted-value?brandId=brand-1");
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_has_no_channels");
  });

  it("brand rates unreadable → every route null, named, exactly as the pipeline prices them (nothing)", async () => {
    const bc = await import("../lib/brand-channels.js");
    vi.mocked(bc.resolveBrandChannels).mockRejectedValueOnce(new Error("campaign-service down"));
    const res = await get("/offers/offer-a/contacted-value?brandId=brand-1");
    expect(res.status).toBe(200);
    expect(res.body.brandEntryRatesUnavailableReason).toBe("brand_contacted_value_unreadable");
    expect(res.body.unmeasuredReason).toBe("no_entry_rate");
    expect(res.body.totalExpectedValueUsd).toBeNull();
  });
});
