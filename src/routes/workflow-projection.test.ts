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

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40, // r2m 0.4
  visitToMeetingPct: 5,  // v2m 0.05
  meetingToClosePct: 30, // m2c 0.3
  visitToClosePct: 2,    // v2c 0.02
  visitToSignupPct: 4,   // v2s 0.04
  signupToPaidClientPct: 50,
};

// Two dynasties.
function wf(over: Record<string, unknown>): Record<string, unknown> {
  return { id: "id", workflowSlug: "wf", workflowName: "WF", workflowDynastyName: "Dyn", workflowDynastySlug: "dyn", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null, ...over };
}
const WORKFLOWS = [
  wf({ id: "ida", workflowSlug: "wf-a", workflowDynastySlug: "dyn-a", workflowDynastyName: "Dynasty A" }),
  wf({ id: "idb", workflowSlug: "wf-b", workflowDynastySlug: "dyn-b", workflowDynastyName: "Dynasty B" }),
];

function costGroup(slug: string, cents: number, runCount = 10): Record<string, unknown> {
  return { dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), runCount, minStartedAt: null, maxStartedAt: null };
}
// crossOrg (fleet): wf-a $1000 / 100 clicks / 50 replies / 200 contacted; wf-b $1000 / 50 clicks / 10 replies
const CROSSORG_COST = [costGroup("wf-a", 100000), costGroup("wf-b", 100000)];

function emailGroup(slug: string, clicked: number, repliesPositive: number, contacted = 200): Record<string, unknown> {
  return { key: slug, broadcast: { recipientStats: { contacted, sent: 200, delivered: 200, opened: 150, clicked, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } } };
}
const CROSSORG_EMAIL = [emailGroup("wf-a", 100, 50), emailGroup("wf-b", 50, 10)];

// Brand grain: this brand ran ONLY wf-a — $500 / 25 clicks / 5 replies / 100 contacted (so cpc=$20 ≠ fleet $10).
const BRAND_COST = [costGroup("wf-a", 50000)];
const BRAND_EMAIL = [emailGroup("wf-a", 25, 5, 100)];

// ── Mock builder ──────────────────────────────────────────────────────────────
// runs /v1/stats/costs is distinguished by the groupBy param:
//   groupBy=workflowSlug (+ brandId) → brand grain
//   groupBy=audienceId               → audience cost totals
//   groupBy=audienceId,workflowSlug  → audience (audience × workflowSlug) couples
interface MockOpts {
  workflows?: unknown[];
  crossOrgCost?: unknown[];
  crossOrgEmail?: unknown[];
  brandCost?: unknown[];
  brandEmail?: unknown[];
  economics?: unknown;
  source?: unknown;
  // audiences: array of { id }, audienceCost groups, couple groups, membersByAudience, outcomesByEmail
  audiences?: Array<{ id: string }>;
  audienceCost?: unknown[];
  audienceCouples?: unknown[];
  membersByAudience?: Record<string, string[]>;
  outcomesByEmail?: Record<string, { contacted?: boolean; clicked?: boolean; replied?: boolean; replyClassification?: string }>;
}

function mockFetch(opts: MockOpts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");

    if (url.includes("/public/workflows")) {
      return json({ workflows: opts.workflows ?? WORKFLOWS });
    }
    // crossOrg fleet cost (public, no brand)
    if (url.includes("/v1/stats/public/costs")) {
      return json({ groups: opts.crossOrgCost ?? CROSSORG_COST });
    }
    // org-scoped runs cost — split by groupBy
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy === "audienceId") return json({ groups: opts.audienceCost ?? [] });
      if (groupBy === "audienceId,workflowSlug") return json({ groups: opts.audienceCouples ?? [] });
      // groupBy=workflowSlug + brandId → brand grain
      return json({ groups: opts.brandCost ?? BRAND_COST });
    }
    // email stats — org-scoped brand grain vs public crossOrg
    if (url.includes("/orgs/stats")) {
      return json({ groups: opts.brandEmail ?? BRAND_EMAIL });
    }
    if (url.includes("/public/stats")) {
      return json({ groups: opts.crossOrgEmail ?? CROSSORG_EMAIL });
    }
    if (url.includes("/sales-economics-effective")) {
      const economics = "economics" in opts ? opts.economics : ECONOMICS;
      const source = "source" in opts ? opts.source : economics == null ? null : "user";
      return json({ economics, source });
    }
    // human-service audiences list
    if (url.includes("/orgs/audiences") && url.includes("/members")) {
      const idMatch = url.match(/\/orgs\/audiences\/([^/]+)\/members/);
      const audienceId = idMatch ? idMatch[1] : "";
      const emails = opts.membersByAudience?.[audienceId] ?? [];
      return json({ members: emails.map((e) => ({ emailNorm: e })), total: emails.length });
    }
    if (url.includes("/orgs/audiences")) {
      return json({ audiences: opts.audiences ?? [] });
    }
    // email-gateway POST /orgs/status → per-email outcome flags
    if (url.includes("/orgs/status")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const items: Array<{ email: string }> = body.items ?? [];
      const results = items.map(({ email }) => {
        const o = opts.outcomesByEmail?.[email] ?? {};
        return { email, broadcast: { brand: { contacted: o.contacted, clicked: o.clicked, replied: o.replied, replyClassification: o.replyClassification ?? null } } };
      });
      return json({ results });
    }
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";
const rowFor = (body: any, dynasty: string, audienceId: string | null = null) =>
  body.rows.find((r: any) => r.workflow.workflowDynastySlug === dynasty && r.audienceId === audienceId);

describe("GET /features/:featureSlug/workflow-projection (3-grain ladder)", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("400 when brandId missing", async () => {
    const res = await request(app).get(`${URL_BASE}?goal=meetingBooked`).set(AUTH);
    expect(res.status).toBe(400);
  });

  it("404 when feature not found", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    mockFetch();
    const res = await request(app).get(`/features/unknown/workflow-projection?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it("goal echo: accepts camel `goal` and snake `objective`; canonical snake objective + camel goal", async () => {
    mockFetch();
    const camel = await request(app).get(`${URL_BASE}?brandId=b1&goal=websiteVisit`).set(AUTH);
    // websiteVisit needs the single-step rate — mock without it → fail loud below; use meetingBooked for echo
    const mb = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(mb.body.objective).toBe("meeting-booked");
    expect(mb.body.goal).toBe("meetingBooked");
    const snake = await request(app).get(`${URL_BASE}?brandId=b1&objective=self-serve`).set(AUTH);
    expect(snake.body.objective).toBe("self-serve");
    expect(snake.body.goal).toBe("signup"); // self-serve aliases signup
    void camel;
  });

  it("brand-level rows: crossOrg + brand grains; brand grain reflects the brand's own unit costs", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(res.status).toBe(200);

    // dyn-a: brand ran it → both grains. dyn-b: brand did NOT run it → crossOrg only.
    const a = rowFor(res.body, "dyn-a");
    expect(a).toBeTruthy();
    expect(a.workflow.workflowDynastyName).toBe("Dynasty A");
    expect(a.estimatesByGrain.crossOrg).toBeTruthy();
    expect(a.estimatesByGrain.brand).toBeTruthy();
    expect(a.estimatesByGrain.audience).toBeUndefined();

    // crossOrg: $1000 / 100 clicks = $10; brand: $500 / 25 clicks = $20.
    expect(a.estimatesByGrain.crossOrg.unitCosts.costPerClickUsd).toBeCloseTo(10, 6);
    expect(a.estimatesByGrain.brand.unitCosts.costPerClickUsd).toBeCloseTo(20, 6);
    expect(a.estimatesByGrain.crossOrg.unitCosts.costPerPositiveReplyUsd).toBeCloseTo(20, 6); // 1000/50
    expect(a.estimatesByGrain.brand.unitCosts.costPerPositiveReplyUsd).toBeCloseTo(100, 6);   // 500/5
    expect(a.estimatesByGrain.crossOrg.unitCosts.costPerContactedUsd).toBeCloseTo(5, 6);      // 1000/200
    expect(a.estimatesByGrain.brand.unitCosts.costPerContactedUsd).toBeCloseTo(5, 6);         // 500/100

    // dyn-b: only crossOrg (brand never ran it).
    const b = rowFor(res.body, "dyn-b");
    expect(b.estimatesByGrain.crossOrg).toBeTruthy();
    expect(b.estimatesByGrain.brand).toBeUndefined();
  });

  it("resolved precedence: brand grain wins over crossOrg when the brand has spend", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    expect(a.resolved.grain).toBe("brand");
    // resolved.costPerClickUsd == brand grain click cost ($20)
    expect(a.resolved.costPerClickUsd).toBeCloseTo(20, 6);
    const b = rowFor(res.body, "dyn-b");
    expect(b.resolved.grain).toBe("crossOrg");
    expect(b.resolved.costPerClickUsd).toBeCloseTo(20, 6); // $1000/50 = $20
  });

  it("no nulls in unitCosts; floor rule: 0 clicks → costPerClickUsd == spentUsd", async () => {
    // Brand ran wf-a with 0 clicks but $500 spend + 100 contacted.
    mockFetch({ brandEmail: [emailGroup("wf-a", 0, 0, 100)] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    expect(a.estimatesByGrain.brand.unitCosts.costPerClickUsd).toBeCloseTo(500, 6); // floor = spentUsd
    expect(a.estimatesByGrain.brand.unitCosts.costPerPositiveReplyUsd).toBeCloseTo(500, 6); // floor
    expect(a.estimatesByGrain.brand.unitCosts.costPerContactedUsd).toBeCloseTo(5, 6); // 500/100 real
    // none null
    for (const g of ["crossOrg", "brand"]) {
      const uc = a.estimatesByGrain[g].unitCosts;
      expect(uc.costPerClickUsd).not.toBeNull();
      expect(uc.costPerPositiveReplyUsd).not.toBeNull();
      expect(uc.costPerContactedUsd).not.toBeNull();
    }
  });

  it("projected non-null when economics present (floor guarantees unit costs > 0)", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    // crossOrg meeting cost = 1/((1/10)·0.05 + (1/20)·0.40) = 1/0.025 = 40
    expect(a.estimatesByGrain.crossOrg.projected.costPerMeetingBookedUsd).toBeCloseTo(40, 3);
    expect(a.estimatesByGrain.crossOrg.projected.costPerSignupUsd).toBeCloseTo(250, 3); // 1/((1/10)·0.04)
    // meeting-booked paid-client = the meeting→paid routes only = costPerMeetingBooked / m2c = 40 / 0.30 = 133.333.
    // (NOT the purchase funnel's 105.60 — that includes the self-serve v2c route, which belongs to the purchase goal.)
    // Coherent: 133.333 ≥ costPerMeetingBooked (40), a paid client is downstream of a booked meeting.
    expect(a.estimatesByGrain.crossOrg.projected.costPerPaidClientUsd).toBeCloseTo(133.3333, 3);
    expect(a.estimatesByGrain.crossOrg.projected.roiMultiple).toBeCloseTo(1000 / 133.3333, 3);
    expect(a.estimatesByGrain.crossOrg.projected.cacPct).toBeCloseTo(100 / (1000 / 133.3333), 3);
  });

  it("SIGNUP goal: costPerPaidClient = costPerSignup / s2pc (coherent, ≥ costPerSignup), NOT the purchase funnel", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=signup`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.goal).toBe("signup");
    const a = rowFor(res.body, "dyn-a");
    const p = a.estimatesByGrain.crossOrg.projected;
    // costPerSignup = 250 (1/((1/10)·0.04)); s2pc = 0.50 → paid = 250/0.50 = 500 = clickUsd/(v2s·s2pc) = 10/(0.04·0.50).
    // This is ABOVE costPerSignup (a paid client requires a signup) and far above the old purchase-funnel 105.60 bug.
    expect(p.costPerSignupUsd).toBeCloseTo(250, 3);
    expect(p.costPerPaidClientUsd).toBeCloseTo(500, 3);
    expect(p.costPerPaidClientUsd).toBeGreaterThanOrEqual(p.costPerSignupUsd);
    expect(p.roiMultiple).toBeCloseTo(1000 / 500, 3); // 2.0×
    expect(p.cacPct).toBeCloseTo(100 / (1000 / 500), 3); // 50%
  });

  it("economics echoed once (non-null); null at cold start with rows still emitted", async () => {
    mockFetch();
    const withEcon = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(withEcon.body.economics.lifetimeRevenueUsd).toBe(1000);
    expect(withEcon.body.economics.visitToSignupPct).toBe(4);

    mockFetch({ economics: null, source: null });
    const cold = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(cold.status).toBe(200);
    expect(cold.body.economics).toBeNull();
    const a = rowFor(cold.body, "dyn-a");
    expect(a.estimatesByGrain.crossOrg.unitCosts.costPerClickUsd).toBeCloseTo(10, 6); // unit costs still real
    expect(a.estimatesByGrain.crossOrg.projected.costPerMeetingBookedUsd).toBeNull();
    expect(a.estimatesByGrain.crossOrg.projected.roiMultiple).toBeNull();
    expect(cold.body.recommendedWorkflowDynastySlug).toBeNull();
    expect(cold.body.recommendedBudgetUsd).toBeNull();
  });

  it("recommended: argmin over resolved.costPerOutcomeUsd; budget = 10 × that cost", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    // dyn-a resolves at brand grain (cpc $20): meeting cost = 1/((1/20)·0.05 + (1/100)·0.40) = 1/0.0065 = 153.846
    // dyn-b resolves at crossOrg (cpc $20, reply $100): meeting = 1/((1/20)·0.05 + (1/100)·0.40) = 153.846 too
    // Both 153.846 → argmin picks the first encountered (dyn-a). recommendedBudget = 10 × 153.846.
    expect(res.body.recommendedWorkflowDynastySlug).toBeTruthy();
    const picked = rowFor(res.body, res.body.recommendedWorkflowDynastySlug);
    expect(res.body.recommendedBudgetUsd).toBeCloseTo(10 * picked.resolved.costPerOutcomeUsd, 2);
  });

  it("audience rows: one per (audienceId × workflow dynasty) couple; audience grain audience-wide, resolves at audience", async () => {
    mockFetch({
      audiences: [{ id: "aud-1" }],
      // aud-1 cost: $400 / (from couples we learn it ran dyn-a). groupBy=audienceId total.
      audienceCost: [{ dimensions: { audienceId: "aud-1" }, totalCostInUsdCents: "40000", runCount: 8 }],
      audienceCouples: [{ dimensions: { audienceId: "aud-1", workflowSlug: "wf-a" }, totalCostInUsdCents: "40000", runCount: 8 }],
      membersByAudience: { "aud-1": ["m1@x.com", "m2@x.com", "m3@x.com", "m4@x.com"] },
      outcomesByEmail: {
        "m1@x.com": { contacted: true, clicked: true },
        "m2@x.com": { contacted: true, clicked: true },
        "m3@x.com": { contacted: true, replied: true, replyClassification: "positive" },
        "m4@x.com": { contacted: true },
      },
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(res.status).toBe(200);

    const audRow = rowFor(res.body, "dyn-a", "aud-1");
    expect(audRow).toBeTruthy();
    expect(audRow.estimatesByGrain.audience).toBeTruthy();
    expect(audRow.estimatesByGrain.crossOrg).toBeTruthy();
    expect(audRow.estimatesByGrain.brand).toBeTruthy();
    // audience: $400 / 2 clicks = $200; 4 contacted; 1 positive reply → $400/1 = $400.
    expect(audRow.estimatesByGrain.audience.evidence.spentUsd).toBeCloseTo(400, 6);
    expect(audRow.estimatesByGrain.audience.evidence.observedClicks).toBe(2);
    expect(audRow.estimatesByGrain.audience.evidence.observedContacted).toBe(4);
    expect(audRow.estimatesByGrain.audience.evidence.observedPositiveReplies).toBe(1);
    expect(audRow.estimatesByGrain.audience.unitCosts.costPerClickUsd).toBeCloseTo(200, 6);
    // resolved at the FINEST grain present → audience.
    expect(audRow.resolved.grain).toBe("audience");
    expect(audRow.resolved.costPerClickUsd).toBeCloseTo(200, 6);
  });

  it("set-completeness: EVERY active audience with cost surfaces an audience grain, even when they share ONE dynasty", async () => {
    // The bug this guards: two audiences whose runs both belong to dyn-a. runs-service's
    // workflowDynastySlug regroup merges by dynasty ALONE, collapsing them to one audience → only 1 of 2
    // surfaced. Grouping on the raw workflowSlug (both here run wf-a) keeps the per-audience split, so
    // BOTH surface with their OWN distinct cost-per-visit (matching /audience-stats' set + numbers).
    mockFetch({
      audiences: [{ id: "aud-1" }, { id: "aud-2" }],
      audienceCost: [
        { dimensions: { audienceId: "aud-1" }, totalCostInUsdCents: "40000", runCount: 8 }, // $400
        { dimensions: { audienceId: "aud-2" }, totalCostInUsdCents: "60000", runCount: 12 }, // $600
      ],
      // BOTH audiences ran ONLY wf-a (→ dyn-a): the exact same-dynasty collapse scenario.
      audienceCouples: [
        { dimensions: { audienceId: "aud-1", workflowSlug: "wf-a" }, totalCostInUsdCents: "40000", runCount: 8 },
        { dimensions: { audienceId: "aud-2", workflowSlug: "wf-a" }, totalCostInUsdCents: "60000", runCount: 12 },
      ],
      membersByAudience: { "aud-1": ["m1@x.com", "m2@x.com"], "aud-2": ["n1@x.com"] },
      outcomesByEmail: {
        "m1@x.com": { contacted: true, clicked: true },
        "m2@x.com": { contacted: true, clicked: true }, // aud-1: 2 clicks → $400/2 = $200
        "n1@x.com": { contacted: true, clicked: true }, // aud-2: 1 click  → $600/1 = $600
      },
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(res.status).toBe(200);

    const a1 = rowFor(res.body, "dyn-a", "aud-1");
    const a2 = rowFor(res.body, "dyn-a", "aud-2");
    // BOTH audiences present at the audience grain (pre-fix, one was dropped by the dynasty collapse).
    expect(a1?.estimatesByGrain.audience).toBeTruthy();
    expect(a2?.estimatesByGrain.audience).toBeTruthy();
    // Each carries its OWN cost-per-visit (spent/clicks) — differentiated, matching /audience-stats.
    expect(a1.estimatesByGrain.audience.unitCosts.costPerClickUsd).toBeCloseTo(200, 6);
    expect(a2.estimatesByGrain.audience.unitCosts.costPerClickUsd).toBeCloseTo(600, 6);
    expect(a1.resolved.grain).toBe("audience");
    expect(a2.resolved.grain).toBe("audience");
  });

  it("grain omission: a grain with spentUsd = 0 is absent from estimatesByGrain", async () => {
    // Brand ran wf-a with 0 cost (should be omitted). crossOrg still present.
    mockFetch({ brandCost: [costGroup("wf-a", 0)] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    expect(a.estimatesByGrain.crossOrg).toBeTruthy();
    expect(a.estimatesByGrain.brand).toBeUndefined();
    expect(a.resolved.grain).toBe("crossOrg");
  });

  it("cascade floor: crossOrg 0 clicks → cpc = own spend (no parent)", async () => {
    // crossOrg wf-a $1000 / 0 clicks → floor to own spend $1000.
    mockFetch({ crossOrgEmail: [emailGroup("wf-a", 0, 0), emailGroup("wf-b", 50, 10)] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    expect(a.estimatesByGrain.crossOrg.unitCosts.costPerClickUsd).toBeCloseTo(1000, 6);
  });

  it("cascade floor: brand 0 clicks, spend BELOW crossOrg cpc → brand cpc = crossOrg cpc", async () => {
    // crossOrg wf-a cpc = $1000/100 = $10. Brand wf-a: $5 spent, 0 clicks → max(5, 10) = $10.
    mockFetch({ brandCost: [costGroup("wf-a", 500)], brandEmail: [emailGroup("wf-a", 0, 0, 100)] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    expect(a.estimatesByGrain.crossOrg.unitCosts.costPerClickUsd).toBeCloseTo(10, 6);
    expect(a.estimatesByGrain.brand.evidence.observedClicks).toBe(0);
    expect(a.estimatesByGrain.brand.unitCosts.costPerClickUsd).toBeCloseTo(10, 6); // floored to crossOrg parent
  });

  it("cascade floor: brand 0 clicks, spend ABOVE crossOrg cpc → brand cpc = own spend", async () => {
    // crossOrg cpc $10. Brand wf-a: $50 spent, 0 clicks → max(50, 10) = $50.
    mockFetch({ brandCost: [costGroup("wf-a", 5000)], brandEmail: [emailGroup("wf-a", 0, 0, 100)] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    expect(a.estimatesByGrain.brand.unitCosts.costPerClickUsd).toBeCloseTo(50, 6);
  });

  it("cascade floor is ITERATIVE: audience 0 clicks floors against BRAND (not crossOrg, not own spend)", async () => {
    // crossOrg cpc $10, brand cpc $20 (default $500/25). Audience $10 spent, 0 clicks →
    // max(10, brand $20) = $20 — proves it used the BRAND parent (finest coarser), not crossOrg ($10) or own spend ($10).
    mockFetch({
      audiences: [{ id: "aud-1" }],
      audienceCost: [{ dimensions: { audienceId: "aud-1" }, totalCostInUsdCents: "1000", runCount: 8 }],
      audienceCouples: [{ dimensions: { audienceId: "aud-1", workflowSlug: "wf-a" }, totalCostInUsdCents: "1000", runCount: 8 }],
      membersByAudience: { "aud-1": ["m1@x.com"] },
      outcomesByEmail: { "m1@x.com": { contacted: true } }, // 0 clicks
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    const audRow = rowFor(res.body, "dyn-a", "aud-1");
    expect(audRow.estimatesByGrain.crossOrg.unitCosts.costPerClickUsd).toBeCloseTo(10, 6);
    expect(audRow.estimatesByGrain.brand.unitCosts.costPerClickUsd).toBeCloseTo(20, 6);
    expect(audRow.estimatesByGrain.audience.evidence.observedClicks).toBe(0);
    expect(audRow.estimatesByGrain.audience.unitCosts.costPerClickUsd).toBeCloseTo(20, 6); // floored to BRAND parent
  });

  it("single-step website_visits: costPerOutcome = RAW CPC (the visit); costPerPaidClient = CPC / v2pc (COHERENT, distinct)", async () => {
    const SINGLE = { ...ECONOMICS, visitToPaidClientPct: 5, replyToPaidClientPct: 20 };
    mockFetch({ economics: SINGLE });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=website_visits`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("website_visits");
    expect(res.body.goal).toBe("websiteVisit");
    expect(res.body.economics.visitToPaidClientPct).toBe(5);
    const a = rowFor(res.body, "dyn-a");
    // crossOrg cpc $10 → paid client 10 / 0.05 = 200
    expect(a.estimatesByGrain.crossOrg.projected.costPerPaidClientUsd).toBeCloseTo(200, 3);
    // brand grain has 25 clicks → MEASURED → resolves at brand (cpc $20).
    expect(a.resolved.grain).toBe("brand");
    // costPerOutcome = the RAW visit cost (CPC $20), NOT the paid-client cost.
    expect(a.resolved.costPerOutcomeUsd).toBeCloseTo(20, 3);
    // costPerPaidClient = CPC / v2pc = 20 / 0.05 = 400 — DISTINCT from the outcome cost (coherent pair).
    expect(a.resolved.costPerPaidClientUsd).toBeCloseTo(400, 3);
    expect(a.resolved.costPerOutcomeUsd).not.toBeCloseTo(a.resolved.costPerPaidClientUsd, 3);
  });

  it("whatsapp_conversations: costPerOutcome = RAW CPC (the WhatsApp-link click); NO paid-client/ROI economics (null-safe)", async () => {
    // brand-service exposes NO whatsapp→paid rate, so costPerPaidClient / ROI / CAC read null.
    mockFetch({ economics: ECONOMICS });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=whatsappConversation`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("whatsapp_conversations");
    expect(res.body.goal).toBe("whatsappConversation");
    const a = rowFor(res.body, "dyn-a");
    // brand grain has 25 clicks → MEASURED → resolves at brand (cpc $20). The click IS the outcome.
    expect(a.resolved.grain).toBe("brand");
    expect(a.resolved.costPerOutcomeUsd).toBeCloseTo(20, 3);
    // No paid-client rate for whatsapp → null (never a false number), and ROI/CAC follow null.
    expect(a.resolved.costPerPaidClientUsd).toBeNull();
    expect(a.resolved.roiMultiple).toBeNull();
    expect(a.resolved.cacPct).toBeNull();
    expect(a.estimatesByGrain.brand.projected.costPerPaidClientUsd).toBeNull();
    // recommendedBudget still rides the (non-null) cost-per-outcome = CPC.
    expect(res.body.recommendedWorkflowDynastySlug).not.toBeNull();
    expect(res.body.recommendedBudgetUsd).toBeGreaterThan(0);
  });

  it("whatsapp_conversations accepts the snake spelling too (whatsapp_conversations)", async () => {
    mockFetch({ economics: ECONOMICS });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=whatsapp_conversations`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("whatsapp_conversations");
    expect(res.body.goal).toBe("whatsappConversation");
  });

  it("DEFECT 2 — positive_replies: costPerOutcome (CPPR) ≠ costPerPaidClient; they differ by the reply→paid rate", async () => {
    // Repro brand's saved economics: reply→paid = 15%. Brand ran wf-a WITH replies (measured) so it
    // resolves at the brand grain: CPPR = $500/5 = $100; paid client = 100 / 0.15 = 666.67. They MUST differ.
    const SINGLE = { ...ECONOMICS, visitToPaidClientPct: 5, replyToPaidClientPct: 15 };
    mockFetch({ economics: SINGLE });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=positive_replies`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("positive_replies");
    expect(res.body.goal).toBe("positiveReply");
    const a = rowFor(res.body, "dyn-a");
    expect(a.resolved.grain).toBe("brand"); // 5 observed replies → measured
    // costPerOutcome = the RAW positive-reply cost (CPPR = brand $500/5 = $100).
    expect(a.resolved.costPerOutcomeUsd).toBeCloseTo(100, 3);
    // costPerPaidClient = CPPR / r2pc = 100 / 0.15 = 666.67 — materially higher, NOT equal.
    expect(a.resolved.costPerPaidClientUsd).toBeCloseTo(100 / 0.15, 3);
    expect(a.resolved.costPerPaidClientUsd).toBeGreaterThan(a.resolved.costPerOutcomeUsd);
  });

  it("DEFECT 1 — positive_replies, brand+audience spend but ZERO replies → provenance is crossOrg (benchmark), NOT this brand/audience", async () => {
    // The exact repro: ~$32 spent on ONE audience, 0 outcomes. Brand + audience grains have spend but 0
    // observed positive replies → their cost is a FLOORED projection, so provenance must NOT be "this
    // brand"/"this audience" — it resolves to the crossOrg fleet benchmark.
    const SINGLE = { ...ECONOMICS, visitToPaidClientPct: 5, replyToPaidClientPct: 15 };
    mockFetch({
      economics: SINGLE,
      brandCost: [costGroup("wf-a", 3200)], // $32 brand spend on wf-a
      brandEmail: [emailGroup("wf-a", 0, 0, 20)], // 0 clicks, 0 replies
      audiences: [{ id: "aud-1" }],
      audienceCost: [{ dimensions: { audienceId: "aud-1" }, totalCostInUsdCents: "3200", runCount: 4 }],
      audienceCouples: [{ dimensions: { audienceId: "aud-1", workflowSlug: "wf-a" }, totalCostInUsdCents: "3200", runCount: 4 }],
      membersByAudience: { "aud-1": ["m1@x.com", "m2@x.com"] },
      outcomesByEmail: { "m1@x.com": { contacted: true }, "m2@x.com": { contacted: true } }, // 0 replies
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=positive_replies`).set(AUTH);
    expect(res.status).toBe(200);

    // crossOrg reply cost = $1000/50 = $20; brand spent $32 on the dynasty (0 replies) → its floored
    // reply cost = max(32, 20) = $32 (brand OUTSPENT the fleet with nothing to show).
    // Brand-level row: LABEL is crossOrg (benchmark, not measured), but the NUMBER stays the brand's own
    // $32 spend floor — NOT collapsed to the fleet $20.
    const brandRow = rowFor(res.body, "dyn-a", null);
    expect(brandRow.estimatesByGrain.brand).toBeTruthy();
    expect(brandRow.estimatesByGrain.brand.evidence.observedPositiveReplies).toBe(0);
    expect(brandRow.resolved.grain).toBe("crossOrg"); // LABEL: NOT "brand" — no measured outcome
    expect(brandRow.resolved.costPerOutcomeUsd).toBeCloseTo(32, 3); // NUMBER: brand spend floor, NOT fleet $20
    expect(brandRow.resolved.costPerOutcomeUsd).not.toBeCloseTo(20, 3);

    // Audience row: audience + brand grains have spend but 0 replies → LABEL crossOrg, NUMBER = audience
    // spend floor ($32), still brand/audience-specific (Kevin's cascade preserved, not fleet-collapsed).
    const audRow = rowFor(res.body, "dyn-a", "aud-1");
    expect(audRow.estimatesByGrain.audience).toBeTruthy();
    expect(audRow.estimatesByGrain.audience.evidence.observedPositiveReplies).toBe(0);
    expect(audRow.resolved.grain).toBe("crossOrg"); // LABEL: NOT "audience" — projection, not measured
    expect(audRow.resolved.costPerOutcomeUsd).toBeCloseTo(32, 3); // NUMBER: own spend floor
    // paid client still coherent (= outcome cost / 0.15), distinct from the outcome cost.
    expect(audRow.resolved.costPerPaidClientUsd).toBeCloseTo(32 / 0.15, 2);
  });

  it("DEFECT 1 — number keeps the brand spend floor even when brand OUTSPENT the fleet (not collapsed to crossOrg)", async () => {
    // crossOrg wf-a reply cost = $1000/50 = $20. Brand ran wf-a: $200 spent, 0 replies → floored reply
    // cost = max(200, 20) = $200. resolved NUMBER must be $200 (brand's own burn), LABEL crossOrg.
    const SINGLE = { ...ECONOMICS, replyToPaidClientPct: 15 };
    mockFetch({ economics: SINGLE, brandCost: [costGroup("wf-a", 20000)], brandEmail: [emailGroup("wf-a", 0, 0, 50)] });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=positive_replies`).set(AUTH);
    const a = rowFor(res.body, "dyn-a", null);
    expect(a.estimatesByGrain.brand.unitCosts.costPerPositiveReplyUsd).toBeCloseTo(200, 3); // floor = own spend
    expect(a.resolved.grain).toBe("crossOrg"); // benchmark label (no measured outcome)
    expect(a.resolved.costPerOutcomeUsd).toBeCloseTo(200, 3); // NUMBER = brand floor, NOT fleet $20
  });

  it("DEFECT 1 no-regression — a brand WITH real observed replies keeps the brand provenance", async () => {
    // Default brand grain: 5 observed replies → the brand's cost IS measured → provenance stays "brand".
    const SINGLE = { ...ECONOMICS, replyToPaidClientPct: 15 };
    mockFetch({ economics: SINGLE });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&objective=positive_replies`).set(AUTH);
    const a = rowFor(res.body, "dyn-a");
    expect(a.estimatesByGrain.brand.evidence.observedPositiveReplies).toBe(5);
    expect(a.resolved.grain).toBe("brand");
  });

  it("single-step goal with the rate field ABSENT → fail loud (502)", async () => {
    mockFetch({ economics: ECONOMICS }); // no visitToPaidClientPct
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=website_visits`).set(AUTH);
    expect(res.status).toBe(502);
  });

  it("COMBINED sales goal: cost-per-outcome == cost-per-paid-client == cost-per-sale (best-channel MIN); ROI = CLTV / cost-per-sale", async () => {
    const SINGLE = { ...ECONOMICS, visitToPaidClientPct: 5, replyToPaidClientPct: 20 };
    mockFetch({ economics: SINGLE });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=sales`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.objective).toBe("sales");
    expect(res.body.goal).toBe("sales");
    // echoes BOTH single-step rates it unions
    expect(res.body.economics.visitToPaidClientPct).toBe(5);
    expect(res.body.economics.replyToPaidClientPct).toBe(20);
    const a = rowFor(res.body, "dyn-a");
    expect(a.resolved.grain).toBe("brand"); // measured (brand has clicks + replies)
    // brand unit costs: cpc $20, cppr $100. visit path = 20/0.05 = $400 ; reply path = 100/0.20 = $500.
    // Combined = MIN (the best-converting channel), NEVER below either single path.
    const expectedSaleCost = Math.min(20 / 0.05, 100 / 0.2); // 400
    expect(a.resolved.costPerOutcomeUsd).toBeCloseTo(expectedSaleCost, 2);
    expect(a.resolved.costPerOutcomeUsd).toBeCloseTo(400, 2);
    // For the combined goal the OUTCOME *is* the paying client → the two are EQUAL (unlike single-step,
    // where they differ by the visit/reply→paid rate).
    expect(a.resolved.costPerPaidClientUsd).toBeCloseTo(a.resolved.costPerOutcomeUsd, 6);
    // ROI = CLTV / cost-per-sale = 1000 / 400 = 2.5 ; cacPct = 100 / ROI.
    expect(a.resolved.roiMultiple).toBeCloseTo(1000 / a.resolved.costPerPaidClientUsd, 5);
    expect(a.resolved.roiMultiple).toBeCloseTo(2.5, 3);
    expect(a.resolved.cacPct).toBeCloseTo(100 / 2.5, 3);
  });

  it("COMBINED sales with a paid-client rate ABSENT → fail loud (502)", async () => {
    mockFetch({ economics: ECONOMICS }); // no visitToPaidClientPct / replyToPaidClientPct
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=sales`).set(AUTH);
    expect(res.status).toBe(502);
  });

  it("website_purchase goal (renamed `purchase`): echoes website_purchase/websitePurchase; legacy `purchase` input still accepted", async () => {
    mockFetch({ economics: ECONOMICS });
    const wp = await request(app).get(`${URL_BASE}?brandId=b1&goal=websitePurchase`).set(AUTH);
    expect(wp.status).toBe(200);
    expect(wp.body.objective).toBe("website_purchase");
    expect(wp.body.goal).toBe("websitePurchase");
    const a = rowFor(wp.body, "dyn-a");
    // Multi-step self-serve/meeting close funnel cost (unchanged math) — a real positive number.
    expect(a.resolved.costPerOutcomeUsd).toBeGreaterThan(0);
    // legacy `purchase` input → SAME renamed echo (input tolerance during the fleet transition)
    mockFetch({ economics: ECONOMICS });
    const legacy = await request(app).get(`${URL_BASE}?brandId=b1&goal=purchase`).set(AUTH);
    expect(legacy.body.objective).toBe("website_purchase");
    expect(legacy.body.goal).toBe("websitePurchase");
  });

  it("unknown goal → 400 (fail loud, never a silent meeting-booked default)", async () => {
    mockFetch({ economics: ECONOMICS });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=bogusGoal`).set(AUTH);
    expect(res.status).toBe(400);
  });

  it("502 when a downstream source fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/v1/stats/public/costs")) return new Response("boom", { status: 500 });
      if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
      return json({});
    });
    const res = await request(app).get(`${URL_BASE}?brandId=b1&goal=meetingBooked`).set(AUTH);
    expect(res.status).toBe(502);
  });
});
