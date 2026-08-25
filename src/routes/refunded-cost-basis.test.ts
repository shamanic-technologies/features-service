/**
 * COMPED SPEND SPLITS THE LEDGER IN TWO — the CHARGED / INCURRED axis.
 *
 * The platform sometimes comps a customer for spend that genuinely happened. runs-service records it
 * as its own cost state, and its aggregation predicates are `status IN ('actual','provisioned')`, so a
 * comped cost falls out of the charged totals ON ITS OWN. That half fixes itself. The half that breaks
 * SILENTLY is the other one: the cross-org fleet benchmark that ranks workflows, and every projection
 * of what a budget buys, would quietly lose real spend — no error, no red test, a comped brand reading
 * artificially cheap and dragging the benchmark down for every other customer.
 *
 * So these cases are written to fail on the design that erases the spend from BOTH sides. A test that
 * only checked "the customer's total went down" would pass on exactly that bug. Every case here drives
 * ONE downstream fixture — the SAME runs-service groups, carrying the SAME comped bucket — and asserts
 * the two bases DIVERGE by exactly the comped amount.
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
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;
const { selectCostCents } = await import("../lib/pricing.js");
const { refundedCents } = await import("../lib/cost-basis.js");
const { fetchBrandWorkflowEvidence } = await import("../lib/workflow-projection-grains.js");

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
  replyToPaidClientPct: 20,
  visitToPaidClientPct: 2,
};

const WORKFLOWS = [{
  id: "ida", workflowSlug: "wf-a", workflowName: "WF A", workflowDynastyName: "Dynasty A",
  workflowDynastySlug: "dyn-a", version: 1, status: "active", featureSlug: "x",
  createdForBrandId: null, upgradedTo: null,
}];

// The incident: $100 of spend was BILLED and a further $400 was burned and then COMPED. One brand, one
// workflow, and — because the fleet is this one brand here — the crossOrg groups are the same rows.
const BILLED_CENTS = 10_000;
const COMPED_CENTS = 40_000;

function costGroup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimensions: { workflowSlug: "wf-a" },
    totalCostInUsdCents: String(BILLED_CENTS),
    actualCostInUsdCents: String(BILLED_CENTS),
    provisionedCostInUsdCents: "0",
    cancelledCostInUsdCents: "0",
    netTotalCostInUsdCents: String(BILLED_CENTS),
    netActualCostInUsdCents: String(BILLED_CENTS),
    netProvisionedCostInUsdCents: "0",
    refundedCostInUsdCents: String(COMPED_CENTS),
    netRefundedCostInUsdCents: String(COMPED_CENTS),
    runCount: 10,
    minStartedAt: null,
    maxStartedAt: null,
    ...over,
  };
}

const EMAIL_GROUP = {
  key: "wf-a",
  broadcast: { recipientStats: { contacted: 200, sent: 200, delivered: 200, opened: 50, clicked: 100, bounced: 0, repliesPositive: 10, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
};

/** ONE fixture. Fleet and brand read the SAME runs group, so any divergence is the BASIS, nothing else. */
function mockFetch(group: Record<string, unknown>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: [group] });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      return json({ groups: [group] });
    }
    if (url.includes("/orgs/stats")) {
      if (u.searchParams.get("audienceId")) return json({ groups: [] });
      return json({ groups: [EMAIL_GROUP] });
    }
    if (url.includes("/public/stats")) return json({ groups: [EMAIL_GROUP] });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) return json({ audiences: [] });
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";
const QUERY = "brandId=75d7e3e8-6926-4f85-a557-976895400666&goal=positiveReply";

describe("comped spend: the CHARGED and INCURRED bases must diverge on the same ledger", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("the customer's own grain drops the comped cost while the fleet benchmark keeps it at full value", async () => {
    mockFetch(costGroup());
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    expect(res.status).toBe(200);

    const row = res.body.rows.find((r: any) => r.audienceId === null && r.workflow.workflowDynastySlug === "dyn-a");
    expect(row).toBeTruthy();

    // ACCOUNTING — the brand grain is this customer's own money. They were charged $100, not $500.
    expect(row.estimatesByGrain.brand.evidence.spentUsd).toBe(BILLED_CENTS / 100);
    expect(row.estimatesByGrain.brand.costBasis).toBe("charged");

    // PERFORMANCE — the crossOrg grain is what the workflow COST to produce its outcomes. The comped
    // $400 was really spent producing them, so it counts in full. THIS is the assertion that fails on
    // the design where the refund silently disappears from both sides.
    expect(row.estimatesByGrain.crossOrg.evidence.spentUsd).toBe((BILLED_CENTS + COMPED_CENTS) / 100);
    expect(row.estimatesByGrain.crossOrg.costBasis).toBe("incurred");

    // ...and they DIVERGE by exactly the comped amount, off one identical downstream fixture.
    expect(row.estimatesByGrain.crossOrg.evidence.spentUsd - row.estimatesByGrain.brand.evidence.spentUsd)
      .toBe(COMPED_CENTS / 100);

    // The same split reaches the unit costs the fleet ranks workflows on: 100 clicks, so the benchmark
    // prices a click at $5.00 while the customer is charged $1.00 for it.
    expect(row.estimatesByGrain.brand.unitCosts.costPerClickUsd).toBe(1);
    expect(row.estimatesByGrain.crossOrg.unitCosts.costPerClickUsd).toBe(5);

    // The resolved pick names the basis it was read on rather than leaving a reader to infer it.
    expect(row.resolved.costBasis).toBe("charged");
  });

  it("with NOTHING comped, both bases are the same number — today's answer, byte for byte", async () => {
    mockFetch(costGroup({ refundedCostInUsdCents: "0", netRefundedCostInUsdCents: "0" }));
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    const row = res.body.rows.find((r: any) => r.audienceId === null);
    expect(row.estimatesByGrain.brand.evidence.spentUsd).toBe(BILLED_CENTS / 100);
    expect(row.estimatesByGrain.crossOrg.evidence.spentUsd).toBe(BILLED_CENTS / 100);
    expect(row.estimatesByGrain.crossOrg.unitCosts.costPerClickUsd)
      .toBe(row.estimatesByGrain.brand.unitCosts.costPerClickUsd);
  });

  it("with the producer's bucket ABSENT it still serves, and both bases read today's number", async () => {
    // runs-service has not deployed its side yet: no refunded field anywhere on the group. Nothing may
    // throw, nothing may be fabricated, and the answer is the one this service gives today.
    const group = costGroup();
    delete group.refundedCostInUsdCents;
    delete group.netRefundedCostInUsdCents;
    mockFetch(group);
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: any) => r.audienceId === null);
    expect(row.estimatesByGrain.brand.evidence.spentUsd).toBe(BILLED_CENTS / 100);
    expect(row.estimatesByGrain.crossOrg.evidence.spentUsd).toBe(BILLED_CENTS / 100);
  });

  it("the brand-grain read used by the BUDGET PROJECTION takes the incurred basis, the displayed one does not", async () => {
    // `pipeline-activity`'s cost-per-outreach divisor floors the fleet benchmark with the brand's OWN
    // ratio, so it reads this same brand grain on the INCURRED basis: a dollar buys the same number of
    // sends whether or not we later comped it. The DISPLAYED brand grain keeps the charged default.
    mockFetch(costGroup());
    const identity = { orgId: "org-1", userId: "user-1", runId: "run-1", featureSlug: "x" };
    const displayed = await fetchBrandWorkflowEvidence("brand-1", "x", WORKFLOWS as any, identity, "gross");
    const projection = await fetchBrandWorkflowEvidence("brand-1", "x", WORKFLOWS as any, identity, "gross", "incurred");
    expect(displayed.get("wf-a")!.totalCostInUsdCents).toBe(BILLED_CENTS);
    expect(projection.get("wf-a")!.totalCostInUsdCents).toBe(BILLED_CENTS + COMPED_CENTS);
  });
});

describe("the selectors themselves", () => {
  const group = costGroup();

  it("CHARGED never adds the comped bucket, on either pricing", () => {
    expect(selectCostCents(group, "totalCostInUsdCents", "gross")).toBe(BILLED_CENTS);
    expect(selectCostCents(group, "actualCostInUsdCents", "gross")).toBe(BILLED_CENTS);
    expect(selectCostCents(group, "totalCostInUsdCents", "net")).toBe(BILLED_CENTS);
  });

  it("INCURRED adds it to the committed total and the billed figure, and to NEITHER hold", () => {
    expect(selectCostCents(group, "totalCostInUsdCents", "gross", "incurred")).toBe(BILLED_CENTS + COMPED_CENTS);
    expect(selectCostCents(group, "actualCostInUsdCents", "gross", "incurred")).toBe(BILLED_CENTS + COMPED_CENTS);
    // A provisioned hold was never charged, so it can never have been comped.
    expect(selectCostCents(group, "provisionedCostInUsdCents", "gross", "incurred")).toBe(0);
  });

  it("COMPOSES with gross/net rather than replacing it — they are two different questions", () => {
    const discounted = costGroup({
      netTotalCostInUsdCents: "5000",
      netRefundedCostInUsdCents: "20000",
    });
    expect(selectCostCents(discounted, "totalCostInUsdCents", "gross", "incurred")).toBe(50_000);
    expect(selectCostCents(discounted, "totalCostInUsdCents", "net", "incurred")).toBe(25_000);
    expect(selectCostCents(discounted, "totalCostInUsdCents", "net", "charged")).toBe(5_000);
  });

  it("an ABSENT bucket contributes zero rather than throwing — the producer has not shipped it yet", () => {
    expect(refundedCents({}, "gross")).toBe(0);
    expect(refundedCents({}, "net")).toBe(0);
    expect(refundedCents({ refundedCostInUsdCents: "not-a-number" }, "gross")).toBe(0);
    // NET falls back to the gross refunded figure the same way runs COALESCEs a pre-freeze row. It is
    // only ever ADDED to a benchmark, so the worst case overstates a workflow's cost — which
    // under-promises what a budget buys rather than over-promising it.
    expect(refundedCents({ refundedCostInUsdCents: "700" }, "net")).toBe(700);
  });

  it("returns the producer's string UNTOUCHED when nothing is comped, so no precision is reformatted", async () => {
    const { selectCostCentsString } = await import("../lib/pricing.js");
    const precise = costGroup({ totalCostInUsdCents: "1234.5678901234", refundedCostInUsdCents: "0" });
    expect(selectCostCentsString(precise, "totalCostInUsdCents", "gross", "incurred")).toBe("1234.5678901234");
  });
});
