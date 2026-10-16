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
vi.mock("../lib/campaign-identity-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/campaign-identity-client.js")>()), fetchBrandCampaignRows: vi.fn() }));
vi.mock("./revenue.js", async (orig) => ({ ...(await orig<typeof import("./revenue.js")>()), fetchDeclaredFunnelsSoft: vi.fn() }));
vi.mock("../lib/brand-ownership.js", async (orig) => ({ ...(await orig<typeof import("../lib/brand-ownership.js")>()), assertBrandHeld: vi.fn() }));
vi.mock("../lib/leads-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/leads-client.js")>()), fetchLeadsForRevenue: vi.fn() }));
vi.mock("../lib/observed-steps.js", async (orig) => ({ ...(await orig<typeof import("../lib/observed-steps.js")>()), fetchObservedStepFacts: vi.fn() }));
vi.mock("../lib/qualifications-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/qualifications-client.js")>()), fetchQualifications: vi.fn() }));
vi.mock("../lib/conversion-emails-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/conversion-emails-client.js")>()), fetchConversionEmails: vi.fn() }));
vi.mock("../lib/email-status-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/email-status-client.js")>()), fetchEventTimestamps: vi.fn() }));
vi.mock("../lib/followup-actions-client.js", () => ({ fetchFollowupActedLeads: vi.fn() }));
vi.mock("../lib/runs-cost-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runs-cost-client.js")>()), fetchRunsCostCents: vi.fn(), fetchMatureSpendCents: vi.fn() }));
vi.mock("../lib/scope-maturity.js", async (orig) => ({ ...(await orig<typeof import("../lib/scope-maturity.js")>()), fetchSpendSplit: vi.fn() }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.NODE_ENV = "test";

const { fetchBrandCampaignRows } = await import("../lib/campaign-identity-client.js");
const { fetchDeclaredFunnelsSoft } = await import("./revenue.js");
const { assertBrandHeld } = await import("../lib/brand-ownership.js");
const { fetchLeadsForRevenue } = await import("../lib/leads-client.js");
const { fetchObservedStepFacts } = await import("../lib/observed-steps.js");
const { fetchQualifications } = await import("../lib/qualifications-client.js");
const { fetchConversionEmails } = await import("../lib/conversion-emails-client.js");
const { fetchEventTimestamps } = await import("../lib/email-status-client.js");
const { fetchRunsCostCents, fetchMatureSpendCents } = await import("../lib/runs-cost-client.js");
const { fetchFollowupActedLeads } = await import("../lib/followup-actions-client.js");
const { fetchSpendSplit } = await import("../lib/scope-maturity.js");
const app = (await import("../index.js")).default;
const { unionBrandFamilies, leadFamiliesScopeKey, withIntentHot } = await import("./brand-lead-families.js");
const { fetchBrandIntent } = await import("../lib/relationship-intent.js");
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const lead = (leadId: string, campaignId: string, signals: Record<string, boolean>, extra: Record<string, unknown> = {}) => ({
  leadId,
  campaignId,
  campaignLeadIds: [`row-${leadId}-${campaignId}`],
  email: `${leadId}@x.com`,
  servedAt: "2026-01-05T09:00:00.000Z",
  signals: { contacted: true, ...signals },
  ...extra,
});

describe("GET /brands/:brandId/lead-families", () => {
  beforeEach(() => {
    vi.mocked(fetchBrandCampaignRows).mockResolvedValue([
      { id: "c1", offerId: "offer-1", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
      { id: "c2", offerId: "offer-2", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    ] as never);
    vi.mocked(fetchDeclaredFunnelsSoft).mockResolvedValue([
      { funnelKey: "sales_meetings_from_conversation", name: "x", steps: [], rates: { replyToMeetingPct: 50, meetingToClosePct: 20 }, lifetimeRevenueUsd: 1000, destinationUrl: null, bookingUrl: null, updatedAt: "" },
    ] as never);
    vi.mocked(assertBrandHeld).mockResolvedValue(undefined);
    vi.mocked(fetchLeadsForRevenue).mockImplementation(async (_b, scope) => {
      const ids = Array.isArray(scope) ? scope : [scope];
      const all = [
        lead("WON", "c1", { positiveReply: true, closeWin: true }),
        lead("HOT", "c1", { positiveReply: true }),
        lead("HOT", "c2", {}), // cold on offer-2, hot on offer-1: hot wins
        lead("COLDREPLY", "c1", { positiveReply: true }),
        lead("NEVER", "c1", {}),
        lead("NEVER2", "c2", {}),
      ];
      return all.filter((l) => ids.includes(l.campaignId)) as never;
    });
    vi.mocked(fetchObservedStepFacts).mockResolvedValue({
      byEmail: new Map(),
      cold: {
        applies: true,
        afterDays: 30,
        leads: [{ leadId: "COLDREPLY", campaignId: "c1", email: "coldreply@x.com", step: "meeting_booked", since: "2026-09-01T00:00:00Z", after: "positive_reply", stalledSince: "2026-08-02T00:00:00Z" }],
      },
    } as never);
    vi.mocked(fetchQualifications).mockResolvedValue(new Map());
    vi.mocked(fetchConversionEmails).mockResolvedValue(new Set());
    vi.mocked(fetchEventTimestamps).mockResolvedValue(
      new Map([["COLDREPLY@x.com", { delivered: "2026-07-20T00:00:00Z" }]]) as never,
    );
    vi.mocked(fetchFollowupActedLeads).mockResolvedValue(new Map());
    vi.mocked(fetchSpendSplit).mockResolvedValue(new Map() as never);
  });

  it("serves every person's family, strongest across offers, keyed on lead id and email, with row ids", async () => {
    const res = await request(app).get("/brands/brand-1/lead-families").set(AUTH);
    expect(res.status).toBe(200);
    const byLead = Object.fromEntries(res.body.people.map((p: { leadId: string }) => [p.leadId, p]));
    expect(byLead.WON).toEqual(expect.objectContaining({ family: "won", email: "won@x.com", campaignLeadIds: ["row-WON-c1"] }));
    expect(byLead.HOT).toEqual(expect.objectContaining({ family: "hot", offerId: "offer-1", campaignLeadIds: ["row-HOT-c1", "row-HOT-c2"] }));
    expect(byLead.COLDREPLY).toEqual(expect.objectContaining({ family: "lost", lostReason: "went_cold" }));
    expect(byLead.NEVER.family).toBe("cold");
    expect(byLead.NEVER2.family).toBe("cold");
    expect(res.body.counts).toEqual({ won: 1, hot: 1, lost: 1, cold: 2 });
    expect(res.body.lostBreakdown).toEqual({ wentCold: 1, ruledOut: 0 });
  });

  it("each offer's won / hot / lost counts equal that offer's outcomes pipeline (Today's figures)", async () => {
    const fam = await request(app).get("/brands/brand-1/lead-families").set(AUTH);
    for (const offer of fam.body.offers) {
      const out = await request(app).get(`/offers/${offer.offerId}/outcomes?brandId=brand-1`).set(AUTH);
      expect(out.status).toBe(200);
      const p = out.body.pipeline;
      expect(offer.counts.won, offer.offerId).toBe(p.customersWon?.leadCount ?? 0);
      expect(offer.counts.hot, offer.offerId).toBe(p.hotLeads?.totalCount ?? 0);
      expect(offer.counts.lost, offer.offerId).toBe(p.lostLeads?.count ?? 0);
    }
  });

  it("a person lead-service tags lead + wants business is Hot whatever the channel; pipeline Today counts stay apart (HOT-INBOUND-UNANSWERED-1016)", async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const person = (humanId: string, emails: string[], lead: string | null, wants: string | null, lastInboundAt: string | null = recent) => ({
      humanId, emails, lastInboundAt, leadState: lead, wantsBusinessState: wants,
    });
    vi.mocked(fetchBrandIntent).mockResolvedValueOnce([
      person("h-inbound", ["Admin@DefiniteJobs.co.uk"], "yes", "yes"),
      person("h-cold", ["coldreply@x.com"], "yes", "yes"),
      person("h-won", ["won@x.com"], "yes", "yes"),
      person("h-friend", ["friend@x.com"], "no", null),
      person("h-nothanks", ["never@x.com"], "yes", "no"),
    ] as never);
    const res = await request(app).get("/brands/brand-1/lead-families").set(AUTH);
    expect(res.status).toBe(200);
    const byEmail = Object.fromEntries(res.body.people.map((p: { email: string }) => [p.email, p]));
    expect(byEmail["admin@definitejobs.co.uk"]).toEqual(
      expect.objectContaining({ family: "hot", leadId: null, offerId: null, hotBasis: "wants_business", humanId: "h-inbound", campaignLeadIds: [] }),
    );
    expect(byEmail["coldreply@x.com"]).toEqual(expect.objectContaining({ family: "hot", lostReason: null, hotBasis: "wants_business" }));
    expect(byEmail["won@x.com"].family).toBe("won");
    expect(byEmail["hot@x.com"]).toEqual(expect.objectContaining({ family: "hot", hotBasis: "pipeline" }));
    expect(byEmail["never@x.com"].family).toBe("cold");
    expect(byEmail["friend@x.com"]).toBeUndefined();
    expect(res.body.counts).toEqual({ won: 1, hot: 3, lost: 0, cold: 2 });
    expect(res.body.hotBreakdown).toEqual({ pipeline: 1, wantsBusiness: 2 });
    expect(res.body.pipelineCounts).toEqual({ won: 1, hot: 1, lost: 1, cold: 2 });
    expect(res.body.intent).toEqual(expect.objectContaining({ writers: 5, leadsWantingBusiness: 3, alreadyWon: 1, promotedFromLost: 1, addedInbound: 1 }));
  });

  it("refuses an unknown cause", async () => {
    const res = await request(app).get("/brands/brand-1/lead-families?cause=bogus").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("cause_unrecognised");
  });
});

describe("unionBrandFamilies", () => {
  it("keeps the strongest family, merges row ids, fills a missing email", () => {
    const u = unionBrandFamilies([
      { offerId: "o1", families: [{ leadId: "a", email: null, campaignLeadIds: ["r1"], family: "cold", lostReason: null }] },
      { offerId: "o2", families: [{ leadId: "a", email: "a@x.com", campaignLeadIds: ["r2"], family: "won", lostReason: null }] },
    ]);
    expect(u.people).toEqual([{ leadId: "a", email: "a@x.com", campaignLeadIds: ["r1", "r2"], family: "won", lostReason: null, offerId: "o2", hotBasis: null, humanId: null }]);
    expect(u.counts).toEqual({ won: 1, hot: 0, lost: 0, cold: 0 });
  });
});

describe("leadFamiliesScopeKey", () => {
  const offer = (campaignIds: string[], funnelKey = "sales_meetings_from_reply") => ({
    offerId: "o1",
    partition: { groups: [{ legKey: "start_to_conversation", featureSlug: "sales-cold-email-outreach", campaignIds }] },
    declared: [{ funnelKey } as never],
  });

  it("a new campaign or funnel moves the key but NOT its family: the previous cell is served, never a blocking compute", async () => {
    const { familyKeyOf } = await import("../lib/view-cache.js");
    const a = leadFamiliesScopeKey("b1", "org1", [offer(["c1"])], "priced:outreach");
    const b = leadFamiliesScopeKey("b1", "org1", [offer(["c1", "c2"])], "priced:outreach");
    const c = leadFamiliesScopeKey("b1", "org1", [offer(["c1"], "website_purchases")], "priced:outreach");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(familyKeyOf(b)).toBe(familyKeyOf(a));
    expect(familyKeyOf(c)).toBe(familyKeyOf(a));
  });

  it("the question asked (cause, org, brand) is never rotated across", async () => {
    const { familyKeyOf } = await import("../lib/view-cache.js");
    const base = familyKeyOf(leadFamiliesScopeKey("b1", "org1", [offer(["c1"])], "priced:outreach"));
    expect(familyKeyOf(leadFamiliesScopeKey("b1", "org1", [offer(["c1"])], "priced:outreach,other"))).not.toBe(base);
    expect(familyKeyOf(leadFamiliesScopeKey("b1", "org2", [offer(["c1"])], "priced:outreach"))).not.toBe(base);
    expect(familyKeyOf(leadFamiliesScopeKey("b2", "org1", [offer(["c1"])], "priced:outreach"))).not.toBe(base);
  });
});

describe("withIntentHot", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const row = (leadId: string, family: "won" | "hot" | "lost" | "cold", lostReason: "went_cold" | "ruled_out" | null = null) => ({
    leadId, email: `${leadId}@x.com`, campaignLeadIds: [`r-${leadId}`], family, lostReason, offerId: "o1", hotBasis: null, humanId: null,
  });
  const person = (humanId: string, emails: string[], lastInboundAt: string | null, lead = "yes", wants = "yes") =>
    ({ humanId, emails, lastInboundAt, leadState: lead, wantsBusinessState: wants }) as never;

  it("a wants-business yes older than the fresh window does not make anyone Hot", () => {
    const u = withIntentHot([row("a", "lost", "went_cold")], [person("h", ["a@x.com", "new@x.com"], "2026-07-01T00:00:00Z")], now);
    expect(u.counts).toEqual({ won: 0, hot: 0, lost: 1, cold: 0 });
    expect(u.intent).toEqual(expect.objectContaining({ leadsWantingBusiness: 1, silentTooLong: 1, freshDays: 30 }));
  });

  it("a tagged person with two addresses is one Hot person with a row per address; a pipeline Hot is never demoted by a no", () => {
    const u = withIntentHot(
      [row("a", "cold"), row("b", "hot")],
      [person("h", ["a@x.com", "a2@x.com"], "2026-10-15T00:00:00Z"), person("hb", ["b@x.com"], "2026-10-15T00:00:00Z", "yes", "no")],
      now,
    );
    expect(u.people.filter((p) => p.family === "hot").map((p) => p.email).sort()).toEqual(["a2@x.com", "a@x.com", "b@x.com"]);
    expect(u.counts.hot).toBe(3); // a (lead), a2 (human h), b: a and a2 are two keys since a is a pipeline lead
    expect(u.hotBreakdown).toEqual({ pipeline: 1, wantsBusiness: 2 });
  });

  it("a person with no email is listed (email null) and counted once", () => {
    const u = withIntentHot([], [person("h", [], "2026-10-15T00:00:00Z")], now);
    expect(u.people).toEqual([expect.objectContaining({ leadId: null, email: null, humanId: "h", family: "hot" })]);
    expect(u.intent.addedWithoutEmail).toBe(1);
    expect(u.counts.hot).toBe(1);
  });
});
