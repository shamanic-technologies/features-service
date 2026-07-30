import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

/**
 * Gold-SWR guard: a GROSS and a NET pipeline-activity request must never share a cached body.
 *
 * The two answers differ in real money (the expected series divide the budget by a cost read on the
 * requested basis), so a `scope_key` that ignored `pricing` would serve a discounted org whichever of
 * the two happened to be computed first — the exact wrong-number-under-a-discount-banner failure the
 * selector exists to prevent. Distinct cells is the property; this suite asserts the endpoint persists
 * TWO of them and that their bodies differ.
 *
 * The cache is ENABLED here (the sibling suite disables it) and every read MISSES, so each request
 * computes and upserts its own snapshot and we can read the keys back off the insert.
 */

const upserts: Array<{ view: string; scopeKey: string; body: unknown }> = [];

const dbMock = {
  query: { features: { findFirst: vi.fn(), findMany: vi.fn() } },
  // Always a MISS → every request computes live and persists its own cell.
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: async () => {
        upserts.push({ view: String(v.view), scopeKey: String(v.scopeKey), body: v.body });
      },
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        then: (resolve: (v: unknown) => void) => resolve(undefined),
        returning: async () => [],
      }),
    }),
  }),
};

vi.mock("../db/index.js", () => ({ db: dbMock, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: vi.fn() }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "true";
process.env.FEATURE_VIEW_SNAPSHOT_TTL_MS = "60000";

const { db } = await import("../db/index.js");
const { fetchWithRetry } = await import("../lib/fetch-retry.js");
const app = (await import("../index.js")).default;

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const SALES_FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales",
  description: "x",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 8,
  signupToPaidClientPct: 25,
  visitToClosePct: 2,
};

const WORKFLOWS = [
  {
    id: "wf-a-id",
    workflowSlug: "wf-a",
    workflowName: "Workflow A",
    workflowDynastyName: "Dynasty A",
    workflowDynastySlug: "dyn-a",
    version: 1,
    status: "active",
    featureSlug: "sales-cold-email-outreach",
    createdForBrandId: null,
    upgradedTo: null,
  },
];

/** Half-price frozen net twin on every cost group — a 50%-discount org's runs#179 rows. */
const NET_PCT = 50;
const withNet = (group: Record<string, unknown>) => ({
  ...group,
  netTotalCostInUsdCents: String(Math.round(Number(group.totalCostInUsdCents) * (1 - NET_PCT / 100))),
});

function mockFetch(): void {
  vi.mocked(fetchWithRetry).mockImplementation(async (input) => {
    const url = String(input);
    const parsed = new URL(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/conversion-counts-by-day")) {
      return json({
        byDay: { signup: {}, meeting_booked: {}, form_submission: {}, sale: {} },
        undated: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 },
      });
    }
    if (url.includes("/daily-budget")) return json({ brandId: "brand-1", dailyBudgetCents: "5000" });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (parsed.pathname.endsWith("/members")) return json({ members: [], total: 0 });
    if (parsed.pathname === "/orgs/audiences") return json({ audiences: [] });
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) {
      return json({
        groups: [withNet({ dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "100000", runCount: 10 })],
      });
    }
    if (url.includes("/public/stats")) {
      return json({
        groups: [{ key: "wf-a", broadcast: { recipientStats: { contacted: 200, opened: 90, clicked: 20 } } }],
      });
    }
    // Brand grain: no attributed spend → no own ratio → the fleet benchmark alone drives the divisor.
    if (url.includes("/v1/stats/costs")) return json({ groups: [] });
    if (parsed.pathname === "/orgs/stats") return json({ groups: [] });
    return json({});
  });
}

describe("pipeline-activity Gold snapshot keys on ?pricing=", () => {
  beforeEach(() => {
    upserts.length = 0;
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    mockFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("persists two DISTINCT cells for gross vs net, with different money in each body", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    const url = "/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York";

    const gross = await request(app).get(url).set(AUTH).expect(200);
    const net = await request(app).get(`${url}&pricing=net`).set(AUTH).expect(200);

    // Fleet benchmark $5.00/outreach gross, $2.50 net → $50 budget buys 10 vs 20 sends.
    expect(gross.body.days[0].metrics.outreach.expected).toBe(10);
    expect(net.body.days[0].metrics.outreach.expected).toBe(20);

    const keys = upserts.filter((u) => u.view === "pipeline-activity").map((u) => u.scopeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("shares ONE cell when the requests differ only by an OMITTED vs explicit gross selector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    const url = "/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York";

    await request(app).get(url).set(AUTH).expect(200);
    await request(app).get(`${url}&pricing=gross`).set(AUTH).expect(200);

    const keys = upserts.filter((u) => u.view === "pipeline-activity").map((u) => u.scopeKey);
    expect(keys).toHaveLength(2);
    // Omitted defaults to gross, so the two land on the SAME cell — the dashboard sending the selector
    // explicitly does not fragment the cache against a caller that omits it. (Pre-existing snapshot rows
    // keyed without `pricing` simply orphan; the Gold layer is derived and rebuildable.)
    expect(new Set(keys).size).toBe(1);
  });
});
