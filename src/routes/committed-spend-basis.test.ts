/**
 * ONE SPEND BASIS, AND IT IS COMMITTED — pinned at every grain `/revenue` answers on.
 *
 * The bug these guard against was consumer-visible and arithmetically simple: the brand Overview
 * read the `spend` block (COMMITTED — billed plus the open provisioned holds) while the campaigns
 * table read `costEconomics` (BILLED only), so one brand running exactly ONE campaign reported
 * "Total spent $202" beside "$ Invested $191", with its ROI and %CAC computed off the smaller
 * number. Both figures were individually correct; the payload answered one question two ways.
 *
 * Every case below drives ONE downstream fixture in which committed and billed DIFFER (20200 vs
 * 19100 cents — the prod ratio), because a fixture where they coincide cannot fail this way. The
 * invariant asserted is always the same: whatever spend a money figure divides by IS the `spend`
 * block's committed total, at the brand, the campaign, the workflow, the lens and the ROI curve.
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
  // The positive-reply lens is a SINGLE-STEP goal: 12% of replies pay, so a lensed lead is worth the
  // same $120 the meeting funnel prices it at — which is why the lens and the brand read must agree.
  replyToPaidClientPct: 12,
  visitToPaidClientPct: 1,
};

/** The prod shape: $202 committed against $191 billed — the $11 of open holds that split the two views. */
const COMMITTED_CENTS = 20_200;
const BILLED_CENTS = 19_100;
/** Half off, frozen per row by runs-service. NET must divide by the NET committed figure. */
const NET_COMMITTED_CENTS = 10_100;
const NET_BILLED_CENTS = 9_550;

const CAMPAIGN_ID = "c1";
const WORKFLOW_SLUG = "dawn-v1";
const WORKFLOWS = [
  {
    id: "w1", workflowSlug: WORKFLOW_SLUG, workflowName: "Dawn v1", workflowDynastyName: "Dawn",
    workflowDynastySlug: "dawn", version: 1, status: "active", featureSlug: "sales-cold-email-outreach",
    createdForBrandId: null, upgradedTo: null,
  },
];

function replyLead(leadId: string): Record<string, unknown> {
  return {
    leadId,
    campaignId: CAMPAIGN_ID,
    workflowSlug: WORKFLOW_SLUG,
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

/** Two positively-replying leads at $120 each — the brand's whole pipeline, on its single campaign. */
const LEADS = [replyLead("l1"), replyLead("l2")];
const PIPELINE_USD = 240;

/**
 * ONE fixture behind every grain. runs-service answers the SAME (committed, billed) pair whatever it
 * is grouped by, because the brand has one campaign on one workflow — which is exactly the prod
 * repro: the two grains describe the identical scope and therefore may not disagree.
 */
function mockFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/campaigns?")) return json({ campaigns: [] });
    if (url.includes("/sales-funnels")) return new Response("not found", { status: 404 });

    if (url.includes("/v1/stats/public/costs/timeseries")) {
      // Two days that sum to the untimed totals — runs guarantees this, which is what lets the
      // curve's last point land ON the headline ROI instead of near it.
      return json({
        buckets: [
          {
            period: "2026-08-01",
            totalCostInUsdCents: String(COMMITTED_CENTS / 2),
            actualCostInUsdCents: String(BILLED_CENTS / 2),
            netTotalCostInUsdCents: String(NET_COMMITTED_CENTS / 2),
            netActualCostInUsdCents: String(NET_BILLED_CENTS / 2),
          },
          {
            period: "2026-08-02",
            totalCostInUsdCents: String(COMMITTED_CENTS / 2),
            actualCostInUsdCents: String(BILLED_CENTS / 2),
            netTotalCostInUsdCents: String(NET_COMMITTED_CENTS / 2),
            netActualCostInUsdCents: String(NET_BILLED_CENTS / 2),
          },
        ],
      });
    }

    if (url.includes("/v1/stats/costs")) {
      const groupBy = new URL(url).searchParams.get("groupBy") ?? "";
      // `startedAfter` narrows the spend block's "today" figures; the whole population is fine here.
      const dimensions: Record<string, string> = {};
      if (groupBy.includes("workflowSlug")) dimensions.workflowSlug = WORKFLOW_SLUG;
      if (groupBy.includes("campaignId")) dimensions.campaignId = CAMPAIGN_ID;
      if (groupBy.includes("costName")) dimensions.costName = "email-send";
      return json({
        groups: [
          {
            dimensions,
            totalCostInUsdCents: String(COMMITTED_CENTS),
            actualCostInUsdCents: String(BILLED_CENTS),
            netTotalCostInUsdCents: String(NET_COMMITTED_CENTS),
            netActualCostInUsdCents: String(NET_BILLED_CENTS),
            runCount: 4,
            minStartedAt: null,
            maxStartedAt: null,
          },
        ],
      });
    }

    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/leads")) return json({ leads: LEADS });
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.includes("/orgs/status")) {
      // Dated replies — without them the pipeline is undated and sits on no day of the ROI curve.
      return json({
        results: LEADS.map((l) => ({
          email: l.email,
          broadcast: {
            brand: {
              contacted: true,
              replied: true,
              replyClassification: "positive",
              firstContactedAt: "2026-08-01T00:00:00.000Z",
              firstSentAt: "2026-08-01T00:00:00.000Z",
              firstDeliveredAt: "2026-08-01T00:00:00.000Z",
              firstRepliedAt: "2026-08-02T00:00:00.000Z",
            },
          },
        })),
      });
    }
    return json({});
  });
}

const get = (query: string) =>
  request(app).get(`/features/sales-cold-email-outreach/revenue?brandId=b1${query}`).set(AUTH);

describe("ONE COMMITTED spend basis across every /revenue grain (features-service#779)", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("the brand Overview's ROI rides the SAME total its spend block reports, not the billed-only one", async () => {
    const res = await get("");
    expect(res.status).toBe(200);

    // The prod contradiction, gone: the spend a consumer renders as "$ Invested" IS "Total spent".
    expect(res.body.spend.totalSpentCents).toBe(COMMITTED_CENTS);
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(COMMITTED_CENTS / 100, 6);
    expect(res.body.costEconomics.committedCostUsd * 100).toBe(res.body.spend.totalSpentCents);

    // ROI, %CAC and $CAC all reproduce from that one number.
    expect(res.body.costEconomics.roiMultiple).toBeCloseTo(PIPELINE_USD / (COMMITTED_CENTS / 100), 6);
    expect(res.body.costEconomics.costOfAcquisitionPct).toBeCloseTo(
      (COMMITTED_CENTS / 100 / PIPELINE_USD) * 100,
      6,
    );
    // expected paying clients = pipeline / LTR = 240 / 1000.
    expect(res.body.costEconomics.costPerAcquisitionUsd).toBeCloseTo(COMMITTED_CENTS / 100 / 0.24, 6);

    // The billed-only figure is still SERVED, still honestly billed-only, and divided by nowhere:
    // a consumer reading the old field has a gap-free path, and the ROI it sits beside is not its own.
    expect(res.body.costEconomics.actualCostUsd).toBeCloseTo(BILLED_CENTS / 100, 6);
    expect(res.body.spend.actualSpentCents).toBe(BILLED_CENTS);
    expect(res.body.costEconomics.roiMultiple).not.toBeCloseTo(PIPELINE_USD / (BILLED_CENTS / 100), 6);
  });

  it("the single campaign's group reads exactly the brand's figures — the two views cannot disagree", async () => {
    const overview = await get("");
    const grouped = await get("&groupBy=campaignId");
    expect(grouped.status).toBe(200);
    expect(grouped.body.groups).toHaveLength(1);

    const only = grouped.body.groups[0].costEconomics;
    expect(only.committedCostUsd).toBeCloseTo(overview.body.costEconomics.committedCostUsd, 6);
    expect(only.roiMultiple).toBeCloseTo(overview.body.costEconomics.roiMultiple, 6);
    expect(only.costOfAcquisitionPct).toBeCloseTo(overview.body.costEconomics.costOfAcquisitionPct, 6);
    expect(only.costPerAcquisitionUsd).toBeCloseTo(overview.body.costEconomics.costPerAcquisitionUsd, 6);
    // And that shared figure is the committed total, not the billed one.
    expect(only.committedCostUsd * 100).toBe(overview.body.spend.totalSpentCents);
  });

  it("the workflow group's money AND volume halves ride one basis — cpc × clicks reconciles with it", async () => {
    const overview = await get("");
    const grouped = await get("&groupBy=workflow");
    expect(grouped.status).toBe(200);
    expect(grouped.body.groups).toHaveLength(1);

    const group = grouped.body.groups[0];
    expect(group.costEconomics.committedCostUsd).toBeCloseTo(overview.body.costEconomics.committedCostUsd, 6);
    expect(group.costEconomics.roiMultiple).toBeCloseTo(overview.body.costEconomics.roiMultiple, 6);

    // The volume half is denominated in the same money as the ROI above it.
    expect(group.outcomes.committedSpentCents).toBe(COMMITTED_CENTS);
    expect(group.outcomes.actualSpentCents).toBe(BILLED_CENTS);
    expect(group.outcomes.recipientsRepliesPositive).toBe(2);
    expect(group.outcomes.cpprCents).toBeCloseTo(COMMITTED_CENTS / 2, 6);
    // No visit on this fixture → null, "we could not measure this", never 0.
    expect(group.outcomes.cpcCents).toBeNull();
  });

  it("the lensed cost per conversion divides by the committed total too, matching $CAC", async () => {
    const res = await get("&lens=positive_replies");
    expect(res.status).toBe(200);
    const ce = res.body.costEconomics;
    expect(ce.committedCostUsd).toBeCloseTo(COMMITTED_CENTS / 100, 6);
    // Both leads reply, each converting at replyToMeeting × meetingToClose = 12%.
    expect(ce.expectedConversions).toBeCloseTo(0.24, 6);
    expect(ce.costPerConversionUsd).toBeCloseTo(COMMITTED_CENTS / 100 / 0.24, 6);
    // The lens and the un-lensed brand read price the same customer identically.
    expect(ce.costPerConversionUsd).toBeCloseTo(ce.costPerAcquisitionUsd, 6);
  });

  it("the ROI curve's final point IS the served ROI — the spend leg is dated committed spend", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    const daily = res.body.roiHistory.daily;
    const last = daily[daily.length - 1];
    expect(last.cumulativeSpendUsd).toBeCloseTo(COMMITTED_CENTS / 100, 6);
    expect(last.roiMultiple).toBeCloseTo(res.body.costEconomics.roiMultiple, 6);
  });

  it("a NET request divides by the NET committed figure — never the gross one, never the net billed one", async () => {
    const res = await get("&pricing=net");
    expect(res.status).toBe(200);
    expect(res.body.spend.totalSpentCents).toBe(NET_COMMITTED_CENTS);
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(NET_COMMITTED_CENTS / 100, 6);
    expect(res.body.costEconomics.actualCostUsd).toBeCloseTo(NET_BILLED_CENTS / 100, 6);
    expect(res.body.costEconomics.roiMultiple).toBeCloseTo(PIPELINE_USD / (NET_COMMITTED_CENTS / 100), 6);
  });
});
