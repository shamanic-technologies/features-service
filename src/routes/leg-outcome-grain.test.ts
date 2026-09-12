/**
 * A LEG-KEYED READ PRICES THE LEG'S OWN STEP, SERVES ITS OWN ORDER, AND ANSWERS FOR THE CAMPAIGN.
 *
 * ONE fixture, shaped like the customer that reported all three, so every number is hand-checkable:
 * brand `75d7e3e8…` on `sales-cold-email-outreach`, selling through a conversation funnel that
 * converts 20% of its conversations into meetings. The `lithium` workflow has **13 observed
 * conversations on $2,141.76 of brand spend** — $164.75 each — and the read used to answer $823.75,
 * the price of a BOOKED MEETING, because the leg was resolved to its funnel and then priced through
 * that funnel's goal.
 *
 * Every case asserts the DIVERGENCE between what the leg's own step says and what the funnel's named
 * step says: a suite that only checked "a number came back" would pass on the implementation this
 * replaces, which is exactly what happened for as long as it shipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const LIVE_CAMPAIGN = "f7b1b610-4fa1-4b54-8fec-f7be124dc32b";
const STOPPED_CAMPAIGN = "aaaaaaaa-4fa1-4b54-8fec-f7be124dc32b";
const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";

/** The brand's real shape: one conversation in five becomes a meeting, half of those close. */
const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 20,
  visitToMeetingPct: 20,
  meetingToClosePct: 50,
  visitToClosePct: 0,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};
const CONVERSATION_FUNNEL = {
  funnelKey: "sales_meetings_from_conversation",
  name: "Sales Meeting from Conversation",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { replyToMeetingPct: 20, meetingToClosePct: 50, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 5000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-12T00:00:00.000Z",
};

// `lithium` is the reported workflow. `sodium` is dearer per conversation but the brand has spent on
// it too, so it is measured and rankable; `argon` is active and has NEVER run.
const WORKFLOWS = [
  { id: "i1", workflowSlug: "wf-lithium", workflowName: "Lithium", workflowDynastyName: "Lithium", workflowDynastySlug: "lithium", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "i2", workflowSlug: "wf-sodium", workflowName: "Sodium", workflowDynastyName: "Sodium", workflowDynastySlug: "sodium", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "i3", workflowSlug: "wf-argon", workflowName: "Argon", workflowDynastyName: "Argon", workflowDynastySlug: "argon", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
];

const BRAND_SPEND_CENTS = 214176; // $2,141.76 — the figure the customer reported
const BRAND_REPLIES = 13;

const cost = (slug: string, cents: number, campaignId?: string) => ({
  dimensions: campaignId ? { workflowSlug: slug, campaignId } : { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  runCount: 10,
  minStartedAt: null,
  maxStartedAt: null,
});
const email = (slug: string, contacted: number, clicked: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 0, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

interface MockOpts {
  /** The campaign rows campaign-service serves — omitted means it is unreachable. */
  campaigns?: unknown[] | null;
}

function mockFetch(opts: MockOpts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    // The FLEET: cheap per reply, so the brand grain never floors down to it.
    if (url.includes("/v1/stats/public/costs")) return json({ groups: [cost("wf-lithium", 10000), cost("wf-sodium", 10000)] });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      const campaignId = u.searchParams.get("campaignId");
      if (groupBy.includes("campaignId")) {
        // The IDENTITY's two members, co-grouped: the live row and the ancestor it replaced.
        return json({
          groups: [
            cost("wf-lithium", 100000, LIVE_CAMPAIGN),
            cost("wf-lithium", 40000, STOPPED_CAMPAIGN),
            cost("wf-lithium", 999999, "someone-elses-campaign"),
            cost("wf-sodium", 50000, LIVE_CAMPAIGN),
          ],
          });
      }
      if (campaignId) return json({ groups: [cost("wf-lithium", 100000), cost("wf-sodium", 50000)] });
      return json({ groups: [cost("wf-lithium", BRAND_SPEND_CENTS), cost("wf-sodium", 500000)] });
    }
    if (url.includes("/orgs/stats")) {
      if (u.searchParams.get("audienceId")) return json({ groups: [] });
      const campaignId = u.searchParams.get("campaignId");
      if (campaignId === LIVE_CAMPAIGN) return json({ groups: [email("wf-lithium", 400, 0, 5), email("wf-sodium", 200, 0, 1)] });
      if (campaignId === STOPPED_CAMPAIGN) return json({ groups: [email("wf-lithium", 300, 0, 2)] });
      if (campaignId) return json({ groups: [] });
      return json({ groups: [email("wf-lithium", 1300, 0, BRAND_REPLIES), email("wf-sodium", 900, 0, 5)] });
    }
    if (url.includes("/public/stats")) return json({ groups: [email("wf-lithium", 9000, 0, 900), email("wf-sodium", 9000, 0, 900)] });
    if (url.includes("/sales-funnels")) return json({ funnels: [CONVERSATION_FUNNEL] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    // ONE active audience, with nothing attributed to it — enough for the unproven `argon` to be
    // enumerated at all (a brand with no serveable audience enumerates nothing, by design).
    if (url.includes("/orgs/audiences")) return json({ audiences: [{ id: "aud-1", name: "A", status: "active", filters: {} }] });
    if (url.includes("/campaigns")) {
      if (opts.campaigns === null) return new Response("boom", { status: 502 });
      return json({
        campaigns: opts.campaigns ?? [
          { id: LIVE_CAMPAIGN, orgId: "org-1", brandId: BRAND, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "sales-cold-email-outreach", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
          { id: STOPPED_CAMPAIGN, orgId: "org-1", brandId: BRAND, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "sales-cold-email-outreach", status: "stopped", createdAt: "2026-08-01T00:00:00.000Z" },
        ],
      });
    }
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);
const brandRow = (body: any, slug: string) => body.rows.find((r: any) => r.audienceId === null && r.workflow.workflowDynastySlug === slug);

describe("a leg-keyed read is priced on the LEG'S OWN STEP", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("prices a conversation at what a conversation cost — not at what a booked meeting costs", async () => {
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    const lithium = brandRow(res.body, "lithium");

    // $2,141.76 over 13 observed conversations. The booked-meeting figure — the number this used to
    // serve — is five times larger, because only one conversation in five books a meeting.
    expect(lithium.resolved.costPerOutcomeUsd).toBeCloseTo(2141.76 / 13, 6);
    expect(lithium.resolved.costPerOutcomeUsd).toBeCloseTo(164.75, 2);
    expect(lithium.estimatesByGrain.brand.projected.costPerMeetingBookedUsd).toBeCloseTo(823.75, 2);
    expect(lithium.resolved.costPerOutcomeUsd * 5).toBeCloseTo(
      lithium.estimatesByGrain.brand.projected.costPerMeetingBookedUsd,
      4,
    );
  });

  it("states, per grain, the leg's own cost, its outcome count and the spend behind them", async () => {
    const res = await get("leg=start_to_conversation");
    const brand = brandRow(res.body, "lithium").estimatesByGrain.brand;

    expect(brand.legOutcome).toEqual({
      costPerOutcomeUsd: expect.closeTo(2141.76 / 13, 6),
      outcomeCount: 13,
      // An ENTRY leg's step IS the observed signal, so its count was COUNTED, not projected.
      outcomeObserved: true,
      spentUsd: expect.closeTo(2141.76, 6),
    });
    // The fleet grain answers on its OWN evidence, and says so — never the brand's number.
    const fleet = brandRow(res.body, "lithium").estimatesByGrain.crossOrg;
    expect(fleet.legOutcome.outcomeCount).toBe(900);
    expect(fleet.legOutcome.spentUsd).toBeCloseTo(100, 6);
    expect(fleet.legOutcome.costPerOutcomeUsd).not.toBeCloseTo(brand.legOutcome.costPerOutcomeUsd, 2);
  });

  it("a DEEPER leg walks the funnel's own rates — a booked meeting is dearer than the conversation below it", async () => {
    const conversation = await get("leg=start_to_conversation");
    const booked = await get("leg=conversation_to_meeting_booked");

    const cheap = brandRow(conversation.body, "lithium").estimatesByGrain.brand.legOutcome;
    const dear = brandRow(booked.body, "lithium").estimatesByGrain.brand.legOutcome;
    expect(dear.costPerOutcomeUsd).toBeCloseTo(cheap.costPerOutcomeUsd! * 5, 4);
    // 13 conversations × 20% — a PROJECTION off the observed signal, and it says so.
    expect(dear.outcomeCount).toBeCloseTo(2.6, 6);
    expect(dear.outcomeObserved).toBe(false);
    // The spend is the same money; only the step it is divided into moved.
    expect(dear.spentUsd).toBeCloseTo(cheap.spentUsd, 6);
  });

  it("a rate the brand never declared leaves the leg UNPRICEABLE rather than reading zero", async () => {
    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      if (url.includes("/sales-funnels")) {
        return json({
          funnels: [
            {
              ...CONVERSATION_FUNNEL,
              // Nobody has stated how a conversation becomes a meeting.
              rates: { replyToMeetingPct: 0, meetingToClosePct: 50 },
            },
          ],
        });
      }
      if (url.includes("/sales-economics-effective")) return json({ economics: { ...ECONOMICS, replyToMeetingPct: 0 }, source: "user" });
      if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
      if (url.includes("/v1/stats/public/costs")) return json({ groups: [cost("wf-lithium", 10000)] });
      if (url.includes("/v1/stats/costs")) return json({ groups: [cost("wf-lithium", BRAND_SPEND_CENTS)] });
      if (url.includes("/orgs/stats")) return json({ groups: [email("wf-lithium", 1300, 0, BRAND_REPLIES)] });
      if (url.includes("/public/stats")) return json({ groups: [email("wf-lithium", 9000, 0, 900)] });
      if (url.includes("/orgs/audiences")) return json({ audiences: [] });
      return json({});
    });

    const res = await get("leg=conversation_to_meeting_booked");
    const brand = brandRow(res.body, "lithium").estimatesByGrain.brand;
    // A 0% rate means nobody arrives: the cost of one is not a number, and 0 would say it is free.
    expect(brand.legOutcome.costPerOutcomeUsd).toBeNull();
    expect(brand.legOutcome.outcomeCount).toBe(0);
    // …while the entry leg of the same funnel still answers, on the same evidence.
    const entry = await get("leg=start_to_conversation");
    expect(brandRow(entry.body, "lithium").estimatesByGrain.brand.legOutcome.costPerOutcomeUsd).toBeCloseTo(2141.76 / 13, 6);
  });

  it("a funnel-keyed and a goal-keyed request carry no leg figures at all", async () => {
    const byFunnel = await get("funnel=sales_meetings_from_conversation");
    const byGoal = await get("goal=meetingBooked");
    for (const body of [byFunnel.body, byGoal.body]) {
      expect(body.leg).toBeUndefined();
      expect(body.campaignIdentity).toBeUndefined();
      for (const row of body.rows) {
        expect(row.rank).toBeUndefined();
        for (const block of Object.values(row.estimatesByGrain) as any[]) expect(block.legOutcome).toBeUndefined();
      }
    }
    // …and the funnel-keyed answer still prices the BOOKED MEETING it has always priced.
    expect(brandRow(byFunnel.body, "lithium").resolved.costPerOutcomeUsd).toBeCloseTo(823.75, 2);
  });
});

describe("the ORDER is served, and the recommendation is its head", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("every workflow carries a rank, the ranks are a total order, and the recommendation is rank 1", async () => {
    const res = await get("leg=start_to_conversation");
    const ranks = new Map<string, number>();
    for (const row of res.body.rows) ranks.set(row.workflow.workflowDynastySlug, row.rank);

    expect([...ranks.keys()].sort()).toEqual(["argon", "lithium", "sodium"]);
    // No ties, no gaps: 1..N exactly once each.
    expect([...ranks.values()].sort((a, b) => a - b)).toEqual([1, 2, 3]);

    const rank1 = [...ranks.entries()].find(([, r]) => r === 1)![0];
    expect(rank1).toBe(res.body.recommendedWorkflowDynastySlug);
    // lithium is $164.75 a conversation against sodium's $5,000/5 = $1,000 — it is rank 1 because it
    // is cheapest, and the recommendation cannot disagree with the order it heads.
    expect(rank1).toBe("lithium");
  });

  it("a workflow that has never run never outranks one with measured evidence", async () => {
    const res = await get("leg=start_to_conversation");
    const rankOf = (slug: string) => res.body.rows.find((r: any) => r.workflow.workflowDynastySlug === slug).rank;
    const argon = res.body.rows.find((r: any) => r.workflow.workflowDynastySlug === "argon");

    expect(argon.measured).toBe(false);
    expect(rankOf("argon")).toBe(3);
    expect(rankOf("argon")).toBeGreaterThan(rankOf("lithium"));
    expect(rankOf("argon")).toBeGreaterThan(rankOf("sodium"));
    // Its allowance is still denominated in the LEG's step, or it would not be comparable to the rows
    // it is ranked beside: $2,141.76 + $5,000 over 1,300 + 900 people reached.
    expect(argon.resolved.costPerOutcomeUsd).toBeCloseTo((2141.76 + 5000) / 2200, 6);
  });

  it("ranking on the CONVERSION RATE inverts the order, and the recommendation follows it", async () => {
    // sodium reaches 900 people for 5 replies (0.56%); lithium reaches 1,300 for 13 (1.0%).
    const byReturn = await get("leg=start_to_conversation&maximize=return");
    const byRate = await get("leg=start_to_conversation&maximize=conversionRate");
    const rankOf = (body: any, slug: string) => body.rows.find((r: any) => r.workflow.workflowDynastySlug === slug).rank;

    expect(rankOf(byReturn.body, "lithium")).toBe(1);
    expect(byRate.body.recommendedWorkflowDynastySlug).toBe(rankOf(byRate.body, "lithium") === 1 ? "lithium" : "sodium");
    expect(rankOf(byRate.body, byRate.body.recommendedWorkflowDynastySlug)).toBe(1);
  });
});

describe("the CAMPAIGN grain answers for the campaign's identity, beside the grains already carried", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("adds a campaign grain beside brand and fleet, totalled over the whole identity", async () => {
    const res = await get(`leg=start_to_conversation&campaignId=${LIVE_CAMPAIGN}`);
    expect(res.status).toBe(200);
    const grains = brandRow(res.body, "lithium").estimatesByGrain;

    expect(Object.keys(grains).sort()).toEqual(["brand", "campaign", "crossOrg"]);
    // The identity's two members: $1,000 + $400 of spend, 5 + 2 conversations. NOT the live row alone,
    // and emphatically not the third campaign's $9,999.99 — that belongs to somebody else.
    expect(grains.campaign.legOutcome.spentUsd).toBeCloseTo(1400, 6);
    expect(grains.campaign.legOutcome.outcomeCount).toBe(7);
    expect(grains.campaign.legOutcome.costPerOutcomeUsd).toBeCloseTo(1400 / 7, 6);
    // Its own figure, divergent from the brand's — which is the whole reason it is served.
    expect(grains.brand.legOutcome.costPerOutcomeUsd).toBeCloseTo(2141.76 / 13, 6);
    expect(grains.campaign.costBasis).toBe("charged");
  });

  it("resolves the numbers at the campaign grain and names what it answered for", async () => {
    const res = await get(`leg=start_to_conversation&campaignId=${LIVE_CAMPAIGN}`);
    const lithium = brandRow(res.body, "lithium");

    expect(lithium.resolved.costPerOutcomeUsd).toBeCloseTo(1400 / 7, 6);
    expect(lithium.resolved.grain).toBe("campaign");
    expect(res.body.campaignIdentity.campaignIds.sort()).toEqual([LIVE_CAMPAIGN, STOPPED_CAMPAIGN].sort());
    expect(res.body.campaignIdentity.representativeId).toBe(LIVE_CAMPAIGN);
    // Either member of the family reads the same answer.
    const viaAncestor = await get(`leg=start_to_conversation&campaignId=${STOPPED_CAMPAIGN}`);
    expect(brandRow(viaAncestor.body, "lithium").resolved.costPerOutcomeUsd).toBeCloseTo(1400 / 7, 6);
  });

  it("a brand-wide read asks campaign-service nothing and carries no campaign grain", async () => {
    const res = await get("leg=start_to_conversation");
    const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((u: string) => u.includes("/campaigns?"))).toBe(false);
    expect(brandRow(res.body, "lithium").estimatesByGrain.campaign).toBeUndefined();
    expect(res.body.campaignIdentity).toBeUndefined();
  });

  it("degrades NARROWER, never wider, when campaign-service is unreachable", async () => {
    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch({ campaigns: null });

    const res = await get(`leg=start_to_conversation&campaignId=${LIVE_CAMPAIGN}`);
    expect(res.status).toBe(200);
    // Its own family of one — today's answer about a real subset, never the brand's under its name.
    expect(res.body.campaignIdentity.campaignIds).toEqual([LIVE_CAMPAIGN]);
    const grains = brandRow(res.body, "lithium").estimatesByGrain;
    expect(grains.campaign.legOutcome.spentUsd).toBeCloseTo(1000, 6);
    expect(grains.campaign.legOutcome.outcomeCount).toBe(5);
    expect(grains.campaign.legOutcome.costPerOutcomeUsd).not.toBeCloseTo(grains.brand.legOutcome.costPerOutcomeUsd, 2);
  });

  it("a campaign named without a leg FAILS LOUD rather than being silently ignored", async () => {
    const res = await get(`goal=meetingBooked&campaignId=${LIVE_CAMPAIGN}`);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("campaign_requires_leg");
  });
});
