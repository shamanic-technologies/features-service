/**
 * ONE CAMPAIGN, ONE SPEND — the curves on a campaign-scoped body describe the campaign the rest of
 * that body describes.
 *
 * Prod 2026-09-17, brand `f4d73dab…` / campaign `647572d9…` / org `f0420eb5…`: ONE request answered
 * `costEconomics.committedCostUsd`, `outcomes.committedSpentCents` and `spend.totalSpentCents` all at
 * **$369.32**, and its `roiHistory` terminated at **$1,342.38** — the brand's spend, i.e. the other
 * campaign identities' money under this campaign's name. Once #980 shipped, the cost-per-outcome
 * curve drawn from the same map printed **$16.57** an outcome directly beneath a stat row reading
 * **$4.56** for the same outcome on the same campaign.
 *
 * The fixture carries that shape: a THREE-member identity worth $369.32 beside a fourth campaign on
 * another funnel carrying the brand to $1,342.38, and 81 clicks. So every case asserts the DIVERGENCE
 * between the campaign's answer and the brand's — a suite driven by a brand with ONE identity cannot
 * tell the fix from the bug, which is exactly why this went unseen.
 *
 * (features-service#983.)
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
const VISIT_LEG = "start_to_website_visit";
const FUNNEL = "sales_meetings_from_website";

/** The identity's three stored rows — one live, two stopped ancestors. */
const MEMBERS = ["c-live", "c-stopped-1", "c-stopped-2"];
/** A fourth campaign on ANOTHER funnel: in the brand's spend, in no member of this identity. */
const OUTSIDER = "c-other-funnel";

/** Per campaign, per UTC day, in CENTS. The family totals 36,932¢; the brand totals 134,238¢. */
const SPEND: Record<string, Array<[string, number]>> = {
  "c-live": [["2026-09-11", 10_000], ["2026-09-12", 6_932]],
  "c-stopped-1": [["2026-09-11", 10_000]],
  "c-stopped-2": [["2026-09-13", 10_000]],
  [OUTSIDER]: [["2026-09-12", 97_306]],
};
const FAMILY_CENTS = 36_932;
const BRAND_CENTS = 134_238;

/** 81 clicks, the campaign's own — the count the body already reports and the curve must divide by. */
const CLICK_DAYS: Array<[string, number]> = [
  ["2026-09-11", 20],
  ["2026-09-12", 20],
  ["2026-09-13", 21],
  ["2026-09-14", 20],
];
const CLICKS = CLICK_DAYS.reduce((sum, [, n]) => sum + n, 0);
/** 121 leads on the identity: 81 that clicked and 40 that did not. Plus 30 on the outsider. */
const FAMILY_LEADS = 121;
const OUTSIDER_LEADS = 30;

function feature(slug: string): Record<string, unknown> {
  return {
    id: "feat-1", slug, name: slug, description: "x", status: "active",
    outputs: [], charts: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
}

const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 30,
  visitToMeetingPct: 20,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

const WORKFLOWS = [{
  id: "wf-0", workflowSlug: "azalea", workflowName: "azalea",
  workflowDynastyName: "azalea", workflowDynastySlug: "azalea",
  version: 1, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null,
}];

/** One lead per click plus silent ones, spread across the identity's THREE members. */
function leadRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < FAMILY_LEADS; i += 1) {
    rows.push({
      leadId: `l-${i}`,
      campaignId: MEMBERS[i % MEMBERS.length],
      workflowSlug: "azalea",
      email: `lead${i}@example.com`,
      contacted: true, sent: true, delivered: true,
      clicked: i < CLICKS, replied: false,
      lead: { firstName: "A", lastName: "B", organization: { id: `o-${i}`, name: `Org ${i}` } },
    });
  }
  // The outsider's leads exist on the brand and belong to no member of this identity.
  for (let i = 0; i < OUTSIDER_LEADS; i += 1) {
    rows.push({
      leadId: `x-${i}`,
      campaignId: OUTSIDER,
      workflowSlug: "azalea",
      email: `outsider${i}@example.com`,
      contacted: true, sent: true, delivered: true,
      clicked: true, replied: false,
      lead: { firstName: "C", lastName: "D", organization: { id: `ox-${i}`, name: `Other ${i}` } },
    });
  }
  return rows;
}

/** email-gateway's per-email first-click dates, spread over CLICK_DAYS. */
function statusResults(): Array<Record<string, unknown>> {
  const dated: string[] = [];
  for (const [day, count] of CLICK_DAYS) {
    for (let i = 0; i < count; i += 1) dated.push(`${day}T10:00:00.000Z`);
  }
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < CLICKS; i += 1) {
    results.push({
      email: `lead${i}@example.com`,
      broadcast: { campaign: { firstClickedAt: dated[i]! }, brand: { firstClickedAt: dated[i]! } },
    });
  }
  for (let i = 0; i < OUTSIDER_LEADS; i += 1) {
    results.push({
      email: `outsider${i}@example.com`,
      broadcast: { campaign: { firstClickedAt: "2026-09-12T10:00:00.000Z" }, brand: { firstClickedAt: "2026-09-12T10:00:00.000Z" } },
    });
  }
  return results;
}

function campaignRow(id: string, funnelKey: string, legKey: string | null): Record<string, unknown> {
  return {
    id, orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: SALES,
    funnelKey, acquisitionChannel: "cold_email", legKey,
    status: id === "c-live" || id === OUTSIDER ? "ongoing" : "stopped",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function mockFetch(): { timeseriesCampaignIds: Array<string | null>; timeseriesFamilyReads: string[] } {
  const timeseriesCampaignIds: Array<string | null> = [];
  const timeseriesFamilyReads: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const cid = (init?.headers as Record<string, string> | undefined)?.["x-campaign-id"];
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/campaigns?")) {
      return json({
        campaigns: [
          ...MEMBERS.map((id) => campaignRow(id, FUNNEL, VISIT_LEG)),
          campaignRow(OUTSIDER, "sales_meetings_from_conversation", "start_to_conversation"),
        ],
      });
    }
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/daily-budget")) {
      return json({ brandId: "b1", legKey: VISIT_LEG, dailyBudgetCents: "5000", updatedAt: null, funnels: [], channels: [], offers: [], legs: [] });
    }
    if (url.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    // THE DATED SPEND LEG. runs takes ONE campaign: a family is read member by member, and a scope
    // that names none legitimately reads the whole brand.
    if (url.includes("/costs/timeseries")) {
      const q = new URL(url).searchParams;
      const campaignId = q.get("campaignId");
      // A family is ONE `campaignIds` read (runs-service v0.47.7), answering the sum of its members.
      const named = q.get("campaignIds")?.split(",") ?? (campaignId ? [campaignId] : null);
      if (named) timeseriesCampaignIds.push(...named);
      else timeseriesCampaignIds.push(null);
      if (q.get("campaignIds")) timeseriesFamilyReads.push(q.get("campaignIds")!);
      const rows = named ? named.flatMap((id) => SPEND[id] ?? []) : Object.values(SPEND).flat();
      const byDay = new Map<string, number>();
      for (const [day, cents] of rows) byDay.set(day, (byDay.get(day) ?? 0) + cents);
      return json({
        buckets: [...byDay].sort().map(([period, cents]) => ({
          period,
          totalCostInUsdCents: String(cents),
          netTotalCostInUsdCents: String(cents),
          actualCostInUsdCents: String(cents),
        })),
      });
    }

    if (url.includes("/orgs/stats")) {
      const group = (key: string, contacted: number, clicks: number) => ({
        key, broadcast: { recipientStats: { contacted, clicked: clicks, repliesPositive: 0 } },
      });
      if (url.includes("groupBy=campaignId")) {
        return json({
          groups: [
            ...MEMBERS.map((id, i) => group(id, 41, i === 0 ? CLICKS : 0)),
            group(OUTSIDER, OUTSIDER_LEADS, OUTSIDER_LEADS),
          ],
        });
      }
      if (url.includes("groupBy=workflowSlug")) return json({ groups: [group("azalea", FAMILY_LEADS, CLICKS)] });
      return json({ groups: [] });
    }

    // THE UNTIMED COST. A family co-groups campaignId and is summed locally, so the brand's
    // outsider spend is excluded by construction — the property the dated leg had to match.
    if (url.includes("/stats/costs")) {
      const cents = (id: string) => String((SPEND[id] ?? []).reduce((sum, [, c]) => sum + c, 0));
      const row = (dimensions: Record<string, unknown>, total: string) => ({
        dimensions, totalCostInUsdCents: total, actualCostInUsdCents: total,
        runCount: 1, minStartedAt: null, maxStartedAt: null,
      });
      const ids = [...MEMBERS, OUTSIDER];
      if (url.includes("groupBy=campaignId")) return json({ groups: ids.map((id) => row({ campaignId: id }, cents(id))) });
      if (url.includes("groupBy=workflowSlug")) {
        return json({ groups: ids.map((id) => row({ workflowSlug: "azalea", campaignId: id }, cents(id))) });
      }
      return json({ groups: ids.map((id) => row({ campaignId: id, costName: "email-send" }, cents(id))) });
    }

    if (url.includes("/orgs/leads")) return json({ leads: leadRows() });
    if (url.includes("/orgs/status")) return json({ results: statusResults() });
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    void cid;
    return json({});
  });

  return { timeseriesCampaignIds, timeseriesFamilyReads };
}

async function body(query: string): Promise<Record<string, any>> {
  const res = await request(app).get(`/features/${SALES}/revenue?${query}`).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}

describe("a campaign-scoped body states ONE spend", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(SALES) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("terminates its return curve on the campaign's OWN invested spend, not the brand's", async () => {
    mockFetch();
    const res = await body("brandId=b1&campaignId=c-live");

    // The three figures that were already right.
    expect(res.costEconomics.committedCostUsd).toBeCloseTo(FAMILY_CENTS / 100, 2);
    expect(res.outcomes.committedSpentCents).toBe(FAMILY_CENTS);
    expect(res.spend.totalSpentCents).toBe(FAMILY_CENTS);

    // THE DIVERGENCE: the curve used to end at the brand's $1,342.38 on this exact body.
    const last = res.roiHistory.daily.at(-1);
    expect(last.cumulativeSpendUsd).toBeCloseTo(FAMILY_CENTS / 100, 2);
    expect(last.cumulativeSpendUsd).not.toBeCloseTo(BRAND_CENTS / 100, 2);
    expect(BRAND_CENTS / FAMILY_CENTS).toBeGreaterThan(3);
  });

  it("draws the cost per outcome the SAME body prints above it, to the cent", async () => {
    mockFetch();
    const res = await body("brandId=b1&campaignId=c-live");

    expect(res.outcomes.recipientsClicked).toBe(CLICKS);
    const served = res.outcomes.cpcCents / 100;
    expect(served).toBeCloseTo(4.56, 2);

    const last = res.costPerOutcomeHistory.daily.at(-1);
    expect(last.cumulativeOutcomes).toBe(CLICKS);
    expect(last.costPerOutcomeUsd).toBeCloseTo(served, 2);
    // THE CONTRADICTION THIS CLOSES: the brand's spend over this campaign's clicks reads $16.57 —
    // the figure a customer saw beneath a stat row saying $4.56.
    expect(BRAND_CENTS / 100 / CLICKS).toBeCloseTo(16.57, 2);
    expect(last.costPerOutcomeUsd).toBeLessThan(5);
  });

  it("reads the dated spend for the whole family in ONE request, and never unfiltered", async () => {
    const { timeseriesCampaignIds, timeseriesFamilyReads } = mockFetch();
    await body("brandId=b1&campaignId=c-live");

    expect([...timeseriesCampaignIds].sort()).toEqual([...MEMBERS].sort());
    expect(timeseriesFamilyReads).toHaveLength(1);
    // An unfiltered read here IS the bug: it answers for every identity on the brand.
    expect(timeseriesCampaignIds).not.toContain(null);
    expect(timeseriesCampaignIds).not.toContain(OUTSIDER);
  });

  it("answers the SAME figures from a STOPPED ancestor of the same identity", async () => {
    mockFetch();
    const live = await body("brandId=b1&campaignId=c-live");
    mockFetch();
    const ancestor = await body("brandId=b1&campaignId=c-stopped-2");

    expect(ancestor.roiHistory.daily.at(-1).cumulativeSpendUsd)
      .toBeCloseTo(live.roiHistory.daily.at(-1).cumulativeSpendUsd, 6);
    expect(ancestor.costPerOutcomeHistory.daily.at(-1).costPerOutcomeUsd)
      .toBeCloseTo(live.costPerOutcomeHistory.daily.at(-1).costPerOutcomeUsd, 6);
  });

  it("leaves the BRAND-WIDE read byte-unchanged — one unfiltered request, the brand's whole spend", async () => {
    const { timeseriesCampaignIds } = mockFetch();
    const res = await body("brandId=b1");

    expect(timeseriesCampaignIds).toEqual([null]);
    expect(res.roiHistory.daily.at(-1).cumulativeSpendUsd).toBeCloseTo(BRAND_CENTS / 100, 2);
    expect(res.costEconomics.committedCostUsd).toBeCloseTo(BRAND_CENTS / 100, 2);
  });
});
