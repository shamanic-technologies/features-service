/**
 * THE BRAND-LEVEL PER-AUDIENCE RETURN — `/audience-stats` read with NEITHER `funnel` NOR `goal`.
 *
 * A brand runs several sales funnels at once, so at brand level there is no goal: the only thing that
 * matters is what came back per dollar. This suite drives THREE surfaces from ONE downstream fixture —
 * the brand-level read, the per-funnel (`?funnel=`) read, and `/funnel-ranking` — and asserts they are
 * one statistic seen three ways, rather than three hand-written expectations:
 *
 *   - the brand's combined return IS the head of the funnel ranking (same definition, same evidence);
 *   - an audience's combined return IS its return on the funnel it was combined through, so the number
 *     the Audiences table leads with is the number a click into that funnel shows;
 *   - naming a funnel still behaves exactly as it did.
 *
 * The fixture is built so the brand's best funnel and an audience's best funnel DIFFER — which is the
 * whole reason the row carries its own `basisFunnelKey` instead of inheriting the brand's.
 */
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
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
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
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = {
  id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x",
  status: "active", createdAt: new Date(), updatedAt: new Date(),
};

/** The brand's effective economics — every declared funnel below falls through to these rates. */
let economics: Record<string, number> = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 30,
  visitToMeetingPct: 20,
  meetingToClosePct: 50,
  visitToClosePct: 10,
  visitToSignupPct: 20,
  signupToPaidClientPct: 40,
  visitToPaidClientPct: 20,
  replyToPaidClientPct: 50,
  visitToFormSubmissionPct: 25,
  formSubmissionToPaidClientPct: 20,
};

/** The funnels this brand DECLARED — a reply-bought meeting funnel and a website purchase funnel. */
let declaredKeys: string[] = ["sales_meetings_from_conversation", "website_purchases"];
/** When true, brand-service refuses the declared-funnel read (the producer-gap path). */
let declarationUnreadable = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
}
function workflow(slug: string): Record<string, unknown> {
  return {
    id: `id-${slug}`, workflowSlug: slug, workflowName: slug, workflowDynastySlug: slug, workflowDynastyName: slug,
    version: 1, status: "active", featureSlug: FEATURE.slug, createdForBrandId: null, upgradedTo: null,
  };
}
function costGroup(dimensions: Record<string, string>, cents: number, runCount = 10): Record<string, unknown> {
  return { dimensions, totalCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), runCount, minStartedAt: null, maxStartedAt: null };
}
function emailGroup(key: string, clicked: number, repliesPositive: number, contacted = 500): Record<string, unknown> {
  return { key, broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: contacted, clicked, bounced: 0, repliesPositive } } };
}

// ── The ONE fixture every surface reads ───────────────────────────────────────
// Fleet (cross-org, per workflow):
//   wf-click  $200 / 100 clicks /   0 replies → click $2.00, reply floors to $200 (spent, none produced)
//   wf-reply  $400 / 100 clicks / 200 replies → click $4.00, reply $2.00
// So the reply-bought meeting funnel wins on wf-reply and the website-purchase funnel wins on wf-click:
// the two funnels are priced apart, on their own channel, against identical evidence.
const FLEET_WORKFLOWS = [workflow("wf-click"), workflow("wf-reply")];
const FLEET_COSTS = [costGroup({ workflowSlug: "wf-click" }, 20000), costGroup({ workflowSlug: "wf-reply" }, 40000)];
const FLEET_EMAIL = [emailGroup("wf-click", 100, 0), emailGroup("wf-reply", 100, 200)];

interface AudienceLeg { slug: string; cents: number; clicks: number; replies: number }
interface AudienceFixture { id: string; name: string; legs: AudienceLeg[] }

// audience-a pays best through the REPLY funnel (its replies are cheap, its clicks are not);
// audience-b pays best through the CLICK funnel. The brand's own best is the reply funnel, so
// audience-b is the case that must NOT be priced on the brand's basis.
const AUDIENCES: AudienceFixture[] = [
  { id: "audience-a", name: "CFOs", legs: [{ slug: "wf-reply", cents: 5000, clicks: 5, replies: 10 }] },
  { id: "audience-b", name: "CTOs", legs: [{ slug: "wf-click", cents: 5000, clicks: 25, replies: 1 }] },
];

function audienceOf(id: string | null): AudienceFixture | undefined {
  return AUDIENCES.find((a) => a.id === id);
}
const sum = (legs: AudienceLeg[], pick: (l: AudienceLeg) => number): number => legs.reduce((t, l) => t + pick(l), 0);

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    const params = new URL(url, "http://x").searchParams;

    if (url.includes("workflow:3000/public/workflows")) return json({ workflows: FLEET_WORKFLOWS });
    if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: FLEET_COSTS });
    if (url.includes("email:3000/public/stats")) return json({ groups: FLEET_EMAIL });
    if (url.includes("brand:3000/orgs/brands/brand-1/sales-economics-effective")) {
      return json({ economics, source: "user" });
    }
    if (url.includes("brand:3000/internal/brands/brand-1/sales-funnels")) {
      if (declarationUnreadable) return json({ error: "boom" }, 500);
      return json({
        funnels: declaredKeys.map((funnelKey) => ({
          funnelKey, active: true, name: funnelKey, steps: [], rates: {},
          lifetimeRevenueUsd: null, destinationUrl: null, bookingUrl: null, updatedAt: "2026-08-14T00:00:00.000Z",
        })),
      });
    }
    if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) return json({ emails: [] });

    if (url.includes("runs:3000/v1/stats/costs")) {
      const groupBy = params.get("groupBy") ?? "";
      // audience-stats numerator: each audience's own attributed spend.
      if (groupBy === "audienceId") {
        return json({ groups: AUDIENCES.map((a) => costGroup({ audienceId: a.id }, sum(a.legs, (l) => l.cents), 1)) });
      }
      // workflow-projection audience grain: the SAME spend, split per workflow.
      if (groupBy === "audienceId,workflowSlug") {
        return json({
          groups: AUDIENCES.flatMap((a) => a.legs.map((l) => costGroup({ audienceId: a.id, workflowSlug: l.slug }, l.cents, 1))),
        });
      }
      // brand grain — this brand ran nothing of its own, so every funnel floors on the fleet.
      return json({ groups: [] });
    }

    if (url.includes("email:3000/orgs/stats")) {
      const audienceId = params.get("audienceId");
      if (audienceId) {
        const audience = audienceOf(audienceId);
        return json({ groups: (audience?.legs ?? []).map((l) => emailGroup(l.slug, l.clicks, l.replies, 20)) });
      }
      const groupBy = params.get("groupBy") ?? "";
      if (groupBy === "audienceId") {
        return json({ groups: AUDIENCES.map((a) => emailGroup(a.id, sum(a.legs, (l) => l.clicks), sum(a.legs, (l) => l.replies), 20)) });
      }
      return json({ groups: [] });
    }

    const members = url.match(/human:3000\/orgs\/audiences\/([^/]+)\/members/);
    if (members) return json({ members: [{ emailNorm: `${members[1]}-1` }], total: 1, limit: 500, offset: 0 });
    if (url.includes("human:3000/orgs/audiences")) {
      return json({
        audiences: AUDIENCES.map((a) => ({ id: a.id, brandId: "brand-1", name: a.name, status: "active", filters: null })),
        total: AUDIENCES.length, limit: 200, offset: 0,
      });
    }
    if (url.includes("email:3000/orgs/status")) return json({ results: [] });
    return json({});
  });
}

const statsUrl = (query = ""): string => `/features/${FEATURE.slug}/audience-stats?brandId=brand-1${query}`;

async function brandLevelRead() {
  const res = await request(app).get(statsUrl()).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}
async function funnelRead(funnel: string) {
  const res = await request(app).get(statsUrl(`&funnel=${funnel}`)).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}
async function ranking() {
  const res = await request(app).get(`/features/${FEATURE.slug}/funnel-ranking?brandId=brand-1`).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}
const rowFor = (body: any, audienceId: string): any => body.audiences.find((r: any) => r.audienceId === audienceId);

describe("brand-level per-audience return: /audience-stats with no funnel and no goal", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    declaredKeys = ["sales_meetings_from_conversation", "website_purchases"];
    declarationUnreadable = false;
    economics = {
      lifetimeRevenueUsd: 1000, replyToMeetingPct: 30, visitToMeetingPct: 20, meetingToClosePct: 50,
      visitToClosePct: 10, visitToSignupPct: 20, signupToPaidClientPct: 40, visitToPaidClientPct: 20,
      replyToPaidClientPct: 50, visitToFormSubmissionPct: 25, formSubmissionToPaidClientPct: 20,
    };
    fetchSpy = mockFetch();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("answers return, cost per paying client and %CAC per audience WITHOUT naming a funnel or a goal", async () => {
    const body = await brandLevelRead();

    expect(body.goal).toBeNull();
    expect(body.sortMetric).toBe("returnPerDollar");
    for (const row of body.audiences) {
      expect(typeof row.projection.returnPerDollar).toBe("number");
      expect(typeof row.projection.costPerPaidClientUsd).toBe("number");
      expect(typeof row.projection.costOfAcquisitionPct).toBe("number");
      // The three units are ONE statement — the share is the reciprocal of the return, always.
      expect(row.projection.costOfAcquisitionPct).toBeCloseTo(100 / row.projection.returnPerDollar, 10);
      expect(row.projection.costPerPaidClientUsd).toBeCloseTo(
        row.projection.lifetimeRevenueUsd / row.projection.returnPerDollar,
        10,
      );
    }
  });

  it("states WHICH declared funnels the figure covers, and what it is denominated in", async () => {
    const body = await brandLevelRead();

    expect(body.funnelCoverage.basis).toBe("best_returning_declared_funnel");
    expect(body.funnelCoverage.funnels.map((f: any) => f.funnelKey).sort()).toEqual(
      ["sales_meetings_from_conversation", "website_purchases"],
    );
    expect(body.funnelCoverage.funnels.every((f: any) => f.priced && f.reason === null)).toBe(true);
    // The cost COLUMNS cannot be combined across funnels, so the one they are priced on is named.
    expect(body.funnelCoverage.pricingBasisFunnelKey).toBe(body.brandProjection.basisFunnelKey);
  });

  it("reconciles with the brand's own return: the combined figure IS the head of /funnel-ranking", async () => {
    const [body, rank] = await Promise.all([brandLevelRead(), ranking()]);

    expect(rank.recommendation.funnelKey).toBe("sales_meetings_from_conversation");
    expect(body.brandProjection.basisFunnelKey).toBe(rank.recommendation.funnelKey);
    expect(body.brandProjection.returnPerDollar).toBeCloseTo(rank.recommendation.returnPerDollar, 10);
    expect(body.brandProjection.costPerPaidClientUsd).toBeCloseTo(rank.recommendation.costPerPaidClientUsd, 10);
    // The ranking's rank-1 return is the MAXIMUM over the declared set — so is this one, by definition.
    const best = Math.max(...rank.ranking.filter((f: any) => f.rankable).map((f: any) => f.returnPerDollar));
    expect(body.brandProjection.returnPerDollar).toBeCloseTo(best, 10);
  });

  it("reconciles with the per-funnel figures: each audience's return is its return on the funnel it was combined through", async () => {
    const brand = await brandLevelRead();
    const perFunnel: Record<string, any> = {
      sales_meetings_from_conversation: await funnelRead("sales_meetings_from_conversation"),
      website_purchases: await funnelRead("website_purchases"),
    };

    for (const row of brand.audiences) {
      const basis = row.projection.basisFunnelKey;
      expect(basis).toBeTruthy();
      const twin = rowFor(perFunnel[basis], row.audienceId);
      expect(row.projection.costPerPaidClientUsd).toBeCloseTo(twin.projection.costPerPaidClientUsd, 10);
      expect(row.projection.returnPerDollar).toBeCloseTo(twin.projection.returnPerDollar, 10);
      expect(row.projection.costOfAcquisitionPct).toBeCloseTo(twin.projection.costOfAcquisitionPct, 10);
      // ...and it is the BEST of the brand's funnels for that audience, not merely one of them.
      for (const key of Object.keys(perFunnel)) {
        expect(row.projection.returnPerDollar).toBeGreaterThanOrEqual(
          rowFor(perFunnel[key], row.audienceId).projection.returnPerDollar,
        );
      }
    }
  });

  it("prices an audience on ITS OWN best funnel, not on the brand's, and ranks best return first", async () => {
    const body = await brandLevelRead();

    // audience-b's replies are expensive and its clicks are cheap, so it pays through the website
    // funnel — while the brand as a whole pays through the conversation funnel.
    expect(rowFor(body, "audience-a").projection.basisFunnelKey).toBe("sales_meetings_from_conversation");
    expect(rowFor(body, "audience-b").projection.basisFunnelKey).toBe("website_purchases");
    expect(body.brandProjection.basisFunnelKey).toBe("sales_meetings_from_conversation");

    const returns = body.audiences.map((r: any) => r.projection.returnPerDollar);
    expect(returns).toEqual([...returns].sort((a: number, b: number) => b - a));
    expect(body.audiences[0].audienceId).toBe("audience-b");
  });

  it("naming a funnel still behaves exactly as it did — one funnel, its own order, no coverage block", async () => {
    const body = await funnelRead("sales_meetings_from_conversation");

    expect(body.goal).toBe("meetingBooked");
    expect(body.sortMetric).toBe("cppr");
    expect(body.funnelCoverage).toBeUndefined();
    expect(body.brandProjection.basisFunnelKey).toBeUndefined();
    for (const row of body.audiences) {
      expect(row.projection.basisFunnelKey).toBeUndefined();
      expect(typeof row.projection.returnPerDollar).toBe("number");
    }
  });

  it("a brand whose funnels state no lifetime revenue reads NULL, never a zero return", async () => {
    economics = { ...economics, lifetimeRevenueUsd: 0 };
    const body = await brandLevelRead();

    expect(body.brandProjection.returnPerDollar).toBeNull();
    expect(body.brandProjection.costOfAcquisitionPct).toBeNull();
    // A paid-client cost IS known, so the gap is named for what it is.
    expect(body.brandProjection.costPerPaidClientUsd).toBeGreaterThan(0);
    expect(body.funnelCoverage.funnels.every((f: any) => !f.priced && f.reason === "no_return_defined")).toBe(true);
    for (const row of body.audiences) {
      expect(row.projection.returnPerDollar).toBeNull();
      expect(row.projection.costOfAcquisitionPct).toBeNull();
    }
  });

  it("a declaration that cannot be READ is a 502 naming it, never a zero return", async () => {
    declarationUnreadable = true;
    const res = await request(app).get(statsUrl()).set(AUTH);

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("declared_funnels_unavailable");
  });

  it("an unrecognised goal is still a 400 — only omitting BOTH parameters is the brand-level read", async () => {
    const res = await request(app).get(statsUrl("&goal=not-a-goal")).set(AUTH);
    expect(res.status).toBe(400);
  });
});
