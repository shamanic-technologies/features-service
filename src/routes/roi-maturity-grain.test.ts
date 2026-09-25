/**
 * THE RETURN ON OUR OUTREACH IS MEASURED ON THE MATURE COHORT — driven end to end through /revenue.
 *
 * ONE fixture, on a clock pinned to 2026-10-01 (so the 14-day cutoff is 2026-09-17T00:00Z): a brand
 * that spent $60 on runs started before the cutoff and $40 after it, on a cold-email campaign bought
 * for `start_to_website_visit`. Seven of its ten leads clicked — three first contacted before the
 * cutoff, three after it, one whose contact date is unknown. Every clicked lead is its own company,
 * so each is worth the same, and the mature pipeline is exactly 4/7 of the whole (3 mature + 1
 * undated).
 *
 * Every case asserts a DIVERGENCE a whole-history implementation cannot produce: the ROI on 4/7 of the
 * pipeline over $60 rather than 7/7 over $100, the undated lead kept (4/7, not 3/7), a young campaign
 * reading `maturing` instead of a terrible ratio, and the SAME fixture on a zero-delay leg reading the
 * whole-history ratio — while every count, the funnel walk and the leads table stay byte-identical.
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
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const SALES = "sales-cold-email-outreach";
const NOW = "2026-10-01T12:00:00.000Z";
const CUTOFF = "2026-09-17T00:00:00.000Z";

const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 30,
  visitToMeetingPct: 20,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

const WORKFLOWS = [
  {
    id: "wf-0", workflowSlug: "azalea", workflowName: "azalea",
    workflowDynastyName: "azalea", workflowDynastySlug: "azalea",
    version: 1, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null,
  },
];

/** Committed cents on runs started before / after the cutoff. */
const MATURE_CENTS = 6000;
const YOUNG_CENTS = 4000;

interface Fixture {
  legKey?: string | null;
  /** Every run is younger than the cutoff — the young-campaign case. */
  allYoung?: boolean;
  /** campaign-service unreachable. */
  campaignsDown?: boolean;
}

/** Ten leads, each its own company. Clickers: l1-l3 mature, l4-l6 young, l7 undated; l8-l10 silent. */
const CONTACTED: Record<string, string | null> = {
  l1: "2026-09-01T10:00:00.000Z",
  l2: "2026-09-02T10:00:00.000Z",
  l3: "2026-09-10T10:00:00.000Z",
  l4: "2026-09-20T10:00:00.000Z",
  l5: "2026-09-25T10:00:00.000Z",
  l6: "2026-09-29T10:00:00.000Z",
  l7: null,
  l8: "2026-09-01T10:00:00.000Z",
  l9: "2026-09-21T10:00:00.000Z",
  l10: "2026-09-05T10:00:00.000Z",
};
const CLICKERS = new Set(["l1", "l2", "l3", "l4", "l5", "l6", "l7"]);

function mockFetch(fixture: Fixture = {}): void {
  const legKey = fixture.legKey === undefined ? "start_to_website_visit" : fixture.legKey;
  const beforeCents = fixture.allYoung ? 0 : MATURE_CENTS;
  const lifetimeCents = beforeCents + YOUNG_CENTS;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    const q = url.includes("?") ? new URL(url).searchParams : new URLSearchParams();

    if (url.includes("/campaigns?")) {
      if (fixture.campaignsDown) return new Response("boom", { status: 500 });
      return json({
        campaigns: [{
          id: "c-live", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: SALES,
          funnelKey: "sales_meetings_from_website", acquisitionChannel: "cold_email", legKey,
          status: "ongoing", createdAt: "2026-08-25T00:00:00.000Z",
        }],
      });
    }
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (url.includes("/costs/timeseries")) {
      const young = [{ period: "2026-09-25", cents: YOUNG_CENTS }];
      const buckets = q.get("startedAfter") ? young : [...(beforeCents ? [{ period: "2026-09-05", cents: beforeCents }] : []), ...young];
      return json({
        buckets: buckets.map((b) => ({
          period: b.period,
          totalCostInUsdCents: String(b.cents),
          netTotalCostInUsdCents: String(b.cents),
          actualCostInUsdCents: String(b.cents),
        })),
      });
    }

    if (url.includes("/stats/costs")) {
      const row = (dimensions: Record<string, unknown>, cents: number) => ({
        dimensions,
        totalCostInUsdCents: String(cents),
        actualCostInUsdCents: String(cents),
        runCount: 1, minStartedAt: null, maxStartedAt: null,
      });
      const groupBy = q.get("groupBy") ?? "";
      const dims = (extra: Record<string, unknown>): Record<string, unknown> => ({
        ...Object.fromEntries(
          groupBy.split(",").map((k): [string, string | null] => [
            k,
            k === "workflowSlug" ? "azalea" : k === "campaignId" ? "c-live" : k === "costName" ? "email-send" : null,
          ]),
        ),
        ...extra,
      });
      if (q.get("startedBefore") && groupBy === "workflowSlug,campaignId") {
        return json({ groups: beforeCents ? [row(dims({}), beforeCents)] : [] });
      }
      if (q.get("startedAfter")) {
        // The maturing read's window holds the young runs; "today" holds nothing.
        return json({ groups: q.get("startedAfter") === CUTOFF ? [row(dims({}), YOUNG_CENTS)] : [] });
      }
      return json({ groups: [row(dims({}), lifetimeCents)] });
    }

    if (url.includes("/orgs/stats")) return json({ groups: [] });

    if (url.includes("/orgs/leads")) {
      return json({
        leads: Object.keys(CONTACTED).map((id) => ({
          leadId: id,
          campaignId: "c-live",
          workflowSlug: "azalea",
          email: `${id}@example.com`,
          contacted: true, sent: true, delivered: true,
          clicked: CLICKERS.has(id),
          replied: false,
          lead: { firstName: "A", lastName: "B", organization: { id: `o-${id}`, name: `Org ${id}` } },
        })),
      });
    }
    if (url.includes("/orgs/status")) {
      return json({
        results: Object.entries(CONTACTED).map(([id, at]) => {
          const scope = { firstContactedAt: at, firstClickedAt: CLICKERS.has(id) && at ? at : null };
          return { email: `${id}@example.com`, broadcast: { campaign: scope, brand: scope } };
        }),
      });
    }
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    return json({});
  });
}

async function body(query = "brandId=b1&leads=full"): Promise<Record<string, any>> {
  const res = await request(app).get(`/features/${SALES}/revenue?${query}`).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}

describe("ROI, %CAC and $CAC are measured on the MATURE cohort", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue({
      id: "feat-1", slug: SALES, name: SALES, description: "x", status: "active",
      outputs: [], charts: [], createdAt: new Date(), updatedAt: new Date(),
    } as never);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("divides the mature pipeline (mature + undated leads) by the mature spend, and says 14 days", async () => {
    mockFetch();
    const res = await body();
    const whole = res.headline.totalPipelineUsd as number;
    expect(whole).toBeGreaterThan(0);

    // The displays keep the whole history.
    expect(res.costEconomics.committedCostUsd).toBeCloseTo(100, 6);
    expect(res.costEconomics.maturityDays).toBe(14);
    expect(res.costEconomics.unmeasuredReason).toBeNull();

    // THE DIVERGENCE: 4/7 of the pipeline over $60 — not 7/7 over $100, and not 3/7 (undated kept).
    const maturePipeline = (whole * 4) / 7;
    expect(res.costEconomics.roiMultiple).toBeCloseTo(maturePipeline / 60, 6);
    expect(res.costEconomics.roiMultiple).not.toBeCloseTo(whole / 100, 3);
    expect(res.costEconomics.roiMultiple).not.toBeCloseTo((whole * 3) / 7 / 60, 3);
    expect(res.costEconomics.costOfAcquisitionPct).toBeCloseTo((60 / maturePipeline) * 100, 6);
    expect(res.costEconomics.costPerAcquisitionUsd).toBeCloseTo(60 / (maturePipeline / 5000), 6);
  });

  it("ends the return curve ON the headline ROI — the curve rides the same mature cohort", async () => {
    mockFetch();
    const res = await body();
    const last = res.roiHistory.daily.at(-1);
    expect(last.cumulativeSpendUsd).toBeCloseTo(60, 6);
    expect(last.cumulativePipelineUsd + res.roiHistory.undatedPipelineUsd).toBeCloseTo(
      (res.headline.totalPipelineUsd * 4) / 7,
      6,
    );
  });

  it("a campaign whose every dollar is younger than the delay reads NULL ratios, reason `maturing` — never 0", async () => {
    mockFetch({ allYoung: true });
    const res = await body();
    expect(res.costEconomics.committedCostUsd).toBeCloseTo(40, 6);
    expect(res.costEconomics.maturityDays).toBe(14);
    expect(res.costEconomics.unmeasuredReason).toBe("maturing");
    expect(res.costEconomics.roiMultiple).toBeNull();
    expect(res.costEconomics.costOfAcquisitionPct).toBeNull();
    expect(res.costEconomics.costPerAcquisitionUsd).toBeNull();
    // The pipeline itself is still stated in full.
    expect(res.headline.totalPipelineUsd).toBeGreaterThan(0);
  });

  it("a zero-delay leg reads the whole history, and every count, the funnel walk and the leads table are byte-identical", async () => {
    mockFetch();
    const maturing = await body();
    mockFetch({ legKey: "conversation_to_meeting_booked" });
    const immediate = await body();

    expect(immediate.costEconomics.maturityDays).toBe(0);
    expect(immediate.costEconomics.roiMultiple).toBeCloseTo(immediate.headline.totalPipelineUsd / 100, 6);
    expect(maturing.costEconomics.roiMultiple).not.toBeCloseTo(immediate.costEconomics.roiMultiple, 3);

    // AC: only the ROI-side economics move.
    expect(maturing.headline).toEqual(immediate.headline);
    expect(maturing.outcomes).toEqual(immediate.outcomes);
    expect(maturing.funnelSteps).toEqual(immediate.funnelSteps);
    expect(maturing.leads).toEqual(immediate.leads);
    expect(maturing.recipientsContacted).toEqual(immediate.recipientsContacted);
    expect(maturing.recipientsClicked).toEqual(immediate.recipientsClicked);
    expect(maturing.spend).toEqual(immediate.spend);
    expect(maturing.costEconomics.committedCostUsd).toBe(immediate.costEconomics.committedCostUsd);
  });

  it("states it cannot separate the cohort when campaign-service is unreachable — null, never the whole-history ratio", async () => {
    mockFetch({ campaignsDown: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await body();
    expect(res.costEconomics.unmeasuredReason).toBe("maturity_unknown");
    expect(res.costEconomics.roiMultiple).toBeNull();
    expect(res.headline.totalPipelineUsd).toBeGreaterThan(0);
    expect(err).toHaveBeenCalled();
  });

  it("the lens divides the mature cohort too", async () => {
    mockFetch();
    const res = await body("brandId=b1&leads=full&lens=signups");
    const whole = res.headline.totalPipelineUsd as number;
    expect(res.costEconomics.maturityDays).toBe(14);
    expect(res.costEconomics.roiMultiple).toBeCloseTo((whole * 4) / 7 / 60, 6);
  });
});
