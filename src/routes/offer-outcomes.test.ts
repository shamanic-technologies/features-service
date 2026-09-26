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
vi.mock("../lib/sales-economics-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/sales-economics-client.js")>()), fetchEffectiveEconomics: vi.fn() }));
vi.mock("../lib/leads-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/leads-client.js")>()), fetchLeadsForRevenue: vi.fn() }));
vi.mock("../lib/observed-steps.js", async (orig) => ({ ...(await orig<typeof import("../lib/observed-steps.js")>()), fetchObservedStepFacts: vi.fn() }));
vi.mock("../lib/qualifications-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/qualifications-client.js")>()), fetchQualifications: vi.fn() }));
vi.mock("../lib/conversion-emails-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/conversion-emails-client.js")>()), fetchConversionEmails: vi.fn() }));
vi.mock("../lib/email-status-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/email-status-client.js")>()), fetchEventTimestamps: vi.fn() }));
vi.mock("../lib/followup-actions-client.js", () => ({ fetchFollowupActedLeads: vi.fn() }));
vi.mock("../lib/runs-cost-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runs-cost-client.js")>()), fetchRunsCostCents: vi.fn(), fetchMatureSpendCents: vi.fn() }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.NODE_ENV = "test";

const { fetchBrandCampaignRows } = await import("../lib/campaign-identity-client.js");
const { fetchDeclaredFunnelsSoft } = await import("./revenue.js");
const { fetchEffectiveEconomics } = await import("../lib/sales-economics-client.js");
const { fetchLeadsForRevenue } = await import("../lib/leads-client.js");
const { fetchObservedStepFacts } = await import("../lib/observed-steps.js");
const { fetchQualifications } = await import("../lib/qualifications-client.js");
const { fetchConversionEmails } = await import("../lib/conversion-emails-client.js");
const { fetchEventTimestamps } = await import("../lib/email-status-client.js");
const { fetchRunsCostCents, fetchMatureSpendCents } = await import("../lib/runs-cost-client.js");
const { fetchFollowupActedLeads } = await import("../lib/followup-actions-client.js");
const app = (await import("../index.js")).default;
const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };

const lead = (leadId: string, campaignId: string, signals: Record<string, boolean>) => ({
  leadId,
  campaignId,
  email: `${leadId}@x.com`,
  signals: { contacted: true, ...signals },
});

describe("GET /offers/:offerId/outcomes", () => {
  beforeEach(() => {
    vi.mocked(fetchBrandCampaignRows).mockResolvedValue([
      { id: "c1", offerId: "offer-1", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", funnelKey: "sales_meetings_from_conversation" },
      { id: "f1", offerId: "offer-1", featureSlug: "feedback-request-cold-email-outreach", legKey: "start_to_conversation", funnelKey: "sales_meetings_from_conversation" },
      { id: "a1", offerId: "offer-1", featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", funnelKey: "sales_meetings_from_conversation" },
    ] as never);
    vi.mocked(fetchDeclaredFunnelsSoft).mockResolvedValue([
      { funnelKey: "sales_meetings_from_conversation", name: "x", steps: [], rates: {}, lifetimeRevenueUsd: 1000, destinationUrl: null, bookingUrl: null, updatedAt: "" },
    ] as never);
    vi.mocked(fetchEffectiveEconomics).mockResolvedValue({
      economics: { lifetimeRevenueUsd: 1000, replyToMeetingPct: 50, visitToMeetingPct: 10, meetingToClosePct: 20, visitToSignupPct: 5, signupToPaidClientPct: 10, visitToClosePct: 1 },
      source: "user",
    });
    vi.mocked(fetchLeadsForRevenue).mockResolvedValue([
      lead("L1", "c1", { positiveReply: true }),
      lead("L2", "c1", { positiveReply: true }),
      lead("L2", "f1", { positiveReply: true }),
    ] as never);
    vi.mocked(fetchObservedStepFacts).mockResolvedValue({ byEmail: new Map([["L1@x.com", { reached: { meeting: null }, unpricedSignals: [], valueUsd: null, deadStepSignals: [] }]]) } as never);
    vi.mocked(fetchQualifications).mockResolvedValue(new Map());
    vi.mocked(fetchConversionEmails).mockResolvedValue(new Set());
    vi.mocked(fetchEventTimestamps).mockResolvedValue(new Map());
    vi.mocked(fetchRunsCostCents).mockImplementation(async (_b, scope) =>
      ({ committedCents: scope === "c1" ? 6000 : scope === "f1" ? 3000 : 1000, actualCents: 0 }) as never,
    );
    vi.mocked(fetchFollowupActedLeads).mockResolvedValue(new Map([["a1", new Set(["L1"])]]));
    vi.mocked(fetchMatureSpendCents).mockImplementation(async (_b, scope) =>
      ({ total: { committedCents: scope === "c1" ? 6000 : 3000, actualCents: 0 }, bySlug: new Map() }) as never,
    );
  });

  it("serves one row per outcome, distinct leads across channels, spend of the legs landing on it", async () => {
    const res = await request(app).get("/offers/offer-1/outcomes?brandId=brand-1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.outcomes.map((o: { step: { key: string } }) => o.step.key)).toEqual(["conversation", "meeting_booked"]);
    const [reply, meeting] = res.body.outcomes;
    expect(reply.legs.map((l: { featureSlug: string; recipientsReached: number }) => [l.featureSlug, l.recipientsReached])).toEqual([
      ["feedback-request-cold-email-outreach", 1],
      ["sales-cold-email-outreach", 2],
    ]);
    expect(reply.recipientsReached).toBe(2); // L2 reached through both channels counts once
    expect(reply.spentUsd).toBe(90);
    expect(reply.costPerOutcomeUsd).toBe(45);
    expect(reply.valuePerOutcomeUsd).toBeCloseTo(100); // 50% x 20% x $1,000
    // The AI answered L1, who booked: one attributed meeting on its $10.
    expect(meeting.recipientsReached).toBe(1);
    expect(meeting.legs[0].countBasis).toBe("acted_leads");
    expect(meeting.spentUsd).toBe(10);
    expect(meeting.costPerOutcomeUsd).toBe(10);
    expect(meeting.roiMultiple).toBeCloseTo(20); // 20% x $1,000 over $10
    expect(fetchFollowupActedLeads).toHaveBeenCalledWith("brand-1", ["a1"]);
    // The two delayed legs' spend is read on the mature cohort; the AI leg is zero-delay.
    expect(fetchMatureSpendCents).toHaveBeenCalledTimes(2);
  });

  it("an unreadable follow-up record degrades the internal leg to unattributed, never a 502", async () => {
    vi.mocked(fetchFollowupActedLeads).mockRejectedValue(new Error("lead-service down"));
    const res = await request(app).get("/offers/offer-1/outcomes?brandId=brand-1").set(AUTH);
    expect(res.status).toBe(200);
    const meeting = res.body.outcomes.find((o: { step: { key: string } }) => o.step.key === "meeting_booked");
    expect(meeting.legs[0].countBasis).toBe("offer_leads_at_step");
    expect(meeting.costPerOutcomeUsd).toBeNull();
    expect(meeting.unmeasuredReason).toBe("not_attributable");
  });

  it("400 without brandId; 404 for an offer this brand does not sell", async () => {
    expect((await request(app).get("/offers/offer-1/outcomes").set(AUTH)).status).toBe(400);
    const res = await request(app).get("/offers/other/outcomes?brandId=brand-1").set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("offer_has_no_channels");
  });
});
