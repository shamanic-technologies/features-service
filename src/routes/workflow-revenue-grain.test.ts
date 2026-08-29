/**
 * WHICH OF THE WORKFLOWS WE RAN FOR THIS BRAND MADE MONEY.
 *
 * These drive `/revenue` from ONE downstream fixture and assert that the per-workflow answer is the
 * SAME realized-money answer the brand read gives, at a finer grain: one group per workflow DYNASTY,
 * versions folded, both legs attributed by the producer that froze them, and — the property that
 * makes the two grains one number rather than two — a brand whose spend all sits on one workflow
 * reading identically at both.
 *
 * They also pin what must NOT move: the un-grouped and per-campaign responses are the customer
 * dashboard's Overview and Campaigns table, so this feature may not touch either.
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
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const SALES_FEATURE = {
  id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x", status: "active",
  outputs: [], charts: [],
  createdAt: new Date(), updatedAt: new Date(),
};
/** A positively-replying lead is worth LTR × replyToMeeting × meetingToClose = 1000 × .4 × .3 = 120. */
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

function replyLead(workflowSlug: string | null, leadId: string): Record<string, unknown> {
  return {
    leadId,
    campaignId: "c1",
    workflowSlug,
    email: `${leadId}@x.com`,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: false,
    bounced: false,
    unsubscribed: false,
    replied: true,
    replyClassification: "positive",
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}

/** Contacted + delivered, and nothing else — the workflow reached this person and got no answer. */
function silentLead(workflowSlug: string | null, leadId: string): Record<string, unknown> {
  return { ...replyLead(workflowSlug, leadId), clicked: false, replied: false, replyClassification: null };
}

/** Contacted + a website visit, no reply. */
function clickLead(workflowSlug: string | null, leadId: string): Record<string, unknown> {
  return { ...silentLead(workflowSlug, leadId), clicked: true };
}

interface Fixture {
  /** Cost cents per VERSIONED workflow slug — what runs-service answers at groupBy=workflowSlug.
   * The fixture sets committed == billed unless a case deliberately splits them. */
  costBySlug: Record<string, number>;
  leads: Array<Record<string, unknown>>;
  /** workflow-service metadata. `null` = the service is unreachable (the version-grain degrade). */
  workflows: Array<Record<string, unknown>> | null;
}

function mockFetch(fixture: Fixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    // Ordered before the email-gateway `/public/stats` branch — one is a superstring of neither, but
    // the workflow list must never be answered by a stats fixture.
    if (url.includes("/public/workflows")) {
      if (!fixture.workflows) return new Response("workflow-service down", { status: 503 });
      return json({ workflows: fixture.workflows });
    }
    if (url.includes("/campaigns?")) return json({ campaigns: [] });
    if (url.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    if (url.includes("/stats/costs")) {
      const groups = Object.entries(fixture.costBySlug).map(([slug, cents]) => ({
        dimensions: { workflowSlug: slug, campaignId: "c1", costName: "email-send" },
        totalCostInUsdCents: String(cents),
        actualCostInUsdCents: String(cents),
        runCount: 1,
        minStartedAt: null,
        maxStartedAt: null,
      }));
      return json({ groups });
    }
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/leads")) return json({ leads: fixture.leads });
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.includes("/orgs/status")) return json({ results: [] });
    return json({});
  });
}

const WORKFLOWS = [
  { id: "w1", workflowSlug: "dawn-v1", workflowName: "Dawn v1", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 1, status: "inactive", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: "w2" },
  { id: "w2", workflowSlug: "dawn-v2", workflowName: "Dawn v2", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 2, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
  { id: "w3", workflowSlug: "osprey-v1", workflowName: "Osprey v1", workflowDynastyName: "Osprey", workflowDynastySlug: "osprey", version: 1, status: "active", featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null },
];

const byWorkflow = (body: { groups: Array<{ workflowDynastySlug: string }> }) =>
  Object.fromEntries(body.groups.map((g) => [g.workflowDynastySlug, g])) as Record<string, any>;

describe("GET /revenue?groupBy=workflow — which workflows made money", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers one group per workflow DYNASTY, folding the versions and pricing each on its own leads", async () => {
    mockFetch({
      // Dawn ran two versions; both are ONE workflow. Osprey spent and reached nobody.
      costBySlug: { "dawn-v1": 3000, "dawn-v2": 2000, "osprey-v1": 4000 },
      leads: [replyLead("dawn-v1", "l1"), replyLead("dawn-v2", "l2")],
      workflows: WORKFLOWS,
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.groupBy).toBe("workflow");

    const groups = byWorkflow(res.body);
    expect(Object.keys(groups).sort()).toEqual(["dawn", "osprey"]);

    // Dawn: two leads at 120, $30 + $20 of spend across its two versions.
    expect(groups.dawn.workflowDynastyName).toBe("Dawn");
    expect(groups.dawn.workflowSlugs).toEqual(["dawn-v1", "dawn-v2"]);
    expect(groups.dawn.headline.totalPipelineUsd).toBeCloseTo(240, 6);
    expect(groups.dawn.headline.economicsSource).toBe("sales-economics");
    expect(groups.dawn.costEconomics.actualCostUsd).toBeCloseTo(50, 6);
    expect(groups.dawn.costEconomics.roiMultiple).toBeCloseTo(4.8, 6);
    expect(groups.dawn.costEconomics.costOfAcquisitionPct).toBeCloseTo((50 / 240) * 100, 6);
    // $CAC = spend ÷ expected paying clients (240/1000 = 0.24 of a client).
    expect(groups.dawn.costEconomics.costPerAcquisitionUsd).toBeCloseTo(50 / 0.24, 6);

    // Osprey BURNED it: real spend, nothing back. 0x, not null — and no $CAC, because it won nobody.
    expect(groups.osprey.costEconomics.actualCostUsd).toBeCloseTo(40, 6);
    expect(groups.osprey.headline.totalPipelineUsd).toBe(0);
    expect(groups.osprey.costEconomics.roiMultiple).toBe(0);
    expect(groups.osprey.costEconomics.costPerAcquisitionUsd).toBeNull();
  });

  it("reads the SAME four figures as the brand when all the spend sits on one workflow", async () => {
    const fixture: Fixture = {
      costBySlug: { "dawn-v1": 3000, "dawn-v2": 2000 },
      leads: [replyLead("dawn-v1", "l1"), replyLead("dawn-v2", "l2")],
      workflows: WORKFLOWS,
    };

    mockFetch(fixture);
    const brand = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(brand.status).toBe(200);

    mockFetch(fixture);
    const perWorkflow = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow")
      .set(AUTH);
    expect(perWorkflow.status).toBe(200);
    expect(perWorkflow.body.groups).toHaveLength(1);

    const only = perWorkflow.body.groups[0];
    expect(only.headline.totalPipelineUsd).toBeCloseTo(brand.body.headline.totalPipelineUsd, 6);
    expect(only.costEconomics.actualCostUsd).toBeCloseTo(brand.body.costEconomics.actualCostUsd, 6);
    expect(only.costEconomics.roiMultiple).toBeCloseTo(brand.body.costEconomics.roiMultiple, 6);
    expect(only.costEconomics.costOfAcquisitionPct).toBeCloseTo(brand.body.costEconomics.costOfAcquisitionPct, 6);
    expect(only.costEconomics.costPerAcquisitionUsd).toBeCloseTo(brand.body.costEconomics.costPerAcquisitionUsd, 6);
  });

  it("leaves the un-grouped and per-campaign answers untouched — they are the customer's Overview", async () => {
    const fixture: Fixture = {
      costBySlug: { "dawn-v1": 3000, "osprey-v1": 2000 },
      leads: [replyLead("dawn-v1", "l1"), replyLead("osprey-v1", "l2")],
      workflows: WORKFLOWS,
    };

    mockFetch(fixture);
    const overview = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(overview.status).toBe(200);
    // Both leads, the brand's whole spend — no workflow vocabulary anywhere on the body.
    expect(overview.body.headline.totalPipelineUsd).toBeCloseTo(240, 6);
    expect(overview.body.costEconomics.actualCostUsd).toBeCloseTo(50, 6);
    expect(overview.body.groupBy).toBeUndefined();
    expect(JSON.stringify(overview.body)).not.toContain("workflowDynastySlug");

    mockFetch(fixture);
    const grouped = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=campaignId")
      .set(AUTH);
    expect(grouped.status).toBe(200);
    expect(grouped.body.groupBy).toBe("campaignId");
    expect(JSON.stringify(grouped.body)).not.toContain("workflowDynastySlug");
  });

  it("puts a lead the producer served under NO workflow in no group — never parks it on one", async () => {
    mockFetch({
      costBySlug: { "dawn-v1": 1000 },
      leads: [replyLead("dawn-v1", "l1"), replyLead(null, "orphan")],
      workflows: WORKFLOWS,
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    // One priced lead, not two — the unattributed one is nobody's.
    expect(res.body.groups[0].headline.totalPipelineUsd).toBeCloseTo(120, 6);
  });

  it("keeps a workflow whose lineage nobody describes, as its own dynasty — never dropped", async () => {
    mockFetch({
      costBySlug: { "dawn-v1": 1000, "retired-legacy": 7000 },
      leads: [replyLead("dawn-v1", "l1")],
      workflows: WORKFLOWS,
    });

    const groups = byWorkflow(
      (await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow").set(AUTH)).body,
    );
    expect(Object.keys(groups).sort()).toEqual(["dawn", "retired-legacy"]);
    expect(groups["retired-legacy"].workflowDynastyName).toBeNull();
    expect(groups["retired-legacy"].costEconomics.actualCostUsd).toBeCloseTo(70, 6);
  });

  it("answers the VOLUME half per workflow — outreach, visits, replies, realized spend and the two costs", async () => {
    mockFetch({
      costBySlug: { "dawn-v1": 3000, "dawn-v2": 2000, "osprey-v1": 4000 },
      leads: [
        // Dawn, across BOTH versions: 4 people reached, 2 of them visited, 1 of them replied.
        replyLead("dawn-v1", "l1"),
        clickLead("dawn-v2", "l2"),
        clickLead("dawn-v1", "l3"),
        silentLead("dawn-v2", "l4"),
        // Osprey reached one person and got nothing back.
        silentLead("osprey-v1", "l5"),
      ],
      workflows: WORKFLOWS,
    });

    const groups = byWorkflow(
      (await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow").set(AUTH)).body,
    );

    // Dawn's versions fold into ONE dynasty on the volume half exactly as they do on the money half.
    expect(groups.dawn.outcomes).toEqual({
      recipientsContacted: 4,
      recipientsConvertible: 4,
      recipientsBounced: 0,
      recipientsUnsubscribed: 0,
      recipientsClicked: 2,
      recipientsRepliesPositive: 1,
      committedSpentCents: 5000,
      actualSpentCents: 5000,
      cpcCents: 2500,
      cpprCents: 5000,
    });
    // Realized spend is the money block's own, in cents — one basis, so the rates and the ROI agree.
    expect(groups.dawn.outcomes.actualSpentCents).toBe(groups.dawn.costEconomics.actualCostUsd * 100);
    expect(groups.osprey.outcomes.recipientsContacted).toBe(1);
    expect(groups.osprey.outcomes.actualSpentCents).toBe(4000);
  });

  it("reports NULL, never 0, for a rate a workflow bought no outcome for", async () => {
    mockFetch({
      // Osprey spent $40 and bought neither a visit nor a positive reply.
      costBySlug: { "dawn-v1": 3000, "osprey-v1": 4000 },
      leads: [clickLead("dawn-v1", "l1"), silentLead("osprey-v1", "l2")],
      workflows: WORKFLOWS,
    });

    const groups = byWorkflow(
      (await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow").set(AUTH)).body,
    );
    // Spend, no outcome: "we could not measure this", not "$0 each" and not a floored benchmark.
    expect(groups.osprey.outcomes.cpcCents).toBeNull();
    expect(groups.osprey.outcomes.cpprCents).toBeNull();
    expect(groups.osprey.outcomes.recipientsClicked).toBe(0);
    // Dawn bought a visit but no reply — the two rates are decided independently.
    expect(groups.dawn.outcomes.cpcCents).toBe(3000);
    expect(groups.dawn.outcomes.cpprCents).toBeNull();
  });

  it("reads the SAME volume figures as the brand when all the spend sits on one workflow", async () => {
    const fixture: Fixture = {
      costBySlug: { "dawn-v1": 3000, "dawn-v2": 2000 },
      leads: [replyLead("dawn-v1", "l1"), clickLead("dawn-v2", "l2"), silentLead("dawn-v1", "l3")],
      workflows: WORKFLOWS,
    };

    mockFetch(fixture);
    const brand = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
    expect(brand.status).toBe(200);

    mockFetch(fixture);
    const only = (
      await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow").set(AUTH)
    ).body.groups[0];

    expect(only.outcomes.recipientsContacted).toBe(brand.body.recipientsContacted.total);
    expect(only.outcomes.recipientsClicked).toBe(brand.body.recipientsClicked.total);
    expect(only.outcomes.recipientsRepliesPositive).toBe(brand.body.recipientsRepliesPositive.total);
    expect(only.outcomes.actualSpentCents).toBe(brand.body.spend.actualSpentCents);
  });

  it("counts a lead re-served under two VERSIONS of one workflow ONCE", async () => {
    mockFetch({
      costBySlug: { "dawn-v1": 1000, "dawn-v2": 1000 },
      // The same person, served under both of Dawn's versions. One person to the dynasty.
      leads: [clickLead("dawn-v1", "l1"), clickLead("dawn-v2", "l1")],
      workflows: WORKFLOWS,
    });

    const groups = byWorkflow(
      (await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow").set(AUTH)).body,
    );
    expect(groups.dawn.outcomes.recipientsContacted).toBe(1);
    expect(groups.dawn.outcomes.recipientsClicked).toBe(1);
    expect(groups.dawn.outcomes.cpcCents).toBe(2000);
  });

  it("degrades to the VERSION grain when workflow-service cannot be read — a poorer grouping, never a wrong number", async () => {
    mockFetch({
      costBySlug: { "dawn-v1": 3000, "dawn-v2": 2000 },
      leads: [replyLead("dawn-v1", "l1"), replyLead("dawn-v2", "l2")],
      workflows: null,
    });

    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&groupBy=workflow")
      .set(AUTH);
    expect(res.status).toBe(200);
    const groups = byWorkflow(res.body);
    expect(Object.keys(groups).sort()).toEqual(["dawn-v1", "dawn-v2"]);
    // The money is still exactly right at the grain it could be grouped on.
    expect(groups["dawn-v1"].costEconomics.actualCostUsd).toBeCloseTo(30, 6);
    expect(groups["dawn-v1"].headline.totalPipelineUsd).toBeCloseTo(120, 6);
    expect(groups["dawn-v2"].costEconomics.actualCostUsd).toBeCloseTo(20, 6);
  });
});
