import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
  },
  sql: {},
}));

vi.mock("../lib/env.js", () => ({
  validateRequiredEnv: vi.fn(),
  REQUIRED_ENV: [],
}));

vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.OUTLETS_SERVICE_URL = "http://outlets:3000";
process.env.OUTLETS_SERVICE_API_KEY = "outlets-key";
process.env.PRESS_KITS_SERVICE_URL = "http://press-kits:3000";
process.env.PRESS_KITS_SERVICE_API_KEY = "press-kits-key";
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
process.env.JOURNALISTS_SERVICE_URL = "http://journalists:3000";
process.env.JOURNALISTS_SERVICE_API_KEY = "journalists-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const MOCK_FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales Cold Email Outreach",
  description: "test",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("GET /features/:featureSlug/stats — network error resilience", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE as any]);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("returns 200 with zeroed stats when all downstream services throw ECONNRESET", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
    );

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.featureSlug).toBe("sales-cold-email-outreach");
    expect(res.body.systemStats.completedRuns).toBe(0);
    expect(res.body.systemStats.totalCostInUsdCents).toBe(0);
  });

  it("returns 200 on global /stats when downstream services throw network errors", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
    );

    const res = await request(app)
      .get("/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.systemStats.completedRuns).toBe(0);
    expect(res.body.systemStats.totalCostInUsdCents).toBe(0);
  });

  it("returns partial data when only some downstream services fail", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;

      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [{
            dimensions: { workflowSlug: "__total__" },
            totalCostInUsdCents: "1500",
            runCount: 10,
            minStartedAt: "2026-01-01T00:00:00Z",
            maxStartedAt: "2026-03-01T00:00:00Z",
          }],
        }), { status: 200 });
      }

      throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.systemStats.completedRuns).toBe(10);
    expect(res.body.systemStats.totalCostInUsdCents).toBe(1500);
  });
});

describe("GET /features/:featureSlug/stats — feature scoping", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE as any]);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("passes featureSlug to all downstream services", async () => {
    const urls: string[] = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      urls.push(url);

      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [{
            dimensions: { workflowSlug: "__total__" },
            totalCostInUsdCents: "0",
            runCount: 0,
            minStartedAt: null,
            maxStartedAt: null,
          }],
        }), { status: 200 });
      }
      if (url.includes("email:3000")) {
        return new Response(JSON.stringify({ broadcast: {}, transactional: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await request(app)
      .get("/features/sales-cold-email-outreach/stats?brandId=brand-1")
      .set(AUTH_HEADERS);

    const httpUrls = urls.filter((u) => u.startsWith("http") && !u.includes("/events"));
    expect(httpUrls.length).toBeGreaterThan(0);
    for (const url of httpUrls) {
      const parsed = new URL(url);
      if (url.includes("email:3000")) {
        // email-gateway expects featureSlugs (plural)
        expect(parsed.searchParams.get("featureSlugs")).toBe("sales-cold-email-outreach");
        expect(parsed.searchParams.get("featureSlug")).toBeNull();
      } else if (url.includes("runs:3000/v1/stats/costs")) {
        // runs-service: GET takes the lineage CSV via featureSlugs; POST carries
        // it in the body (no query string), so any URL with no query is fine.
        if (parsed.search) {
          expect(parsed.searchParams.get("featureSlugs")).toBe("sales-cold-email-outreach");
          expect(parsed.searchParams.get("featureSlug")).toBeNull();
        }
      } else {
        expect(parsed.searchParams.get("featureSlug")).toBe("sales-cold-email-outreach");
      }
    }
  });
});

describe("GET /features/:featureSlug/stats — fetchLeadsStats mapping", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const LEAD_STATS_BLOCK = {
    totalLeads: 100,
    byOutreachStatus: {
      contacted: 80,
      sent: 75,
      delivered: 70,
      opened: 50,
      bounced: 5,
      clicked: 30,
      unsubscribed: 2,
      repliesPositive: 10,
      repliesNegative: 4,
      repliesNeutral: 6,
      repliesAutoReply: 3,
      repliesDetail: { interested: 6, meetingBooked: 2, closed: 1, notInterested: 3, wrongPerson: 1, unsubscribe: 0, neutral: 4, autoReply: 3, outOfOffice: 2 },
    },
    repliesDetail: { interested: 6, meetingBooked: 2, closed: 1, notInterested: 3, wrongPerson: 1, unsubscribe: 0, neutral: 4, autoReply: 3, outOfOffice: 2 },
    buffered: 15,
    skipped: 8,
    claimed: 90,
  };

  const FAKE_RUNS_RESPONSE = {
    groups: [{
      dimensions: { workflowSlug: "__total__" },
      totalCostInUsdCents: "1000",
      runCount: 5,
      minStartedAt: "2026-01-01T00:00:00Z",
      maxStartedAt: "2026-03-01T00:00:00Z",
    }],
  };

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(MOCK_FEATURE as any);
    vi.mocked(db.query.features.findMany).mockResolvedValue([MOCK_FEATURE as any]);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("flat: maps every lead-service /orgs/stats field to leads* registry keys", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      if (url.includes("leads:3000")) return new Response(JSON.stringify(LEAD_STATS_BLOCK), { status: 200 });
      if (url.includes("runs:3000")) return new Response(JSON.stringify(FAKE_RUNS_RESPONSE), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    const s = res.body.stats;
    expect(s.leadsServed).toBe(100);
    expect(s.leadsContacted).toBe(80);
    expect(s.leadsSent).toBe(75);
    expect(s.leadsDelivered).toBe(70);
    expect(s.leadsOpened).toBe(50);
    expect(s.leadsClicked).toBe(30);
    expect(s.leadsBounced).toBe(5);
    expect(s.leadsUnsubscribed).toBe(2);
    expect(s.leadsRepliesPositive).toBe(10);
    expect(s.leadsRepliesNegative).toBe(4);
    expect(s.leadsRepliesNeutral).toBe(6);
    expect(s.leadsRepliesAutoReply).toBe(3);
    expect(s.leadsRepliesInterested).toBe(6);
    expect(s.leadsRepliesMeetingBooked).toBe(2);
    expect(s.leadsRepliesClosed).toBe(1);
    expect(s.leadsRepliesNotInterested).toBe(3);
    expect(s.leadsRepliesWrongPerson).toBe(1);
    expect(s.leadsRepliesUnsubscribeDetail).toBe(0);
    expect(s.leadsRepliesNeutralDetail).toBe(4);
    expect(s.leadsRepliesAutoReplyDetail).toBe(3);
    expect(s.leadsRepliesOutOfOffice).toBe(2);
    expect(s.leadsBuffered).toBe(15);
    expect(s.leadsSkipped).toBe(8);
    expect(s.leadsClaimed).toBe(90);

    // Derived rates: leadsOpened / leadsDelivered = 50/70
    expect(s.leadOpenRate).toBeCloseTo(50 / 70);
    expect(s.leadClickRate).toBeCloseTo(30 / 70);
    expect(s.leadPositiveReplyRate).toBeCloseTo(10 / 70);
    // Cost-per: 1000 / 50, 1000 / 30, 1000 / 10
    expect(s.costPerLeadOpenCents).toBeCloseTo(1000 / 50);
    expect(s.costPerLeadClickCents).toBeCloseTo(1000 / 30);
    expect(s.costPerLeadPositiveReplyCents).toBeCloseTo(1000 / 10);
  });

  it("grouped: maps every leads* field per group", async () => {
    const groupedResponse = {
      groups: [
        { key: "campaign-a", ...LEAD_STATS_BLOCK },
        { key: "campaign-b", ...LEAD_STATS_BLOCK, totalLeads: 50, buffered: 7 },
      ],
    };
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      if (url.includes("leads:3000")) return new Response(JSON.stringify(groupedResponse), { status: 200 });
      if (url.includes("runs:3000")) {
        return new Response(JSON.stringify({
          groups: [
            { dimensions: { campaignId: "campaign-a" }, totalCostInUsdCents: "500", runCount: 2, minStartedAt: null, maxStartedAt: null },
            { dimensions: { campaignId: "campaign-b" }, totalCostInUsdCents: "300", runCount: 1, minStartedAt: null, maxStartedAt: null },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/stats?groupBy=campaignId")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    const a = res.body.groups.find((g: any) => g.campaignId === "campaign-a");
    const b = res.body.groups.find((g: any) => g.campaignId === "campaign-b");
    expect(a.stats.leadsServed).toBe(100);
    expect(a.stats.leadsContacted).toBe(80);
    expect(a.stats.leadsRepliesInterested).toBe(6);
    expect(a.stats.leadsBuffered).toBe(15);
    expect(b.stats.leadsServed).toBe(50);
    expect(b.stats.leadsBuffered).toBe(7);
  });
});

describe("GET /entities/registry", () => {
  // Every entity name referenced by seed features and dashboard campaign route folders.
  const REQUIRED_ENTITY_KEYS = [
    "leads",
    "companies",
    "emails",
    "outlets",
    "journalists",
    "articles",
    "press-kits",
    "prompts",
    "competitors",
    "visibility-runs",
    "quote-requests",
    "quote-pitches",
  ];

  // Icon names must match keys in dashboard ICON_MAP (apps/dashboard/src/components/campaign-sidebar.tsx).
  const EXPECTED_ICONS: Record<string, string> = {
    leads: "users",
    companies: "building",
    emails: "envelope",
    outlets: "newspaper",
    journalists: "pen-tool",
    articles: "scroll-text",
    "press-kits": "document",
    prompts: "message-square",
    competitors: "swords",
    "visibility-runs": "sparkles",
    "quote-requests": "help-circle",
    "quote-pitches": "quote",
  };

  // pathSuffix must match dashboard campaign route folder names.
  const EXPECTED_PATH_SUFFIXES: Record<string, string> = {
    leads: "leads",
    companies: "companies",
    emails: "emails",
    outlets: "outlets",
    journalists: "journalists",
    articles: "articles",
    "press-kits": "press-kits",
    prompts: "prompts",
    competitors: "competitors",
    "visibility-runs": "visibility-runs",
    "quote-requests": "quote-requests",
    "quote-pitches": "quote-pitches",
  };

  it("returns 200 with registry containing every required entity key", async () => {
    const res = await request(app)
      .get("/entities/registry")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.registry).toBeDefined();

    const reg = res.body.registry;
    for (const key of REQUIRED_ENTITY_KEYS) {
      expect(reg[key], `missing entity registry entry: ${key}`).toBeDefined();
    }
  });

  it("each entry has non-empty label/icon/pathSuffix/description", async () => {
    const res = await request(app)
      .get("/entities/registry")
      .set(AUTH_HEADERS);

    const reg = res.body.registry;
    for (const [, def] of Object.entries(reg) as [string, Record<string, string>][]) {
      expect(def.label).toBeTruthy();
      expect(def.icon).toBeTruthy();
      expect(def.pathSuffix).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  it("icons match dashboard ICON_MAP keys", async () => {
    const res = await request(app)
      .get("/entities/registry")
      .set(AUTH_HEADERS);

    const reg = res.body.registry;
    for (const [key, expectedIcon] of Object.entries(EXPECTED_ICONS)) {
      expect(reg[key]?.icon, `entity ${key} icon`).toBe(expectedIcon);
    }
  });

  it("pathSuffix matches dashboard campaign route folder names", async () => {
    const res = await request(app)
      .get("/entities/registry")
      .set(AUTH_HEADERS);

    const reg = res.body.registry;
    for (const [key, expectedSuffix] of Object.entries(EXPECTED_PATH_SUFFIXES)) {
      expect(reg[key]?.pathSuffix, `entity ${key} pathSuffix`).toBe(expectedSuffix);
    }
  });

  it("rejects requests without API key", async () => {
    const res = await request(app).get("/entities/registry");
    expect(res.status).toBe(401);
  });
});
