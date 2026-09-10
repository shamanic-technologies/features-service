/**
 * ONE CAMPAIGN'S WORKFLOWS, AND ONE OF THOSE WORKFLOWS ON ITS OWN.
 *
 * A customer opens a campaign's Workflows page and then clicks a row. Both screens were unanswerable:
 * `?groupBy=workflow` stated the BRAND's figures whatever campaign the reader was looking at, and the
 * un-grouped read had no way to drill into one workflow at all. A brand figure under a campaign's
 * name is the wrong-grain bug this fleet has already paid for once.
 *
 * These drive `/revenue` from ONE fixture where the brand's numbers and the campaign's DIVERGE by
 * construction — a second campaign on another channel carries most of the brand's spend and most of
 * its replies through the SAME workflow dynasty. So every case asserts the divergence: a suite that
 * only checked "a number came back" would pass on an implementation that ignored the parameter
 * entirely, which is exactly what shipped before.
 *
 * They also pin what must NOT move: an un-narrowed read of either shape is byte-identical to today.
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
const SALES = "sales-cold-email-outreach";
const BRAND = "brand-1";
const FEATURE = {
  id: "feat-1", slug: SALES, name: "Sales", description: "x", status: "active",
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

/** The catalogue: two versions of ONE dynasty (`dawn`) beside a second dynasty (`osprey`). */
const WORKFLOWS = [
  { id: "w1", workflowSlug: "dawn-v1", workflowName: "Dawn v1", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 1, status: "inactive", featureSlug: SALES, createdForBrandId: null, upgradedTo: "w2" },
  { id: "w2", workflowSlug: "dawn-v2", workflowName: "Dawn v2", workflowDynastyName: "Dawn", workflowDynastySlug: "dawn", version: 2, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null },
  { id: "w3", workflowSlug: "osprey-v1", workflowName: "Osprey v1", workflowDynastyName: "Osprey", workflowDynastySlug: "osprey", version: 1, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null },
];
const dynastyOf = (slug: string) => WORKFLOWS.find((w) => w.workflowSlug === slug)?.workflowDynastySlug ?? slug;

/**
 * ONE campaign IDENTITY of two rows (the live one and the ancestor it switched away from), beside a
 * SECOND campaign on another channel. campaign-service's key is (org, brand, funnel, channel), so
 * `other` is a different campaign — and it is what makes the brand's numbers diverge from this one's.
 */
const CAMPAIGNS = [
  { id: "stopped", orgId: "org-1", brandId: BRAND, featureSlug: SALES, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: SALES, status: "stopped", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "live", orgId: "org-1", brandId: BRAND, featureSlug: SALES, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: SALES, status: "ongoing", createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "other", orgId: "org-1", brandId: BRAND, featureSlug: SALES, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "crm_email", status: "ongoing", createdAt: "2026-02-01T00:00:00.000Z" },
];

type LeadShape = { clicked?: boolean; positive?: boolean };
function lead(campaignId: string, workflowSlug: string | null, leadId: string, shape: LeadShape = {}): Record<string, unknown> {
  return {
    leadId,
    campaignId,
    workflowSlug,
    email: `${leadId}@x.com`,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: Boolean(shape.clicked),
    bounced: false,
    unsubscribed: false,
    replied: Boolean(shape.positive),
    replyClassification: shape.positive ? "positive" : null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}

/** COMMITTED cents per (campaignId, versioned workflow slug) — what runs-service holds. */
interface CostRow { campaignId: string; workflowSlug: string; committed: number; actual: number }

const COSTS: CostRow[] = [
  { campaignId: "live", workflowSlug: "dawn-v2", committed: 4000, actual: 3000 },
  { campaignId: "stopped", workflowSlug: "dawn-v1", committed: 1000, actual: 1000 },
  { campaignId: "live", workflowSlug: "osprey-v1", committed: 2000, actual: 2000 },
  // The OTHER campaign, on the SAME dynasty: the brand grain is dominated by it, so a per-workflow
  // group that ignored the campaign scope reads 13000¢ where this campaign spent 5000¢.
  { campaignId: "other", workflowSlug: "dawn-v2", committed: 8000, actual: 8000 },
  // A RETIRED lineage — real spend and a real lead under a slug workflow-service no longer
  // describes. It is its own dynasty of one, and it is exactly the workflow a "which of these
  // burned money" question is about.
  { campaignId: "live", workflowSlug: "retired-v1", committed: 700, actual: 700 },
];

const LEADS = [
  lead("live", "dawn-v2", "l1", { positive: true }),
  lead("live", "dawn-v2", "l2"),
  lead("stopped", "dawn-v1", "l3", { positive: true }),
  lead("live", "osprey-v1", "l4", { clicked: true }),
  lead("other", "dawn-v2", "o1", { positive: true }),
  lead("other", "dawn-v2", "o2", { positive: true }),
  lead("other", "dawn-v2", "o3", { positive: true }),
  lead("live", "retired-v1", "r1", { positive: true }),
];

interface Options {
  /** `false` = workflow-service unreachable (the fail-loud case for `?workflow=`). */
  catalogue?: boolean;
  /** NET cents per (campaign, slug) — half the gross here, so a net read cannot pass as gross. */
  net?: boolean;
}

/**
 * Emulates the producers' OWN filtering, so the assertions are about this service's requests rather
 * than about a fixture that hands back whatever is convenient: runs applies `campaignId` /
 * `workflowDynastySlug` / `groupBy`, lead-service applies `campaignId`, email-gateway applies both.
 */
type FetchImpl = (input: unknown, init?: unknown) => Promise<Response>;

function mockFetch(options: Options = {}): FetchImpl {
  const catalogue = options.catalogue !== false;
  const impl: FetchImpl = async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.pathname.includes("/public/workflows")) {
      if (!catalogue) return new Response("workflow-service down", { status: 503 });
      return json({ workflows: WORKFLOWS });
    }
    if (url.pathname.endsWith("/campaigns")) return json({ campaigns: CAMPAIGNS });
    // The brand declares the funnel its campaigns sell — so the funnel walk has ONE chain to state.
    // No per-funnel rates: every term falls through to the brand-wide economics, unchanged.
    if (url.pathname.includes("/sales-funnels")) {
      return json({ funnels: [{ funnelKey: "sales_meetings_from_conversation", name: "Meetings from a conversation" }] });
    }
    if (url.pathname.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    // The producers filter on the VERSIONED slugs the caller resolved — `workflowSlugs`. The dynasty
    // lever exists on both, and this service deliberately does not use it (see workflow-scope.ts).
    const rowsFor = () => {
      const campaignId = q.get("campaignId");
      const slugs = q.get("workflowSlugs")?.split(",");
      return COSTS.filter(
        (c) => (!campaignId || c.campaignId === campaignId) && (!slugs || slugs.includes(c.workflowSlug)),
      );
    };
    const cents = (n: number) => String(options.net ? n / 2 : n);

    if (url.pathname.includes("/stats/public/costs/timeseries")) {
      // The ONE leg with no slug filter. It resolves the dynasty through workflow-service, which 404s
      // for one it does not describe — reproduced here so the fail-soft degrade is exercised.
      const dynasty = q.get("workflowDynastySlug");
      if (dynasty && !WORKFLOWS.some((w) => w.workflowDynastySlug === dynasty)) {
        return new Response(JSON.stringify({ error: `No workflows found for workflowDynastySlug: ${dynasty}` }), { status: 500 });
      }
      const campaignId = q.get("campaignId");
      const total = COSTS.filter(
        (c) => (!campaignId || c.campaignId === campaignId) && (!dynasty || dynastyOf(c.workflowSlug) === dynasty),
      ).reduce((sum, c) => sum + c.committed, 0);
      return json({
        interval: "day",
        timezone: "UTC",
        buckets: [{
          period: "2026-02-01",
          totalCostInUsdCents: String(total), actualCostInUsdCents: String(total),
          provisionedCostInUsdCents: "0", cancelledCostInUsdCents: "0", refundedCostInUsdCents: "0",
          netRefundedCostInUsdCents: "0", netTotalCostInUsdCents: String(total / 2),
          netActualCostInUsdCents: String(total / 2), netProvisionedCostInUsdCents: "0", runCount: 1,
        }],
      });
    }
    if (url.pathname.includes("/stats/costs")) {
      const groupBy = (q.get("groupBy") ?? "").split(",");
      const groups = rowsFor().map((c) => {
        const dimensions: Record<string, string> = {};
        if (groupBy.includes("workflowSlug")) dimensions.workflowSlug = c.workflowSlug;
        if (groupBy.includes("campaignId")) dimensions.campaignId = c.campaignId;
        if (groupBy.includes("costName")) dimensions.costName = "email-send";
        return {
          dimensions,
          totalCostInUsdCents: cents(c.committed),
          actualCostInUsdCents: cents(c.actual),
          netTotalCostInUsdCents: String(c.committed / 2),
          netActualCostInUsdCents: String(c.actual / 2),
          runCount: 1, minStartedAt: null, maxStartedAt: null,
        };
      });
      return json({ groups });
    }
    if (url.pathname.includes("/orgs/leads")) {
      const campaignId = q.get("campaignId");
      return json({ leads: campaignId ? LEADS.filter((l) => l.campaignId === campaignId) : LEADS });
    }
    if (url.pathname.includes("/orgs/stats")) {
      const campaignId = q.get("campaignId");
      const slugs = q.get("workflowSlugs")?.split(",");
      const contacted = LEADS.filter(
        (l) => (!campaignId || l.campaignId === campaignId) && (!slugs || slugs.includes(String(l.workflowSlug))),
      ).length;
      return json({ groups: [{ key: "2026-02-01", broadcast: { recipientStats: { contacted } } }] });
    }
    if (url.pathname.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.pathname.includes("/orgs/status")) return json({ results: [] });
    return json({});
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
  return impl;
}

/** The same fixture, with every request URL recorded — for asserting what the PRODUCERS were asked. */
function recordingFetch(options: Options = {}): string[] {
  const impl = mockFetch(options);
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: unknown) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url);
    return impl(input, init);
  }) as never);
  return seen;
}

interface Group {
  workflowDynastySlug: string;
  workflowSlugs: string[];
  headline: { totalPipelineUsd: number | null };
  costEconomics: { committedCostUsd: number };
  outcomes: { recipientsContacted: number; recipientsRepliesPositive: number; recipientsClicked: number; committedSpentCents: number; cpprCents: number | null; cpcCents: number | null };
}

async function grouped(query: string): Promise<{ status: number; body: Record<string, unknown>; byWorkflow: Record<string, Group> }> {
  const res = await request(app).get(`/features/${SALES}/revenue?brandId=${BRAND}&groupBy=workflow${query}`).set(AUTH);
  const groups: Group[] = (res.body.groups ?? []) as Group[];
  return { status: res.status, body: res.body, byWorkflow: Object.fromEntries(groups.map((g) => [g.workflowDynastySlug, g])) };
}

async function revenue(query: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await request(app).get(`/features/${SALES}/revenue?brandId=${BRAND}${query}`).set(AUTH);
  return { status: res.status, body: res.body };
}

beforeEach(() => {
  vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as never);
});
afterEach(() => vi.restoreAllMocks());

describe("?groupBy=workflow&campaignId= — a campaign's workflows, at the campaign's grain", () => {
  it("states what THIS campaign did through each workflow, and DIVERGES from the brand", async () => {
    mockFetch();

    const brand = await grouped("");
    const campaign = await grouped("&campaignId=live");

    // The brand's `dawn` row folds in the other campaign's 8000¢ and its three replies.
    expect(brand.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(130);
    expect(brand.byWorkflow.dawn.outcomes.recipientsContacted).toBe(6);
    expect(brand.byWorkflow.dawn.outcomes.recipientsRepliesPositive).toBe(5);

    // The campaign's own row: its two members' spend on the dynasty (4000 + 1000) and its own people.
    expect(campaign.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(50);
    expect(campaign.byWorkflow.dawn.outcomes.recipientsContacted).toBe(3);
    expect(campaign.byWorkflow.dawn.outcomes.recipientsRepliesPositive).toBe(2);
    expect(campaign.byWorkflow.dawn.outcomes.committedSpentCents).toBe(5000);
    // 5000¢ over 2 replies — coherent with the committed basis by construction.
    expect(campaign.byWorkflow.dawn.outcomes.cpprCents).toBe(2500);
    // Two positively-replying leads in two organisations: 2 × $120.
    expect(campaign.byWorkflow.dawn.headline.totalPipelineUsd).toBeCloseTo(240, 5);

    // BOTH versions of the dynasty are folded in — the ancestor's workflow is still this campaign's.
    expect(campaign.byWorkflow.dawn.workflowSlugs).toEqual(["dawn-v1", "dawn-v2"]);
  });

  it("answers for the whole campaign IDENTITY — either member reads the same, and says so", async () => {
    mockFetch();

    const live = await grouped("&campaignId=live");
    const stopped = await grouped("&campaignId=stopped");

    expect(stopped.byWorkflow).toEqual(live.byWorkflow);
    expect((live.body.campaignIdentity as { campaignIds: string[] }).campaignIds).toEqual(["live", "stopped"]);
    expect((live.body.campaignIdentity as { representativeId: string }).representativeId).toBe("live");
    // The stopped ancestor's own spend is in the campaign's answer, which is the whole point of the
    // identity: it is one campaign to the customer whatever campaign-service did with its rows.
    expect(live.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(50);
  });

  it("keeps every workflow of the campaign, each on its own numbers", async () => {
    mockFetch();
    const { byWorkflow } = await grouped("&campaignId=live");

    expect(Object.keys(byWorkflow).sort()).toEqual(["dawn", "osprey", "retired-v1"]);
    expect(byWorkflow.osprey.costEconomics.committedCostUsd).toBe(20);
    expect(byWorkflow.osprey.outcomes.recipientsContacted).toBe(1);
    // It reached one person who visited the site and nobody who replied: a MEASURED count of 0 beside
    // a NULL rate, never a $0 that would read as a free reply.
    expect(byWorkflow.osprey.outcomes.recipientsRepliesPositive).toBe(0);
    expect(byWorkflow.osprey.outcomes.cpprCents).toBeNull();
    expect(byWorkflow.osprey.outcomes.cpcCents).toBe(2000);
  });

  it("a campaign that spent through no workflow is an EMPTY list, never the brand's figures", async () => {
    mockFetch();
    // `other` is on another channel; give it a campaign scope that has no cost row and no lead.
    const res = await request(app)
      .get(`/features/${SALES}/revenue?brandId=${BRAND}&groupBy=workflow&campaignId=never-ran`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it("the brand-wide read carries NO campaign identity and is unchanged", async () => {
    mockFetch();
    const brand = await grouped("");
    expect(brand.body.campaignIdentity).toBeUndefined();
    expect(brand.byWorkflow.dawn.costEconomics.committedCostUsd).toBe(130);
  });

  it("honours ?pricing=net — the frozen net twin, on the campaign's own scope", async () => {
    mockFetch({ net: true });
    const { byWorkflow } = await grouped("&campaignId=live&pricing=net");
    expect(byWorkflow.dawn.costEconomics.committedCostUsd).toBe(25);
  });
});

describe("?workflow= — one workflow of the scope, on the un-grouped body", () => {
  it("narrows every block, and DIVERGES from the un-narrowed read", async () => {
    mockFetch();

    const whole = await revenue("");
    const drilled = await revenue("&workflow=dawn");

    expect(whole.body.outcomes.recipientsContacted).toBe(8);
    expect(whole.body.costEconomics.committedCostUsd).toBe(157);

    // dawn across the brand: 4000 + 1000 + 8000 = 13000¢, six people, five replies.
    expect(drilled.status).toBe(200);
    expect(drilled.body.costEconomics.committedCostUsd).toBe(130);
    expect(drilled.body.outcomes.recipientsContacted).toBe(6);
    expect(drilled.body.outcomes.recipientsRepliesPositive).toBe(5);
    expect(drilled.body.spend.totalSpentCents).toBe(13000);
    // The funnel walk, the return curve and the daily series are the same narrowed evidence.
    expect(drilled.body.funnelSteps.contactedRecipients).toBe(6);
    expect(drilled.body.funnelSteps.steps[0].recipientsReached).toBe(5);
    expect(drilled.body.recipientsContacted.total).toBe(6);
    expect(drilled.body.roiHistory).not.toBeNull();
    // The echo names the subject rather than leaving a consumer to infer it from a number.
    expect(drilled.body.workflow).toEqual({
      workflowDynastySlug: "dawn",
      workflowDynastyName: "Dawn",
      workflowSlugs: ["dawn-v1", "dawn-v2"],
    });
  });

  it("composes with ?campaignId= — one campaign, one workflow", async () => {
    mockFetch();
    const { body } = await revenue("&campaignId=live&workflow=dawn");

    expect(body.costEconomics.committedCostUsd).toBe(50);
    expect(body.outcomes.recipientsContacted).toBe(3);
    expect(body.outcomes.recipientsRepliesPositive).toBe(2);
    expect(body.headline.totalPipelineUsd).toBeCloseTo(240, 5);
    expect(body.funnelSteps.contactedRecipients).toBe(3);
    expect(body.funnelSteps.steps[0].recipientsReached).toBe(2);
    // The campaign's OTHER workflow is a different, smaller answer on the same scope.
    const osprey = await revenue("&campaignId=live&workflow=osprey");
    expect(osprey.body.costEconomics.committedCostUsd).toBe(20);
    expect(osprey.body.outcomes.recipientsContacted).toBe(1);
    expect(osprey.body.outcomes.recipientsClicked).toBe(1);
  });

  it("a campaign-scoped drill-down equals that campaign's own group in the grouped read", async () => {
    mockFetch();
    const { byWorkflow } = await grouped("&campaignId=live");
    const { body } = await revenue("&campaignId=live&workflow=dawn");

    expect(body.costEconomics.committedCostUsd).toBe(byWorkflow.dawn.costEconomics.committedCostUsd);
    expect(body.outcomes.recipientsContacted).toBe(byWorkflow.dawn.outcomes.recipientsContacted);
    expect(body.outcomes.recipientsRepliesPositive).toBe(byWorkflow.dawn.outcomes.recipientsRepliesPositive);
    expect(body.headline.totalPipelineUsd).toBeCloseTo(byWorkflow.dawn.headline.totalPipelineUsd!, 5);
  });

  it("a workflow the scope never ran is an EMPTY answer, never a 404 and never a fleet estimate", async () => {
    mockFetch();
    const { status, body } = await revenue("&campaignId=live&workflow=never-ran");

    expect(status).toBe(200);
    expect(body.costEconomics.committedCostUsd).toBe(0);
    expect(body.outcomes.recipientsContacted).toBe(0);
    expect(body.outcomes.cpprCents).toBeNull();
    expect(body.workflow.workflowDynastySlug).toBe("never-ran");
    expect(body.workflow.workflowSlugs).toEqual([]);
  });

  it("honours ?pricing=net on the drill-down", async () => {
    mockFetch({ net: true });
    const { body } = await revenue("&campaignId=live&workflow=dawn&pricing=net");
    expect(body.costEconomics.committedCostUsd).toBe(25);
  });

  it("omitting it is byte-identical to today — no workflow echo, nothing narrowed", async () => {
    mockFetch();
    const { body } = await revenue("");
    expect(body.workflow).toBeUndefined();
    expect(body.outcomes.recipientsContacted).toBe(8);
  });

  it("is FAIL-LOUD when the catalogue is unreachable — never one version under the whole workflow's name", async () => {
    mockFetch({ catalogue: false });
    const { status } = await revenue("&workflow=dawn");
    expect(status).toBe(502);
  });

  it("a RETIRED lineage answers with its real numbers — the producers are asked for the SLUG, never the dynasty", async () => {
    const seen = recordingFetch();

    const { status, body } = await revenue("&campaignId=live&workflow=retired-v1");

    // Prod, 2026-09-10: routing this through the producers' own dynasty lever made runs answer 500
    // and email-gateway 502, so the read 502'd for exactly the workflow the question is about.
    expect(status).toBe(200);
    expect(body.costEconomics.committedCostUsd).toBe(7);
    expect(body.outcomes.recipientsContacted).toBe(1);
    expect(body.outcomes.recipientsRepliesPositive).toBe(1);
    // It is its own dynasty of one: no name, no versions, and still a real answer.
    expect(body.workflow).toEqual({ workflowDynastySlug: "retired-v1", workflowDynastyName: null, workflowSlugs: [] });
    // The dated-spend leg is the ONE that must ask the producer to resolve the dynasty, so it is the
    // one that degrades — a null curve beside correct money, never a 502.
    expect(body.roiHistory).toBeNull();

    const spendCalls = seen.filter((u) => u.includes("/stats/costs") && u.includes("groupBy=costName"));
    expect(spendCalls.length).toBeGreaterThan(0);
    expect(spendCalls.every((u) => u.includes("workflowSlugs=retired-v1"))).toBe(true);
    expect(spendCalls.some((u) => u.includes("workflowDynastySlug="))).toBe(false);
    const dayCalls = seen.filter((u) => u.includes("/orgs/stats") && u.includes("groupBy=day"));
    expect(dayCalls.length).toBeGreaterThan(0);
    expect(dayCalls.every((u) => u.includes("workflowSlugs=retired-v1"))).toBe(true);
  });

  it("asks the spend producers for the dynasty's VERSIONED slugs, both of them", async () => {
    const seen = recordingFetch();

    await revenue("&campaignId=live&workflow=dawn");

    // The SPEND block's own reads (groupBy=costName). Other /stats/costs calls on this path are the
    // brand-level cost-per-outcome BENCHMARK, which is deliberately not narrowed to one workflow.
    const spendCalls = seen.filter((u) => u.includes("/stats/costs") && u.includes("groupBy=costName"));
    expect(spendCalls.length).toBeGreaterThan(0);
    expect(spendCalls.every((u) => decodeURIComponent(u).includes("workflowSlugs=dawn-v1,dawn-v2"))).toBe(true);
    expect(spendCalls.some((u) => u.includes("workflowDynastySlug="))).toBe(false);
    // The timeseries has no slug filter at all, so it is the one leg that keeps the dynasty lever.
    expect(seen.filter((u) => u.includes("timeseries")).every((u) => u.includes("workflowDynastySlug=dawn"))).toBe(true);
  });

  it("naming both a workflow and a groupBy is a 400", async () => {
    mockFetch();
    const res = await request(app)
      .get(`/features/${SALES}/revenue?brandId=${BRAND}&workflow=dawn&groupBy=workflow`)
      .set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("workflow_and_group_by");
  });
});
