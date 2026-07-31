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
process.env.FEATURE_VIEW_CACHE_ENABLED = "false"; // exercise the pure live-compute path
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

const SALES_FEATURE = { id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

// LTR $1000; signup paid = click / (4% × 50%); reply paid = reply / 25%.
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
  visitToPaidClientPct: 5,
  replyToPaidClientPct: 25,
};

function wf(slug: string, dynasty: string, name: string): Record<string, unknown> {
  return {
    id: `id-${slug}`,
    workflowSlug: slug,
    workflowName: name,
    workflowDynastyName: name,
    workflowDynastySlug: dynasty,
    version: 1,
    status: "active",
    featureSlug: "sales-cold-email-outreach",
    createdForBrandId: null,
    upgradedTo: null,
  };
}
const WORKFLOWS = [wf("wf-a", "dyn-a", "Dynasty A"), wf("wf-b", "dyn-b", "Dynasty B")];

const costGroup = (slug: string, cents: number) => ({
  dimensions: { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  runCount: 10,
  minStartedAt: null,
  maxStartedAt: null,
});
const emailGroup = (slug: string, clicked: number, repliesPositive: number, contacted = 200) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 10, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

// dyn-a: $1000 / 100 clicks / 50 replies → click $10, reply $20 (cheapest CLICK).
// dyn-b: $1000 /  10 clicks / 100 replies → click $100, reply $10 (cheapest REPLY).
const CROSSORG_COST = [costGroup("wf-a", 100_000), costGroup("wf-b", 100_000)];
const CROSSORG_EMAIL = [emailGroup("wf-a", 100, 50), emailGroup("wf-b", 10, 100)];

/** A declared sales funnel, shaped exactly like brand-service's deployed item. */
function declaredFunnel(goal: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    funnelKey: "visit_signup",
    name: "Website Purchase",
    steps: ["Website visit", "Signup", "Paid client"],
    goal,
    currentGoal: "signup",
    rates: {},
    lifetimeRevenueUsd: null,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...over,
  };
}

interface MockOpts {
  economics?: unknown;
  /** The funnels brand-service serves. Omitted → the endpoint 404s (a brand-service without the model). */
  funnels?: unknown[];
  audiences?: Array<{ id: string }>;
}

function mockFetch(opts: MockOpts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");

    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: CROSSORG_COST });
    if (url.includes("/v1/stats/costs")) return json({ groups: [] }); // brand + audience grains: no spend
    if (url.includes("/orgs/stats")) return json({ groups: [] });
    if (url.includes("/public/stats")) return json({ groups: CROSSORG_EMAIL });
    if (url.includes("/sales-funnels")) {
      if (!("funnels" in opts)) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      }
      return json({ funnels: opts.funnels });
    }
    if (url.includes("/sales-economics-effective")) {
      const economics = "economics" in opts ? opts.economics : ECONOMICS;
      return json({ economics, source: economics == null ? null : "user" });
    }
    if (url.includes("/orgs/audiences")) return json({ audiences: opts.audiences ?? [] });
    void u;
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const URL_BASE = "/features/sales-cold-email-outreach/goal-arbitration";

describe("GET /features/:featureSlug/goal-arbitration", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("400 when brandId missing, 400 on an invalid pricing value, 404 when the feature is unknown", async () => {
    mockFetch({ funnels: [declaredFunnel("signups")] });
    expect((await request(app).get(URL_BASE).set(AUTH)).status).toBe(400);
    expect((await request(app).get(`${URL_BASE}?brandId=b1&pricing=bogus`).set(AUTH)).status).toBe(400);

    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    expect((await request(app).get(`/features/nope/goal-arbitration?brandId=b1`).set(AUTH)).status).toBe(404);
  });

  it("elects the best goal, its best workflow, and the pairing's rows — in ONE request", async () => {
    mockFetch({
      funnels: [declaredFunnel("signups"), declaredFunnel("positive_replies"), declaredFunnel("whatsapp_conversations")],
      audiences: [{ id: "aud-1" }],
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.authorizedGoals).toEqual(["signup", "positiveReply", "whatsappConversation"]);
    expect(res.body.arbitration.status).toBe("resolved");
    expect(res.body.arbitration.goal).toBe("positiveReply");
    expect(res.body.arbitration.returnPerDollar).toBeCloseTo(25, 6); // 1000 / (reply $10 / 25%)
    expect(res.body.workflow.workflowDynastySlug).toBe("dyn-b");
    expect(res.body.rows.every((r: any) => r.workflow.workflowDynastySlug === "dyn-b")).toBe(true);
    expect(res.body.rows.some((r: any) => r.audienceId === "aud-1")).toBe(true);
    expect(res.body.economics.lifetimeRevenueUsd).toBe(1000);

    // The goal with no path to a paying client is scored but can never win.
    const whatsapp = res.body.candidates.find((c: any) => c.goal === "whatsappConversation");
    expect(whatsapp.rankable).toBe(false);
    expect(whatsapp.unrankableReason).toBe("no_paid_client_path");
  });

  it("the elected workflow matches what the SINGLE-GOAL read says for that goal — same fixture, same argmin", async () => {
    mockFetch({ funnels: [declaredFunnel("signups"), declaredFunnel("positive_replies")] });
    const arbitrated = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);
    const winner = arbitrated.body.arbitration.goal;

    // Reproduce each goal's own economics in isolation, then check the winner against them.
    const single = async (goal: string) =>
      (await request(app).get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&goal=${goal}`).set(AUTH)).body;
    const bestBrandRow = (body: any) =>
      body.rows
        .filter((r: any) => r.audienceId === null && r.resolved.costPerOutcomeUsd > 0)
        .sort((a: any, b: any) => a.resolved.costPerOutcomeUsd - b.resolved.costPerOutcomeUsd)[0];

    const reply = bestBrandRow(await single("positiveReply"));
    const signup = bestBrandRow(await single("signup"));
    expect(reply.resolved.roiMultiple).toBeCloseTo(25, 6);
    expect(signup.resolved.roiMultiple).toBeCloseTo(2, 6);
    expect(winner).toBe("positiveReply"); // the higher return per dollar of the two, verified in isolation
    expect(arbitrated.body.workflow.workflowDynastySlug).toBe(reply.workflow.workflowDynastySlug);
    expect(arbitrated.body.arbitration.costPerOutcomeUsd).toBeCloseTo(reply.resolved.costPerOutcomeUsd, 6);
    expect(arbitrated.body.arbitration.returnPerDollar).toBeCloseTo(reply.resolved.roiMultiple, 6);
    expect(arbitrated.body.candidates.find((c: any) => c.goal === "signup").workflow.workflowDynastySlug).toBe(
      signup.workflow.workflowDynastySlug,
    );
  });

  it("the declared meeting show-up rate lowers the meeting goal's return — it is not a free 100%", async () => {
    // The meeting chain is reply → BOOKED → attended → paid. Our meetingToClosePct is BOOKED → paid,
    // brand-service's funnel prices ATTENDED → paid, so a declared show-up rate must divide the return.
    const meetingFunnel = (rates: Record<string, number | null>) =>
      declaredFunnel("booked_meetings", { funnelKey: "reply_meeting", currentGoal: "meetingBooked", rates });

    // 40% reply→booked, 50% booked→attended, 40% attended→paid ⇒ 20% booked→paid.
    mockFetch({ funnels: [meetingFunnel({ replyToMeetingPct: 40, meetingBookedToAttendedPct: 50, meetingToClosePct: 40 })] });
    const withShowUp = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    // The SAME funnel with no show-up rate declared ⇒ 40% booked→paid, i.e. twice the conversion.
    mockFetch({ funnels: [meetingFunnel({ replyToMeetingPct: 40, meetingToClosePct: 40 })] });
    const without = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(withShowUp.status).toBe(200);
    expect(without.status).toBe(200);
    expect(withShowUp.body.economics.meetingToClosePct).toBeCloseTo(20, 6);
    expect(without.body.economics.meetingToClosePct).toBeCloseTo(40, 6);
    // Half the booked→paid rate ⇒ twice the cost per paid client ⇒ half the return per dollar.
    expect(withShowUp.body.arbitration.costPerPaidClientUsd).toBeCloseTo(
      without.body.arbitration.costPerPaidClientUsd * 2,
      6,
    );
    expect(withShowUp.body.arbitration.returnPerDollar).toBeCloseTo(without.body.arbitration.returnPerDollar / 2, 6);
  });

  it("the single-goal read is untouched by the presence of an authorized set", async () => {
    mockFetch({ funnels: [declaredFunnel("signups"), declaredFunnel("positive_replies")] });
    const withSet = (await request(app).get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&goal=signup`).set(AUTH)).body;
    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
    mockFetch(); // a brand that declared no funnel at all
    const without = (await request(app).get(`/features/sales-cold-email-outreach/workflow-projection?brandId=b1&goal=signup`).set(AUTH)).body;
    expect(withSet).toEqual(without);
  });

  it("502 with an explicit reason when the declared-funnel read cannot be answered — never a substituted default", async () => {
    mockFetch(); // brand-service without the funnel model → the read 404s
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("authorized_goals_unavailable");
    expect(res.body.error).toContain("sales funnels");
  });

  it("502 with an explicit reason on an authorized goal we cannot map — never silently dropped", async () => {
    mockFetch({ funnels: [declaredFunnel("signups"), declaredFunnel("telepathy", { currentGoal: "telepathy" })] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("authorized_goal_unrecognised");
    expect(res.body.error).toContain("telepathy");
  });

  it("200 unrankable (not an error) when the brand declared NO funnel", async () => {
    mockFetch({ funnels: [] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).toBe("unrankable");
    expect(res.body.arbitration.reason).toBe("no_authorized_goals");
    expect(res.body.arbitration.goal).toBeNull();
    expect(res.body.rows).toEqual([]);
  });

  it("200 unrankable with a per-goal reason when nothing can be ranked", async () => {
    mockFetch({ funnels: [declaredFunnel("whatsapp_conversations")] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1`).set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.arbitration.status).toBe("unrankable");
    expect(res.body.arbitration.reason).toBe("no_rankable_goal");
    expect(res.body.candidates[0].unrankableReason).toBe("no_paid_client_path");
  });

  it("does not accept an authorized set from the caller", async () => {
    // The brand declared ONE funnel; the caller asks for two more. The answer must ignore the caller.
    mockFetch({ funnels: [declaredFunnel("signups")] });
    const res = await request(app)
      .get(`${URL_BASE}?brandId=b1&authorizedGoals=positive_replies,sales&goals=positive_replies`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.authorizedGoals).toEqual(["signup"]);
    expect(res.body.arbitration.goal).toBe("signup");
  });
});
