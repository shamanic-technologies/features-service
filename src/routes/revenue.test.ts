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
process.env.OUTLETS_SERVICE_URL = "http://outlets:3000";
process.env.OUTLETS_SERVICE_API_KEY = "outlets-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.JOURNALISTS_SERVICE_URL = "http://journalists:3000";
process.env.JOURNALISTS_SERVICE_API_KEY = "journalists-key";
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const { __resetPlatformRatesCache } = await import("../lib/platform-rates-client.js");
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
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10, // 0.20 × 0.10 = 0.02 = visitToClosePct
  visitToClosePct: 2,
};

// Platform funnel: sent/contacted=1, delivered/sent=1, clicked/delivered=0.1, posReply/delivered=0.1
//   pClose_click=orP(0.02, 0.015)=0.0347, pClose_reply=0.12, pClose_deliv=orP(0.1·0.0347, 0.1·0.12)=0.0154284
//   → contacted=sent=delivered EV = 1000·0.0154284 = 15.4284 ; click EV = 34.7 ; reply EV = 120
const PLATFORM_STATS = {
  broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, clicked: 10, repliesPositive: 10 } },
};

function leadRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    leadId: "l1",
    email: "l1@x.com",
    contacted: true,
    sent: true,
    delivered: true,
    clicked: false,
    bounced: false,
    unsubscribed: false,
    replied: false,
    replyClassification: null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } },
    ...over,
  };
}

/** email → first*At, mapped onto the email-gateway /orgs/status brand-scope shape. */
type Timestamps = Record<string, { firstContactedAt?: string | null; firstSentAt?: string | null; firstDeliveredAt?: string | null; firstOpenedAt?: string | null; firstClickedAt?: string | null; firstRepliedAt?: string | null }>;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

/** runs-service /v1/stats/costs response carrying a single workflow group of `cents`. */
function costGroups(cents: number): string {
  return JSON.stringify({ groups: [{ dimensions: {}, totalCostInUsdCents: String(cents), runCount: 0, minStartedAt: null, maxStartedAt: null }] });
}

/** email → first meeting-booked / closed manual-qualification timestamps. */
type Qualifications = Record<string, { meetingBookedAt?: string; closedAt?: string }>;

/** Map the `quals` fixture into email-gateway /orgs/manual-qualifications rows (sorted DESC IRL; order-agnostic here). */
function qualRows(quals: Qualifications): unknown[] {
  const rows: unknown[] = [];
  for (const [email, q] of Object.entries(quals)) {
    if (q.meetingBookedAt) rows.push({ id: `q-${email}-m`, orgId: "org-1", campaignId: "c1", instantlyCampaignId: "ic1", email, status: "lead_meeting_booked", qualifiedBy: "u1", notes: null, qualifiedAt: q.meetingBookedAt });
    if (q.closedAt) rows.push({ id: `q-${email}-c`, orgId: "org-1", campaignId: "c1", instantlyCampaignId: "ic1", email, status: "lead_closed", qualifiedBy: "u1", notes: null, qualifiedAt: q.closedAt });
  }
  return rows;
}

/** Route fetch mock keyed by URL substring. effective economics (saved set + cross-brand average) + leads + status timestamps + manual quals + platform stats + cost overridable. */
function mockFetch(opts: { economics?: unknown; economicsAverage?: unknown; leads?: unknown[]; timestamps?: Timestamps; quals?: Qualifications; qualRowsRaw?: unknown[]; platformStats?: unknown; costCents?: number } = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    if (url.includes("/stats/costs")) {
      return new Response(costGroups(opts.costCents ?? 0), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // brand-service /orgs/brands/:brandId/sales-economics-effective — ONE call returning
    // { economics, source }. Synthesize from fixtures: a saved set → "user"; else the cross-brand
    // average → "cross-brand-average"; else cold start → { economics: null, source: null }.
    if (url.includes("/sales-economics-effective")) {
      const effective =
        opts.economics != null
          ? { economics: opts.economics, source: "user" }
          : opts.economicsAverage != null
            ? { economics: opts.economicsAverage, source: "cross-brand-average" }
            : { economics: null, source: null };
      return new Response(JSON.stringify(effective), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/public/stats")) {
      return new Response(JSON.stringify(opts.platformStats ?? PLATFORM_STATS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/manual-qualifications")) {
      const qualifications = opts.qualRowsRaw ?? qualRows(opts.quals ?? {});
      return new Response(JSON.stringify({ qualifications }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orgs/leads")) {
      return new Response(JSON.stringify({ leads: opts.leads ?? [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orgs/status")) {
      const ts = opts.timestamps ?? {};
      const results = Object.entries(ts).map(([email, scope]) => ({
        email,
        broadcast: { byCampaign: null, campaign: null, brand: { contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: true, replyClassification: "positive", bounced: false, unsubscribed: false, lastDeliveredAt: null, ...scope }, global: { email: { bounced: false, unsubscribed: false } } },
      }));
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // runs-service trace events etc. — ignore
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("GET /features/:featureSlug/revenue", () => {
  beforeEach(() => {
    __resetPlatformRatesCache();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("400 when brandId missing", async () => {
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue").set(AUTH);
    expect(res.status).toBe(400);
  });

  it("404 when feature not found", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(undefined as any);
    const res = await request(app).get("/features/unknown/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(404);
  });

  it("null pipeline when feature has no funnel wired (economicsSource null)", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue({ ...SALES_FEATURE, slug: "pr-cold-email-outreach" } as any);
    mockFetch();
    const res = await request(app).get("/features/pr-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.headline.economicsSource).toBeNull();
    expect(res.body.organizations).toEqual([]);
  });

  it("null pipeline when brand has no saved economics AND no cross-brand average (cold start)", async () => {
    mockFetch({ economics: null }); // no saved + no average → effective { economics: null, source: null }
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.headline.economicsSource).toBeNull();
    expect(res.body.leads).toEqual([]);
  });

  const HAPPY_LEADS = [
    leadRow({ leadId: "l1", email: "click@x.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } } }),
    leadRow({ leadId: "l2", email: "reply@y.com", replied: true, replyClassification: "positive", lead: { firstName: "Reply", lastName: "Y", photoUrl: null, organization: { id: "o2", name: "Org2", logoUrl: null } } }),
  ];

  it("happy path with per-event timestamps — headline + tables + timeSeries + events", async () => {
    // Dates within the reply→meeting window (14d): a bare positive reply now decays under Phase 2,
    // so the happy-path reply must be recent. click (visit) is terminal and never decays. Compute
    // once and reuse so the engine's pass-through dates match the assertions deterministically.
    const clickAt = daysAgo(13);
    const replyAt = daysAgo(5);
    mockFetch({
      economics: ECONOMICS,
      leads: HAPPY_LEADS,
      timestamps: {
        "click@x.com": { firstClickedAt: clickAt },
        "reply@y.com": { firstRepliedAt: replyAt },
      },
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    // o1: visit EV 34.7, o2: reply EV 120 → total 154.7
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(154.7, 5);
    expect(res.body.headline.economicsSource).toBe("sales-economics"); // brand's own saved set
    expect(res.body.organizations).toHaveLength(2);
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.organizations[0].expectedRevenueUsd).toBe(120); // reply org first (furthest stage), EV desc
    expect(res.body.timeSeries).toHaveLength(2);
    expect(res.body.timeSeries[0].date).toBe(clickAt); // older click first
    expect(res.body.timeSeries[0].cumulativePipelineUsd).toBeCloseTo(34.7, 5);
    expect(res.body.timeSeries[1].date).toBe(replyAt); // then reply
    expect(res.body.timeSeries[1].cumulativePipelineUsd).toBeCloseTo(154.7, 5);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events.find((e: any) => e.eventType === "reply").eventDate).toBe(replyAt);
  });

  it("cross-brand-average fallback — no saved economics but average exists → computed + tagged estimate", async () => {
    // brand-service returns the cross-brand average (source "cross-brand-average") → same math as the
    // happy path, now tagged provenance so the dashboard can badge it estimated.
    mockFetch({
      economics: null,
      economicsAverage: ECONOMICS,
      leads: HAPPY_LEADS,
      timestamps: { "click@x.com": { firstClickedAt: daysAgo(13) }, "reply@y.com": { firstRepliedAt: daysAgo(5) } },
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(154.7, 5); // visit 34.7 + reply 120, computed on the average
    expect(res.body.headline.economicsSource).toBe("cross-brand-average");
    expect(res.body.leads).toHaveLength(2);
  });

  it("one lead with BOTH click + positive reply → combined route EV (independent-probability SUM)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "lboth", email: "both@x.com", clicked: true, replied: true, replyClassification: "positive", lead: { firstName: "Bo", lastName: "Th", photoUrl: null, organization: { id: "ob", name: "OrgB", logoUrl: null } } })],
      timestamps: { "both@x.com": { firstClickedAt: daysAgo(5), firstRepliedAt: daysAgo(5) } }, // reply within its 14d window → alive
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    // LTR=1000, visit EV 34.7 + reply EV 120 → combined 1000·(1−(1−0.0347)(1−0.12)) = 150.536 (> MAX 120, < sum 154.7)
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(150.536, 5);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].expectedRevenueUsd).toBeCloseTo(150.536, 5);
    expect(res.body.leads[0].tags.sort()).toEqual(["reply", "visit"]);
  });

  it("earns stage EV from Contacted/Delivered onward (no click or reply)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l3", email: "cold@z.com", lead: { firstName: "Cold", lastName: "Z", photoUrl: null, organization: { id: "o3", name: "Org3", logoUrl: null } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(15.42836, 4); // delivered-stage EV, no click/reply
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].expectedRevenueUsd).toBeCloseTo(15.42836, 4);
    expect(res.body.leads[0].tags).toContain("delivered");
    expect(res.body.events).toEqual([]); // delivery-stage events are not itemised
  });

  it("bounced lead earns no expected revenue (excluded even if clicked)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l4", email: "bounce@z.com", clicked: true, bounced: true })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
    expect(res.body.leads).toEqual([]);
  });

  // ── Outcome lenses (?lens=) ───────────────────────────────────────────────────

  const LENS_LEADS = [
    leadRow({ leadId: "lc", email: "click@x.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "oc", name: "OrgC", logoUrl: null } } }),
    leadRow({ leadId: "lr", email: "reply@y.com", replied: true, replyClassification: "positive", lead: { firstName: "Reply", lastName: "Y", photoUrl: null, organization: { id: "or", name: "OrgR", logoUrl: null } } }),
    leadRow({ leadId: "lb", email: "both@z.com", clicked: true, replied: true, replyClassification: "positive", lead: { firstName: "Bo", lastName: "Th", photoUrl: null, organization: { id: "ob", name: "OrgB", logoUrl: null } } }),
    leadRow({ leadId: "lcold", email: "cold@w.com", lead: { firstName: "Cold", lastName: "W", photoUrl: null, organization: { id: "ow", name: "OrgW", logoUrl: null } } }),
  ];

  it("lens=signups — only clicked leads; prob == v2s, revenue == (v2s/100)·LTR", async () => {
    mockFetch({ economics: ECONOMICS, leads: LENS_LEADS });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&lens=signups").set(AUTH);
    expect(res.status).toBe(200);
    // clicked leads = lc + lb (the both-signals lead clicked too); reply-only + cold excluded
    expect(res.body.leads.map((l: any) => l.leadId).sort()).toEqual(["lb", "lc"]);
    for (const lead of res.body.leads) {
      expect(lead.conversionProbabilityPct).toBe(20); // v2s
      expect(lead.expectedRevenueUsd).toBeCloseTo(200, 6); // (20/100)·1000
    }
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(400, 6); // 2 leads × 200
    expect(res.body.headline.economicsSource).toBe("sales-economics");
    expect(res.body.organizations).toEqual([]);
    expect(res.body.timeSeries).toEqual([]);
    expect(res.body.events).toEqual([]);
  });

  it("lens=booked-meetings — only positive-reply leads; prob == r2m, revenue == (r2m/100)·LTR", async () => {
    mockFetch({ economics: ECONOMICS, leads: LENS_LEADS });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&lens=booked-meetings").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.leads.map((l: any) => l.leadId).sort()).toEqual(["lb", "lr"]); // reply leads = lr + lb
    for (const lead of res.body.leads) {
      expect(lead.conversionProbabilityPct).toBe(40); // r2m
      expect(lead.expectedRevenueUsd).toBeCloseTo(400, 6); // (40/100)·1000
    }
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(800, 6); // 2 leads × 400
  });

  it("lens=sales — clicked-or-reply union; combined-OR per lead; both-signals > either single & ≤100", async () => {
    mockFetch({ economics: ECONOMICS, leads: LENS_LEADS });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&lens=sales").set(AUTH);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.leads.map((l: any) => [l.leadId, l]));
    expect(Object.keys(byId).sort()).toEqual(["lb", "lc", "lr"]); // cold excluded
    // pClick = orP(0.02, 0.05·0.30) = 0.0347 → 3.47% / $34.7
    expect(byId.lc.conversionProbabilityPct).toBeCloseTo(3.47, 6);
    expect(byId.lc.expectedRevenueUsd).toBeCloseTo(34.7, 6);
    // pReply = 0.40·0.30 = 0.12 → 12% / $120
    expect(byId.lr.conversionProbabilityPct).toBeCloseTo(12, 6);
    expect(byId.lr.expectedRevenueUsd).toBeCloseTo(120, 6);
    // both = orP(0.0347, 0.12) = 0.150536 → 15.0536% / $150.536
    expect(byId.lb.conversionProbabilityPct).toBeCloseTo(15.0536, 6);
    expect(byId.lb.expectedRevenueUsd).toBeCloseTo(150.536, 6);
    // both-signals strictly > either single, and ≤ 100
    expect(byId.lb.conversionProbabilityPct).toBeGreaterThan(byId.lc.conversionProbabilityPct);
    expect(byId.lb.conversionProbabilityPct).toBeGreaterThan(byId.lr.conversionProbabilityPct);
    expect(byId.lb.conversionProbabilityPct).toBeLessThanOrEqual(100);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(34.7 + 120 + 150.536, 5);
  });

  it("lens with no matching leads → empty leads + 0 pipeline", async () => {
    mockFetch({ economics: ECONOMICS, leads: [LENS_LEADS[3]] }); // only the cold lead
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&lens=signups").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.leads).toEqual([]);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
  });

  it("invalid lens value → 400", async () => {
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&lens=bogus").set(AUTH);
    expect(res.status).toBe(400);
  });

  it("no lens → leads carry NO conversionProbabilityPct (back-compat)", async () => {
    mockFetch({ economics: ECONOMICS, leads: HAPPY_LEADS });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.leads.length).toBeGreaterThan(0);
    for (const lead of res.body.leads) expect(lead).not.toHaveProperty("conversionProbabilityPct");
  });

  // ── orgDomain (for logo.dev) ──────────────────────────────────────────────────

  it("orgDomain — organization.primaryDomain surfaced on organizations[] and leads[]", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l1", email: "click@cascobay.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Casco Bay", logoUrl: null, primaryDomain: "cascobay.com" } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.organizations[0].orgDomain).toBe("cascobay.com");
    expect(res.body.leads[0].orgDomain).toBe("cascobay.com");
  });

  it("orgDomain — falls back to a domain parsed from websiteUrl when primaryDomain is null", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l1", email: "click@cascobay.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Casco Bay", logoUrl: null, primaryDomain: null, websiteUrl: "https://www.cascobay.com/about" } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.organizations[0].orgDomain).toBe("cascobay.com"); // protocol + www + path stripped
    expect(res.body.leads[0].orgDomain).toBe("cascobay.com");
  });

  it("orgDomain — null when neither primaryDomain nor websiteUrl is known", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "l1", email: "click@x.com", clicked: true, lead: { firstName: "Click", lastName: "X", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } } })],
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.organizations[0].orgDomain).toBeNull();
    expect(res.body.leads[0].orgDomain).toBeNull();
  });

  it("502 when platform rates (/public/stats) fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200 });
      if (url.includes("/sales-economics-effective")) return new Response(JSON.stringify({ economics: ECONOMICS, source: "user" }), { status: 200 });
      if (url.includes("/public/stats")) return new Response("boom", { status: 500 });
      if (url.includes("/orgs/leads")) return new Response(JSON.stringify({ leads: HAPPY_LEADS }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(502);
  });

  it("degrades to dateless (still 200, pipeline correct) when email-gateway /orgs/status fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200 });
      if (url.includes("/sales-economics-effective")) return new Response(JSON.stringify({ economics: ECONOMICS, source: "user" }), { status: 200 });
      if (url.includes("/orgs/leads")) return new Response(JSON.stringify({ leads: HAPPY_LEADS }), { status: 200 });
      if (url.includes("/orgs/status")) return new Response("boom", { status: 502 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(154.7, 5); // pipeline still exact
    expect(res.body.timeSeries).toEqual([]); // enrichment absent
    expect(res.body.events).toEqual([]);
    expect(res.body.leads[0].date).toBeNull();
  });

  it("502 when lead-service fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200 });
      if (url.includes("/sales-economics-effective")) return new Response(JSON.stringify({ economics: ECONOMICS, source: "user" }), { status: 200 });
      if (url.includes("/orgs/leads")) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(502);
  });

  // ── costEconomics ───────────────────────────────────────────────────────────

  it("costEconomics — normal: finite cost-of-acquisition % and ROI multiple", async () => {
    mockFetch({ economics: ECONOMICS, leads: HAPPY_LEADS, costCents: 7000 }); // $70 cost, pipeline 154.7
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(154.7, 5);
    expect(res.body.costEconomics.totalCostUsd).toBe(70);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBeCloseTo((70 / 154.7) * 100, 4); // 70/154.7*100
    expect(res.body.costEconomics.roiMultiple).toBeCloseTo(154.7 / 70, 4); // 154.7/70
  });

  it("costEconomics — null pipeline (no economics): both ratios null, totalCostUsd real", async () => {
    mockFetch({ economics: null, costCents: 5000 });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.costEconomics.totalCostUsd).toBe(50);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBeNull();
    expect(res.body.costEconomics.roiMultiple).toBeNull();
  });

  it("costEconomics — null pipeline (no funnel): present with both ratios null", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue({ ...SALES_FEATURE, slug: "pr-cold-email-outreach" } as any);
    mockFetch({ costCents: 3000 });
    const res = await request(app).get("/features/pr-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeNull();
    expect(res.body.costEconomics.totalCostUsd).toBe(30);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBeNull();
    expect(res.body.costEconomics.roiMultiple).toBeNull();
  });

  it("costEconomics — zero cost: roiMultiple null, costOfAcquisitionPct 0", async () => {
    mockFetch({ economics: ECONOMICS, leads: HAPPY_LEADS, costCents: 0 }); // pipeline 154.7, no cost
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(154.7, 5);
    expect(res.body.costEconomics.totalCostUsd).toBe(0);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBe(0);
    expect(res.body.costEconomics.roiMultiple).toBeNull();
  });

  it("502 (fail-loud) when runs-service /v1/stats/costs fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response("boom", { status: 500 });
      if (url.includes("/sales-economics-effective")) return new Response(JSON.stringify({ economics: ECONOMICS, source: "user" }), { status: 200 });
      if (url.includes("/orgs/leads")) return new Response(JSON.stringify({ leads: HAPPY_LEADS }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(502);
  });

  // ── decay (stall phase-out) ───────────────────────────────────────────────

  it("maps firstOpenedAt → opened stage (alive, tag opened)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "lo", email: "open@x.com", lead: { firstName: "Op", lastName: "En", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } } })],
      timestamps: { "open@x.com": { firstDeliveredAt: daysAgo(3), firstOpenedAt: daysAgo(2) } },
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(15.42836, 4); // opened carries delivered-stage EV
    expect(res.body.leads[0].tags).toContain("opened");
  });

  it("stalled lead drops off the total but stays in the leads table with a stale tag", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [leadRow({ leadId: "lc", email: "cold@x.com", sent: false, delivered: false, lead: { firstName: "Co", lastName: "Ld", photoUrl: null, organization: { id: "o9", name: "Org9", logoUrl: null } } })],
      timestamps: { "cold@x.com": { firstContactedAt: daysAgo(20) } }, // contacted 20d ago, window 7d
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
    expect(res.body.organizations).toEqual([]);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].expectedRevenueUsd).toBe(0);
    expect(res.body.leads[0].tags).toContain("stale");
  });

  // ── Phase 2: post-engagement decay + close-win (manual-qualification enrichment) ───

  const REPLY_LEAD = (over: Record<string, unknown> = {}) =>
    leadRow({ leadId: "lr", email: "reply@x.com", replied: true, replyClassification: "positive", lead: { firstName: "Re", lastName: "Ply", photoUrl: null, organization: { id: "or", name: "OrgR", logoUrl: null } }, ...over });

  it("meeting-booked enrichment → meeting stage EV (300), tag meeting, alive (resets the reply clock)", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [REPLY_LEAD()],
      timestamps: { "reply@x.com": { firstRepliedAt: daysAgo(20) } }, // reply 20d ago alone would decay (14d window)
      quals: { "reply@x.com": { meetingBookedAt: daysAgo(5) } },      // …but a meeting 5d ago resets the clock
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(300); // meeting EV bump over reply's 120
    expect(res.body.leads[0].expectedRevenueUsd).toBe(300);
    expect(res.body.leads[0].tags).toContain("meeting");
    expect(res.body.leads[0].tags).not.toContain("stale");
  });

  it("closed-won enrichment → books full LTR (1000), tag closeWin, never decays even if old", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [REPLY_LEAD()],
      timestamps: { "reply@x.com": { firstRepliedAt: daysAgo(420) } },
      quals: { "reply@x.com": { meetingBookedAt: daysAgo(410), closedAt: daysAgo(400) } },
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(1000); // full LTR realized
    expect(res.body.leads[0].expectedRevenueUsd).toBe(1000);
    expect(res.body.leads[0].tags).toContain("closeWin");
    expect(res.body.leads[0].tags).not.toContain("stale");
  });

  it("positive-reply lead with no meeting within 14d decays out (stale), no qualification data", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: [REPLY_LEAD()],
      timestamps: { "reply@x.com": { firstRepliedAt: daysAgo(20) } }, // reply 20d ago, window 14d, no meeting
      quals: {},
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
    expect(res.body.organizations).toEqual([]);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].expectedRevenueUsd).toBe(0);
    expect(res.body.leads[0].tags).toEqual(["reply", "stale"]);
  });

  it("degrades (still 200, Phase 1 pipeline correct) when /orgs/manual-qualifications fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200 });
      if (url.includes("/sales-economics-effective")) return new Response(JSON.stringify({ economics: ECONOMICS, source: "user" }), { status: 200 });
      if (url.includes("/public/stats")) return new Response(JSON.stringify(PLATFORM_STATS), { status: 200 });
      if (url.includes("/manual-qualifications")) return new Response("boom", { status: 502 });
      if (url.includes("/orgs/leads")) return new Response(JSON.stringify({ leads: HAPPY_LEADS }), { status: 200 });
      if (url.includes("/orgs/status")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(154.7, 5); // click 34.7 + reply 120, unaffected by missing quals
  });

  it("logs a warning (no silent truncation) when manual-qualifications returns the 500-row cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const capped = Array.from({ length: 500 }, (_, i) => ({
      id: `q${i}`, orgId: "org-1", campaignId: "c1", instantlyCampaignId: "ic1",
      email: `lead${i}@x.com`, status: "lead_meeting_booked", qualifiedBy: "u1", notes: null, qualifiedAt: daysAgo(1),
    }));
    mockFetch({ economics: ECONOMICS, leads: HAPPY_LEADS, qualRowsRaw: capped });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(warnSpy.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("manual-qualifications hit 500-row cap"))).toBe(true);
  });

  it("Wave A fires its four independent downstream calls concurrently, not sequentially", async () => {
    // Gate every Wave-A URL on a barrier that only releases once ALL FOUR are in flight. Parallel
    // code (Promise.all) drives inFlight to 4 → barrier releases → all resolve. Sequential awaits
    // would stall the first call on the barrier forever (inFlight stuck at 1) → vitest timeout. So
    // the test PASSING is itself proof of concurrency; a regression to sequential awaits times out.
    const WAVE_A = ["/stats/costs", "/sales-economics-effective", "/public/stats", "/orgs/leads"];
    let inFlight = 0;
    let releaseAll!: () => void;
    const allInFlight = new Promise<void>((r) => { releaseAll = r; });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      if (WAVE_A.some((p) => url.includes(p))) {
        inFlight += 1;
        if (inFlight === WAVE_A.length) releaseAll();
        await allInFlight; // sequential code deadlocks here; parallel code sails through
      }
      if (url.includes("/stats/costs")) return new Response(costGroups(0), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
      if (url.includes("/public/stats")) return json(PLATFORM_STATS);
      if (url.includes("/orgs/leads")) return json({ leads: HAPPY_LEADS });
      if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
      if (url.includes("/orgs/status")) return json({ results: [] });
      return json({});
    });

    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(res.status).toBe(200);
    expect(inFlight).toBe(WAVE_A.length); // all four were in flight simultaneously
  });
});

// ── GET /features/:featureSlug/revenue?groupBy=campaignId ─────────────────────

/** One campaign's downstream fixtures, keyed below by the x-campaign-id header every client sets. */
type CampaignFixture = { costCents?: number; leads?: unknown[]; timestamps?: Timestamps; quals?: Qualifications };

/**
 * Grouped-path fetch mock. The runs enumeration call (groupBy=campaignId, NO x-campaign-id)
 * returns one group per campaign; every other call is keyed by the x-campaign-id header so the
 * standalone ?campaignId= call and the grouped sub-computation hit byte-identical downstream data.
 */
function mockFetchGrouped(opts: { economics?: unknown; economicsAverage?: unknown; platformStats?: unknown; campaigns: Record<string, CampaignFixture> }): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const cid = (init?.headers as Record<string, string> | undefined)?.["x-campaign-id"];

    if (url.includes("/stats/costs")) {
      // Enumeration: groupBy=campaignId, no campaign header → one group per campaign.
      if (url.includes("groupBy=campaignId")) {
        const groups = Object.entries(opts.campaigns).map(([id, c]) => ({
          dimensions: { campaignId: id }, totalCostInUsdCents: String(c.costCents ?? 0), runCount: 0, minStartedAt: null, maxStartedAt: null,
        }));
        return new Response(JSON.stringify({ groups }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // Per-campaign cost: groupBy=workflowSlug + x-campaign-id → single group with that campaign's cost.
      return new Response(costGroups(cid ? (opts.campaigns[cid]?.costCents ?? 0) : 0), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/sales-economics-effective")) {
      const effective =
        opts.economics != null
          ? { economics: opts.economics, source: "user" }
          : opts.economicsAverage != null
            ? { economics: opts.economicsAverage, source: "cross-brand-average" }
            : { economics: null, source: null };
      return new Response(JSON.stringify(effective), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/public/stats")) {
      return new Response(JSON.stringify(opts.platformStats ?? PLATFORM_STATS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/manual-qualifications")) {
      return new Response(JSON.stringify({ qualifications: qualRows(cid ? (opts.campaigns[cid]?.quals ?? {}) : {}) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orgs/leads")) {
      return new Response(JSON.stringify({ leads: cid ? (opts.campaigns[cid]?.leads ?? []) : [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/orgs/status")) {
      const ts = (cid ? opts.campaigns[cid]?.timestamps : {}) ?? {};
      const results = Object.entries(ts).map(([email, scope]) => ({
        email,
        broadcast: { byCampaign: null, campaign: null, brand: { contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: true, replyClassification: "positive", bounced: false, unsubscribed: false, lastDeliveredAt: null, ...scope }, global: { email: { bounced: false, unsubscribed: false } } },
      }));
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("GET /features/:featureSlug/revenue?groupBy=campaignId", () => {
  beforeEach(() => {
    __resetPlatformRatesCache();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  const replyLead = (org: string) => leadRow({ leadId: `lr-${org}`, email: `reply-${org}@x.com`, replied: true, replyClassification: "positive", lead: { firstName: "Re", lastName: "Ply", photoUrl: null, organization: { id: org, name: org, logoUrl: null } } });
  const deliveredLead = (org: string) => leadRow({ leadId: `ld-${org}`, email: `cold-${org}@z.com`, lead: { firstName: "Co", lastName: "Ld", photoUrl: null, organization: { id: org, name: org, logoUrl: null } } });

  it("returns one LEAN group per campaign with runs (campaignId + headline + costEconomics only)", async () => {
    mockFetchGrouped({
      economics: ECONOMICS,
      campaigns: {
        c1: { costCents: 7000, leads: [replyLead("o1")] },     // reply EV 120, $70 cost
        c2: { costCents: 1000, leads: [deliveredLead("o2")] }, // delivered EV 15.4284, $10 cost
      },
    });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=campaignId").set(AUTH);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["featureSlug", "groupBy", "groups"]);
    expect(res.body.featureSlug).toBe("sales-cold-email-outreach");
    expect(res.body.groupBy).toBe("campaignId");
    expect(res.body.groups).toHaveLength(2);
    // Each group is lean — exactly campaignId + headline + costEconomics, no timeSeries/orgs/leads/events.
    for (const g of res.body.groups) {
      expect(Object.keys(g).sort()).toEqual(["campaignId", "costEconomics", "headline"]);
    }
    const byId = Object.fromEntries(res.body.groups.map((g: any) => [g.campaignId, g]));
    expect(byId.c1.headline.totalPipelineUsd).toBe(120);
    expect(byId.c1.costEconomics.totalCostUsd).toBe(70);
    expect(byId.c1.costEconomics.roiMultiple).toBeCloseTo(120 / 70, 5);
    expect(byId.c2.headline.totalPipelineUsd).toBeCloseTo(15.42836, 4);
    expect(byId.c2.costEconomics.totalCostUsd).toBe(10);
    expect(byId.c2.costEconomics.costOfAcquisitionPct).toBeCloseTo((10 / 15.42836) * 100, 4);
  });

  it("a group's headline + costEconomics are byte-equal to the standalone ?campaignId= call (incl. enrichment)", async () => {
    const opts = {
      economics: ECONOMICS,
      campaigns: {
        c1: { costCents: 5000, leads: [replyLead("o1")], quals: { "reply-o1@x.com": { meetingBookedAt: daysAgo(5), closedAt: daysAgo(2) } } }, // closeWin → full LTR 1000
      },
    };
    mockFetchGrouped(opts);
    const single = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&campaignId=c1").set(AUTH);
    expect(single.status).toBe(200);
    expect(single.body.headline.totalPipelineUsd).toBe(1000); // close-win books realized LTR

    mockFetchGrouped(opts);
    __resetPlatformRatesCache();
    const grouped = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=campaignId").set(AUTH);
    expect(grouped.status).toBe(200);
    const g = grouped.body.groups.find((x: any) => x.campaignId === "c1");
    expect(g.headline).toEqual(single.body.headline);
    expect(g.costEconomics).toEqual(single.body.costEconomics);
  });

  it("empty groups[] when no campaign has runs for the brand+feature", async () => {
    mockFetchGrouped({ economics: ECONOMICS, campaigns: {} });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=campaignId").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.groupBy).toBe("campaignId");
    expect(res.body.groups).toEqual([]);
  });

  it("unknown groupBy value falls back to the ungrouped overview response (no groupBy/groups keys)", async () => {
    mockFetch({ economics: null });
    const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=foo").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("headline");
    expect(res.body).toHaveProperty("costEconomics");
    expect(res.body).not.toHaveProperty("groupBy");
    expect(res.body).not.toHaveProperty("groups");
  });
});
