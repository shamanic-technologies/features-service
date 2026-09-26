/**
 * A ROW'S POSITION AMONG THE ROWS IT IS COMPARABLE WITH.
 *
 * `rank` is a property of the WORKFLOW, scored over every row a dynasty has — the right answer to
 * "which workflow do we pick" and the wrong number to print beside ONE grain's figures. Measured in
 * prod 2026-09-13 (brand `75d7e3e8…`, leg `start_to_conversation`): the rank-1 workflow reads
 * **$175 on its campaign row** and **$20.35 on the audience cell that crowned it** — 3 conversations
 * on $61 against 13 on $2,272 — so a page showing the campaign column and ordering on `rank` shows
 * no relation between the two, and reads as random.
 *
 * ONE fixture where the three orders genuinely DISAGREE, so a suite that only checked "a number came
 * back" would pass on an implementation that copied `rank` into `scopeRank`:
 *
 *                     brand row        aud-hot          aud-cold
 *   lithium           $2,000/10 = 200  $30/3  =  10     $900/1 = 900
 *   sodium            $600/10   =  60  $400/2 = 200     $100/5 =  20
 *   argon             never run        never run        never run
 *
 *   global `rank`  (best cell per dynasty) → lithium 1 ($10), sodium 2 ($20), argon 3
 *   scope null     (the campaign column)   → sodium  1 ($60), lithium 2 ($200), argon 3
 *   scope aud-hot                          → lithium 1 ($10), sodium  2 ($200), argon 3
 *   scope aud-cold                         → sodium  1 ($20), lithium 2 ($900), argon 3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { offerEconomicsFromDeclared } from "../lib/leg-economics-fixture.js";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
// These suites pin the grains on email-gateway counts alone: the person-grain reply set is not read,
// so every grain reads what it always did (the person basis is guarded in crm-only-repliers.test.ts).
vi.mock("../lib/crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/crm-only-repliers.js")>()),
  fetchPositiveRepliers: vi.fn(async () => undefined),
}));
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
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const HOT = "aud-hot";
const COLD = "aud-cold";
const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";

const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 20,
  visitToMeetingPct: 20,
  meetingToClosePct: 50,
  visitToClosePct: 0,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};
const CONVERSATION_FUNNEL = {
  funnelKey: "sales_meetings_from_conversation",
  name: "Sales Meeting from Conversation",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates: { replyToMeetingPct: 20, meetingToClosePct: 50, meetingBookedToAttendedPct: 100 },
  lifetimeRevenueUsd: 5000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-13T00:00:00.000Z",
};

const WORKFLOWS = [
  { id: "i1", workflowSlug: "wf-lithium", workflowName: "Lithium", workflowDynastyName: "Lithium", workflowDynastySlug: "lithium", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "i2", workflowSlug: "wf-sodium", workflowName: "Sodium", workflowDynastyName: "Sodium", workflowDynastySlug: "sodium", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
  { id: "i3", workflowSlug: "wf-argon", workflowName: "Argon", workflowDynastyName: "Argon", workflowDynastySlug: "argon", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null },
];

const cost = (slug: string, cents: number, audienceId?: string) => ({
  dimensions: audienceId ? { workflowSlug: slug, audienceId } : { workflowSlug: slug },
  totalCostInUsdCents: String(cents),
  runCount: 5,
  minStartedAt: null,
  maxStartedAt: null,
});
const email = (slug: string, contacted: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 0, clicked: 0, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

function mockFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    // The FLEET is DEAR, so it never floors any of the figures below down to itself.
    if (url.includes("/v1/stats/public/costs")) return json({ groups: [cost("wf-lithium", 5000000), cost("wf-sodium", 5000000)] });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) {
        return json({
          groups: [
            cost("wf-lithium", 3000, HOT),
            cost("wf-sodium", 40000, HOT),
            cost("wf-lithium", 90000, COLD),
            cost("wf-sodium", 10000, COLD),
          ],
        });
      }
      return json({ groups: [cost("wf-lithium", 200000), cost("wf-sodium", 60000)] });
    }
    if (url.includes("/orgs/stats")) {
      const audienceId = u.searchParams.get("audienceId");
      if (audienceId === HOT) return json({ groups: [email("wf-lithium", 300, 3), email("wf-sodium", 100, 2)] });
      if (audienceId === COLD) return json({ groups: [email("wf-lithium", 100, 1), email("wf-sodium", 500, 5)] });
      if (audienceId) return json({ groups: [] });
      // Brand grain: sodium is CHEAPER per reply and WORSE per person, so return and conversion
      // rate order the campaign column in opposite directions.
      return json({ groups: [email("wf-lithium", 1000, 10), email("wf-sodium", 2000, 10)] });
    }
    if (url.includes("/public/stats")) return json({ groups: [email("wf-lithium", 9000, 100), email("wf-sodium", 9000, 100)] });
    if (url.includes("/offer-economics")) return json(offerEconomicsFromDeclared([CONVERSATION_FUNNEL]));
    if (url.includes("/sales-funnels")) return json({ funnels: [CONVERSATION_FUNNEL] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) {
      return json({ audiences: [{ id: HOT, name: "Hot", status: "active", filters: {} }, { id: COLD, name: "Cold", status: "active", filters: {} }] });
    }
    if (url.includes("/campaigns")) return json({ campaigns: [] });
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const get = (query: string) => request(app).get(`${URL_BASE}?brandId=${BRAND}&${query}`).set(AUTH);
/** Every row of ONE scope, keyed dynasty → row. `null` is the brand / campaign column. */
const scope = (body: any, audienceId: string | null) =>
  body.rows.filter((r: any) => r.audienceId === audienceId);
const orderOf = (body: any, audienceId: string | null) =>
  scope(body, audienceId)
    .slice()
    .sort((a: any, b: any) => a.scopeRank - b.scopeRank)
    .map((r: any) => r.workflow.workflowDynastySlug);

describe("a row states its position among the rows it is COMPARABLE with", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("gives every scope a TOTAL order over its own rows — no ties, no gaps", async () => {
    const res = await get("leg=start_to_conversation");
    expect(res.status).toBe(200);

    for (const audienceId of [null, HOT, COLD]) {
      const rows = scope(res.body, audienceId);
      expect(rows).toHaveLength(3);
      expect(rows.map((r: any) => r.scopeRank).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3]);
    }
  });

  it("orders the CAMPAIGN column on its own figures — which is NOT the workflow order", async () => {
    const res = await get("leg=start_to_conversation");

    // The workflow order is unchanged: lithium is picked on its $10 audience cell.
    expect(res.body.recommendedWorkflowDynastySlug).toBe("lithium");
    expect(scope(res.body, null).find((r: any) => r.workflow.workflowDynastySlug === "lithium").rank).toBe(1);

    // The column a reader is LOOKING at says the opposite: $60 a conversation against $200.
    expect(orderOf(res.body, null)).toEqual(["sodium", "lithium", "argon"]);
    const brandRow = (slug: string) => scope(res.body, null).find((r: any) => r.workflow.workflowDynastySlug === slug);
    expect(brandRow("sodium").resolved.costPerOutcomeUsd).toBeCloseTo(60, 6);
    expect(brandRow("lithium").resolved.costPerOutcomeUsd).toBeCloseTo(200, 6);
    expect(brandRow("sodium").scopeRank).toBe(1);
    expect(brandRow("lithium").scopeRank).toBe(2);
  });

  it("orders each audience on ITS OWN evidence — two audiences disagree about the same two workflows", async () => {
    const res = await get("leg=start_to_conversation");

    expect(orderOf(res.body, HOT)).toEqual(["lithium", "sodium", "argon"]);
    expect(orderOf(res.body, COLD)).toEqual(["sodium", "lithium", "argon"]);

    const cell = (audienceId: string, slug: string) =>
      scope(res.body, audienceId).find((r: any) => r.workflow.workflowDynastySlug === slug).resolved.costPerOutcomeUsd;
    expect(cell(HOT, "lithium")).toBeCloseTo(10, 6);
    expect(cell(HOT, "sodium")).toBeCloseTo(200, 6);
    expect(cell(COLD, "lithium")).toBeCloseTo(900, 6);
    expect(cell(COLD, "sodium")).toBeCloseTo(20, 6);
  });

  it("ascends on the row's OWN resolved cost, in every scope", async () => {
    const res = await get("leg=start_to_conversation");

    for (const audienceId of [null, HOT, COLD]) {
      const measured = scope(res.body, audienceId).filter((r: any) => r.measured);
      const byRank = measured.slice().sort((a: any, b: any) => a.scopeRank - b.scopeRank);
      const byCost = measured.slice().sort((a: any, b: any) => a.resolved.costPerOutcomeUsd - b.resolved.costPerOutcomeUsd);
      expect(byRank.map((r: any) => r.workflow.workflowDynastySlug)).toEqual(
        byCost.map((r: any) => r.workflow.workflowDynastySlug),
      );
    }
  });

  it("never lets a workflow that has NEVER RUN outrank a measured one, in any scope", async () => {
    const res = await get("leg=start_to_conversation");

    for (const audienceId of [null, HOT, COLD]) {
      const rows = scope(res.body, audienceId);
      const argon = rows.find((r: any) => r.workflow.workflowDynastySlug === "argon");
      expect(argon.measured).toBe(false);
      expect(argon.scopeRank).toBe(3);
      for (const other of rows.filter((r: any) => r.measured)) {
        expect(argon.scopeRank).toBeGreaterThan(other.scopeRank);
      }
    }
  });

  it("follows the objective the caller named, exactly as the workflow order does", async () => {
    const byReturn = await get("leg=start_to_conversation&maximize=return");
    const byRate = await get("leg=start_to_conversation&maximize=conversionRate");

    // Same two rows, opposite columns: sodium is cheaper per conversation, lithium converts twice
    // as many of the people it reaches (10/1000 against 10/2000).
    expect(orderOf(byReturn.body, null)).toEqual(["sodium", "lithium", "argon"]);
    expect(orderOf(byRate.body, null)).toEqual(["lithium", "sodium", "argon"]);
  });

  it("carries NO scopeRank on a funnel- or goal-keyed read", async () => {
    for (const query of ["funnel=sales_meetings_from_conversation", "goal=meetingBooked"]) {
      const res = await get(query);
      expect(res.status).toBe(200);
      expect(res.body.rows.length).toBeGreaterThan(0);
      for (const row of res.body.rows) {
        expect(row.scopeRank).toBeUndefined();
        expect(row.rank).toBeUndefined();
      }
    }
  });
});
