/**
 * AN ACTIVE WORKFLOW WITH NO HISTORY IS STILL REACHABLE — the EXPLORE ALLOWANCE, in a channel that
 * ALREADY has workflows with spend.
 *
 * features-service#805 gave a history-less CHANNEL its audiences back, but it fires only when the whole
 * channel has measured nothing. The case that actually occurs is the MIXED one, and it is the one that
 * cost a live customer: prod 2026-08-25, 75 cold-email workflows created on 15-16 August inside
 * `sales-cold-email-outreach` — a channel with 18 workflows that DO have spend, so the whole-channel
 * guard never fired. Those 75 were active for eight days, logged ZERO runs and generated ZERO emails,
 * while nine already-spent, zero-outcome workflows rotated.
 *
 * The fixture below is prod-shaped: the measured dynasties carry the real spend / contacted / positive
 * reply aggregates read off prod for brand `75d7e3e8…` (a measured leader, a zero-outcome husk, and the
 * channel's heavy spender), and beside them sit two active workflows with no history and one deprecated
 * one. Every case is driven from that ONE fixture, so "the unproven workflow becomes reachable" and "the
 * established workflow is worth exactly what it was" are one property.
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

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = { id: "feat-1", slug: "x", name: "X", description: "x", status: "active", createdAt: new Date(), updatedAt: new Date() };

// The brand's declared conversation-chain rates, as brand-service serves them.
const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 50,
  visitToClosePct: 2,
  visitToSignupPct: 4,
  signupToPaidClientPct: 50,
};
const V2M = ECONOMICS.visitToMeetingPct / 100;
const R2M = ECONOMICS.replyToMeetingPct / 100;

function wf(over: Record<string, unknown>): Record<string, unknown> {
  return { id: "id", workflowSlug: "wf", workflowName: "WF", workflowDynastyName: "Dyn", workflowDynastySlug: "dyn", version: 1, status: "active", featureSlug: "x", createdForBrandId: null, upgradedTo: null, ...over };
}

// ── PROD-SHAPED evidence (brand 75d7e3e8…, sales-cold-email-outreach, 2026-08-25) ────────────────
// Three dynasties with real history: the measured leader, a zero-reply husk, the heavy spender.
const MEASURED = [
  { dyn: "ballad", crossCents: 39610, crossContacted: 1143, crossReplies: 4, brandCents: 26996, brandContacted: 761, brandReplies: 4 },
  { dyn: "moraine", crossCents: 8466, crossContacted: 314, crossReplies: 0, brandCents: 3093, brandContacted: 155, brandReplies: 0 },
  { dyn: "lithium", crossCents: 169361, crossContacted: 7045, crossReplies: 16, brandCents: 121255, brandContacted: 4009, brandReplies: 10 },
];
// The workflows created on 15-16 August: active, and nothing anywhere has ever spent on them.
const UNPROVEN = ["cinder", "bramble"];
// A retired lineage with no history either — it must stay unreachable.
const RETIRED = "obsidian";

const MEASURED_WORKFLOWS = MEASURED.map((m) => wf({ id: `id-${m.dyn}`, workflowSlug: `wf-${m.dyn}`, workflowDynastySlug: m.dyn, workflowDynastyName: m.dyn }));
const WORKFLOWS = [
  ...MEASURED_WORKFLOWS,
  ...UNPROVEN.map((d) => wf({ id: `id-${d}`, workflowSlug: `wf-${d}`, workflowDynastySlug: d, workflowDynastyName: d })),
  wf({ id: `id-${RETIRED}`, workflowSlug: `wf-${RETIRED}`, workflowDynastySlug: RETIRED, workflowDynastyName: RETIRED, status: "deprecated" }),
];

const AUDIENCES = [{ id: "aud-1" }, { id: "aud-2" }];

const costGroup = (slug: string, cents: number) => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: String(cents), runCount: 10, minStartedAt: null, maxStartedAt: null });
const emailGroup = (slug: string, contacted: number, repliesPositive: number) => ({
  key: slug,
  broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: 0, clicked: 0, bounced: 0, repliesPositive, repliesNegative: 0, repliesNeutral: 0, repliesAutoReply: 0 } },
});

const CROSS_COST = MEASURED.map((m) => costGroup(`wf-${m.dyn}`, m.crossCents));
const CROSS_EMAIL = MEASURED.map((m) => emailGroup(`wf-${m.dyn}`, m.crossContacted, m.crossReplies));
const BRAND_COST = MEASURED.map((m) => costGroup(`wf-${m.dyn}`, m.brandCents));
const BRAND_EMAIL = MEASURED.map((m) => emailGroup(`wf-${m.dyn}`, m.brandContacted, m.brandReplies));

function mockFetch(opts: { workflows?: unknown[] } = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const u = new URL(url, "http://x");
    if (url.includes("/public/workflows")) return json({ workflows: opts.workflows ?? WORKFLOWS });
    if (url.includes("/v1/stats/public/costs")) return json({ groups: CROSS_COST });
    if (url.includes("/v1/stats/costs")) {
      const groupBy = u.searchParams.get("groupBy") ?? "";
      if (groupBy.startsWith("audienceId")) return json({ groups: [] });
      return json({ groups: BRAND_COST });
    }
    if (url.includes("/orgs/stats")) {
      if (u.searchParams.get("audienceId")) return json({ groups: [] });
      return json({ groups: BRAND_EMAIL });
    }
    if (url.includes("/public/stats")) return json({ groups: CROSS_EMAIL });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/audiences")) return json({ audiences: AUDIENCES });
    return json({});
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const URL_BASE = "/features/sales-cold-email-outreach/workflow-projection";
const QUERY = "brandId=75d7e3e8-6926-4f85-a557-976895400666&goal=meetingBooked";

// campaign-service's own picker, verbatim (`selectWorkflowGreedy`): first strict minimum over every
// row's resolved cost-per-outcome, a null / non-positive metric skipped. What "reachable" means.
function selectWorkflowGreedy(rows: any[]): string | null {
  let bestSlug: string | null = null;
  let bestCost = Infinity;
  for (const r of rows) {
    const cpo = r.resolved.costPerOutcomeUsd;
    if (cpo == null || !(cpo > 0)) continue;
    if (cpo < bestCost) { bestCost = cpo; bestSlug = r.workflow.workflowDynastySlug; }
  }
  return bestSlug;
}

describe("workflow-projection: an unproven workflow is reachable inside an established channel", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers every active unproven workflow — its brand row and one row per active audience", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);

    expect(res.status).toBe(200);
    // The channel HAS measured history, so the #805 whole-channel guard does not fire — and used to
    // leave the unproven workflows out entirely.
    expect(res.body.measured).toBe(true);
    expect(res.body.unmeasuredReason).toBeUndefined();

    for (const dyn of UNPROVEN) {
      const rows = res.body.rows.filter((r: any) => r.workflow.workflowDynastySlug === dyn);
      expect(rows).toHaveLength(1 + AUDIENCES.length);
      expect(rows.filter((r: any) => r.audienceId === null)).toHaveLength(1);
      expect(rows.filter((r: any) => r.audienceId).map((r: any) => r.audienceId).sort()).toEqual(["aud-1", "aud-2"]);
      for (const row of rows) {
        expect(row.measured).toBe(false);
        // Nothing borrowed from the workflows that DO have a history.
        expect(row.estimatesByGrain).toEqual({});
        expect(row.resolved.grain).toBeNull();
        // A cost FLOOR and nothing else: no paid-client cost, no return, no %CAC on a workflow with
        // no evidence that it converts.
        expect(row.resolved.costPerPaidClientUsd).toBeNull();
        expect(row.resolved.costPerMeetingBookedUsd).toBeNull();
        expect(row.resolved.roiMultiple).toBeNull();
        expect(row.resolved.cacPct).toBeNull();
      }
    }
  });

  it("a consumer picking from the projection reaches it — and the allowance is the price of ONE outreach, not a cheap proven number", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);

    // The allowance = Σ measured BRAND spend ÷ Σ measured BRAND contacted, through the goal's funnel.
    const brandCents = MEASURED.reduce((a, m) => a + m.brandCents, 0);
    const brandContacted = MEASURED.reduce((a, m) => a + m.brandContacted, 0);
    const outreachUsd = brandCents / 100 / brandContacted;
    const expected = outreachUsd / (V2M + R2M);

    const unprovenRow = res.body.rows.find((r: any) => r.workflow.workflowDynastySlug === "bramble" && r.audienceId === null);
    expect(unprovenRow.resolved.costPerOutcomeUsd).toBeCloseTo(expected, 6);
    expect(unprovenRow.resolved.costPerClickUsd).toBeCloseTo(outreachUsd, 6);
    // Never 0 — a zero cost is both a lie and unrankable (campaign-service skips it).
    expect(unprovenRow.resolved.costPerOutcomeUsd).toBeGreaterThan(0);

    // REACHABLE: the picker campaign-service actually runs lands on an unproven workflow, which is the
    // whole point — it cannot earn a first run until something offers it.
    expect(UNPROVEN).toContain(selectWorkflowGreedy(res.body.rows));

    // NOT a cheap-and-proven number: it is stated unmeasured, it is never recommended, and it carries
    // no return at all — so it cannot be read as this brand's own result the way a measured row is.
    expect(MEASURED.map((m) => m.dyn)).toContain(res.body.recommendedWorkflowDynastySlug);
    expect(res.body.recommendedBudgetUsd).toBeGreaterThan(0);
  });

  it("an established workflow is worth exactly what it was — byte-identical with and without the unproven ones", async () => {
    mockFetch();
    const withUnproven = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    mockFetch({ workflows: MEASURED_WORKFLOWS });
    const measuredOnly = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);

    expect(measuredOnly.status).toBe(200);
    const measuredRows = withUnproven.body.rows.filter((r: any) => r.measured);
    expect(measuredRows).toEqual(measuredOnly.body.rows);
    expect(measuredOnly.body.rows.every((r: any) => r.measured)).toBe(true);
    // Same recommendation, same budget, same economics echo.
    expect(withUnproven.body.recommendedWorkflowDynastySlug).toBe(measuredOnly.body.recommendedWorkflowDynastySlug);
    expect(withUnproven.body.recommendedBudgetUsd).toBe(measuredOnly.body.recommendedBudgetUsd);
    expect(withUnproven.body.economics).toEqual(measuredOnly.body.economics);
    // The allowance sits BELOW every measured row, which is why it gets picked at all — and every
    // measured cost is untouched by it.
    const measuredCosts = measuredRows.map((r: any) => r.resolved.costPerOutcomeUsd).filter((c: number | null) => c != null);
    const allowance = withUnproven.body.rows.find((r: any) => !r.measured).resolved.costPerOutcomeUsd;
    expect(measuredCosts.length).toBeGreaterThan(0);
    expect(Math.min(...measuredCosts)).toBeGreaterThan(allowance);
  });

  it("a deprecated workflow stays unreachable", async () => {
    mockFetch();
    const res = await request(app).get(`${URL_BASE}?${QUERY}`).set(AUTH);
    expect(res.body.rows.some((r: any) => r.workflow.workflowDynastySlug === RETIRED)).toBe(false);
    expect(selectWorkflowGreedy(res.body.rows)).not.toBe(RETIRED);
  });
});
