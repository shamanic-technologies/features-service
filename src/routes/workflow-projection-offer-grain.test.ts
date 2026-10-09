/**
 * THE OFFER GRAIN STATES THE BRAND GRAIN'S FIGURE WHEN THE BRAND SELLS ONE OFFER (features-service#1172).
 *
 * The v2 Workflows page prints, per workflow, "Brand" and "Offer" under one label (the cost of one
 * outcome of the leg). The Offer column used to come from a different read on a different basis (the
 * realized mature-cohort ratio, null at 0 outcomes), so on brand 75d7e3e8… — every campaign selling
 * ONE offer — ballad read $118.61 against $53.91 and a 0-outcome workflow read $103.56 against a dash.
 * The offer grain is now built on this ladder, from the byte-same readers and floor as the brand
 * grain, so a difference between the two columns only ever means a difference in scope.
 *
 * Every case asserts both the EQUALITY on a one-offer brand and the DIVERGENCE on a two-offer brand, so
 * a suite that only checked "an offer block came back" would pass on an implementation that copied
 * the brand block (or the campaign block) under the offer's name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { offerEconomicsFromDeclared } from "../lib/leg-economics-fixture.js";

vi.mock("../lib/workflow-leg-assignments.js", async (importOriginal) => {
  const { everyWorkflowActive } = await import("../lib/leg-assignments-fixture.js");
  return {
    ...(await importOriginal<typeof import("../lib/workflow-leg-assignments.js")>()),
    fetchLegAssignments: vi.fn(async () => everyWorkflowActive()),
  };
});
vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
// These suites pin the grains on email-gateway counts alone: the person-grain reply set is not read,
// so every grain reads what it always did (the person basis is guarded in crm-only-repliers.test.ts).
vi.mock("../lib/crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/crm-only-repliers.js")>()),
  fetchPositiveRepliers: vi.fn(async () => undefined),
}));
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

const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const C1 = "11111111-4fa1-4b54-8fec-f7be124dc32b"; // leg start_to_conversation — the named campaign
const C2 = "22222222-4fa1-4b54-8fec-f7be124dc32b"; // another leg on the same channel
const OFFER_A = "d5ecba00-783a-4939-b5bd-f85b9e6b7d9e";
const OFFER_B = "bbbbbbbb-783a-4939-b5bd-f85b9e6b7d9e";
const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";

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
  name: "Sales Meeting from Positive Reply",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { replyToMeetingPct: 20, meetingToClosePct: 50, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 5000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-12T00:00:00.000Z",
};

// `ballad` has outcomes; `alioth` spent and produced nothing (the floored case).
const WORKFLOWS = [
  { id: "i1", workflowSlug: "wf-ballad", workflowName: "Ballad", workflowDynastyName: "Ballad", workflowDynastySlug: "ballad", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "i2", workflowSlug: "wf-alioth", workflowName: "Alioth", workflowDynastyName: "Alioth", workflowDynastySlug: "alioth", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
];

const cost = (slug: string, cents: number, campaignId?: string) => ({
  dimensions: campaignId ? { workflowSlug: slug, campaignId } : { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  netTotalCostInUsdCents: String(cents),
  runCount: 10,
  minStartedAt: null,
  maxStartedAt: null,
});
const email = (slug: string, contacted: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 0, clicked: 0, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

// Per-campaign evidence. The brand is exactly C1 + C2 (no spend outside a campaign).
const COST_BY_CAMPAIGN: Record<string, Array<[string, number]>> = {
  [C1]: [["wf-ballad", 26955], ["wf-alioth", 8233]],
  [C2]: [["wf-ballad", 32348]],
};
const EMAIL_BY_CAMPAIGN: Record<string, ReturnType<typeof email>[]> = {
  [C1]: [email("wf-ballad", 400, 3), email("wf-alioth", 200, 0)],
  [C2]: [email("wf-ballad", 300, 2)],
};

function sumEmail(groups: ReturnType<typeof email>[]): ReturnType<typeof email>[] {
  const byKey = new Map<string, ReturnType<typeof email>>();
  for (const g of groups) {
    const prev = byKey.get(g.key);
    if (!prev) { byKey.set(g.key, JSON.parse(JSON.stringify(g))); continue; }
    for (const [k, v] of Object.entries(g.broadcast.recipientStats)) {
      (prev.broadcast.recipientStats as Record<string, number>)[k] += v as number;
    }
  }
  return [...byKey.values()];
}

function mockFetch(c2Offer: string): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    // The FLEET is cheap per reply ($10), so the brand floor for alioth is its own $82.33.
    if (url.includes("/v1/stats/public/costs")) return json({ groups: [cost("wf-ballad", 10000), cost("wf-alioth", 10000)] });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      const campaignId = u.searchParams.get("campaignId");
      if (groupBy.includes("campaignId")) {
        return json({
          groups: Object.entries(COST_BY_CAMPAIGN).flatMap(([cid, rows]) => rows.map(([s, c]) => cost(s, c, cid))),
        });
      }
      if (campaignId) return json({ groups: (COST_BY_CAMPAIGN[campaignId] ?? []).map(([s, c]) => cost(s, c)) });
      // BRAND: the sum over both campaigns.
      const totals = new Map<string, number>();
      for (const rows of Object.values(COST_BY_CAMPAIGN)) for (const [s, c] of rows) totals.set(s, (totals.get(s) ?? 0) + c);
      return json({ groups: [...totals].map(([s, c]) => cost(s, c)) });
    }
    if (url.includes("/orgs/stats")) {
      if (u.searchParams.get("audienceId")) return json({ groups: [] });
      const family = u.searchParams.get("campaignIds")?.split(",");
      if (family) return json({ groups: sumEmail(family.flatMap((id) => EMAIL_BY_CAMPAIGN[id] ?? [])) });
      const campaignId = u.searchParams.get("campaignId");
      if (campaignId) return json({ groups: EMAIL_BY_CAMPAIGN[campaignId] ?? [] });
      return json({ groups: sumEmail(Object.values(EMAIL_BY_CAMPAIGN).flat()) });
    }
    if (url.includes("/public/stats")) return json({ groups: [email("wf-ballad", 9000, 900), email("wf-alioth", 9000, 900)] });
    if (url.includes("/offer-economics")) {
      return json(
        offerEconomicsFromDeclared([CONVERSATION_FUNNEL], {
          offers: [
            { offerId: OFFER_A, lifetimeRevenueUsd: 5000 },
            ...(c2Offer !== OFFER_A ? [{ offerId: c2Offer, lifetimeRevenueUsd: 5000 }] : []),
          ],
        }),
      );
    }
    if (url.includes("/sales-funnels")) return json({ funnels: [CONVERSATION_FUNNEL] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) return json({ audiences: [] });
    if (url.includes("/campaigns")) {
      return json({
        campaigns: [
          { id: C1, orgId: "0e9a0000-0000-4000-8000-000000000001", brandId: BRAND, offerId: OFFER_A, legKey: "start_to_conversation", acquisitionChannel: "sales-cold-email-outreach", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
          { id: C2, orgId: "0e9a0000-0000-4000-8000-000000000001", brandId: BRAND, offerId: c2Offer, legKey: "conversation_to_meeting_booked", acquisitionChannel: "sales-cold-email-outreach", status: "ongoing", createdAt: "2026-09-02T00:00:00.000Z" },
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
const legCost = (block: any) => block?.legOutcome?.costPerOutcomeUsd ?? null;

describe("the OFFER grain is priced on the brand grain's basis", () => {
  beforeEach(() => vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any));
  afterEach(() => vi.restoreAllMocks());

  it("a brand selling ONE offer: offer and brand state the same figure for every workflow, outcomes or not", async () => {
    mockFetch(OFFER_A);
    const res = await get(`leg=start_to_conversation&campaignId=${C1}&pricing=net`);
    expect(res.status).toBe(200);

    const ballad = brandRow(res.body, "ballad");
    // $593.03 over 5 replies, on BOTH grains — never the offer's mature slice over the same 5.
    expect(legCost(ballad.estimatesByGrain.brand)).toBeCloseTo(118.606, 3);
    expect(legCost(ballad.estimatesByGrain.offer)).toBe(legCost(ballad.estimatesByGrain.brand));
    expect(ballad.estimatesByGrain.offer.evidence).toEqual(ballad.estimatesByGrain.brand.evidence);
    expect(ballad.estimatesByGrain.offer.costBasis).toBe("charged");
    // …and it is NOT the campaign's own figure (C1 alone: $269.55 / 3).
    expect(legCost(ballad.estimatesByGrain.campaign)).toBeCloseTo(89.85, 2);

    const alioth = brandRow(res.body, "alioth");
    // Zero outcomes: the same floored figure on both grains, never a floor on one and null on the other.
    expect(legCost(alioth.estimatesByGrain.brand)).not.toBeNull();
    expect(legCost(alioth.estimatesByGrain.offer)).toBe(legCost(alioth.estimatesByGrain.brand));
  });

  it("a brand selling TWO offers: the offer grain covers its own campaigns and diverges from the brand", async () => {
    mockFetch(OFFER_B);
    const res = await get(`leg=start_to_conversation&campaignId=${C1}`);
    expect(res.status).toBe(200);
    const ballad = brandRow(res.body, "ballad");
    expect(legCost(ballad.estimatesByGrain.offer)).toBeCloseTo(89.85, 2); // C1 only
    expect(legCost(ballad.estimatesByGrain.brand)).toBeCloseTo(118.606, 3);
  });

  it("the offer grain never moves the pick: resolved, rank and the recommendation are unchanged", async () => {
    mockFetch(OFFER_A);
    const withOffer = (await get(`leg=start_to_conversation&campaignId=${C1}`)).body;
    for (const row of withOffer.rows) {
      expect(row.resolved.grain).not.toBe("offer");
      expect(row.resolved.costBasis).not.toBeUndefined();
    }
    // The campaign grain stays floored against the BRAND, byte-identical to a campaign-only read.
    mockFetch(OFFER_B);
    const other = (await get(`leg=start_to_conversation&campaignId=${C1}`)).body;
    expect(brandRow(withOffer, "ballad").estimatesByGrain.campaign).toEqual(brandRow(other, "ballad").estimatesByGrain.campaign);
    expect(brandRow(withOffer, "alioth").estimatesByGrain.campaign).toEqual(brandRow(other, "alioth").estimatesByGrain.campaign);
  });

  it("no campaign named: no offer grain", async () => {
    mockFetch(OFFER_A);
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);
    for (const row of res.body.rows) expect(row.estimatesByGrain.offer).toBeUndefined();
  });
});
