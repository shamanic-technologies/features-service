import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));

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
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

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

function mockFetch(opts: {
  dailyBudgetCents?: string | number | null;
  economics?: unknown;
  emailStats?: unknown[];
  dailyStats?: unknown[];
  personaStats?: unknown[];
  personaWorkflowStats?: Record<string, unknown>;
  personas?: unknown[];
  brandProfile?: unknown;
} = {}): void {
  vi.mocked(fetchWithRetry).mockImplementation(async (input) => {
    const rawInput = input as unknown;
    const url = typeof rawInput === "string" ? rawInput : rawInput instanceof URL ? rawInput.toString() : (rawInput as any).url;
    const parsed = new URL(url);

    if (url.includes("/internal/brands/brand-1/daily-budget")) {
      return new Response(JSON.stringify({
        brandId: "brand-1",
        dailyBudgetCents: "dailyBudgetCents" in opts ? opts.dailyBudgetCents : "5000",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/sales-economics-effective")) {
      const economics = "economics" in opts ? opts.economics : ECONOMICS;
      return new Response(JSON.stringify({ economics, source: economics ? "user" : null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/orgs/brands/brand-1/personas")) {
      return new Response(JSON.stringify({
        personas: opts.personas ?? [
          { id: "persona-a", brandId: "brand-1", name: "Persona A", filters: {}, status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
          { id: "persona-b", brandId: "brand-1", name: "Persona B", filters: {}, status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/orgs/brands/brand-1/brand-profile")) {
      return new Response(JSON.stringify({
        current: "brandProfile" in opts ? opts.brandProfile : {
          id: "profile-1",
          brandId: "brand-1",
          version: 1,
          fields: {},
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/public/workflows")) {
      return new Response(JSON.stringify({ workflows: WORKFLOWS }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/v1/stats/public/costs")) {
      return new Response(JSON.stringify({
        groups: [{ dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "100000", runCount: 10, minStartedAt: null, maxStartedAt: null }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/public/stats")) {
      return new Response(JSON.stringify({
        groups: opts.emailStats ?? [
          { key: "wf-a", broadcast: { recipientStats: { contacted: 200, sent: 200, delivered: 200, opened: 90, clicked: 20, bounced: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/v1/stats/costs") && parsed.searchParams.get("groupBy") === "customerProfileId") {
      return new Response(JSON.stringify({
        groups: [
          { dimensions: { customerProfileId: "persona-a" }, totalCostInUsdCents: "10000" },
          { dimensions: { customerProfileId: "persona-b" }, totalCostInUsdCents: "40000" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("/orgs/stats")) {
      const groupBy = parsed.searchParams.get("groupBy");
      if (groupBy === "day") {
        return new Response(JSON.stringify({
          groups: opts.dailyStats ?? [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (groupBy === "customerProfileId") {
        return new Response(JSON.stringify({
          groups: opts.personaStats ?? [
            { key: "persona-a", broadcast: { recipientStats: { contacted: 100, opened: 40, clicked: 20, repliesPositive: 5 } } },
            { key: "persona-b", broadcast: { recipientStats: { contacted: 100, opened: 90, clicked: 10, repliesPositive: 1 } } },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        broadcast: {
          recipientStats: opts.personaWorkflowStats ?? {
            contacted: 100,
            opened: 40,
            clicked: 20,
            repliesPositive: 5,
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("GET /features/:featureSlug/pipeline-activity", () => {
  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns seven buckets with today actuals and daily expected values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    mockFetch({
      dailyStats: [
        { key: "2026-06-17", broadcast: { recipientStats: { contacted: 2, sent: 2, opened: 1, clicked: 1 } } },
      ],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
      .set(AUTH)
      .expect(200);

    expect(res.body.days).toHaveLength(7);
    expect(res.body.days.map((day: any) => day.date)).toEqual([
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
      "2026-06-23",
    ]);

    const today = res.body.days[0];
    expect(today.isToday).toBe(true);
    expect(today.metrics.outreach).toEqual({ actual: 2, expected: 10 });
    expect(today.metrics.opens).toEqual({ actual: 1, expected: 4 });
    expect(today.metrics.clicks).toEqual({ actual: 1, expected: 2 });
    expect(today.metrics.signups).toEqual({ actual: 0.08, expected: 0.16, conversionPct: 8 });

    const tomorrow = res.body.days[1];
    expect(tomorrow.metrics.outreach).toEqual({ actual: null, expected: 10 });
    expect(tomorrow.metrics.signups).toEqual({ actual: null, expected: 0.16, conversionPct: 8 });

    expect(res.body.summary).toEqual({
      dailyBudgetUsd: 50,
      openRatePct: 40,
      clickToSignupPct: 8,
    });

    const billingCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) =>
      String(input).includes("/internal/brands/brand-1/daily-budget"),
    );
    expect(billingCall).toBeTruthy();
    expect((billingCall?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      "x-api-key": "billing-key",
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-brand-id": "brand-1",
      "x-feature-slug": "sales-cold-email-outreach",
    });

    const personaStatsCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) => {
      const callUrl = new URL(String(input));
      return callUrl.pathname === "/orgs/stats" && callUrl.searchParams.get("groupBy") === "customerProfileId";
    });
    expect(personaStatsCall).toBeTruthy();
    const personaStatsUrl = new URL(String(personaStatsCall?.[0]));
    expect(personaStatsUrl.searchParams.get("workflowDynastySlug")).toBeNull();
    expect(personaStatsUrl.searchParams.get("workflowSlugs")).toBe("wf-a");

    const personaWorkflowCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) => {
      const callUrl = new URL(String(input));
      return callUrl.pathname === "/orgs/stats" && callUrl.searchParams.get("customerProfileId") === "persona-a";
    });
    expect(personaWorkflowCall).toBeTruthy();
    const personaWorkflowUrl = new URL(String(personaWorkflowCall?.[0]));
    expect(personaWorkflowUrl.searchParams.get("workflowDynastySlug")).toBeNull();
    expect(personaWorkflowUrl.searchParams.get("workflowSlugs")).toBe("wf-a");

    const dailyStatsCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) => {
      const callUrl = new URL(String(input));
      return callUrl.pathname === "/orgs/stats" && callUrl.searchParams.get("groupBy") === "day";
    });
    expect(dailyStatsCall).toBeTruthy();
    const dailyStatsUrl = new URL(String(dailyStatsCall?.[0]));
    expect(dailyStatsUrl.searchParams.get("type")).toBe("broadcast");
    expect(dailyStatsUrl.searchParams.get("groupBy")).toBe("day");
    expect(dailyStatsUrl.searchParams.get("timezone")).toBe("America/New_York");
    expect(dailyStatsUrl.searchParams.get("brandId")).toBe("brand-1");
    expect(dailyStatsUrl.searchParams.get("featureSlugs")).toBe("sales-cold-email-outreach");
  });

  it("returns null expected values when brand daily budget is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    mockFetch({
      dailyBudgetCents: null,
      dailyStats: [
        { key: "2026-06-17", broadcast: { recipientStats: { contacted: 1, sent: 1, opened: 1, clicked: 1 } } },
      ],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=UTC")
      .set(AUTH)
      .expect(200);

    expect(res.body.days).toHaveLength(7);
    expect(res.body.days[0].metrics.outreach).toEqual({ actual: 1, expected: null });
    expect(res.body.days[0].metrics.opens).toEqual({ actual: 1, expected: null });
    expect(res.body.days[0].metrics.clicks).toEqual({ actual: 1, expected: null });
    expect(res.body.days[0].metrics.signups).toEqual({ actual: 0.08, expected: null, conversionPct: 8 });
    expect(res.body.summary.dailyBudgetUsd).toBeNull();
  });

  it("projects expected values from brand daily budget, not campaign status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    mockFetch({
      dailyBudgetCents: "7500",
      dailyStats: [
        { key: "2026-06-17", broadcast: { recipientStats: { contacted: 1, sent: 1, opened: 1, clicked: 1 } } },
      ],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=UTC")
      .set(AUTH)
      .expect(200);

    expect(res.body.days[0].metrics.outreach).toEqual({ actual: 1, expected: 15 });
    expect(res.body.days[1].metrics.outreach).toEqual({ actual: null, expected: 15 });
    expect(res.body.summary.dailyBudgetUsd).toBe(75);
    expect(vi.mocked(fetchWithRetry).mock.calls.some(([input]) => String(input).includes("/campaigns?"))).toBe(false);
  });

  it("falls back to selected workflow rates when persona rates are unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    mockFetch({
      personaStats: [
        { key: "persona-a", broadcast: { recipientStats: { contacted: 100, opened: 0, clicked: 0, repliesPositive: 0 } } },
        { key: "persona-b", broadcast: { recipientStats: { contacted: 100, opened: 0, clicked: 0, repliesPositive: 0 } } },
      ],
      dailyStats: [
        { key: "2026-06-17", broadcast: { recipientStats: { contacted: 1, sent: 1, opened: 1, clicked: 1 } } },
      ],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=UTC")
      .set(AUTH)
      .expect(200);

    expect(res.body.days[0].metrics.outreach).toEqual({ actual: 1, expected: 10 });
    expect(res.body.days[0].metrics.opens).toEqual({ actual: 1, expected: 4.5 });
    expect(res.body.days[0].metrics.clicks).toEqual({ actual: 1, expected: 1 });
    expect(res.body.days[0].metrics.signups).toEqual({ actual: 0.08, expected: 0.08, conversionPct: 8 });
    expect(res.body.summary.openRatePct).toBe(45);
  });

  it("orders days and buckets actuals by the requested timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T02:30:00.000Z"));
    mockFetch({
      dailyStats: [
        { key: "2026-06-16", broadcast: { recipientStats: { contacted: 1, sent: 1, opened: 1, clicked: 1 } } },
      ],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=America/Los_Angeles")
      .set(AUTH)
      .expect(200);

    expect(res.body.days.map((day: any) => day.date)).toEqual([
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
    ]);
    expect(res.body.days[0].isToday).toBe(true);
    expect(res.body.days[0].metrics.outreach.actual).toBe(1);
    expect(res.body.days[1].metrics.outreach.actual).toBeNull();
  });
});
