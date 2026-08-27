/**
 * CROSS-SURFACE INVARIANT — the AGGREGATE cost-per-outcome the dashboard's Overview card shows
 * (`/revenue` → `spend.*Cents`) must be the SAME number the Strategy page shows for that brand
 * (`/workflow-projection`), for the same brand + goal + moment.
 *
 * The per-AUDIENCE rows already did this (see `audience-cost-coherence.test.ts`): at 0 outcomes the
 * cost floors to max(own committed spend, the fleet-backed expected cost of the workflow the brand's
 * goal crowns). The brand/campaign AGGREGATE did NOT — it returned null, and the dashboard then fell
 * back to printing the brand's own total spend, so "Cost per positive reply $28.74" sat directly above
 * "Total spent $28.74" while the Strategy page said $62.98 for the same brand at the same moment.
 *
 * Both endpoints are driven here by ONE downstream fixture, so the equality is a property of the two
 * computes, not of two hand-written expectations.
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
process.env.FEATURE_VIEW_CACHE_ENABLED = "false"; // pure live-compute path on both surfaces
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
const FEATURE = { id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

const ECONOMICS = {
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
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
function leadRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    leadId: "l1", email: "l1@x.com", contacted: true, sent: true, delivered: true, clicked: false,
    bounced: false, unsubscribed: false, replied: false, replyClassification: null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } },
    ...over,
  };
}

// ── The ONE fixture both surfaces read ────────────────────────────────────────
// Fleet (cross-org, per workflow) — the prod shape (`dawn` vs `arcadia` at goal=positiveReply):
//   wf-husk     $60 / 13 clicks / ZERO replies → reply cost = its own floor $60 ← the goal's winner
//   wf-measured $80 /  0 clicks /  1   reply   → reply cost = $80/1 = $80 (measured, but pricier)
// The brand has no send-tag brand-grain evidence, so the winner resolves at grain crossOrg — exactly
// the AC's prod reading (dawn, crossOrg, $62.98).
const FLEET_WORKFLOWS = [workflow("wf-husk"), workflow("wf-measured")];
const FLEET_COSTS = [costGroup({ workflowSlug: "wf-husk" }, 6000), costGroup({ workflowSlug: "wf-measured" }, 8000)];
const FLEET_EMAIL = [emailGroup("wf-husk", 13, 0), emailGroup("wf-measured", 0, 1)];
/** The winning workflow's cost per positive reply — what BOTH surfaces must report at 0 replies. */
const BENCHMARK_CPPR_USD = 60;
/** …and its cost per website visit, for the CPC family. */
const BENCHMARK_CPC_USD = 6000 / 100 / 13;

/** The brand's OWN committed / actual spend on this feature (runs groupBy=costName). */
let brandCommittedCents = 2874;
let brandActualCents = 2874;
/** The SALES FUNNELS the brand declared it sells through (brand-service INTERNAL declared set). An
 * empty array means it declared nothing — the read fails loud there and the columns stay OBSERVED. */
let brandFunnels: string[] = ["website_purchases"];
/** The brand's leads snapshot — drives the observed click / positive-reply denominators. */
let leads: Array<Record<string, unknown>> = [leadRow({ leadId: "l1", email: "quiet@x.com" })];
/** Real attributed conversion counts (lead-service). */
let conversionCounts: { signup: number; meeting_booked: number; form_submission: number; sale: number } | null = {
  signup: 0, meeting_booked: 0, form_submission: 0, sale: 0,
};

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    const params = new URL(url, "http://x").searchParams;

    // ── Cross-org projection inputs (shared by both surfaces) ──────────────
    if (url.includes("workflow:3000/public/workflows")) return json({ workflows: FLEET_WORKFLOWS });
    if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: FLEET_COSTS });
    // Serves BOTH the fleet per-workflow grain (?groupBy=workflowSlug) and the platform funnel rates
    // (no groupBy) — one source, so the two never disagree on the fleet's engagement.
    if (url.includes("email:3000/public/stats")) return json({ groups: FLEET_EMAIL });

    // ── Brand economics: effective (both surfaces) + INTERNAL saved (the declared goal) ────
    if (url.includes("brand:3000/internal/brands/brand-1/sales-funnels")) {
      // What the brand DECLARED it sells through — the funnel the spend columns are priced on. An empty
      // list is brand-service's "this org never stated a set": the client throws on it, and the columns
      // degrade to observed rather than being priced on a substituted funnel.
      return json({
        funnels: brandFunnels.map((funnelKey) => ({
          funnelKey, name: funnelKey, steps: [], rates: {}, lifetimeRevenueUsd: null,
          destinationUrl: null, bookingUrl: null, updatedAt: "2026-08-01T00:00:00.000Z",
        })),
      });
    }
    if (url.includes("brand:3000/internal/brands/brand-1/sales-economics")) {
      return json({ salesEconomics: ECONOMICS });
    }
    if (url.includes("brand:3000/orgs/brands/brand-1/sales-economics-effective")) {
      return json({ economics: ECONOMICS, source: "user" });
    }

    // ── Org-scoped runs cost ───────────────────────────────────────────────
    if (url.includes("runs:3000/v1/stats/costs")) {
      const groupBy = params.get("groupBy") ?? "";
      // /revenue spend breakdown (groupBy=costName): lifetime, then today (startedAfter).
      if (groupBy === "costName") {
        if (params.get("startedAfter")) {
          return json({ groups: [{ dimensions: { costName: "email-send-step-1" }, totalCostInUsdCents: "0", netTotalCostInUsdCents: "0", actualCostInUsdCents: "0", netActualCostInUsdCents: "0", runCount: 0 }] });
        }
        return json({
          groups: [{
            dimensions: { costName: "email-send-step-1" },
            totalCostInUsdCents: String(brandCommittedCents), netTotalCostInUsdCents: String(brandCommittedCents),
            actualCostInUsdCents: String(brandActualCents), netActualCostInUsdCents: String(brandActualCents),
            runCount: 3,
          }],
        });
      }
      // Brand grain (workflow-projection): this brand carries no send-tag workflow evidence, so the
      // winner resolves at the crossOrg grain — the AC's prod reading.
      return json({ groups: [] });
    }

    // ── Email-gateway org-scoped stats (brand grain / sequences day series) ─
    if (url.includes("email:3000/orgs/stats")) return json({ groups: [] });
    if (url.includes("email:3000/orgs/status")) return json({ results: [] });
    if (url.includes("email:3000/orgs/manual-qualifications")) return json({ qualifications: [] });

    // ── lead-service ───────────────────────────────────────────────────────
    if (url.includes("lead:3000/orgs/leads")) return json({ leads });
    if (url.includes("/conversion-counts")) {
      if (!conversionCounts) return new Response("nope", { status: 500 });
      return json({ counts: conversionCounts });
    }
    if (url.includes("/converted-lead-emails")) return json({ emails: [] });

    // human-service audiences — used by /workflow-projection's audience grain only. The AGGREGATE
    // floor must never reach it (it passes an empty audience-id list); asserted below.
    if (url.includes("human:3000/orgs/audiences")) return json({ audiences: [], total: 0, limit: 200, offset: 0 });
    return json({});
  });
}

/**
 * The brand-level cost the Strategy page renders — mirroring the dashboard's `strategy-model.ts`
 * `pickBestBrandRow`: the cheapest `audienceId == null` row on `resolved.costPerOutcomeUsd`.
 */
async function strategyBrandCost(goal: string, field: "costPerOutcomeUsd" | "costPerClickUsd"): Promise<number> {
  const res = await request(app)
    .get(`/features/${FEATURE.slug}/workflow-projection?brandId=brand-1&goal=${goal}&pricing=net`)
    .set(AUTH);
  expect(res.status).toBe(200);
  const brandRows = res.body.rows.filter((r: any) => r.audienceId == null);
  const best = brandRows
    .filter((r: any) => r.resolved.costPerOutcomeUsd != null && r.resolved.costPerOutcomeUsd > 0)
    .sort((a: any, b: any) => a.resolved.costPerOutcomeUsd - b.resolved.costPerOutcomeUsd)[0];
  return best.resolved[field];
}

async function revenueSpend(): Promise<any> {
  const res = await request(app).get(`/features/${FEATURE.slug}/revenue?brandId=brand-1&pricing=net`).set(AUTH);
  expect(res.status).toBe(200);
  return res.body.spend;
}

describe("aggregate cost coherence: /revenue spend ↔ /workflow-projection", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    brandCommittedCents = 2874;
    brandActualCents = 2874;
    brandFunnels = ["website_purchases"];
    leads = [leadRow({ leadId: "l1", email: "quiet@x.com" })];
    conversionCounts = { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 };
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  // THE REPORTED BUG. 0 positive replies + $28.74 committed spend → cpprCents used to be null, and the
  // dashboard printed the total spend under a cost-per-reply label.
  it("a 0-outcome brand reports the SAME expected cost per positive reply as the Strategy page", async () => {
    const spend = await revenueSpend();
    const strategyUsd = await strategyBrandCost("positiveReply", "costPerOutcomeUsd");

    expect(spend.positiveRepliesCount).toBe(0);
    expect(spend.totalSpentCents).toBe(2874);
    // Coherent by construction with what the customer sees on the Strategy page…
    expect(spend.cpprCents / 100).toBeCloseTo(strategyUsd, 9);
    // …which is the winning workflow's $60, NOT the brand's own $28.74 total spend.
    expect(spend.cpprCents).toBe(BENCHMARK_CPPR_USD * 100);
    expect(spend.cpprCents).not.toBe(spend.totalSpentCents);
  });

  // The aggregate has no audience column, so it must NOT pay for the per-audience fan-out the
  // /audience-stats caller needs (zero human-service round-trips, zero per-audience cost/outcome reads).
  it("adds no audience-grain fan-out", async () => {
    await revenueSpend();
    const calls: string[] = (fetchSpy.mock.calls as unknown[][]).map((c) => urlOf(c[0]));
    expect(calls.filter((u: string) => u.includes("human:3000"))).toEqual([]);
    expect(calls.filter((u: string) => u.includes("audienceId"))).toEqual([]);
  });

  // SPEND-WINS ABOVE THE BENCHMARK IS INTENDED — the same conservative floor the audience grain applies.
  // A brand that already burned more than the expected cost with nothing to show reports its own spend.
  it("a 0-outcome brand whose own committed spend exceeds the benchmark still reports its own spend", async () => {
    brandCommittedCents = 900000; // $9,000 ≫ the $60 benchmark
    brandActualCents = 900000;

    const spend = await revenueSpend();

    expect(spend.positiveRepliesCount).toBe(0);
    expect(spend.cpprCents).toBe(900000);
    expect(spend.cpprCents).toBeGreaterThan(BENCHMARK_CPPR_USD * 100);
  });

  // A REAL OBSERVED RATIO STILL WINS — nothing changes once the outcome count is > 0.
  it("an observed ratio is untouched by the floor", async () => {
    brandCommittedCents = 400;
    brandActualCents = 400;
    leads = [leadRow({ leadId: "l2", email: "reply@y.com", replied: true, replyClassification: "positive" })];

    const spend = await revenueSpend();

    expect(spend.positiveRepliesCount).toBe(1);
    expect(spend.cpprCents).toBe(400); // $4.00 measured — far below the $60 benchmark, and kept
  });

  // THE COST-PER-CLICK FAMILY at zero clicks. Each variant keeps its OWN spend basis and floors against
  // the SAME fleet-backed cost per website visit (the block never claims total == actual + provisioned
  // for a RATIO), so all three legitimately report the same lower bound when nothing is measurable.
  it("the cost-per-click family floors at the winning workflow's cost per website visit at 0 clicks", async () => {
    brandCommittedCents = 300; // $3.00 committed = $2.00 billed + $1.00 held, all under the benchmark
    brandActualCents = 200;

    const spend = await revenueSpend();
    const strategyClickUsd = await strategyBrandCost("positiveReply", "costPerClickUsd");

    expect(spend.provisionedSpentCents).toBe(100);
    expect(spend.totalCpcCents / 100).toBeCloseTo(strategyClickUsd, 9);
    expect(spend.totalCpcCents / 100).toBeCloseTo(BENCHMARK_CPC_USD, 9);
    expect(spend.actualCpcCents).toBe(spend.totalCpcCents);
    expect(spend.provisionedCpcCents).toBe(spend.totalCpcCents);
  });

  // FUNNEL columns take the PROJECTION, never the raw dollar total: answering "cost per signup" with a
  // total spend is a units error (the same split /audience-stats makes between its raw and derived
  // columns). Each must be ≥ the click cost it is reached through.
  it("the funnel columns project through the winning workflow instead of reporting the raw spend total", async () => {
    const spend = await revenueSpend();

    for (const field of ["cpsCents", "cpsmCents", "cpSaleCents"] as const) {
      expect({ field, value: spend[field] }).toEqual({ field, value: expect.any(Number) });
      expect({ field, value: spend[field] }).not.toEqual({ field, value: spend.totalSpentCents });
    }
    // cost per signup = clickUsd / visitToSignupPct(20%) — the brand's own economics through the
    // winner's click cost, not a dollar total.
    expect(spend.cpsCents / 100).toBeCloseTo(BENCHMARK_CPC_USD / 0.2, 9);
    // A funnel column whose rate this funnel's projection does not resolve (cost per form submission is
    // only projected for the form-magnet funnel) has NO expected cost — so it stays null rather than
    // falling back to the raw dollar total, which would be the units error all over again.
    expect(spend.cpfsCents).toBeNull();
  });

  it("the form-submission column projects (and never reports the raw total) for a form-submission brand", async () => {
    brandFunnels = ["form_magnet"];

    const spend = await revenueSpend();

    // clickUsd / visitToFormSubmissionPct(25%) — the winner's click cost through the brand's own rate.
    expect(spend.cpfsCents / 100).toBeCloseTo(BENCHMARK_CPC_USD / 0.25, 9);
    expect(spend.cpfsCents).not.toBe(spend.totalSpentCents);
  });

  // NO DECLARED FUNNEL → there is no funnel to be coherent with, so the columns stay OBSERVED (null at 0
  // outcomes). "We could not estimate this" — never a substituted funnel, and never the raw spend total.
  it("a brand that has declared NO sales funnel keeps the observed (null) behaviour", async () => {
    brandFunnels = [];

    const spend = await revenueSpend();

    expect(spend.totalSpentCents).toBe(2874);
    expect(spend.cpprCents).toBeNull();
    expect(spend.totalCpcCents).toBeNull();
    expect(spend.cpsCents).toBeNull();
    expect(spend.cpfsCents).toBeNull();
  });

  // FAIL-SOFT: a projection blip degrades the cost columns to today's observed behaviour rather than
  // 502-ing the customer's Overview — and NEVER to the raw-spend floor (the bug this feature removes).
  it("degrades to observed (never to the raw spend total) when the projection read fails", async () => {
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("workflow:3000/public/workflows")) return new Response("boom", { status: 500 });
      return (await mockFetchOnce(url)) as Response;
    });

    const res = await request(app).get(`/features/${FEATURE.slug}/revenue?brandId=brand-1&pricing=net`).set(AUTH);
    expect(res.status).toBe(200); // the Overview must not 502 on an enrichment blip
    expect(res.body.spend.cpprCents).toBeNull();
    expect(res.body.spend.cpprCents).not.toBe(res.body.spend.totalSpentCents);
  });
});

/** Replay the standard fixture for a single URL (used by the fail-soft case, which overrides one route). */
async function mockFetchOnce(url: string): Promise<Response> {
  const params = new URL(url, "http://x").searchParams;
  if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: FLEET_COSTS });
  if (url.includes("email:3000/public/stats")) return json({ groups: FLEET_EMAIL });
  if (url.includes("brand:3000/internal/brands/brand-1/sales-funnels")) {
    return json({
      funnels: brandFunnels.map((funnelKey) => ({
        funnelKey, name: funnelKey, steps: [], rates: {}, lifetimeRevenueUsd: null,
        destinationUrl: null, bookingUrl: null, updatedAt: "2026-08-01T00:00:00.000Z",
      })),
    });
  }
  if (url.includes("brand:3000/internal/brands/brand-1/sales-economics")) {
    return json({ salesEconomics: ECONOMICS });
  }
  if (url.includes("brand:3000/orgs/brands/brand-1/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
  if (url.includes("runs:3000/v1/stats/costs")) {
    if ((params.get("groupBy") ?? "") === "costName") {
      const cents = params.get("startedAfter") ? 0 : brandCommittedCents;
      const actual = params.get("startedAfter") ? 0 : brandActualCents;
      return json({ groups: [{ dimensions: { costName: "email-send-step-1" }, totalCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), actualCostInUsdCents: String(actual), netActualCostInUsdCents: String(actual), runCount: 3 }] });
    }
    return json({ groups: [] });
  }
  if (url.includes("email:3000/orgs/stats")) return json({ groups: [] });
  if (url.includes("email:3000/orgs/status")) return json({ results: [] });
  if (url.includes("email:3000/orgs/manual-qualifications")) return json({ qualifications: [] });
  if (url.includes("lead:3000/orgs/leads")) return json({ leads });
  if (url.includes("/conversion-counts")) return json({ counts: conversionCounts });
  if (url.includes("/converted-lead-emails")) return json({ emails: [] });
  return json({});
}
