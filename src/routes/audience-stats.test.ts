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
process.env.FEATURE_VIEW_CACHE_ENABLED = "false"; // exercise the pure live-compute path here

process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
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

// `netCents` = runs#179's FROZEN net twin (defaults to gross == a non-discounted org). Pass a distinct
// value to model a frozen per-row discount; features-service reads it verbatim (no read-time multiply).
function costGroup(audienceId: string | null, cents: number, runCount = 1, netCents = cents): Record<string, unknown> {
  return {
    dimensions: { audienceId },
    totalCostInUsdCents: String(cents),
    netTotalCostInUsdCents: String(netCents),
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
      // Each group carries the gross cents + a frozen NET twin (here net = gross halved → models a 50%
      // frozen usage discount). GROSS reads totalCostInUsdCents; NET reads netTotalCostInUsdCents.
      return new Response(JSON.stringify({
        groups: [
          costGroup("audience-a", 3000, 3, 1500),
          costGroup("audience-b", 1000, 2, 500),
          costGroup("unknown-audience", 200, 1, 100),
          costGroup(null, 9000, 9, 4500),
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

  it("400 on an invalid pricing value", async () => {
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&pricing=NET")
      .set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pricing/);
  });

  it("pricing=gross returns the SAME numbers as omitting the selector (default is gross)", async () => {
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&pricing=gross")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.audiences[0].metrics.cpcCents).toBe(50);
    expect(res.body.audiences[1].metrics.cpcCents).toBe(300);
    expect(res.body.audiences[1].evidence.totalCostInUsdCents).toBe(3000);
    // GROSS never calls billing.
    const billed = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).some((u: string) => u.includes("usage-discount"));
    expect(billed).toBe(false);
  });

  it("pricing=net reads runs' FROZEN net cents (no billing call, no read-time multiply); counts/rate unchanged", async () => {
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&pricing=net")
      .set(AUTH);
    expect(res.status).toBe(200);
    // cpc reads the frozen net twin (net = gross/2 here): b 500 /20 = 25; a 1500 /10 = 150.
    expect(res.body.audiences[0].metrics.cpcCents).toBe(25);
    expect(res.body.audiences[1].metrics.cpcCents).toBe(150);
    // $ evidence is the frozen net; the non-money counts are identical to gross.
    expect(res.body.audiences[1].evidence.totalCostInUsdCents).toBe(1500);
    expect(res.body.audiences[1].evidence.websiteClicks).toBe(10);
    expect(res.body.audiences[0].evidence.contacted).toBe(20);
    // NET no longer touches billing — it reads runs' frozen net field.
    const billed = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).some((u: string) => u.includes("usage-discount"));
    expect(billed).toBe(false);
  });

  it("pricing=net fails loud (502) when runs omits the frozen net twin — never silently gross", async () => {
    // runs WITHOUT #179 → cost groups carry only the gross field, no netTotalCostInUsdCents.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences")) {
        return new Response(JSON.stringify({
          audiences: [
            { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: { seniorities: ["c_suite"] } },
            { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: { titles: ["founder"] } },
          ],
          total: 2, limit: 200, offset: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
        return new Response(JSON.stringify({ current: { id: "bp-1", brandId: "brand-1", version: 3, fields: {}, createdAt: "2026-01-01T00:00:00Z" }, versions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("runs:3000/v1/stats/costs")) {
        // gross-only groups (no net twin).
        return new Response(JSON.stringify({ groups: [
          { dimensions: { audienceId: "audience-a" }, totalCostInUsdCents: "3000", runCount: 3, minStartedAt: null, maxStartedAt: null },
          { dimensions: { audienceId: "audience-b" }, totalCostInUsdCents: "1000", runCount: 2, minStartedAt: null, maxStartedAt: null },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/status")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
        return new Response(JSON.stringify({ results: body.items.map(({ email }) => ({ email, broadcast: { brand: { contacted: true, opened: true, clicked: true, replied: false, replyClassification: null } } })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup&pricing=net")
      .set(AUTH);
    expect(res.status).toBe(502);
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

  it("goal=formSubmission attributes real per-audience form submissions via membership ∩ matched-lead emails", async () => {
    // conversion emails (matched-lead canonical, lowercased) — a1,a3 in audience-a; b2 in audience-b.
    const CONVERSION_EMAILS = ["a1", "a3", "b2"];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
      if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) {
        expect(new URL(url).searchParams.get("event")).toBe("form_submission");
        return new Response(JSON.stringify({ emails: CONVERSION_EMAILS }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences")) {
        return new Response(JSON.stringify({
          audiences: [
            { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: { seniorities: ["c_suite"] } },
            { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: { titles: ["founder"] } },
          ],
          total: 2, limit: 200, offset: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
        return new Response(JSON.stringify({ current: { id: "brand-profile-1", brandId: "brand-1", version: 3, fields: {}, createdAt: "2026-01-01T00:00:00Z" }, versions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("runs:3000/v1/stats/costs")) {
        return new Response(JSON.stringify({ groups: [costGroup("audience-a", 3000, 3), costGroup("audience-b", 1000, 2)] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/status")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
        const results = body.items.map(({ email }) => ({ email, broadcast: { brand: { contacted: true, opened: true, clicked: true, replied: POSITIVE.has(email), replyClassification: POSITIVE.has(email) ? "positive" : null } } }));
        return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as ReturnType<typeof vi.spyOn>;

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=formSubmission")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("formSubmission");
    expect(res.body.sortMetric).toBe("cpc"); // form_submissions is visit-driven → ranks on cpc, not cpfs.
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // audience-a: 2 members converted (a1,a3), spend 3000 → cpfs 1500. audience-b: 1 (b2), spend 1000 → cpfs 1000.
    expect(byId["audience-a"].evidence.formSubmissions).toBe(2);
    expect(byId["audience-a"].metrics.cpfsCents).toBe(1500);
    expect(byId["audience-b"].evidence.formSubmissions).toBe(1);
    expect(byId["audience-b"].metrics.cpfsCents).toBe(1000);
  });

  it("goal=formSubmission degrades to absent form submissions (null cpfs, never $0) when lead-service is unavailable", async () => {
    // Default mock returns {} for converted-lead-emails → client throws → soft-degrades to absent.
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=formSubmission")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.audiences.every((r: any) => r.evidence.formSubmissions === undefined)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.metrics.cpfsCents === null)).toBe(true);
  });

  it("goal=signup attributes real per-audience signups via membership ∩ matched-lead emails", async () => {
    // conversion emails (matched-lead canonical, lowercased) — a1,a3 in audience-a; b2 in audience-b.
    const CONVERSION_EMAILS = ["a1", "a3", "b2"];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
      if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) {
        expect(new URL(url).searchParams.get("event")).toBe("signup");
        return new Response(JSON.stringify({ emails: CONVERSION_EMAILS }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences")) {
        return new Response(JSON.stringify({
          audiences: [
            { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: { seniorities: ["c_suite"] } },
            { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: { titles: ["founder"] } },
          ],
          total: 2, limit: 200, offset: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
        return new Response(JSON.stringify({ current: { id: "brand-profile-1", brandId: "brand-1", version: 3, fields: {}, createdAt: "2026-01-01T00:00:00Z" }, versions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("runs:3000/v1/stats/costs")) {
        return new Response(JSON.stringify({ groups: [costGroup("audience-a", 3000, 3), costGroup("audience-b", 1000, 2)] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/status")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
        const results = body.items.map(({ email }) => ({ email, broadcast: { brand: { contacted: true, opened: true, clicked: true, replied: POSITIVE.has(email), replyClassification: POSITIVE.has(email) ? "positive" : null } } }));
        return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as ReturnType<typeof vi.spyOn>;

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("signup");
    expect(res.body.sortMetric).toBe("cpc"); // signup is visit-driven → ranks on cpc, not cps.
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // audience-a: 2 members converted (a1,a3), spend 3000 → cps 1500. audience-b: 1 (b2), spend 1000 → cps 1000.
    expect(byId["audience-a"].evidence.signups).toBe(2);
    expect(byId["audience-a"].metrics.cpsCents).toBe(1500);
    expect(byId["audience-b"].evidence.signups).toBe(1);
    expect(byId["audience-b"].metrics.cpsCents).toBe(1000);
  });

  it("goal=signup degrades to absent signups (null cps, never $0) when lead-service is unavailable", async () => {
    // Default mock returns {} for converted-lead-emails → client throws → soft-degrades to absent.
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.audiences.every((r: any) => r.evidence.signups === undefined)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.metrics.cpsCents === null)).toBe(true);
  });

  it("non-conversion goals never call the converted-lead-emails read and carry null cpfs/cps", async () => {
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);
    expect(res.status).toBe(200);
    const calledLead = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).some((u: string) => u.includes("converted-lead-emails"));
    expect(calledLead).toBe(false);
    expect(res.body.audiences.every((r: any) => r.metrics.cpfsCents === null)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.evidence.formSubmissions === undefined)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.metrics.cpsCents === null)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.evidence.signups === undefined)).toBe(true);
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
    // audience-a: clicks > 0 but no attributed spend (cost un-attributed) → PROJECTED floors to the brand
    // parent cpc (audience→brand), NOT a false $0 and NOT null. brand parent = brand total tagged cost 1000
    // / distinct union clicks 30 (10 in a + 20 in b, all clicked) = 33.33¢.
    expect(byId["audience-a"].evidence.websiteClicks).toBeGreaterThan(0);
    expect(byId["audience-a"].evidence.totalCostInUsdCents).toBe(0);
    expect(byId["audience-a"].metrics.cpcCents).toBeCloseTo(1000 / 30, 6);
    // audience-b: real spend → real CPC (parent ignored), unchanged.
    expect(byId["audience-b"].metrics.cpcCents).toBe(50);
    // audience-a (33.33¢, brand-floored) now sorts ahead of audience-b (50¢, real).
    expect(res.body.audiences[0].audienceId).toBe("audience-a");
  });

  // ── Optional campaign scope (?campaignId=) ──────────────────────────────────
  // Under campaign scope, only a SUBSET of each audience's members were contacted/clicked WITHIN the
  // campaign, and the runs cost numerator is filtered to that campaign's spend. Audiences stay brand-wide.
  const CAMP_CONTACTED = new Set<string>([...EMAILS_A.slice(0, 4), ...EMAILS_B.slice(0, 10)]);
  function mockFetchCampaignAware(): ReturnType<typeof vi.spyOn> {
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
          total: 2, limit: 200, offset: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
        return new Response(JSON.stringify({ current: { id: "brand-profile-1", brandId: "brand-1", version: 3, fields: {}, createdAt: "2026-01-01T00:00:00Z" }, versions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("runs:3000/v1/stats/costs")) {
        const campaignId = new URL(url).searchParams.get("campaignId");
        // Campaign-filtered spend is smaller than the brand-wide total; brand-wide when no filter.
        const groups = campaignId
          ? [costGroup("audience-a", 1200, 2), costGroup("audience-b", 400, 1)]
          : [costGroup("audience-a", 3000, 3), costGroup("audience-b", 1000, 2)];
        return new Response(JSON.stringify({ groups }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/status")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { brandId?: string; campaignId?: string; items: Array<{ email: string }> };
        const campaignScoped = Boolean(body.campaignId);
        const results = body.items.map(({ email }) => {
          const hit = campaignScoped ? CAMP_CONTACTED.has(email) : true;
          const flags = { contacted: hit, opened: hit, clicked: hit, replied: false, replyClassification: null };
          // Campaign scope → put flags under broadcast.campaign; brand scope → broadcast.brand.
          return { email, broadcast: campaignScoped ? { campaign: flags, brand: null } : { brand: flags } };
        });
        return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it("?campaignId= scopes cost (runs campaignId filter) + outcomes (email-gateway campaign scope)", async () => {
    fetchSpy = mockFetchCampaignAware();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit&campaignId=camp-1")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // Cost is the campaign-filtered spend; clicks are the campaign-scoped member counts.
    // audience-a: 4 of 10 members clicked in-campaign, spend 1200 → cpc 300.
    expect(byId["audience-a"].evidence.totalCostInUsdCents).toBe(1200);
    expect(byId["audience-a"].evidence.websiteClicks).toBe(4);
    expect(byId["audience-a"].metrics.cpcCents).toBe(300);
    // audience-b: 10 of 20 members clicked in-campaign, spend 400 → cpc 40.
    expect(byId["audience-b"].evidence.totalCostInUsdCents).toBe(400);
    expect(byId["audience-b"].evidence.websiteClicks).toBe(10);
    expect(byId["audience-b"].metrics.cpcCents).toBe(40);

    // runs cost fetch carried the campaignId filter (still grouped by audienceId).
    const costUrl = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).find((u: string) => u.includes("runs:3000")) ?? "";
    expect(costUrl).toContain("groupBy=audienceId");
    expect(costUrl).toContain("campaignId=camp-1");
    // email-gateway status was driven by a campaignId body field (NOT brandId).
    const statusCall = fetchSpy.mock.calls.find((c: any[]) => urlOf(c[0]).includes("email:3000/orgs/status"));
    const statusBody = JSON.parse(String((statusCall?.[1] as any)?.body ?? "{}"));
    expect(statusBody.campaignId).toBe("camp-1");
    expect(statusBody.brandId).toBeUndefined();
  });

  it("omitting campaignId is brand-wide + byte-identical (no runs campaignId filter, brand-scope email body)", async () => {
    fetchSpy = mockFetchCampaignAware();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // Brand-wide: all members contacted/clicked, brand-wide spend.
    expect(byId["audience-a"].evidence.totalCostInUsdCents).toBe(3000);
    expect(byId["audience-a"].evidence.websiteClicks).toBe(10);
    expect(byId["audience-a"].metrics.cpcCents).toBe(300);
    expect(byId["audience-b"].evidence.totalCostInUsdCents).toBe(1000);
    expect(byId["audience-b"].evidence.websiteClicks).toBe(20);
    expect(byId["audience-b"].metrics.cpcCents).toBe(50);

    // No campaignId filter reaches runs; email body drives on brandId (brand scope).
    const costUrl = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).find((u: string) => u.includes("runs:3000")) ?? "";
    expect(costUrl).not.toContain("campaignId=");
    const statusCall = fetchSpy.mock.calls.find((c: any[]) => urlOf(c[0]).includes("email:3000/orgs/status"));
    const statusBody = JSON.parse(String((statusCall?.[1] as any)?.body ?? "{}"));
    expect(statusBody.brandId).toBe("brand-1");
    expect(statusBody.campaignId).toBeUndefined();
  });
});
