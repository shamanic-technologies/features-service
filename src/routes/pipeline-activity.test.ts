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
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
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

// lead-service conversion-counts-by-day default: a brand with ZERO real tracked conversions
// (the AC2 verification-brand shape — byDay all-empty, undated all-zero).
const EMPTY_CONVERSION_BY_DAY = {
  byDay: { signup: {}, meeting_booked: {}, form_submission: {}, sale: {} },
  undated: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 },
};

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
  conversionByDay?: unknown;
  conversionByDayStatus?: number;
  /** runs /v1/stats/costs?groupBy=workflowSlug&brandId — the BRAND's own committed spend per dynasty. */
  brandCosts?: unknown[];
  /** email-gateway /orgs/stats?groupBy=workflowSlug&brandId — the BRAND's own recipients contacted. */
  brandEmailStats?: unknown[];
  /**
   * When set, EVERY runs-service cost group additionally carries runs#179's frozen NET twin
   * (`netTotalCostInUsdCents` = gross reduced by this percentage), as a discounted org's rows do.
   * Left UNSET, the groups carry only the gross field — the shape a `pricing=net` request must fail
   * loud on rather than silently serving full price.
   */
  netDiscountPct?: number;
} = {}): void {
  vi.mocked(fetchWithRetry).mockImplementation(async (input, init) => {
    const rawInput = input as unknown;
    const url = typeof rawInput === "string" ? rawInput : rawInput instanceof URL ? rawInput.toString() : (rawInput as any).url;
    const parsed = new URL(url);
    const members = opts.members ?? MEMBERS;
    const outcomes = opts.outcomes ?? DEFAULT_OUTCOMES;
    const audienceCosts = opts.audienceCosts ?? DEFAULT_AUDIENCE_COSTS;
    // runs#179 freezes each cost row's usage discount at WRITE time and serves the reduced twin
    // alongside the gross field. Mirror that here so a `pricing=net` request has something to read.
    const withNet = <T extends Record<string, unknown>>(group: T): T =>
      opts.netDiscountPct === undefined
        ? group
        : {
            ...group,
            netTotalCostInUsdCents: String(
              Math.round(Number(group.totalCostInUsdCents) * (1 - opts.netDiscountPct / 100)),
            ),
          };

    // lead-service: REAL per-day attributed conversion counts (drives signup/form-submission .actual).
    if (url.includes("/internal/brands/brand-1/conversion-counts-by-day")) {
      const status = opts.conversionByDayStatus ?? 200;
      const body = status === 200 ? (opts.conversionByDay ?? EMPTY_CONVERSION_BY_DAY) : { error: "lead-service down" };
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }

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
        groups: [withNet({ dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "100000", runCount: 10, minStartedAt: null, maxStartedAt: null })],
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
        groups: Object.entries(audienceCosts).map(([audienceId, totalCostInUsdCents]) =>
          withNet({ dimensions: { audienceId }, totalCostInUsdCents }),
        ),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // runs-service BRAND-grain cost (groupBy=workflowSlug + brandId) — numerator of the brand's own
    // observed cost per outreach. Default: no attributed brand spend → no own-ratio → fleet benchmark.
    if (url.includes("/v1/stats/costs") && parsed.searchParams.get("groupBy") === "workflowSlug") {
      return new Response(JSON.stringify({
        groups: (opts.brandCosts ?? []).map((g) => withNet(g as Record<string, unknown>)),
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

    // email-gateway BRAND-grain broadcast stats (GET /orgs/stats?groupBy=workflowSlug) — denominator of
    // the brand's own observed cost per outreach.
    if (parsed.pathname === "/orgs/stats" && parsed.searchParams.get("groupBy") === "workflowSlug") {
      return new Response(JSON.stringify({ groups: opts.brandEmailStats ?? [] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    // signups EXPECTED = clicks 5 * 0.08 (projection). ACTUAL = the REAL per-day conversion count from
    // lead-service (0 here — no tracked signups today), NOT clicks × rate.
    expect(today.metrics.signups).toEqual({ actual: 0, expected: 0.4, conversionPct: 8 });
    // this brand carries no visitToFormSubmissionPct → expected null; actual = the REAL observed count (0).
    expect(today.metrics.formSubmissions).toEqual({ actual: 0, expected: null, conversionPct: null });

    const tomorrow = res.body.days[1];
    expect(tomorrow.metrics.outreach).toEqual({ actual: null, expected: 10 });
    // future days keep the forecast in .expected; .actual is null (no observed conversions yet).
    expect(tomorrow.metrics.signups).toEqual({ actual: null, expected: 0.4, conversionPct: 8 });
    expect(tomorrow.metrics.formSubmissions).toEqual({ actual: null, expected: null, conversionPct: null });

    expect(res.body.summary).toEqual({
      dailyBudgetUsd: 50,
      openRatePct: 50,
      clickToSignupPct: 8,
      clickToFormSubmissionPct: null,
      undatedSignups: 0,
      undatedFormSubmissions: 0,
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
    expect(res.body.days[0].metrics.signups).toEqual({ actual: 0, expected: null, conversionPct: 8 });
    expect(res.body.summary.dailyBudgetUsd).toBeNull();
  });

  it("projects the form-submission EXPECTED off clicks, but takes .actual from real observed conversions", async () => {
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
    // EXPECTED (future forecast, also shown today) = clicks 5 × 0.15 = 0.75 (projection stays here).
    // ACTUAL = the REAL observed count (0 tracked form submissions), NOT clicks × 0.15.
    expect(today.metrics.formSubmissions).toEqual({ actual: 0, expected: 0.75, conversionPct: 15 });
    const tomorrow = res.body.days[1];
    expect(tomorrow.metrics.formSubmissions).toEqual({ actual: null, expected: 0.75, conversionPct: 15 });
    expect(res.body.summary.clickToFormSubmissionPct).toBe(15);
  });

  it("AC2: 0 real tracked form submissions → today's form-submission .actual is 0, never clicks × rate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    // A form brand (25% rate) with 5 clicks today: the OLD code fabricated actual = 5 × 0.25 = 1.25 ("1").
    // With 0 real tracked conversions the observed .actual must be 0.
    mockFetch({
      economics: { ...ECONOMICS, visitToFormSubmissionPct: 25 },
      dailyStats: [{ key: "2026-06-17", broadcast: { recipientStats: { contacted: 20, sent: 20, opened: 10, clicked: 5 } } }],
      conversionByDay: EMPTY_CONVERSION_BY_DAY,
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=UTC")
      .set(AUTH)
      .expect(200);

    const today = res.body.days[0];
    expect(today.metrics.clicks.actual).toBe(5); // real clicks today
    expect(today.metrics.formSubmissions.actual).toBe(0); // NOT 1.25 — coherent with revenue spend.formSubmissionsCount (0)
    expect(today.metrics.formSubmissions.expected).toBeGreaterThan(0); // projection lives only in .expected
    expect(res.body.summary.undatedFormSubmissions).toBe(0);
  });

  it("sources signup + form-submission .actual from the REAL per-day conversion counts (today), never clicks × rate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    // Only 1 click today, but 3 real tracked signups + 2 form submissions today → .actual is the REAL count,
    // proving it is NOT derived from clicks (clicks × any rate could never yield 3).
    mockFetch({
      economics: { ...ECONOMICS, visitToFormSubmissionPct: 15 },
      dailyStats: [{ key: "2026-06-17", broadcast: { recipientStats: { contacted: 2, sent: 2, opened: 1, clicked: 1 } } }],
      conversionByDay: {
        byDay: {
          signup: { "2026-06-17": 3, "2026-06-15": 9 },
          meeting_booked: {},
          form_submission: { "2026-06-17": 2 },
          sale: {},
        },
        undated: { signup: 1, meeting_booked: 0, form_submission: 4, sale: 0 },
      },
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=UTC")
      .set(AUTH)
      .expect(200);

    const today = res.body.days[0];
    expect(today.metrics.clicks.actual).toBe(1);
    // REAL observed today: 3 signups, 2 form submissions (a past day's 9 signups is NOT in the today+future range).
    expect(today.metrics.signups.actual).toBe(3);
    expect(today.metrics.formSubmissions.actual).toBe(2);
    // a per-day actual never exceeds the deduped attributed total (AC5): 3 <= 3+9+1 = 13.
    // projection still populates .expected.
    expect(today.metrics.signups.expected).toBeGreaterThan(0);
    // undated conversions are counted on the summary — never dropped, never assigned a fabricated day.
    expect(res.body.summary.undatedSignups).toBe(1);
    expect(res.body.summary.undatedFormSubmissions).toBe(4);
  });

  it("degrades signup/form-submission .actual to null (never a fabricated count) when lead-service is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
    mockFetch({
      economics: { ...ECONOMICS, visitToFormSubmissionPct: 15 },
      dailyStats: [{ key: "2026-06-17", broadcast: { recipientStats: { contacted: 2, sent: 2, opened: 1, clicked: 1 } } }],
      conversionByDayStatus: 500, // lead-service down → soft-degrade to absent
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&timezone=UTC")
      .set(AUTH)
      .expect(200); // graph still renders — conversion actual is display enrichment, not a 502

    const today = res.body.days[0];
    // observed series absent → .actual is null ("-"), NOT a fabricated clicks × rate. Forecast survives.
    expect(today.metrics.signups.actual).toBeNull();
    expect(today.metrics.formSubmissions.actual).toBeNull();
    expect(today.metrics.formSubmissions.expected).toBeGreaterThan(0);
    expect(today.metrics.clicks.actual).toBe(1); // outreach/opens/clicks actuals unchanged
    expect(res.body.summary.undatedSignups).toBeNull();
    expect(res.body.summary.undatedFormSubmissions).toBeNull();
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
    expect(res.body.days[0].metrics.signups).toEqual({ actual: 0, expected: 0.08, conversionPct: 8 });
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

  // ── EXPECTED outreach is floored at the brand's OWN cost per outreach ──────────────────────────
  //
  // Fleet benchmark across every case below: (100000/100)/200 = $5.00 per outreach, budget $50.
  // The brand's own ratio = its committed spend on this feature / the recipients it contacted.
  describe("expected outreach is reachable with the brand's own daily budget", () => {
    function brandEvidence(costCents: string, contacted: number) {
      return {
        brandCosts: [{ dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: costCents, runCount: 1 }],
        brandEmailStats: [
          { key: "wf-a", broadcast: { recipientStats: { contacted, clicked: 0, repliesPositive: 0 } } },
        ],
      };
    }

    it("floors the divisor at the brand's own cost per outreach when it is WORSE than the fleet best", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      // brand: $40 committed over 4 contacted = $10/outreach, 2x the $5 fleet benchmark.
      mockFetch(brandEvidence("4000", 4));

      const res = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
        .set(AUTH)
        .expect(200);

      // $50 budget / $10 own cost = 5 sends — NOT the 10 the fleet benchmark would promise.
      expect(res.body.days[0].metrics.outreach.expected).toBe(5);
      // AC4: the derived series fall proportionally (best audience aud-a: 0.5 open, 0.5 click).
      expect(res.body.days[0].metrics.opens.expected).toBe(2.5);
      expect(res.body.days[0].metrics.clicks.expected).toBe(2.5);
      expect(res.body.days[0].metrics.signups.expected).toBeCloseTo(0.2, 10);
      // Every future day carries the same corrected forecast.
      expect(res.body.days[6].metrics.outreach.expected).toBe(5);
    });

    it("keeps the fleet best when the brand's own cost per outreach is BETTER (the floor is a max, never a raise)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      // brand: $4 committed over 4 contacted = $1/outreach, well under the $5 benchmark.
      mockFetch(brandEvidence("400", 4));

      const res = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
        .set(AUTH)
        .expect(200);

      // max($5, $1) = $5 → 10 sends. The floor must never push the count ABOVE the benchmark.
      expect(res.body.days[0].metrics.outreach.expected).toBe(10);
      expect(res.body.days[0].metrics.opens.expected).toBe(5);
      expect(res.body.days[0].metrics.clicks.expected).toBe(5);
    });

    it("uses the fleet best unchanged when the brand has no own ratio (no spend, or nobody contacted)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      // Spend but ZERO contacted → no denominator → no own ratio.
      mockFetch(brandEvidence("4000", 0));

      const noContacted = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
        .set(AUTH)
        .expect(200);
      expect(noContacted.body.days[0].metrics.outreach.expected).toBe(10);

      // Contacted but ZERO attributed spend (a fresh brand) → no numerator → no own ratio.
      mockFetch(brandEvidence("0", 40));

      const noSpend = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
        .set(AUTH)
        .expect(200);
      expect(noSpend.body.days[0].metrics.outreach.expected).toBe(10);
    });

    it("reads the brand's own evidence brand-scoped and feature-scoped (never the fleet-wide figures)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      mockFetch(brandEvidence("4000", 4));

      await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
        .set(AUTH)
        .expect(200);

      const costCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) => {
        const callUrl = new URL(String(input));
        return callUrl.pathname === "/v1/stats/costs" && callUrl.searchParams.get("groupBy") === "workflowSlug";
      });
      expect(costCall).toBeTruthy();
      const costUrl = new URL(String(costCall?.[0]));
      expect(costUrl.searchParams.get("brandId")).toBe("brand-1");
      expect(costUrl.searchParams.get("featureSlugs")).toBe("sales-cold-email-outreach");

      const statsCall = vi.mocked(fetchWithRetry).mock.calls.find(([input]) => {
        const callUrl = new URL(String(input));
        return callUrl.pathname === "/orgs/stats" && callUrl.searchParams.get("groupBy") === "workflowSlug";
      });
      expect(statsCall).toBeTruthy();
      const statsUrl = new URL(String(statsCall?.[0]));
      expect(statsUrl.searchParams.get("type")).toBe("broadcast");
      expect(statsUrl.searchParams.get("brandId")).toBe("brand-1");
      expect(statsUrl.searchParams.get("featureSlugs")).toBe("sales-cold-email-outreach");
    });
  });

  // ── ?pricing=gross|net ────────────────────────────────────────────────────────────────────────
  //
  // The forecast divides REAL money (the daily budget) by a cost per outreach. For an org carrying a
  // usage discount, reading that cost at FULL price makes the promise ~half the volume the budget
  // actually buys — the bar sits at half the height of the real bars beside it. NET reads runs#179's
  // frozen net twins so the divisor is priced at what the org pays.
  //
  // Fleet benchmark: (100000/100)/200 = $5.00/outreach gross. Budget $50.
  describe("?pricing=gross|net", () => {
    function brandEvidence(costCents: string, contacted: number) {
      return {
        brandCosts: [{ dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: costCents, runCount: 1 }],
        brandEmailStats: [
          { key: "wf-a", broadcast: { recipientStats: { contacted, clicked: 0, repliesPositive: 0 } } },
        ],
      };
    }

    it("omitting the selector keeps today's full-price answer, even when the net twins are on the wire", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      // brand: $40 gross over 4 contacted = $10/outreach (the floor wins over the $5 fleet benchmark).
      mockFetch({ ...brandEvidence("4000", 4), netDiscountPct: 50 });

      const res = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York")
        .set(AUTH)
        .expect(200);

      expect(res.body.days[0].metrics.outreach.expected).toBe(5);
    });

    it("net prices the divisor at what the org actually pays, so the promise matches the real volume", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      mockFetch({ ...brandEvidence("4000", 4), netDiscountPct: 50 });

      const res = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York&pricing=net")
        .set(AUTH)
        .expect(200);

      // net fleet = $2.50, net own = $2000/100/4 = $5 → max $5 → $50 budget buys 10 sends (2x the
      // full-price 5 — exactly this org's net/gross ratio, the prod symptom).
      expect(res.body.days[0].metrics.outreach.expected).toBe(10);
      // The derived series follow the corrected volume; the rates themselves never move.
      expect(res.body.days[0].metrics.opens.expected).toBe(5);
      expect(res.body.days[0].metrics.clicks.expected).toBe(5);
      // Every future day carries it, and the BUDGET itself is untouched (a ceiling is never discounted).
      expect(res.body.days[6].metrics.outreach.expected).toBe(10);
      expect(res.body.summary.dailyBudgetUsd).toBe(50);
    });

    it("floors BOTH sides on the requested basis — never a net figure against a full-price one", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      // brand: $32 gross over 4 = $8/outreach gross, $4/outreach net. Fleet: $5 gross, $2.50 net.
      // Correct net answer floors at max($2.50, $4) = $4 → 12.5 sends. Comparing the brand's NET $4
      // against the fleet's GROSS $5 would pick $5 and answer 10 — a units mismatch, not a floor.
      mockFetch({ ...brandEvidence("3200", 4), netDiscountPct: 50 });

      const res = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York&pricing=net")
        .set(AUTH)
        .expect(200);

      expect(res.body.days[0].metrics.outreach.expected).toBe(12.5);
    });

    it("gives a non-discounted org identical numbers either way (its frozen net equals its gross)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      mockFetch({ ...brandEvidence("4000", 4), netDiscountPct: 0 });

      const gross = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York&pricing=gross")
        .set(AUTH)
        .expect(200);
      const net = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York&pricing=net")
        .set(AUTH)
        .expect(200);

      expect(net.body.days[0].metrics.outreach.expected).toBe(gross.body.days[0].metrics.outreach.expected);
      expect(net.body.days[0].metrics.outreach.expected).toBe(5);
    });

    it("fails loud on net when the frozen net figure is absent — never a silent fallback to full price", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T14:30:00.000Z"));
      // No netDiscountPct → the cost groups carry gross only (a runs-service predating #179).
      mockFetch(brandEvidence("4000", 4));

      await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York&pricing=net")
        .set(AUTH)
        .expect(502);
    });

    it("400s an unknown pricing value (no coercion, no silent default)", async () => {
      mockFetch();

      const res = await request(app)
        .get("/features/sales-cold-email-outreach/pipeline-activity?brandId=brand-1&days=7&timezone=America/New_York&pricing=discounted")
        .set(AUTH)
        .expect(400);

      expect(res.body.error).toMatch(/pricing/);
    });
  });
});
