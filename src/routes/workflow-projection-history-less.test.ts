/**
 * A CHANNEL WITH NO HISTORY STILL ANSWERS WHO IT COULD BE SERVED TO.
 *
 * A brand sells through several acquisition channels at once, and each is a feature slug. The day a
 * customer funds a SECOND channel, that channel has spent nothing — so every (audience × workflow)
 * couple has no grain and the projection used to answer with an empty `rows`. Downstream that reads as
 * "this brand has no serveable audience", so the campaign serves nobody, so it accumulates no history,
 * so it keeps answering with nothing: it cannot start because it has not started.
 *
 * Audience membership is a property of the BRAND, not of what one channel has already spent. So a
 * history-less channel enumerates the brand's active audiences under its own active workflows, stated
 * UNMEASURED — no cost, no return, no rank, nothing borrowed from the channel that does have a history.
 *
 * Driven from ONE mock harness so the two halves are one property: the history-less channel starts
 * answering AND the established channel's answer is unchanged.
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
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};

// Two active workflow dynasties, the same shape workflow-service serves for either channel.
function wf(over: Record<string, unknown>): Record<string, unknown> {
  return { id: "id", workflowSlug: "wf", workflowName: "WF", workflowDynastyName: "Dyn", workflowDynastySlug: "dyn", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null, ...over };
}
const WORKFLOWS = [
  wf({ id: "ida", workflowSlug: "wf-a", workflowDynastySlug: "dyn-a", workflowDynastyName: "Dynasty A" }),
  wf({ id: "idb", workflowSlug: "wf-b", workflowDynastySlug: "dyn-b", workflowDynastyName: "Dynasty B" }),
];

// The brand's four ACTIVE audiences — the same four for EVERY channel it sells through.
const AUDIENCES = [{ id: "aud-1" }, { id: "aud-2" }, { id: "aud-3" }, { id: "aud-4" }];

const costGroup = (slug: string, cents: number) => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), runCount: 10, minStartedAt: null, maxStartedAt: null });
const emailGroup = (slug: string, clicked: number, repliesPositive: number, contacted = 200) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 10, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

interface MockOpts {
  workflows?: unknown[];
  crossOrgCost?: unknown[];
  crossOrgEmail?: unknown[];
  brandCost?: unknown[];
  brandEmail?: unknown[];
  audiences?: Array<{ id: string }>;
  audienceCouples?: unknown[];
  audienceEngagement?: Record<string, unknown[]>;
}

function mockFetch(opts: MockOpts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: opts.workflows ?? WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: opts.crossOrgCost ?? [] });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy === "audienceId,workflowSlug") return json({ groups: opts.audienceCouples ?? [] });
      if (groupBy === "audienceId") return json({ groups: [] });
      return json({ groups: opts.brandCost ?? [] });
    }
    if (url.includes("/orgs/stats")) {
      const audienceId = u.searchParams.get("audienceId");
      if (audienceId) return json({ groups: opts.audienceEngagement?.[audienceId] ?? [] });
      return json({ groups: opts.brandEmail ?? [] });
    }
    if (url.includes("/public/stats")) return json({ groups: opts.crossOrgEmail ?? [] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) return json({ audiences: opts.audiences ?? AUDIENCES });
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const URL_BASE = "/features/feedback-request-cold-email-outreach/workflow-projection";
const QUERY = "brandId=75d7e3e8-6926-4f85-a557-976895400666&goal=meetingBooked";

describe("workflow-projection: a channel with no history still answers who it could be served to", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("enumerates the brand's active audiences, unmeasured — no cost, no return, no rank", async () => {
    // The funded-yesterday channel: no fleet spend, no brand spend, no audience couple. Same brand,
    // same four active audiences, twelve-workflow-shaped feature with no results.
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.measured).toBe(false);
    expect(res.body.unmeasuredReason).toBe("no_spend_recorded");

    // Every (active audience × active workflow) couple, plus the brand-level row per workflow.
    const audienceIds = [...new Set(res.body.rows.filter((r: any) => r.audienceId).map((r: any) => r.audienceId))].sort();
    expect(audienceIds).toEqual(["aud-1", "aud-2", "aud-3", "aud-4"]);
    const dynasties = [...new Set(res.body.rows.map((r: any) => r.workflow.workflowDynastySlug))].sort();
    expect(dynasties).toEqual(["dyn-a", "dyn-b"]);
    expect(res.body.rows).toHaveLength(2 * (1 + 4));
    expect(res.body.rows.find((r: any) => r.workflow.workflowDynastySlug === "dyn-a").workflow.workflowDynastyName).toBe("Dynasty A");

    // NOTHING is invented: no grain, and every resolved figure absent rather than 0.
    for (const row of res.body.rows) {
      expect(row.measured).toBe(false);
      expect(row.estimatesByGrain).toEqual({});
      expect(row.resolved).toEqual({
        grain: null,
        costBasis: null,
        costPerClickUsd: null,
        costPerOutcomeUsd: null,
        costPerPaidClientUsd: null,
        costPerMeetingBookedUsd: null,
        roiMultiple: null,
        cacPct: null,
      });
    }
    // No rank: an unmeasured row can never be recommended.
    expect(res.body.recommendedWorkflowDynastySlug).toBeNull();
    expect(res.body.recommendedBudgetUsd).toBeNull();
  });

  it("'this brand has no active audiences' is a DIFFERENT answer from 'this channel has no measurements'", async () => {
    mockFetch({ audiences: [] });
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.measured).toBe(false);
    // The reason is what a caller acts on: nothing to serve through ANY channel, vs a channel waiting
    // for its first run. Both answer `rows: []`-shaped emptiness at the audience level.
    expect(res.body.unmeasuredReason).toBe("no_active_audiences");
  });

  it("a feature with no active workflow says so, rather than reading as a brand with no audiences", async () => {
    mockFetch({ workflows: [] });
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.measured).toBe(false);
    expect(res.body.unmeasuredReason).toBe("no_active_workflows");
  });

  it("an ESTABLISHED channel's MEASURED answer is unchanged, and its history-less workflow is offered UNMEASURED beside it", async () => {
    // Fleet + brand spend on dyn-a ONLY. dyn-a's rows are measured exactly as before: one brand-level
    // row plus one per active audience, each resolving at a real grain. dyn-b has no grain anywhere —
    // it is the MIXED case #805 could not reach (prod 2026-08-25: 75 new workflows invisible inside a
    // channel with 18 that had spend), so it is now offered UNMEASURED, carrying the explore allowance
    // and nothing else. Full coverage of that half lives in workflow-projection-explore-allowance.test.ts.
    mockFetch({
      crossOrgCost: [costGroup("wf-a", 100000)],
      crossOrgEmail: [emailGroup("wf-a", 100, 50)],
      brandCost: [costGroup("wf-a", 50000)],
      brandEmail: [emailGroup("wf-a", 25, 5, 100)],
    });
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.measured).toBe(true);
    expect(res.body.unmeasuredReason).toBeUndefined();

    const measured = res.body.rows.filter((r: any) => r.measured);
    expect(measured).toHaveLength(1 + 4); // dyn-a: brand-level + one per active audience
    expect(measured.every((r: any) => r.workflow.workflowDynastySlug === "dyn-a")).toBe(true);
    for (const row of measured) {
      expect(row.resolved.grain).not.toBeNull();
      expect(row.resolved.costPerClickUsd).toBeGreaterThan(0);
      expect(row.resolved.costPerOutcomeUsd).toBeGreaterThan(0);
    }
    // The workflow it RECOMMENDS is still picked from real evidence — an unmeasured row is reachable,
    // never recommended.
    expect(res.body.recommendedWorkflowDynastySlug).toBe("dyn-a");

    const unmeasured = res.body.rows.filter((r: any) => !r.measured);
    expect(unmeasured).toHaveLength(1 + 4); // dyn-b, same enumeration
    expect(unmeasured.every((r: any) => r.workflow.workflowDynastySlug === "dyn-b")).toBe(true);
    for (const row of unmeasured) {
      expect(row.estimatesByGrain).toEqual({});
      expect(row.resolved.grain).toBeNull();
      expect(row.resolved.costPerOutcomeUsd).toBeGreaterThan(0);
      expect(row.resolved.roiMultiple).toBeNull();
    }
  });
});
