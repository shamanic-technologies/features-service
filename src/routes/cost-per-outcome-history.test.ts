/**
 * THE DATED COST PER OUTCOME, DRIVEN END TO END — from ONE fixture shaped like the campaign that
 * reported it.
 *
 * Prod 2026-09-17, brand `9546c4b2…` / campaign `31df7683…`, leg `start_to_website_visit`: 31 dated
 * clicks across five days, $247.193125 of dated committed spend, and a served `outcomes.cpcCents` of
 * 797.35. The consumer draws this curve directly beneath that figure, so the two cannot disagree —
 * and it could not be assembled in the browser, because an outcome carrying no timestamp is in the
 * scope's total while sitting on no day.
 *
 * Every case asserts a DIVERGENCE: the curve's last point against the served scalar to the cent, the
 * deeper leg against the entry leg on identical evidence, the lens and grouped shapes against the
 * Overview's, and the whole rest of the body BYTE-EQUAL with the block stripped. A suite that only
 * checked "a block came back" would pass on an implementation that charted the driver signal under
 * the outcome's name.
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
const MEETING_LEG = "website_visit_to_meeting_booked";
const FUNNEL = "sales_meetings_from_website";

function feature(slug: string): Record<string, unknown> {
  return {
    id: "feat-1", slug, name: slug, description: "x", status: "active",
    outputs: [], charts: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
}

/** 20% visit→meeting, so the deeper leg's count is a fifth of the entry leg's and its price five times. */
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

/** The reported campaign's five dated click days. Cents per day, to the same sub-cent runs serves. */
const SPEND_BUCKETS: Array<[string, number]> = [
  ["2026-09-11", 4905.4782573438],
  ["2026-09-12", 4918.461450119999],
  ["2026-09-13", 4905.4732183199],
  ["2026-09-14", 4921.77288312],
  ["2026-09-15", 4914.72668796],
  ["2026-09-16", 153.4],
];
const TOTAL_CENTS = SPEND_BUCKETS.reduce((sum, [, c]) => sum + c, 0);

/** 31 clicks: 4 / 6 / 9 / 9 / 3 across the five days the prod campaign clicked on. */
const CLICK_DAYS: Array<[string, number]> = [
  ["2026-09-11", 4],
  ["2026-09-14", 6],
  ["2026-09-15", 9],
  ["2026-09-16", 9],
  ["2026-09-17", 3],
];

interface Fixture {
  legKey?: string | null;
  /** How many of the clicked leads carry NO click timestamp — in the total, on no day. */
  undatedClicks?: number;
  /** Make runs' dated-cost timeseries unreachable, to drive the degrade. */
  spendByDayDown?: boolean;
  /** Drop every lead's click, to drive the still-learning case. */
  noClicks?: boolean;
}

/** One lead per click plus a silent remainder, so `outcomes` counts exactly the clicks the curve does. */
function leadRows(fixture: Fixture): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let n = 0;
  const clicked = fixture.noClicks ? 0 : 31;
  for (let i = 0; i < 40; i += 1) {
    n += 1;
    rows.push({
      leadId: `l-${n}`,
      campaignId: "c-live",
      workflowSlug: "azalea",
      email: `lead${n}@example.com`,
      contacted: true,
      sent: true,
      delivered: true,
      clicked: i < clicked,
      replied: false,
      lead: { firstName: "A", lastName: "B", organization: { id: `o-${n}`, name: `Org ${n}` } },
    });
  }
  return rows;
}

/** email-gateway's per-email first-click dates: the first N clicked leads, spread over CLICK_DAYS. */
function statusResults(fixture: Fixture): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  let n = 0;
  const undated = fixture.undatedClicks ?? 0;
  const dated: string[] = [];
  for (const [day, count] of CLICK_DAYS) {
    for (let i = 0; i < count; i += 1) dated.push(`${day}T10:00:00.000Z`);
  }
  // The undated share comes off the END, so the dated days stay exactly the prod shape.
  for (let i = 0; i < 31; i += 1) {
    n += 1;
    const at = i < 31 - undated ? dated[i]! : null;
    results.push({
      email: `lead${n}@example.com`,
      broadcast: { campaign: { firstClickedAt: at }, brand: { firstClickedAt: at } },
    });
  }
  return results;
}

function mockFetch(fixture: Fixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const cid = (init?.headers as Record<string, string> | undefined)?.["x-campaign-id"];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/campaigns?")) {
      return json({
        campaigns: [{
          id: "c-live", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: SALES,
          funnelKey: FUNNEL, acquisitionChannel: "cold_email",
          legKey: fixture.legKey === undefined ? VISIT_LEG : fixture.legKey,
          status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z",
        }],
      });
    }
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/daily-budget")) {
      return json({ brandId: "b1", legKey: VISIT_LEG, dailyBudgetCents: "5000", updatedAt: null, funnels: [], channels: [], offers: [], legs: [] });
    }
    if (url.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    // THE DATED SPEND LEG — runs' own cost buckets, one per UTC day.
    if (url.includes("/costs/timeseries")) {
      // Nothing in this fixture started after the maturity cutoff on the suite's clock.
      if (new URL(url).searchParams.get("startedAfter")) return json({ buckets: [] });
      if (fixture.spendByDayDown) return new Response("boom", { status: 503 });
      return json({
        buckets: SPEND_BUCKETS.map(([period, cents]) => ({
          period,
          totalCostInUsdCents: String(cents),
          netTotalCostInUsdCents: String(cents),
          actualCostInUsdCents: String(cents),
        })),
      });
    }

    if (url.includes("/orgs/stats")) {
      const group = (key: string, clicks: number) => ({
        key,
        broadcast: { recipientStats: { contacted: 40, clicked: clicks, repliesPositive: 0 } },
      });
      if (url.includes("groupBy=campaignId")) return json({ groups: [group("c-live", fixture.noClicks ? 0 : 31)] });
      if (url.includes("groupBy=workflowSlug")) return json({ groups: [group("azalea", fixture.noClicks ? 0 : 31)] });
      return json({ groups: [] });
    }

    if (url.includes("/stats/costs")) {
      if (new URL(url).searchParams.get("startedAfter")) return json({ groups: [] });
      const total = String(Math.round(TOTAL_CENTS));
      const row = (dimensions: Record<string, unknown>) => ({
        dimensions, totalCostInUsdCents: total, actualCostInUsdCents: total,
        runCount: 1, minStartedAt: null, maxStartedAt: null,
      });
      if (url.includes("groupBy=campaignId")) return json({ groups: [row({ campaignId: "c-live" })] });
      if (url.includes("groupBy=workflowSlug")) return json({ groups: [row({ workflowSlug: "azalea", campaignId: cid ?? "c-live" })] });
      return json({ groups: [row({ campaignId: cid ?? "c-live", costName: "email-send" })] });
    }

    if (url.includes("/orgs/leads")) return json({ leads: leadRows(fixture) });
    if (url.includes("/orgs/status")) return json({ results: statusResults(fixture) });
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    return json({});
  });
}

async function body(query = "brandId=b1&campaignId=c-live"): Promise<Record<string, any>> {
  const res = await request(app).get(`/features/${SALES}/revenue?${query}`).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}

describe("what one outcome has cost, day by day", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(SALES) as never);
  });
  // Every run and every lead of this fixture is older than the ROI maturity delay on this clock
  // (lib/roi-maturity.ts): the suite is about how the curves are SCOPED, not about maturity, so the
  // mature cohort is the whole fixture here and the figures read exactly as they did before the rule.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("terminates on the cost per outcome the SAME body already serves", async () => {
    mockFetch({});
    const res = await body();
    const history = res.costPerOutcomeHistory;

    expect(history).not.toBeNull();
    expect(res.outcomes.recipientsClicked).toBe(31);
    const served = res.outcomes.cpcCents / 100;

    const last = history.daily.at(-1);
    expect(last.cumulativeOutcomes).toBe(31);
    // THE RECONCILIATION: the curve's final point IS the served scalar. Both legs are the scope's own
    // totals, so the only gap is the sub-cent one runs' own per-group rounding introduces — the same
    // one roiHistory's terminal ROI carries against costEconomics.roiMultiple.
    expect(last.costPerOutcomeUsd).toBeCloseTo(served, 2);
    expect(Math.round(last.costPerOutcomeUsd * 100)).toBe(Math.round(served * 100));
    expect(last.costPerOutcomeUsd).toBeCloseTo(7.97, 2);

    // THE DIVERGENCE a per-day ratio would show: 09-16 spent $1.53 on 9 clicks, i.e. $0.17 —
    // a number this curve must never print.
    const sept16 = history.daily.find((p: { date: string }) => p.date === "2026-09-16");
    expect(sept16.costPerOutcomeUsd).toBeGreaterThan(7);
  });

  it("spans the days roiHistory spans, and both legs move together", async () => {
    mockFetch({});
    const res = await body();
    const curve: Array<{ date: string; cumulativeSpendUsd: number }> = res.costPerOutcomeHistory.daily;
    const roi: Array<{ date: string; cumulativeSpendUsd: number }> = res.roiHistory.daily;

    expect(curve.map((p) => p.date)).toEqual(roi.map((p) => p.date));
    // The SAME dated committed buckets feed both — a consumer stacking the two charts reads one spend.
    for (const [i, point] of curve.entries()) {
      expect(point.cumulativeSpendUsd).toBeCloseTo(roi[i]!.cumulativeSpendUsd, 9);
    }
    expect(curve.at(-1)!.cumulativeSpendUsd).toBeCloseTo(TOTAL_CENTS / 100, 6);
  });

  it("names the step it is denominated in — the SAME one learningPhase counts", async () => {
    mockFetch({});
    const res = await body();
    expect(res.costPerOutcomeHistory.outcomeStep).toEqual(res.learningPhase.outcomeStep);
    expect(res.costPerOutcomeHistory.legKey).toBe(VISIT_LEG);
    expect(res.costPerOutcomeHistory.outcomeObserved).toBe(true);
  });

  it("prices a DEEPER leg five times dearer on identical evidence", async () => {
    mockFetch({});
    const entry = (await body()).costPerOutcomeHistory;
    mockFetch({ legKey: MEETING_LEG });
    const deeper = (await body()).costPerOutcomeHistory;

    expect(deeper.outcomeStep.key).toBe("meeting_booked");
    expect(deeper.outcomeObserved).toBe(false);
    expect(deeper.datedOutcomes).toBeCloseTo(6.2, 6);
    // THE DIVERGENCE: same spend, same clicks, a fifth as many outcomes at five times the price. An
    // implementation charting the driver signal under the outcome's name would report one number.
    expect(deeper.daily.at(-1).costPerOutcomeUsd).toBeCloseTo(entry.daily.at(-1).costPerOutcomeUsd * 5, 6);
    expect(deeper.daily.map((p: { date: string }) => p.date)).toEqual(entry.daily.map((p: { date: string }) => p.date));
  });

  it("states the UNDATED share rather than folding it in or dropping it", async () => {
    mockFetch({ undatedClicks: 6 });
    const res = await body();
    const history = res.costPerOutcomeHistory;

    expect(res.outcomes.recipientsClicked).toBe(31);
    expect(res.recipientsClicked.undatedCount).toBe(6);
    expect(history.datedOutcomes).toBe(25);
    expect(history.undatedOutcomes).toBe(6);
    expect(history.datedOutcomes + history.undatedOutcomes).toBe(31);

    // THE DIVERGENCE this field exists for: the curve now describes 25 of 31, so its last point is
    // DEARER than the served scalar, and only the stated undated share explains the gap. A consumer
    // summing the dated series in the browser would have had no way to know.
    const served = res.outcomes.cpcCents / 100;
    expect(history.daily.at(-1).costPerOutcomeUsd).toBeGreaterThan(served);
    expect(history.daily.at(-1).costPerOutcomeUsd).toBeCloseTo((TOTAL_CENTS / 100) / 25, 6);
  });

  it("answers honestly for a campaign still learning — an all-null series, never absent", async () => {
    mockFetch({ noClicks: true });
    const res = await body();
    const history = res.costPerOutcomeHistory;

    expect(history).not.toBeNull();
    expect(history.daily.length).toBeGreaterThan(0);
    expect(history.daily.every((p: { costPerOutcomeUsd: number | null }) => p.costPerOutcomeUsd === null)).toBe(true);
    expect(history.datedOutcomes).toBe(0);
    // A zero would say the scope's outcomes were free; `outcomes.cpcCents` nulls for the same reason.
    expect(res.outcomes.cpcCents).toBeNull();
  });

  it("is NULL when the scope names no priceable outcome step, and nothing else on the body moves", async () => {
    mockFetch({});
    const priced = await body();
    mockFetch({ legKey: null });
    const unstated = await body();

    expect(unstated.costPerOutcomeHistory).toBeNull();
    // `learningPhase` beside it names WHY, so no reason vocabulary is duplicated on this block.
    expect(unstated.learningPhase.unmeasuredReason).toBe("no_leg_stated");
    // Every figure a consumer reads today is byte-identical with the block and without it.
    const strip = (b: Record<string, any>) => {
      const { costPerOutcomeHistory, conversionRateHistory, learningPhase, ...rest } = b;
      // A campaign stating no leg waits for nothing (lib/roi-maturity.ts), so the delay it states
      // differs by design; on this clock the cohort is the whole fixture, so every figure agrees.
      const byLeg = (o: Record<string, any> | null) =>
        o && { ...o, ratioBasis: { ...o.ratioBasis, maturityDays: "by leg" } };
      return {
        ...rest,
        // The identity key carries the leg (campaign-service's own index), so it names the leg too.
        campaignIdentity: { ...rest.campaignIdentity, key: "by leg" },
        costEconomics: { ...rest.costEconomics, maturityDays: "by leg" },
        outcomes: byLeg(rest.outcomes),
        spend: byLeg(rest.spend),
        funnelSteps: byLeg(rest.funnelSteps),
      };
    };
    expect(strip(unstated)).toEqual(strip(priced));
  });

  it("is NULL when the dated-spend read degrades — like roiHistory, never a 502", async () => {
    mockFetch({ spendByDayDown: true });
    const res = await body();
    expect(res.costPerOutcomeHistory).toBeNull();
    expect(res.roiHistory).toBeNull();
    // The rest of the page is correct and is served.
    expect(res.outcomes.recipientsClicked).toBe(31);
    expect(res.costEconomics.committedCostUsd).toBeGreaterThan(0);
  });

  it("is absent from the lean grouped rows and null on the lensed read", async () => {
    mockFetch({});
    const grouped = await body("brandId=b1&groupBy=campaignId");
    expect(grouped.groups[0]).not.toHaveProperty("costPerOutcomeHistory");

    const lensed = await body("brandId=b1&campaignId=c-live&lens=signups");
    expect(lensed.costPerOutcomeHistory).toBeNull();
    expect(lensed.roiHistory).toBeNull();
  });
});
