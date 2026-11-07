/**
 * OUTCOME-FINEST-1106: the published Units read, hard-coded per outcome. Rows come from the subject's own service filtered
 * on the org + brand; the ledger credits each row's Units.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const assertBrandHeld = vi.fn(async () => undefined);
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: (...a: unknown[]) => assertBrandHeld(...(a as [])), BrandOwnershipError: class BrandOwnershipError extends Error {} }));
vi.mock("../middleware/auth.js", () => ({
  apiKeyAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));
const fetchWithRetry = vi.fn();
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

const fetchSalesFunnelCampaigns = vi.fn(async () => [] as unknown[]);
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => fetchSalesFunnelCampaigns(...(a as [])) }));
vi.mock("../lib/campaign-identity-client.js", () => ({ fetchBrandCampaignRows: async () => [] }));
vi.mock("../lib/brand-leg-economics-client.js", () => ({ fetchBrandLegEconomics: async () => ({ offers: [] }) }));
vi.mock("../lib/offer-lifetime-revenue.js", () => ({ offerLifetimeRevenue: async (stated: number | null | undefined) => (typeof stated === "number" ? { usd: stated, source: "offer_stated" } : { usd: 1000, source: "fleet_median" }) }));

import router from "./published-units.js";
import { __resetPublishedUnits, __setPublishedUnitsModelLoader } from "../lib/published-units-io.js";

const app = express().use(router);
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const threadsPost = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orgId: "org-1",
  brandId: "b1",
  accountUsername: "distribute_you_gtm",
  permalink: `https://threads.net/p/${id}`,
  text: `post ${id}`,
  performedBy: "ours",
  outcomeKey: "threads_post_published",
  outcomeRunId: `run-${id}`,
  publishedAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  __resetPublishedUnits();
  for (const [k, v] of Object.entries({ RUNS_SERVICE_URL: "http://runs", RUNS_SERVICE_API_KEY: "k", SOCIAL_SERVICE_URL: "http://social", SOCIAL_SERVICE_API_KEY: "k", META_SERVICE_URL: "http://meta", META_SERVICE_API_KEY: "k", TRANSACTIONAL_EMAIL_SERVICE_URL: "http://te", TRANSACTIONAL_EMAIL_SERVICE_API_KEY: "k" })) process.env[k] = v;
  fetchWithRetry.mockReset();
  fetchSalesFunnelCampaigns.mockReset();
  fetchSalesFunnelCampaigns.mockResolvedValue([]);
  // A catalogue where a post converts to a paying client 0.1% of the time (nobody of ours works that leg: $0), so it is
  // worth 1/1000 of the lifetime revenue NET, and the X pipe expects $0.10 a post.
  __setPublishedUnitsModelLoader(async (ltr) => ({
    lifetimeRevenueUsd: ltr,
    steps: new Map([
      ["threads_post_published", { key: "threads_post_published", valueUsd: ltr === null ? null : ltr / 1000, valueVia: { toStep: "paid_client", ratePct: 0.1 } }],
      ["paid_client", { key: "paid_client", valueUsd: ltr, valueVia: null }],
    ]),
    pipes: new Map([["x|start_to_threads_post_published", { id: "x|start_to_threads_post_published", published: true, outcome: "x_post_published", toStep: "threads_post_published", operatedBy: "platform", expectedCost: { costPerOutcomeUsd: 0.1, source: "default", basis: "default" } }]]),
  }) as never);
});

describe("GET /brands/:brandId/published-units/:outcomeKey", () => {
  it("Threads: the brand's own posts (ours and hand posts), views from post metrics, cost and visits from the ledger", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://meta/internal/threads/measurable-posts"))
        return json({ posts: [threadsPost("p1"), threadsPost("p2", { performedBy: "client_team", outcomeKey: "threads_post_published" }), threadsPost("p3", { brandId: "other" })] });
      if (url.startsWith("http://social/internal/post-metrics")) return json({ posts: [{ subjectId: "p1", publishRunId: "run-p1", metrics: { views: 120 }, engagement: 7 }] });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) {
        const q = new URL(url).searchParams;
        if (q.get("direction") === "produced" && q.get("outcomeKey") === "threads_post_published" && (q.get("runIds") ?? "").split(",").includes("run-p1"))
          return json({ occurrences: [{ id: "u1", runId: "run-p1", direction: "produced", outcomeKey: "threads_post_published", subjectService: "meta-service", subjectId: "p1", cost: { grossCents: "50", netCents: "25" }, consumption: null }], nextCursor: null });
        if (q.get("direction") === "consumed" && !q.get("runIds") && q.get("outcomeKey") === "threads_post_published")
          return json({ occurrences: [{ id: "c1", runId: "visit-run", direction: "consumed", outcomeKey: "threads_post_published", subjectService: "meta-service", subjectId: "p1", cost: null, consumption: { sourceOccurrenceId: "u1", consumingOutcomes: [{ outcomeKey: "website_visit" }] } }], nextCursor: null });
        if (q.get("outcomeKey") === "website_visit" && q.get("direction") === "produced")
          return json({ occurrences: [{ id: "w1", runId: "visit-run", direction: "produced", outcomeKey: "website_visit", subjectService: "lead-service", subjectId: "lead-1", cost: null, consumption: null }], nextCursor: null });
        return json({ occurrences: [], nextCursor: null });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/threads_post_published");
    expect(res.status).toBe(200);
    expect(res.body.pricing).toBe("net");
    expect(res.body.rows).toHaveLength(2);
    const p1 = res.body.rows.find((r: { id: string }) => r.id === "p1");
    expect(p1).toMatchObject({ performedBy: "ours", text: "post p1", views: 120, engagements: 7, spentUsd: 0.25, visits: 1, signups: 0 });
    const p2 = res.body.rows.find((r: { id: string }) => r.id === "p2");
    expect(p2).toMatchObject({ performedBy: "client_team", views: null, ledgerUnavailableReason: "not_on_ledger_yet" });
    expect(res.body.learning).toBe(true);
    expect(res.body.costPerSignupUsd).toBeNull();
  });

  it("newsletter: one row per release of the org (a release stating no brand lists on its brands), Units = emails sent", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://te/internal/mailing-list-releases"))
        return json({
          releases: [
            { releaseId: "r1", listSlug: "newsletter", subject: "Hello", orgId: "org-1", brandIds: [], unitsRunId: "units-1", emailsSent: 3, firstSentAt: "2026-11-02T08:00:00.000Z", createdAt: "2026-11-02T07:00:00.000Z" },
            { releaseId: "r2", listSlug: "newsletter", subject: "Other org", orgId: "org-2", brandIds: [], unitsRunId: "units-2", emailsSent: 9, firstSentAt: null, createdAt: "2026-11-02T07:00:00.000Z" },
            { releaseId: "r3", listSlug: "newsletter", subject: "Other brand", orgId: "org-1", brandIds: ["b2"], unitsRunId: null, emailsSent: 9, firstSentAt: null, createdAt: "2026-11-02T07:00:00.000Z" },
          ],
        });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) {
        const q = new URL(url).searchParams;
        if (q.get("direction") === "produced" && q.get("outcomeKey") === "newsletter_email_sent")
          return json({ occurrences: ["a", "b", "c"].map((s) => ({ id: `u-${s}`, runId: "units-1", direction: "produced", outcomeKey: "newsletter_email_sent", subjectService: "transactional-email-service", subjectId: s, cost: { grossCents: "2", netCents: "1" }, consumption: null })), nextCursor: null });
        return json({ occurrences: [], nextCursor: null });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/newsletter_email_sent?pricing=gross");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([expect.objectContaining({ id: "r1", text: "Hello", account: "newsletter", units: 3, performedBy: "ours", spentUsd: 0.06, visits: null, signups: null, visitsUnavailableReason: "no_visit_attribution_on_outcome" })]);
    expect(res.body.totals.all.units).toBe(3);
  });

  it("LinkedIn: the brand's connected LinkedIn accounts' posts, hand posts as client_team; X posts stay on the X page", async () => {
    const post = (id: string, platform: string, performedBy: string) => ({ id, platform, orgId: "org-1", brandId: "b1", username: "kevin", externalId: id, text: `t ${id}`, permalink: `https://linkedin.com/feed/${id}`, publishedAt: "2026-11-05T10:00:00.000Z", performedBy, ourSubjectId: null, outcomeKey: `${platform}_post_published`, unitRunId: null, metrics: { views: 10, likes: 2, replies: 1, reposts: null, quotes: null, bookmarks: null } });
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://social/internal/account-posts")) return json({ posts: [post("l1", "linkedin", "client_team"), post("x1", "x", "client_team")] });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) return json({ occurrences: [], nextCursor: null });
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/linkedin_post_published");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([expect.objectContaining({ id: "l1", performedBy: "client_team", views: 10, engagements: 3, ledgerUnavailableReason: "not_on_ledger_yet" })]);
  });

  it("refuses an outcome it does not serve, and a foreign brand", async () => {
    expect((await request(app).get("/brands/b1/published-units/post_published")).status).toBe(400);
    expect((await request(app).get("/brands/b1/published-units/x_post_published?pricing=vendor")).status).toBe(400);
  });

  it("X (SOCIAL-OUTCOMES-1107): a retweet is left out, the breakdown sums, each post valued, measured and expected returns served", async () => {
    const xPost = (id: string, over: Record<string, unknown> = {}) => ({ id, platform: "x", orgId: "org-1", brandId: "b1", username: "DistributeYou", externalId: id, text: `t ${id}`, permalink: `https://x.com/s/${id}`, publishedAt: "2026-11-05T10:00:00.000Z", performedBy: "ours", ourSubjectId: id, outcomeKey: "x_post_published", unitRunId: `run-${id}`, metrics: { views: 40, likes: 2, replies: 1, reposts: 0, quotes: 0, bookmarks: 1 }, kind: "post", ...over });
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://social/internal/account-posts"))
        return json({ posts: [xPost("x1"), xPost("rt", { text: "RT @tparsi: big news", kind: "repost", metrics: { views: 30, likes: 9000, replies: 0, reposts: 2701, quotes: 0, bookmarks: 0 } })] });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) {
        const q = new URL(url).searchParams;
        if (q.get("direction") === "produced" && q.get("outcomeKey") === "x_post_published")
          return json({ occurrences: [{ id: "u1", runId: "run-x1", direction: "produced", outcomeKey: "x_post_published", subjectService: "social-service", subjectId: "x1", cost: { grossCents: "20", netCents: "20" }, consumption: null, tags: { campaignId: null } }], nextCursor: null });
        return json({ occurrences: [], nextCursor: null });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/x_post_published");
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { id: string }) => r.id)).toEqual(["x1"]);
    expect(res.body.repostsExcluded).toEqual({ rows: 1, engagements: 11701 });
    expect(res.body.rows[0]).toMatchObject({ engagements: 4, engagementBreakdown: { likes: 2, replies: 1, reposts: 0, quotes: 0, bookmarks: 1, shares: null, clicks: null }, valuePerUnitUsd: 1, valueUsd: 1, value: { offerId: null, lifetimeRevenueSource: "fleet_median", step: "threads_post_published" }, measuredReturn: { roiMultiple: null, spentUsd: 0.2, unavailableReason: "return_only_at_campaign_target" } });
    expect(res.body.totals.all).toMatchObject({ engagements: 4, views: 40, valueUsd: 1 });
    expect(res.body.visitsMeasured).toBe(false);
    // OUTCOME-ACCOUNTING-1107: no campaign targets X posts, so no return; the report states the four figures.
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: null, unavailableReason: "outcome_is_no_campaign_target" });
    expect(res.body.measuredReturn).toMatchObject({ roiMultiple: null, unavailableReason: "outcome_is_no_campaign_target" });
    expect(res.body.accounting).toMatchObject({
      costPerUnit: { actualUsd: 0.2, expectedUsd: 0.1, variance: { usd: 0.1, pct: 100 } },
      costFromStart: { actualUsd: 0.2, expectedUsd: 0.1, route: ["threads_post_published"] },
      yieldToNext: { nextStep: "paid_client", measuredPct: null, measuredUnavailableReason: "next_milestone_not_tracked_for_outcome", expectedPct: 0.1 },
      value: { expectedNetPerUnitUsd: 1, basis: "expected_net" },
      returns: { isCampaignTarget: false, unavailableReason: "outcome_is_no_campaign_target" },
    });
    expect(res.body.rows[0].accounting.costPerUnit).toMatchObject({ actualUsd: 0.2, expectedUsd: 0.1 });
  });

  it("OUTCOME-ACCOUNTING-1107: a campaign whose Target is the outcome gets the return, on its own Units and spend", async () => {
    const xPost = (id: string, campaign: string | null) => ({ id, platform: "x", orgId: "org-1", brandId: "b1", username: "DistributeYou", externalId: id, text: `t ${id}`, permalink: null, publishedAt: "2026-11-05T10:00:00.000Z", performedBy: "ours", ourSubjectId: id, outcomeKey: "x_post_published", unitRunId: `run-${id}`, metrics: { views: 10 }, kind: "post", campaign });
    fetchSalesFunnelCampaigns.mockResolvedValue([{ id: "fc-1", target: "threads_post_published", units: [{ campaignId: "unit-1" }] }, { id: "fc-2", target: "paid_client", units: [{ campaignId: "unit-2" }] }]);
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://social/internal/account-posts")) return json({ posts: [xPost("x1", "unit-1"), xPost("x2", "unit-2")] });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) {
        const q = new URL(url).searchParams;
        if (q.get("direction") === "produced" && q.get("outcomeKey") === "x_post_published")
          return json({
            occurrences: ["x1", "x2"].map((id, i) => ({ id: `u${id}`, runId: `run-${id}`, direction: "produced", outcomeKey: "x_post_published", subjectService: "social-service", subjectId: id, cost: { grossCents: "40", netCents: "40" }, consumption: null, tags: { campaignId: i === 0 ? "unit-1" : "unit-2" } })),
            nextCursor: null,
          });
        return json({ occurrences: [], nextCursor: null });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/x_post_published");
    expect(res.status).toBe(200);
    // fc-1 made x1 ($0.40) worth $1: measured 2.5x (Learning under 10 Units); expected $1 / $0.10 = 10x.
    expect(res.body.accounting.returns).toMatchObject({ isCampaignTarget: true, targetCampaignIds: ["fc-1"], measured: { roiMultiple: 2.5, targetUnits: 1, spentUsd: 0.4, learning: true }, expected: { roiMultiple: 10 } });
    expect(res.body.measuredReturn).toMatchObject({ roiMultiple: 2.5 });
    expect(res.body.expectedReturn).toMatchObject({ roiMultiple: 10, costPerUnitUsd: 0.1 });
  });

  it("a producer that fails is named on the 502 (newsletter: runs-service 500)", async () => {
    fetchWithRetry.mockImplementation(async (url: string) => {
      if (url.startsWith("http://te/internal/mailing-list-releases"))
        return json({ releases: [{ releaseId: "r1", listSlug: "newsletter", subject: "Hello", orgId: "org-1", brandIds: [], unitsRunId: "units-1", emailsSent: 3, unitsDeclared: 3, firstSentAt: "2026-11-02T08:00:00.000Z", createdAt: "2026-11-02T07:00:00.000Z" }] });
      if (url.startsWith("http://runs/internal/outcome-occurrences")) return { ok: false, status: 500, json: async () => ({}), text: async () => '{"error":"boom"}' };
      throw new Error(`unexpected ${url}`);
    });
    const res = await request(app).get("/brands/b1/published-units/newsletter_email_sent");
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ reason: "producer_unavailable", producer: "runs-service", producerPath: "/internal/outcome-occurrences", producerStatus: 500 });
  });
});
