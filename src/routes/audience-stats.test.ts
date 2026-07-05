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
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
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

const FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales",
  description: "x",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function costGroup(audienceId: string | null, cents: number, runCount = 1): Record<string, unknown> {
  return {
    dimensions: { audienceId },
    totalCostInUsdCents: String(cents),
    runCount,
    minStartedAt: "2026-01-01T00:00:00Z",
    maxStartedAt: "2026-01-02T00:00:00Z",
  };
}

const mkEmails = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const EMAILS_A = mkEmails("a", 10);
const EMAILS_B = mkEmails("b", 20);
const EMAILS_C = mkEmails("c", 15);
const POSITIVE = new Set([...EMAILS_A.slice(0, 2), ...EMAILS_B.slice(0, 5)]);

function membersResponse(emails: string[]): Response {
  return new Response(
    JSON.stringify({ members: emails.map((e) => ({ emailNorm: e })), total: emails.length, limit: 500, offset: 0 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
}

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = urlOf(input);

    if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
    if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
    if (url.includes("human:3000/orgs/audiences")) {
      return new Response(JSON.stringify({
        audiences: [
          { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: { seniorities: ["c_suite"] } },
          { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: { titles: ["founder"] } },
        ],
        total: 2,
        limit: 200,
        offset: 0,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
      return new Response(JSON.stringify({
        current: { id: "brand-profile-1", brandId: "brand-1", version: 3, fields: {}, createdAt: "2026-01-01T00:00:00Z" },
        versions: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("runs:3000/v1/stats/costs")) {
      return new Response(JSON.stringify({
        groups: [
          costGroup("audience-a", 3000, 3),
          costGroup("audience-b", 1000, 2),
          costGroup("unknown-audience", 200, 1),
          costGroup(null, 9000, 9),
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("email:3000/orgs/status")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
      const results = body.items.map(({ email }) => ({
        email,
        broadcast: {
          brand: {
            contacted: true,
            opened: true,
            clicked: true,
            replied: POSITIVE.has(email),
            replyClassification: POSITIVE.has(email) ? "positive" : null,
          },
        },
      }));
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

// Status-aware audiences mock: human-service GET /orgs/audiences?status=<s> returns
// only that status's audiences (one audience per status: a=active, b=paused, c=archived).
function mockFetchByStatus(): ReturnType<typeof vi.spyOn> {
  const BY_STATUS: Record<string, Array<Record<string, unknown>>> = {
    active: [{ id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: { seniorities: ["c_suite"] } }],
    paused: [{ id: "audience-b", brandId: "brand-1", name: "Founders", status: "paused", filters: { titles: ["founder"] } }],
    archived: [{ id: "audience-c", brandId: "brand-1", name: "Legacy", status: "archived", filters: null }],
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = urlOf(input);

    if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
    if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
    if (url.includes("human:3000/orgs/audiences/audience-c/members")) return membersResponse(EMAILS_C);
    if (url.includes("human:3000/orgs/audiences?")) {
      const status = new URL(url).searchParams.get("status") ?? "active";
      return new Response(JSON.stringify({ audiences: BY_STATUS[status] ?? [], total: 1, limit: 200, offset: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
      return new Response(JSON.stringify({
        current: { id: "brand-profile-1", brandId: "brand-1", version: 3, fields: {}, createdAt: "2026-01-01T00:00:00Z" },
        versions: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("runs:3000/v1/stats/costs")) {
      return new Response(JSON.stringify({
        groups: [costGroup("audience-a", 3000, 3), costGroup("audience-b", 1000, 2), costGroup("audience-c", 5000, 8)],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("email:3000/orgs/status")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
      const results = body.items.map(({ email }) => ({
        email,
        broadcast: {
          brand: {
            contacted: true,
            opened: true,
            clicked: true,
            replied: POSITIVE.has(email),
            replyClassification: POSITIVE.has(email) ? "positive" : null,
          },
        },
      }));
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("GET /features/:featureSlug/audience-stats", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("400 when brandId or goal is missing or limit is invalid", async () => {
    let res = await request(app).get("/features/sales-cold-email-outreach/audience-stats?goal=signup").set(AUTH);
    expect(res.status).toBe(400);

    res = await request(app).get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1").set(AUTH);
    expect(res.status).toBe(400);

    res = await request(app).get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&limit=1abc").set(AUTH);
    expect(res.status).toBe(400);
  });

  it("returns rows under `audiences` with each block under `audience` and no persona keys", async () => {
    fetchSpy = mockFetch();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sortMetric).toBe("cpc");
    expect(res.body.brandProfileId).toBe("brand-profile-1");
    // audience-named response shape — no legacy persona keys.
    expect(res.body.personas).toBeUndefined();
    expect(Array.isArray(res.body.audiences)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.persona === undefined)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.audience !== undefined)).toBe(true);
    expect(res.body.audiences.map((r: any) => r.audienceId)).toEqual(["audience-b", "audience-a"]);
    expect(res.body.audiences).toHaveLength(2);
    expect(res.body.audiences[0].audience.name).toBe("Founders");
    expect(res.body.audiences[0].evidence).toMatchObject({
      totalCostInUsdCents: 1000,
      completedRuns: 2,
      contacted: 20,
      opened: 20,
      websiteClicks: 20,
      positiveReplies: 5,
    });
    expect(res.body.audiences[0].metrics.cpcCents).toBe(50);
    expect(res.body.audiences[1].metrics.cpcCents).toBe(300);
    // cost fetch groups by audienceId.
    const costUrl = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).find((u: string) => u.includes("runs:3000"));
    expect(costUrl).toContain("groupBy=audienceId");
    expect(costUrl).not.toContain("goal=");
  });

  it("sorts sales-meeting audiences by CPPR using read-time membership evidence", async () => {
    fetchSpy = mockFetch();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=meetingBooked")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.sortMetric).toBe("cppr");
    expect(res.body.audiences.map((r: any) => r.audienceId)).toEqual(["audience-b", "audience-a"]);
    expect(res.body.audiences[0].metrics.cpprCents).toBe(200);
    expect(res.body.audiences[1].metrics.cpprCents).toBe(1500);
  });

  it("goal=websiteVisit sorts by CPC (visit is the outcome proxy) and echoes the goal", async () => {
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("websiteVisit");
    expect(res.body.sortMetric).toBe("cpc");
  });

  it("goal=positiveReply sorts by CPPR; snake_case (positive_replies) is accepted", async () => {
    fetchSpy = mockFetch();
    const camel = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=positiveReply")
      .set(AUTH);
    expect(camel.status).toBe(200);
    expect(camel.body.sortMetric).toBe("cppr");
    fetchSpy = mockFetch();
    const snake = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=positive_replies")
      .set(AUTH);
    expect(snake.status).toBe(200);
    expect(snake.body.goal).toBe("positiveReply"); // normalised to canonical camel
    expect(snake.body.sortMetric).toBe("cppr");
  });

  it("uses explicit brandProfileId and respects limit", async () => {
    fetchSpy = mockFetch();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&brandProfileId=brand-profile-explicit&limit=1")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.brandProfileId).toBe("brand-profile-explicit");
    expect(res.body.audiences).toHaveLength(1);
    const urls: string[] = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0]));
    expect(urls.some((url) => url.includes("/brand-profile"))).toBe(false);
    // Cost NUMERATOR is attributed by audienceId only — never filtered by goal/brandProfileId
    // (those dims are untagged on runs/cost rows, so filtering would drop every real cost row).
    const costUrl = urls.find((url) => url.includes("runs:3000")) ?? "";
    expect(costUrl).toContain("groupBy=audienceId");
    expect(costUrl).not.toContain("brandProfileId");
    expect(costUrl).not.toContain("goal=");
  });

  it("400 when statuses contains a token outside {active,paused,archived}", async () => {
    let res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&statuses=active,suggested")
      .set(AUTH);
    expect(res.status).toBe(400);

    res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&statuses=deprecated")
      .set(AUTH);
    expect(res.status).toBe(400);

    res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&statuses=")
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it("absent statuses fetches active only (one human-service call, status=active)", async () => {
    fetchSpy = mockFetchByStatus();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.audiences.map((r: any) => r.audienceId).sort()).toEqual(["audience-a"]);
    const audienceListCalls = fetchSpy.mock.calls
      .map((c: any[]) => urlOf(c[0]))
      .filter((u: string) => u.includes("human:3000/orgs/audiences?"));
    expect(audienceListCalls).toHaveLength(1);
    expect(audienceListCalls[0]).toContain("status=active");
  });

  it("statuses=active,paused,archived returns rows for archived audiences with evidence", async () => {
    fetchSpy = mockFetchByStatus();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&statuses=active,paused,archived")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // archived audience-c surfaces with its historical run/email evidence.
    expect(byId["audience-c"]).toBeDefined();
    expect(byId["audience-c"].audience.status).toBe("archived");
    expect(byId["audience-c"].evidence.totalCostInUsdCents).toBe(5000);
    expect(byId["audience-c"].evidence.contacted).toBeGreaterThan(0);
    expect(byId["audience-c"].metrics.cpcCents).not.toBeNull();
    // active + paused also present.
    expect(byId["audience-a"]).toBeDefined();
    expect(byId["audience-b"].audience.status).toBe("paused");
    // one human-service audiences call per requested status.
    const audienceListCalls = fetchSpy.mock.calls
      .map((c: any[]) => urlOf(c[0]))
      .filter((u: string) => u.includes("human:3000/orgs/audiences?"));
    expect(audienceListCalls).toHaveLength(3);
    expect(audienceListCalls.some((u: string) => u.includes("status=archived"))).toBe(true);
  });

  it("returns null CPC (not a false $0.00) when an audience has clicks but no attributed spend", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences")) {
        return new Response(JSON.stringify({
          audiences: [
            { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: null },
            { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: null },
          ],
          total: 2, limit: 200, offset: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
        return new Response(JSON.stringify({ current: null, versions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("runs:3000/v1/stats/costs")) {
        // audience-a has NO cost row (no attributed spend); audience-b has real spend.
        return new Response(JSON.stringify({ groups: [costGroup("audience-b", 1000, 2)] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/status")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
        // Everyone clicked — so audience-a has clicks but zero attributed cost.
        const results = body.items.map(({ email }) => ({
          email,
          broadcast: { brand: { contacted: true, opened: true, clicked: true, replied: false, replyClassification: null } },
        }));
        return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // audience-a: clicks > 0 but no attributed spend → CPC null (renders "-"), NOT $0.00.
    expect(byId["audience-a"].evidence.websiteClicks).toBeGreaterThan(0);
    expect(byId["audience-a"].evidence.totalCostInUsdCents).toBe(0);
    expect(byId["audience-a"].metrics.cpcCents).toBeNull();
    // audience-b: real spend → real CPC, and sorts ahead of the null-CPC audience.
    expect(byId["audience-b"].metrics.cpcCents).toBe(50);
    expect(res.body.audiences[0].audienceId).toBe("audience-b");
  });
});
