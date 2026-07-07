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
process.env.FEATURE_VIEW_CACHE_ENABLED = "false"; // exercise the pure live-compute path here

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

// Default audiences (active). audience.id IS the attribution key (audienceId).
const AUDIENCES = [
  { id: "aud-a", brandId: "brand-1", name: "Audience A", status: "active", filters: {} },
  { id: "aud-b", brandId: "brand-1", name: "Audience B", status: "active", filters: {} },
];

// audienceId -> member emails (human-service /orgs/audiences/:id/members)
const MEMBERS: Record<string, string[]> = {
  "aud-a": ["a1@x.com", "a2@x.com"],
  "aud-b": ["b1@x.com", "b2@x.com"],
};

// email -> brand-scoped broadcast outcome flags (email-gateway POST /orgs/status)
type Outcome = { contacted?: boolean; opened?: boolean; clicked?: boolean; replied?: boolean; replyClassification?: string | null };
const DEFAULT_OUTCOMES: Record<string, Outcome> = {
  // aud-a: contacted 2, opened 1, clicked 1, positiveReply 1 -> CPC = 10000/1 = 10000 (best)
  "a1@x.com": { contacted: true, opened: true, clicked: true, replied: true, replyClassification: "positive" },
  "a2@x.com": { contacted: true },
  // aud-b: contacted 2, clicked 1, positiveReply 0 -> CPC = 40000/1 = 40000
  "b1@x.com": { contacted: true, opened: true, clicked: true },
  "b2@x.com": { contacted: true },
};

// audienceId -> cost cents (runs /v1/stats/costs groupBy=audienceId)
const DEFAULT_AUDIENCE_COSTS: Record<string, string> = { "aud-a": "10000", "aud-b": "40000" };

function mockFetch(opts: {
  dailyBudgetCents?: string | number | null;
  economics?: unknown;
  emailStats?: unknown[];
  dailyStats?: unknown[];
  audiences?: unknown[];
  members?: Record<string, string[]>;
  outcomes?: Record<string, Outcome>;
  audienceCosts?: Record<string, string>;
  brandProfile?: unknown;
} = {}): void {
  vi.mocked(fetchWithRetry).mockImplementation(async (input, init) => {
    const rawInput = input as unknown;
    const url = typeof rawInput === "string" ? rawInput : rawInput instanceof URL ? rawInput.toString() : (rawInput as any).url;
    const parsed = new URL(url);
    const members = opts.members ?? MEMBERS;
    const outcomes = opts.outcomes ?? DEFAULT_OUTCOMES;
    const audienceCosts = opts.audienceCosts ?? DEFAULT_AUDIENCE_COSTS;

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

    // human-service: audience members (check BEFORE the audiences list — superstring path).
    if (parsed.pathname.endsWith("/members")) {
      const audienceId = parsed.pathname.split("/").slice(-2)[0];
      const emails = members[audienceId] ?? [];
      return new Response(JSON.stringify({
        members: emails.map((emailNorm) => ({ emailNorm })),
        total: emails.length,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // human-service: active audiences list
    if (parsed.pathname === "/orgs/audiences") {
      return new Response(JSON.stringify({ audiences: opts.audiences ?? AUDIENCES }), { status: 200, headers: { "Content-Type": "application/json" } });
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

    // runs-service per-audience cost (groupBy=audienceId)
    if (url.includes("/v1/stats/costs") && parsed.searchParams.get("groupBy") === "audienceId") {
      return new Response(JSON.stringify({
        groups: Object.entries(audienceCosts).map(([audienceId, totalCostInUsdCents]) => ({
          dimensions: { audienceId },
          totalCostInUsdCents,
        })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // email-gateway: per-email brand-scoped outcome flags (POST /orgs/status)
    if (parsed.pathname === "/orgs/status") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { items?: Array<{ email: string }> };
      const results = (body.items ?? []).map(({ email }) => ({
        email,
        broadcast: { brand: outcomes[email] ?? {} },
      }));
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // email-gateway: daily broadcast actuals (GET /orgs/stats?groupBy=day)
    if (parsed.pathname === "/orgs/stats") {
      return new Response(JSON.stringify({ groups: opts.dailyStats ?? [] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    // outreachUsd = (100000/100)/200 = 5; budget 50 / 5 = 10 outreach.
    expect(today.metrics.outreach).toEqual({ actual: 2, expected: 10 });
    // best audience aud-a openPerOutreach = opened 1 / contacted 2 = 0.5 (audience-grain); opens = 10 * 0.5 = 5.
    expect(today.metrics.opens).toEqual({ actual: 1, expected: 5 });
    // best audience aud-a clickPerOutreach = clicked 1 / contacted 2 = 0.5; clicks = 10 * 0.5 = 5.
    expect(today.metrics.clicks).toEqual({ actual: 1, expected: 5 });
    // signups expected = clicks 5 * 0.08; actual = clicks 1 * 0.08.
    expect(today.metrics.signups).toEqual({ actual: 0.08, expected: 0.4, conversionPct: 8 });
    // this brand carries no visitToFormSubmissionPct → the form-submission series is all-null (never a false 0).
    expect(today.metrics.formSubmissions).toEqual({ actual: null, expected: null, conversionPct: null });

    const tomorrow = res.body.days[1];
    expect(tomorrow.metrics.outreach).toEqual({ actual: null, expected: 10 });
    expect(tomorrow.metrics.signups).toEqual({ actual: null, expected: 0.4, conversionPct: 8 });
    expect(tomorrow.metrics.formSubmissions).toEqual({ actual: null, expected: null, conversionPct: null });

    expect(res.body.summary).toEqual({
      dailyBudgetUsd: 50,
      openRatePct: 50,
      clickToSignupPct: 8,
      clickToFormSubmissionPct: null,
    });

    // candidate set sourced from human-service active audiences (not brand personas).
    const audiencesCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) => {
      const callUrl = new URL(String(input));
      return callUrl.pathname === "/orgs/audiences" && callUrl.searchParams.get("status") === "active";
    });
    expect(audiencesCall).toBeTruthy();

    // cost attributed via runs groupBy=audienceId, scoped to the chosen workflow dynasty.
    // The cost NUMERATOR is NOT filtered by goal/brandProfileId (untagged on runs rows → would
    // drop every real cost row).
    const audienceCostCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) => {
      const callUrl = new URL(String(input));
      return callUrl.pathname === "/v1/stats/costs" && callUrl.searchParams.get("groupBy") === "audienceId";
    });
    expect(audienceCostCall).toBeTruthy();
    const audienceCostUrl = new URL(String(audienceCostCall?.[0]));
    expect(audienceCostUrl.searchParams.get("workflowDynastySlug")).toBe("dyn-a");
    expect(audienceCostUrl.searchParams.get("goal")).toBeNull();
    expect(audienceCostUrl.searchParams.get("brandProfileId")).toBeNull();

    // outcomes resolved read-time: member emails per audience + per-email outcome flags.
    const memberCalls = vi.mocked(fetchWithRetry).mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.endsWith("/members"),
    );
    expect(memberCalls).toHaveLength(2);
    const statusCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) =>
      new URL(String(input)).pathname === "/orgs/status",
    );
    expect(statusCall).toBeTruthy();

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

  it("projects the form-submission series off clicks when the brand carries visitToFormSubmissionPct", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    // Same brand as the happy path, but the effective economics now carries the visit→form rate (15%).
    mockFetch({
      economics: { ...ECONOMICS, visitToFormSubmissionPct: 15 },
      dailyStats: [{ key: "2026-06-17", broadcast: { recipientStats: { contacted: 2, sent: 2, opened: 1, clicked: 1 } } }],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
      .set(AUTH)
      .expect(200);

    const today = res.body.days[0];
    // clicks: actual 1, expected 5 (unchanged). form submissions = clicks × 0.15.
    expect(today.metrics.formSubmissions).toEqual({ actual: 0.15, expected: 0.75, conversionPct: 15 });
    const tomorrow = res.body.days[1];
    expect(tomorrow.metrics.formSubmissions).toEqual({ actual: null, expected: 0.75, conversionPct: 15 });
    expect(res.body.summary.clickToFormSubmissionPct).toBe(15);
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

  it("falls back to selected workflow rates when no audience has click outcomes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    mockFetch({
      // no audience member clicked -> no audience qualifies -> all rates fall back to workflow aggregate.
      outcomes: {
        "a1@x.com": { contacted: true },
        "a2@x.com": { contacted: true },
        "b1@x.com": { contacted: true },
        "b2@x.com": { contacted: true },
      },
      dailyStats: [
        { key: "2026-06-17", broadcast: { recipientStats: { contacted: 1, sent: 1, opened: 1, clicked: 1 } } },
      ],
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=UTC")
      .set(AUTH)
      .expect(200);

    expect(res.body.days[0].metrics.outreach).toEqual({ actual: 1, expected: 10 });
    // workflow open rate 90/200 = 0.45 -> 10 * 0.45 = 4.5.
    expect(res.body.days[0].metrics.opens).toEqual({ actual: 1, expected: 4.5 });
    // workflow click rate 20/200 = 0.1 -> 10 * 0.1 = 1.
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
