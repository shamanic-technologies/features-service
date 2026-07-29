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
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
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

// Per-audience SEND-TAG engagement group (email-gateway /orgs/stats?groupBy=audienceId → groups keyed
// by audienceId with broadcast.recipientStats). Models the old membership numbers (all members engaged,
// POSITIVE → positive reply); `include` narrows the set for the campaign-scoped mock.
function sendTagGroup(audienceId: string, emails: string[], include: (e: string) => boolean = () => true): Record<string, unknown> {
  const hit = emails.filter(include);
  const n = hit.length;
  const repliesPositive = hit.filter((e) => POSITIVE.has(e)).length;
  return { key: audienceId, broadcast: { recipientStats: { contacted: n, sent: n, delivered: n, opened: n, clicked: n, bounced: 0, repliesPositive } } };
}

function membersResponse(emails: string[]): Response {
  return new Response(
    JSON.stringify({ members: emails.map((e) => ({ emailNorm: e })), total: emails.length, limit: 500, offset: 0 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Brand effective economics (fetchEffectiveEconomics) driving the fleet-backed projected floor parents.
const FLEET_ECON = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 30,
  visitToMeetingPct: 20,
  meetingToClosePct: 50,
  visitToSignupPct: 20,
  signupToPaidClientPct: 40,
  visitToClosePct: 10,
  visitToPaidClientPct: 20,
  replyToPaidClientPct: 50,
  visitToFormSubmissionPct: 40,
  formSubmissionToPaidClientPct: 50,
};

// The 4 cross-org fleet + economics reads behind fetchBrandProjectedParents (the fleet-backed floor
// parent, mirroring workflow-projection.resolved). The parent is the BEST workflow's cost, never a
// cross-workflow pooled average, so the fleet fixture carries the workflow-dynasty list too.
// Fleet: wf-1 $1000 over 500 clicks / 200 replies → its CPC $2.00 (200¢), CPPR $5.00 (500¢) — the ONLY
// backed dynasty here, so it IS the best. With FLEET_ECON: cps parent = 2.00/0.20 = $10 (1000¢),
// cpfs parent = 2.00/0.40 = $5 (500¢), cpsale(sales) = min(2/0.2, 5/0.5) = $10 (1000¢),
// cpsale(websitePurchase) = costPerPurchase = $8 (800¢). netTotalCostInUsdCents == gross (fleet is
// cross-org, not per-org-discounted) so pricing=net reads the same fleet benchmark.
const FLEET_WORKFLOWS: Array<Record<string, unknown>> = [
  {
    id: "wf-id-1",
    workflowSlug: "wf-1",
    workflowName: "WF 1",
    workflowDynastySlug: "dyn-1",
    workflowDynastyName: "Dynasty 1",
    version: 1,
    status: "active",
    featureSlug: "sales-cold-email-outreach",
    createdForBrandId: null,
    upgradedTo: null,
  },
];

/** Override the fleet fixture for one test (best-workflow parent cases). */
let fleetOverride: { workflows?: unknown[]; costs?: unknown[]; email?: unknown[] } | null = null;

function fleetEconResponse(url: string): Response | null {
  if (url.includes("workflow:3000/public/workflows")) {
    return json({ workflows: fleetOverride?.workflows ?? FLEET_WORKFLOWS });
  }
  if (url.includes("runs:3000/v1/stats/public/costs")) {
    return json({
      groups: fleetOverride?.costs ?? [
        { dimensions: { workflowSlug: "wf-1" }, totalCostInUsdCents: "100000", netTotalCostInUsdCents: "100000", runCount: 100, minStartedAt: null, maxStartedAt: null },
      ],
    });
  }
  if (url.includes("email:3000/public/stats")) {
    return json({
      groups: fleetOverride?.email ?? [
        { key: "wf-1", broadcast: { recipientStats: { contacted: 1000, sent: 1000, delivered: 1000, opened: 800, clicked: 500, bounced: 0, repliesPositive: 200 } } },
      ],
    });
  }
  if (url.includes("brand:3000/orgs/brands/brand-1/sales-economics-effective")) {
    return json({ economics: FLEET_ECON, source: "user" });
  }
  return null;
}

/** Build a fleet workflow-metadata entry (dynasty defaults to its own slug; `upgradedTo` chains versions). */
function fleetWorkflow(slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${slug}`,
    workflowSlug: slug,
    workflowName: slug,
    workflowDynastySlug: slug,
    workflowDynastyName: slug,
    version: 1,
    status: "active",
    featureSlug: "sales-cold-email-outreach",
    createdForBrandId: null,
    upgradedTo: null,
    ...over,
  };
}

function fleetCost(slug: string, cents: number, runCount = 10): Record<string, unknown> {
  return { dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), runCount, minStartedAt: null, maxStartedAt: null };
}

function fleetEmail(slug: string, clicked: number, repliesPositive: number): Record<string, unknown> {
  return { key: slug, broadcast: { recipientStats: { contacted: 1000, sent: 1000, delivered: 1000, opened: 800, clicked, bounced: 0, repliesPositive } } };
}

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }

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
    // send-tag engagement: email-gateway GET /orgs/stats?groupBy=audienceId → per-audience recipientStats.
    if (url.includes("email:3000/orgs/stats")) {
      return new Response(JSON.stringify({ groups: [sendTagGroup("audience-a", EMAILS_A), sendTagGroup("audience-b", EMAILS_B)] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    { const fe = fleetEconResponse(url); if (fe) return fe; }

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
    if (url.includes("email:3000/orgs/stats")) {
      return new Response(JSON.stringify({ groups: [sendTagGroup("audience-a", EMAILS_A), sendTagGroup("audience-b", EMAILS_B), sendTagGroup("audience-c", EMAILS_C)] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    fleetOverride = null;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
    fleetOverride = null;
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
    // brand-service retired versioned brand-profile storage → brandProfileId is null without an explicit param.
    expect(res.body.brandProfileId).toBeNull();
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
    { const fe = fleetEconResponse(url); if (fe) return fe; }
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

  it("goal=whatsappConversation sorts by CPC and exposes the click-based outcome (cpcCents + websiteClicks) — WhatsApp-link click IS the outcome", async () => {
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=whatsappConversation")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("whatsappConversation");
    // Click-driven → ranks on CPC, reusing the existing click evidence (no new event pipeline).
    expect(res.body.sortMetric).toBe("cpc");
    // cost-per-outcome = cpcCents; outcome count = evidence.websiteClicks (clicks on the WhatsApp link).
    expect(res.body.audiences[0].metrics.cpcCents).toBe(50);
    expect(res.body.audiences[0].evidence.websiteClicks).toBe(20);
    // whatsapp is NOT a conversion-tracker goal → the converted-lead-emails read is never made.
    const convUrl = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).find((u: string) => u.includes("converted-lead-emails"));
    expect(convUrl).toBeUndefined();
  });

  it("goal=whatsapp_conversations (snake) and the 'WhatsApp conversations' display value both normalise to whatsappConversation", async () => {
    fetchSpy = mockFetch();
    let res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=whatsapp_conversations")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("whatsappConversation");
    fetchSpy = mockFetch();
    res = await request(app)
      .get(`/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=${encodeURIComponent("WhatsApp conversations")}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("whatsappConversation");
    expect(res.body.sortMetric).toBe("cpc");
  });

  it("goal=formSubmission attributes real per-audience form submissions via membership ∩ matched-lead emails", async () => {
    // conversion emails (matched-lead canonical, lowercased) — a1,a3 in audience-a; b2 in audience-b.
    const CONVERSION_EMAILS = ["a1", "a3", "b2"];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }
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
    { const fe = fleetEconResponse(url); if (fe) return fe; }
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

  for (const goalSpelling of ["sales", "websitePurchase"] as const) {
    it(`goal=${goalSpelling} attributes real per-audience SALES via membership ∩ matched-lead sale emails (event=sale)`, async () => {
      const CONVERSION_EMAILS = ["a1", "a3", "b2"];
      fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }
        if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) {
          expect(new URL(url).searchParams.get("event")).toBe("sale"); // RENAMED from "purchase"
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
        .get(`/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=${goalSpelling}`)
        .set(AUTH);

      expect(res.status).toBe(200);
      expect(res.body.goal).toBe(goalSpelling);
      expect(res.body.sortMetric).toBe("cppr"); // both sale-terminating goals are reply-inclusive close goals
      const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
      // audience-a: 2 members converted (a1,a3), spend 3000 → cpsale 1500. audience-b: 1 (b2), spend 1000 → 1000.
      expect(byId["audience-a"].evidence.sales).toBe(2);
      expect(byId["audience-a"].metrics.cpsaleCents).toBe(1500);
      expect(byId["audience-b"].evidence.sales).toBe(1);
      expect(byId["audience-b"].metrics.cpsaleCents).toBe(1000);
    });
  }

  it("legacy `purchase` goal spelling normalises to websitePurchase + reads sale attribution", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }
      if (url.includes("converted-lead-emails")) {
        expect(new URL(url).searchParams.get("event")).toBe("sale");
        return new Response(JSON.stringify({ emails: ["a1"] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences")) {
        return new Response(JSON.stringify({ audiences: [{ id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: null }], total: 1, limit: 200, offset: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) return new Response(JSON.stringify({ current: null, versions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("runs:3000/v1/stats/costs")) return new Response(JSON.stringify({ groups: [costGroup("audience-a", 2000, 1)] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("email:3000/orgs/status")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
        return new Response(JSON.stringify({ results: body.items.map(({ email }) => ({ email, broadcast: { brand: { contacted: true, opened: false, clicked: true, replied: false, replyClassification: null } } })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as ReturnType<typeof vi.spyOn>;
    const res = await request(app).get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=purchase").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("websitePurchase"); // legacy purchase → renamed echo
  });

  it("goal=sales degrades to absent sales (null cpsale, never $0) when lead-service is unavailable", async () => {
    fetchSpy = mockFetch(); // default returns {} for converted-lead-emails → client throws → soft-degrades
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=sales")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.audiences.every((r: any) => r.evidence.sales === undefined)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.metrics.cpsaleCents === null)).toBe(true);
  });

  it("unknown goal → 400 (fail loud, never a silent default)", async () => {
    fetchSpy = mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=bogusGoal")
      .set(AUTH);
    expect(res.status).toBe(400);
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
    expect(res.body.audiences.every((r: any) => r.metrics.cpsaleCents === null)).toBe(true);
    expect(res.body.audiences.every((r: any) => r.evidence.sales === undefined)).toBe(true);
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
    { const fe = fleetEconResponse(url); if (fe) return fe; }
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
      // send-tag: everyone clicked → audience-a has clicks but zero attributed cost.
      if (url.includes("email:3000/orgs/stats")) {
        return new Response(JSON.stringify({ groups: [sendTagGroup("audience-a", EMAILS_A), sendTagGroup("audience-b", EMAILS_B)] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    // audience-a: clicks > 0 but no attributed spend (cost un-attributed) → PROJECTED floors to the
    // FLEET-BACKED parent cpc (crossOrg $2.00 = 200¢), NOT a false $0, NOT null, NOT a brand-own aggregate.
    expect(byId["audience-a"].evidence.websiteClicks).toBeGreaterThan(0);
    expect(byId["audience-a"].evidence.totalCostInUsdCents).toBe(0);
    expect(byId["audience-a"].metrics.cpcCents).toBe(200);
    // audience-b: real spend → real CPC (parent ignored), unchanged.
    expect(byId["audience-b"].metrics.cpcCents).toBe(50);
    // audience-b (50¢, real) sorts ahead of audience-a (200¢, fleet-floored).
    expect(res.body.audiences[0].audienceId).toBe("audience-b");
  });

  it("0-outcome audience with spend FLOORS to the fleet cost-per-outcome (never a raw tiny-spend value, never null); truly-empty audience is null", async () => {
    // audience-a: real spend 500 but ZERO positive replies. audience-b: spend 1000 + 5 positive replies
    // (real ratio 200). audience-c: ZERO spend AND zero replies (truly empty).
    // FLEET-BACKED parent cppr = crossOrg $5.00 = 500¢. → audience-a floors to max(500, 500) = 500 (its own
    // spend equals the fleet cost), NOT null, NOT 500/0.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences/audience-c/members")) return membersResponse(EMAILS_C);
      if (url.includes("human:3000/orgs/audiences")) {
        return new Response(JSON.stringify({
          audiences: [
            { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: null },
            { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: null },
            { id: "audience-c", brandId: "brand-1", name: "Idle", status: "active", filters: null },
          ],
          total: 3, limit: 200, offset: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) {
        return new Response(JSON.stringify({ current: null, versions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("runs:3000/v1/stats/costs")) {
        // audience-a spent 500, audience-b spent 1000; audience-c has NO cost row (truly empty).
        return new Response(JSON.stringify({ groups: [costGroup("audience-a", 500, 1), costGroup("audience-b", 1000, 2)] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/stats")) {
        // audience-a: contacted but ZERO positive replies. audience-b: 5 positive replies. audience-c: none.
        return new Response(JSON.stringify({ groups: [
          { key: "audience-a", broadcast: { recipientStats: { contacted: 10, sent: 10, delivered: 10, opened: 5, clicked: 3, bounced: 0, repliesPositive: 0 } } },
          { key: "audience-b", broadcast: { recipientStats: { contacted: 20, sent: 20, delivered: 20, opened: 20, clicked: 20, bounced: 0, repliesPositive: 5 } } },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=positiveReply")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // audience-a: spend 500, 0 replies → FLOOR max(500, fleet 500) = 500, never null.
    expect(byId["audience-a"].evidence.positiveReplies).toBe(0);
    expect(byId["audience-a"].metrics.cpprCents).toBe(500);
    // audience-b: real observed ratio 1000/5 = 200 (parent ignored), unchanged.
    expect(byId["audience-b"].metrics.cpprCents).toBe(200);
    // audience-c: 0 spend AND 0 replies → truly empty → null (sorts last).
    expect(byId["audience-c"].metrics.cpprCents).toBeNull();
    expect(res.body.audiences[res.body.audiences.length - 1].audienceId).toBe("audience-c");
  });

  it("0-outcome audience with spend BELOW the fleet cost lifts to the fleet floor (not the raw spend)", async () => {
    // audience-a: real spend 100 but ZERO positive replies (below fleet cost). audience-b: spend 3000 + 5
    // positive replies (real ratio 600). FLEET-BACKED parent cppr = crossOrg $5.00 = 500¢ → audience-a
    // floors to max(100, 500) = 500 (the fleet-backed cost), NOT the artificially-cheap raw 100.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }
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
        return new Response(JSON.stringify({ groups: [costGroup("audience-a", 100, 1), costGroup("audience-b", 3000, 2)] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/stats")) {
        return new Response(JSON.stringify({ groups: [
          { key: "audience-a", broadcast: { recipientStats: { contacted: 10, sent: 10, delivered: 10, opened: 5, clicked: 3, bounced: 0, repliesPositive: 0 } } },
          { key: "audience-b", broadcast: { recipientStats: { contacted: 20, sent: 20, delivered: 20, opened: 20, clicked: 20, bounced: 0, repliesPositive: 5 } } },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=positiveReply")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // fleet cost = $5.00 = 500¢ → audience-a lifts to 500, NOT the raw 100.
    expect(byId["audience-a"].metrics.cpprCents).toBe(500);
    expect(byId["audience-b"].metrics.cpprCents).toBe(600);
  });

  it("0-signup audience with spend FLOORS to the fleet cost-per-signup (coherent with the cpc/cppr floor)", async () => {
    // Same floor rule on the conversion columns. audience-a: spend 3000, 0 signups; audience-b: spend 1000,
    // 1 signup (b2). FLEET-BACKED parent cps = projected cost per signup = crossOrg CPC $2.00 / v2s 0.20 =
    // $10 = 1000¢. audience-a floors to max(3000, 1000) = 3000, never null, never 3000/0.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }
      if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) {
        return new Response(JSON.stringify({ emails: ["b2"] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
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
        return new Response(JSON.stringify({ groups: [costGroup("audience-a", 3000, 3), costGroup("audience-b", 1000, 2)] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("email:3000/orgs/status")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<{ email: string }> };
        return new Response(JSON.stringify({ results: body.items.map(({ email }) => ({ email, broadcast: { brand: { contacted: true, opened: true, clicked: true, replied: false, replyClassification: null } } })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // audience-a: 0 signups, spend 3000 → FLOOR max(3000, fleet cps 1000) = 3000 (own spend > fleet), never null.
    expect(byId["audience-a"].evidence.signups).toBe(0);
    expect(byId["audience-a"].metrics.cpsCents).toBe(3000);
    // audience-b: real observed ratio 1000/1 = 1000 (parent ignored).
    expect(byId["audience-b"].metrics.cpsCents).toBe(1000);
  });

  it("reported bug: 0-website-visit audiences with tiny spend floor to the FLEET-BACKED cost (not their raw ¢), matching the Strategy page", async () => {
    // Repro of the prod bug: every audience has 0 website visits (0 clicks) and only a tiny attributed
    // spend (66¢, 92¢, 94¢). The OLD brand-own aggregate parent (brand total tagged ¢ / brand clicks 0 =
    // null) let each audience floor to its own tiny ¢ → the Audiences table showed $0.66 / $0.92 / $0.94,
    // FAR below the realistic projected cost. The fleet-backed parent (crossOrg CPC $2.00 = 200¢) lifts
    // every 0-click audience to 200¢ — the SAME number workflow-projection.resolved shows on the Strategy
    // page. (Here 200¢ stands in for the reported $2.54; both come from the same crossOrg fleet benchmark.)
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      { const fe = fleetEconResponse(url); if (fe) return fe; }
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences/audience-c/members")) return membersResponse(EMAILS_C);
      if (url.includes("human:3000/orgs/audiences")) {
        return json({
          audiences: [
            { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: null },
            { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: null },
            { id: "audience-c", brandId: "brand-1", name: "VPs", status: "active", filters: null },
          ],
          total: 3, limit: 200, offset: 0,
        });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) return json({ current: null, versions: [] });
      if (url.includes("runs:3000/v1/stats/costs")) {
        // Tiny per-audience attributed spend (below the fleet 200¢ per click), 0 clicks each.
        return json({ groups: [costGroup("audience-a", 66, 1), costGroup("audience-b", 92, 1), costGroup("audience-c", 94, 1)] });
      }
      if (url.includes("email:3000/orgs/stats")) {
        // Every audience contacted but ZERO website visits (0 clicks).
        return json({ groups: [
          { key: "audience-a", broadcast: { recipientStats: { contacted: 10, sent: 10, delivered: 10, opened: 4, clicked: 0, bounced: 0, repliesPositive: 0 } } },
          { key: "audience-b", broadcast: { recipientStats: { contacted: 20, sent: 20, delivered: 20, opened: 8, clicked: 0, bounced: 0, repliesPositive: 0 } } },
          { key: "audience-c", broadcast: { recipientStats: { contacted: 15, sent: 15, delivered: 15, opened: 6, clicked: 0, bounced: 0, repliesPositive: 0 } } },
        ] });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    // All three lift to the fleet-backed 200¢ (NOT their raw 66/92/94¢), coherent across audiences.
    expect(byId["audience-a"].evidence.websiteClicks).toBe(0);
    expect(byId["audience-a"].metrics.cpcCents).toBe(200);
    expect(byId["audience-b"].metrics.cpcCents).toBe(200);
    expect(byId["audience-c"].metrics.cpcCents).toBe(200);
    // None reads its artificially-cheap raw spend.
    expect(byId["audience-a"].metrics.cpcCents).not.toBe(66);
  });

  it("0-click audience whose own spend EXCEEDS the fleet cost keeps its higher own-spend floor (own spend wins)", async () => {
    // audience-a spent 500¢ with 0 clicks — above the fleet CPC 200¢ → floors to its OWN spend (500),
    // NOT the fleet 200 (already outspent the benchmark with nothing to show). audience-b (tiny 90¢, 0
    // clicks) floors up to the fleet 200.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      { const fe = fleetEconResponse(url); if (fe) return fe; }
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences/audience-b/members")) return membersResponse(EMAILS_B);
      if (url.includes("human:3000/orgs/audiences")) {
        return json({
          audiences: [
            { id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: null },
            { id: "audience-b", brandId: "brand-1", name: "Founders", status: "active", filters: null },
          ],
          total: 2, limit: 200, offset: 0,
        });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) return json({ current: null, versions: [] });
      if (url.includes("runs:3000/v1/stats/costs")) {
        return json({ groups: [costGroup("audience-a", 500, 1), costGroup("audience-b", 90, 1)] });
      }
      if (url.includes("email:3000/orgs/stats")) {
        return json({ groups: [
          { key: "audience-a", broadcast: { recipientStats: { contacted: 10, sent: 10, delivered: 10, opened: 4, clicked: 0, bounced: 0, repliesPositive: 0 } } },
          { key: "audience-b", broadcast: { recipientStats: { contacted: 20, sent: 20, delivered: 20, opened: 8, clicked: 0, bounced: 0, repliesPositive: 0 } } },
        ] });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.audiences.map((r: any) => [r.audienceId, r]));
    expect(byId["audience-a"].metrics.cpcCents).toBe(500); // own spend (500) > fleet (200) → own wins
    expect(byId["audience-b"].metrics.cpcCents).toBe(200); // own spend (90) < fleet (200) → fleet floor
  });

  // ── The fleet-backed parent is cross-org + BEST WORKFLOW, never cross-workflow POOLED ─────────
  // Standing product rule: we never surface a cross-org PLUS cross-workflow pooled estimate. A pooled
  // parent (Σ fleet spend ÷ Σ fleet outcomes) read ~3x the Strategy page's number for the same brand +
  // goal + moment, so the Audiences table and the Strategy page showed two different prices for the same
  // thing while both labelled it "fleet benchmark".

  /** One 0-click audience with a tiny attributed spend (below any plausible parent) → renders the parent. */
  function mockOneZeroOutcomeAudience(spendCents = 50): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      { const fe = fleetEconResponse(url); if (fe) return fe; }
      // Conversion tracker (signup / form / sale goals): no converted lead → 0 conversions, not absent.
      if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) return json({ emails: [] });
      if (url.includes("human:3000/orgs/audiences/audience-a/members")) return membersResponse(EMAILS_A);
      if (url.includes("human:3000/orgs/audiences")) {
        return json({
          audiences: [{ id: "audience-a", brandId: "brand-1", name: "CFOs", status: "active", filters: null }],
          total: 1, limit: 200, offset: 0,
        });
      }
      if (url.includes("brand:3000/orgs/brands/brand-1/brand-profile")) return json({ current: null, versions: [] });
      if (url.includes("runs:3000/v1/stats/costs")) return json({ groups: [costGroup("audience-a", spendCents, 1)] });
      if (url.includes("email:3000/orgs/stats")) {
        return json({ groups: [
          { key: "audience-a", broadcast: { recipientStats: { contacted: 10, sent: 10, delivered: 10, opened: 4, clicked: 0, bounced: 0, repliesPositive: 0 } } },
        ] });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it("parent = the BEST workflow's cost per outcome, NOT the cross-workflow pooled average", async () => {
    // Fleet: cheap $200/100 clicks = $2.00 (200¢) · pricey $1000/50 clicks = $20.00 · husk $5/0 clicks.
    // POOLED (the old parent) = (20000 + 100000 + 500)¢ ÷ 150 clicks = 803¢ — 4x the best workflow.
    fleetOverride = {
      workflows: [fleetWorkflow("wf-cheap"), fleetWorkflow("wf-pricey"), fleetWorkflow("wf-husk")],
      costs: [fleetCost("wf-cheap", 20000), fleetCost("wf-pricey", 100000), fleetCost("wf-husk", 500)],
      email: [fleetEmail("wf-cheap", 100, 40), fleetEmail("wf-pricey", 50, 10), fleetEmail("wf-husk", 0, 0)],
    };
    fetchSpy = mockOneZeroOutcomeAudience();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);

    expect(res.status).toBe(200);
    const row = res.body.audiences[0];
    expect(row.evidence.websiteClicks).toBe(0);
    expect(row.metrics.cpcCents).toBe(200); // the BEST workflow (wf-cheap $2.00)
    expect(row.metrics.cpcCents).not.toBe(803); // never the cross-workflow pooled average
  });

  it("a workflow that observed 0 of the driving outcome is NOT eligible to be the best pick", async () => {
    // wf-husk spent 30¢ and produced ZERO clicks. Its cost-per-click is meaningless; if it were eligible
    // (floored to its own spend) it would win at 30¢ and price every 0-click audience at $0.30. The best
    // pick may only consider workflows that actually observed the outcome → wf-cheap's 200¢.
    fleetOverride = {
      workflows: [fleetWorkflow("wf-cheap"), fleetWorkflow("wf-husk")],
      costs: [fleetCost("wf-cheap", 20000), fleetCost("wf-husk", 30)],
      email: [fleetEmail("wf-cheap", 100, 40), fleetEmail("wf-husk", 0, 0)],
    };
    fetchSpy = mockOneZeroOutcomeAudience();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.audiences[0].metrics.cpcCents).toBe(200);
    expect(res.body.audiences[0].metrics.cpcCents).not.toBe(30);
  });

  it("collapses a workflow's version chain into ONE dynasty before picking the best", async () => {
    // dyn-x spans two versions: v1 $600/10 clicks, v2 $400/90 clicks. Rolled up the DYNASTY is
    // $1000/100 clicks = $10.00 (1000¢). dyn-y is $1200/100 clicks = $12.00. Best dynasty = dyn-x, 1000¢.
    // Treating the versions as independent workflows would crown v2 alone ($400/90 = $4.44 = 444¢) — the
    // corruption this collapse prevents.
    fleetOverride = {
      workflows: [
        fleetWorkflow("wf-x-v1", { id: "id-wf-x-v1", status: "deprecated", workflowDynastySlug: "wf-x-v2", upgradedTo: "id-wf-x-v2" }),
        fleetWorkflow("wf-x-v2", { id: "id-wf-x-v2", version: 2 }),
        fleetWorkflow("wf-y"),
      ],
      costs: [fleetCost("wf-x-v1", 60000), fleetCost("wf-x-v2", 40000), fleetCost("wf-y", 120000)],
      email: [fleetEmail("wf-x-v1", 10, 5), fleetEmail("wf-x-v2", 90, 45), fleetEmail("wf-y", 100, 50)],
    };
    fetchSpy = mockOneZeroOutcomeAudience();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websiteVisit")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.audiences[0].metrics.cpcCents).toBe(1000); // dynasty-rolled dyn-x
    expect(res.body.audiences[0].metrics.cpcCents).not.toBe(444); // never the un-collapsed v2 alone
  });

  it("EVERY column reads the ONE workflow the GOAL picks — not a per-column blend across workflows", async () => {
    // wf-click: $200 / 100 clicks / 25 replies → click $2.00, reply $8.00 · cost-per-signup 2/0.20 = $10
    // wf-reply: $200 /  20 clicks / 50 replies → click $10.00, reply $4.00 · cost-per-signup 10/0.20 = $50
    // The signup goal picks wf-click, so the reply column must read wf-click's $8.00 — NOT wf-reply's
    // cheaper $4.00. Blending the two would price two columns off two different workflows, which is how
    // the Audiences table and the Strategy page drifted apart in the first place.
    fleetOverride = {
      workflows: [fleetWorkflow("wf-click"), fleetWorkflow("wf-reply")],
      costs: [fleetCost("wf-click", 20000), fleetCost("wf-reply", 20000)],
      email: [fleetEmail("wf-click", 100, 25), fleetEmail("wf-reply", 20, 50)],
    };
    fetchSpy = mockOneZeroOutcomeAudience();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=signup")
      .set(AUTH);

    expect(res.status).toBe(200);
    const row = res.body.audiences[0];
    expect(row.metrics.cpcCents).toBe(200); // wf-click's click cost
    expect(row.metrics.cpprCents).toBe(800); // wf-click's reply cost, NOT wf-reply's cheaper 400
    expect(row.metrics.cpsCents).toBe(1000); // wf-click's cost per signup
  });

  it("the goal's best workflow wins even when another workflow has cheaper clicks", async () => {
    // wf-cheap  $200 / 100 clicks /   0 replies → click $2.00, no reply channel
    // wf-closer $400 / 100 clicks / 200 replies → click $4.00, reply $2.00
    // FLEET_ECON: pCloseClick = orP(0.10, 0.20·0.50) = 0.19, pCloseReply = 0.30·0.50 = 0.15.
    //   wf-cheap  closes/budget = 0.19/2                = 0.095  → $10.53 per purchase
    //   wf-closer closes/budget = 0.19/4 + 0.15/2       = 0.1225 → $8.16 per purchase  ← wins the goal
    // So the website-purchase goal rides wf-closer, and the click column reads ITS $4.00.
    fleetOverride = {
      workflows: [fleetWorkflow("wf-cheap"), fleetWorkflow("wf-closer")],
      costs: [fleetCost("wf-cheap", 20000), fleetCost("wf-closer", 40000)],
      email: [fleetEmail("wf-cheap", 100, 0), fleetEmail("wf-closer", 100, 200)],
    };
    fetchSpy = mockOneZeroOutcomeAudience();

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/audience-stats?brandId=brand-1&goal=websitePurchase")
      .set(AUTH);

    expect(res.status).toBe(200);
    const row = res.body.audiences[0];
    expect(row.metrics.cpcCents).toBe(400); // wf-closer's click cost, NOT wf-cheap's cheaper 200
    expect(row.metrics.cpsaleCents).toBeCloseTo(100 / 0.1225, 6); // $8.16 per purchase, in cents
  });

  // ── Optional campaign scope (?campaignId=) ──────────────────────────────────
  // Under campaign scope, only a SUBSET of each audience's members were contacted/clicked WITHIN the
  // campaign, and the runs cost numerator is filtered to that campaign's spend. Audiences stay brand-wide.
  const CAMP_CONTACTED = new Set<string>([...EMAILS_A.slice(0, 4), ...EMAILS_B.slice(0, 10)]);
  function mockFetchCampaignAware(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
    { const fe = fleetEconResponse(url); if (fe) return fe; }
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
      // send-tag engagement: campaign scope narrows to CAMP_CONTACTED via the campaignId query param.
      if (url.includes("email:3000/orgs/stats")) {
        const campaignId = new URL(url).searchParams.get("campaignId");
        const include = campaignId ? (e: string) => CAMP_CONTACTED.has(e) : () => true;
        return new Response(JSON.stringify({ groups: [sendTagGroup("audience-a", EMAILS_A, include), sendTagGroup("audience-b", EMAILS_B, include)] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    // email-gateway engagement (send-tag) carried the campaignId query param (NOT brandId-only scope).
    const statsUrl = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).find((u: string) => u.includes("email:3000/orgs/stats")) ?? "";
    expect(statsUrl).toContain("groupBy=audienceId");
    expect(statsUrl).toContain("campaignId=camp-1");
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

    // No campaignId filter reaches runs; email engagement (send-tag) is brand-scoped (no campaignId).
    const costUrl = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).find((u: string) => u.includes("runs:3000")) ?? "";
    expect(costUrl).not.toContain("campaignId=");
    const statsUrl = fetchSpy.mock.calls.map((c: any[]) => urlOf(c[0])).find((u: string) => u.includes("email:3000/orgs/stats")) ?? "";
    expect(statsUrl).toContain("brandId=brand-1");
    expect(statsUrl).not.toContain("campaignId=");
  });
});
