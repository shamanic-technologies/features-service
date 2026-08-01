import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

/**
 * Guard suite for the cross-org `PublicCache` windows (features-service#706).
 *
 * Every cache miss on a cross-org COST surface costs runs-service one of three unbounded ledger scans
 * measured at 11-14 s (runs-service#206). These tests pin the two properties that reduce the number of
 * those scans without ever making a caller wait for one:
 *   • repeated reads inside the fresh window do NOT re-scan;
 *   • a read past the fresh window is answered from the last known value while the rescan runs BEHIND it;
 *   • a cold cache serves concurrent readers with ONE scan (the single-flight guard);
 *   • a failed background rescan keeps the last known value, and a cold failure still fails loud.
 *
 * Driven through `/public/stats/cost-projection` because it is the smallest surface whose fan-out
 * includes `fetchPublicCosts` — the exact runs-service read being counted.
 */

const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: (...a: unknown[]) => mockFindFirst(...a), findMany: (...a: unknown[]) => mockFindMany(...a) } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const {
  __resetPublicCostProjectionCache,
  __expirePublicCacheFreshWindowsForTest,
  __awaitPublicCacheRefreshForTest,
} = await import("./public.js");

const FEATURE_SLUG = "sales-cold-email-outreach";
const URL_PATH = `/public/stats/cost-projection?featureSlug=${FEATURE_SLUG}`;
const MOCK_FEATURE = { id: "feat-1", slug: FEATURE_SLUG, name: "Sales", description: "t", status: "active" };

const WORKFLOWS = [
  {
    id: "w1",
    workflowSlug: "wf-1",
    workflowName: "WF One",
    workflowDynastyName: "WF One",
    workflowDynastySlug: "wf-1",
    version: 1,
    status: "active",
    featureSlug: FEATURE_SLUG,
    createdForBrandId: null,
    upgradedTo: null,
  },
];
const EMAIL_GROUPS = [
  {
    key: "wf-1",
    broadcast: {
      recipientStats: {
        contacted: 100, sent: 100, delivered: 100, opened: 50, clicked: 10,
        bounced: 0, repliesPositive: 5, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0,
      },
    },
  },
];
const ECONOMICS = { lifetimeRevenueUsd: 1000, replyToMeetingPct: 40, visitToMeetingPct: 5, meetingToClosePct: 30, visitToClosePct: 2 };

/** Install the downstream mock. `state.runsCostCents` drives the value the surface computes from, so a
 *  recompute is observable in the body; `state.runsCalls` counts the runs-service ledger scans; and
 *  `state.failRuns` makes the scan fail so refresh/cold failure paths can be asserted. */
function installFetchMock(state: { runsCostCents: string; runsCalls: number; failRuns: boolean }) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://lead:3000/internal/feature-memberships")) {
      return new Response(JSON.stringify({ memberships: [{ orgId: "org-A", brandId: "brand-1", workflowSlug: "wf-1" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("http://workflow:3000/public/workflows")) {
      return new Response(JSON.stringify({ workflows: WORKFLOWS }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("http://runs:3000/v1/stats/public/costs")) {
      state.runsCalls += 1;
      if (state.failRuns) return new Response(JSON.stringify({ error: "ledger scan blew up" }), { status: 500 });
      return new Response(
        JSON.stringify({ groups: [{ dimensions: { workflowSlug: "wf-1" }, totalCostInUsdCents: state.runsCostCents, runCount: 5, minStartedAt: null, maxStartedAt: null }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("http://email:3000/public/stats")) {
      return new Response(JSON.stringify({ groups: EMAIL_GROUPS }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (/http:\/\/brand:3000\/orgs\/brands\/[^/]+\/sales-economics-effective/.test(url)) {
      return new Response(JSON.stringify({ economics: ECONOMICS, source: "user" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
}

describe("cross-org PublicCache windows (features-service#706)", () => {
  let state: { runsCostCents: string; runsCalls: number; failRuns: boolean };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPublicCostProjectionCache();
    state = { runsCostCents: "1000", runsCalls: 0, failRuns: false }; // $10 spend / 10 clicks → $1 per click
    installFetchMock(state);
    mockFindFirst.mockResolvedValue(MOCK_FEATURE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("repeated reads inside the fresh window trigger exactly ONE runs-service ledger scan", async () => {
    const first = await request(app).get(URL_PATH);
    expect(first.status).toBe(200);
    expect(state.runsCalls).toBe(1);

    for (let i = 0; i < 5; i++) {
      const again = await request(app).get(URL_PATH);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
    }

    // The whole point: a surface read repeatedly no longer re-scans the ledger every 60 s.
    expect(state.runsCalls).toBe(1);
  });

  it("the fresh window outlives the old 60 s one — five minutes on, a read still does NOT re-scan", async () => {
    await request(app).get(URL_PATH);
    expect(state.runsCalls).toBe(1);

    // Five minutes later: under the historical 60 s window this read paid another 11-14 s ledger scan.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + 5 * 60_000);

    const later = await request(app).get(URL_PATH);
    expect(later.status).toBe(200);
    expect(state.runsCalls).toBe(1);
  });

  it("past the STALE window a read recomputes synchronously — a stale entry is never served forever", async () => {
    const first = await request(app).get(URL_PATH);
    expect(first.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(1, 5);

    state.runsCostCents = "2000";
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => realNow + 7 * 60 * 60_000); // 7 h > the 6 h stale cap

    const res = await request(app).get(URL_PATH);
    expect(res.status).toBe(200);
    // Recomputed on the request path (the correct-but-slow branch), not served from the expired entry.
    expect(res.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(2, 5);
    expect(state.runsCalls).toBe(2);
  });

  it("past the fresh window a read is answered from the last value INSTANTLY, and the rescan runs behind it", async () => {
    const first = await request(app).get(URL_PATH);
    expect(first.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(1, 5);
    expect(state.runsCalls).toBe(1);

    // The underlying fleet spend moves, and the entry goes past fresh (still inside stale).
    state.runsCostCents = "2000"; // $20 / 10 clicks → $2 per click
    __expirePublicCacheFreshWindowsForTest();

    const stale = await request(app).get(URL_PATH);
    expect(stale.status).toBe(200);
    // Served from the LAST KNOWN value — the caller did not wait for the rescan.
    expect(stale.body).toEqual(first.body);

    // …which is running behind the response.
    await __awaitPublicCacheRefreshForTest();
    expect(state.runsCalls).toBe(2);

    const refreshed = await request(app).get(URL_PATH);
    expect(refreshed.body.avgCostPerOutcomeByObjective.websiteVisit).toBeCloseTo(2, 5);
    expect(state.runsCalls).toBe(2); // the refreshed entry is fresh again — no third scan
  });

  it("a cold cache serves concurrent readers with ONE scan (single-flight, no stampede)", async () => {
    const responses = await Promise.all([
      request(app).get(URL_PATH),
      request(app).get(URL_PATH),
      request(app).get(URL_PATH),
      request(app).get(URL_PATH),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(responses[0].body);
    }
    expect(state.runsCalls).toBe(1);
  });

  it("a FAILED background rescan keeps the last known value (never zeroes it) and retries on the next read", async () => {
    const first = await request(app).get(URL_PATH);
    expect(first.status).toBe(200);

    state.failRuns = true;
    __expirePublicCacheFreshWindowsForTest();

    const stale = await request(app).get(URL_PATH);
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual(first.body);
    await __awaitPublicCacheRefreshForTest();
    expect(state.runsCalls).toBe(2); // the failed attempt happened…

    // …and left the prior entry intact, so the next read still answers instantly and retries behind it.
    const stillStale = await request(app).get(URL_PATH);
    expect(stillStale.status).toBe(200);
    expect(stillStale.body).toEqual(first.body);
    await __awaitPublicCacheRefreshForTest();
    expect(state.runsCalls).toBe(3);
  });

  it("a COLD compute failure still fails loud — nothing is fabricated when there is no previous value", async () => {
    state.failRuns = true;

    const res = await request(app).get(URL_PATH);

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});
