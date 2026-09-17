/**
 * THE DATED CONVERSION RATE, DRIVEN END TO END — from ONE fixture carrying the reported campaign's
 * own days.
 *
 * Prod 2026-09-17, brand `6e21bb6c…` / campaign `9e28ba26…` / channel `sales-cold-email-outreach` /
 * leg `start_to_website_visit`: **143 website visits against 2,808 people reached**, both fully
 * dated, across 70 reach days and 39 click days — the arrays below, verbatim. That campaign converts
 * at **5.0925925925%**, which is to the digit what its `funnelSteps` rung already states and what
 * `outcomes.recipientsClicked / recipientsContacted` divides to. The consumer draws this curve beside
 * `roiHistory` and `costPerOutcomeHistory` on the same screen, so the three cannot disagree about
 * which step they measure.
 *
 * The brand runs a SECOND campaign on another funnel, so every scoping case asserts a DIVERGENCE
 * rather than a tautology: the campaign-scoped answer is 143/2,808 while the brand's is 148/3,308.
 * A suite built on a single-campaign brand cannot tell the two implementations apart — which is
 * exactly how the sibling spend curve shipped dividing its brand's population.
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
const FORM_LEG = "website_visit_to_form_filled";
const FUNNEL = "form_magnet";

function feature(slug: string): Record<string, unknown> {
  return {
    id: "feat-1", slug, name: slug, description: "x", status: "active",
    outputs: [], charts: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
}

/** 20% visit→form, so the deeper leg reads a FIFTH of the entry leg's rate on identical evidence. */
const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 30,
  visitToMeetingPct: 20,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
  visitToFormSubmissionPct: 20,
  formSubmissionToPaidClientPct: 10,
};

const WORKFLOWS = [
  {
    id: "wf-0", workflowSlug: "azalea", workflowName: "azalea",
    workflowDynastyName: "azalea", workflowDynastySlug: "azalea",
    version: 1, status: "active", featureSlug: SALES, createdForBrandId: null, upgradedTo: null,
  },
];

/** The reported campaign's 70 reach days, verbatim from prod. Sums to 2,808. */
const CONTACTED_DAYS: Array<[string, number]> = [
  ["2026-07-09", 32],
  ["2026-07-10", 15],
  ["2026-07-11", 15],
  ["2026-07-12", 14],
  ["2026-07-13", 28],
  ["2026-07-14", 28],
  ["2026-07-15", 33],
  ["2026-07-16", 37],
  ["2026-07-17", 37],
  ["2026-07-18", 30],
  ["2026-07-19", 25],
  ["2026-07-20", 30],
  ["2026-07-21", 35],
  ["2026-07-22", 27],
  ["2026-07-23", 27],
  ["2026-07-24", 29],
  ["2026-07-25", 29],
  ["2026-07-26", 31],
  ["2026-07-27", 32],
  ["2026-07-28", 31],
  ["2026-07-29", 32],
  ["2026-07-30", 30],
  ["2026-07-31", 26],
  ["2026-08-01", 27],
  ["2026-08-02", 27],
  ["2026-08-03", 25],
  ["2026-08-04", 24],
  ["2026-08-05", 25],
  ["2026-08-06", 25],
  ["2026-08-07", 5],
  ["2026-08-08", 7],
  ["2026-08-09", 25],
  ["2026-08-10", 22],
  ["2026-08-11", 23],
  ["2026-08-12", 25],
  ["2026-08-13", 23],
  ["2026-08-14", 26],
  ["2026-08-15", 25],
  ["2026-08-16", 24],
  ["2026-08-19", 25],
  ["2026-08-20", 25],
  ["2026-08-21", 25],
  ["2026-08-22", 26],
  ["2026-08-23", 10],
  ["2026-08-24", 45],
  ["2026-08-25", 13],
  ["2026-08-26", 192],
  ["2026-08-27", 177],
  ["2026-08-28", 73],
  ["2026-08-29", 74],
  ["2026-08-30", 62],
  ["2026-08-31", 62],
  ["2026-09-01", 76],
  ["2026-09-02", 60],
  ["2026-09-03", 60],
  ["2026-09-04", 36],
  ["2026-09-05", 36],
  ["2026-09-06", 69],
  ["2026-09-07", 64],
  ["2026-09-08", 37],
  ["2026-09-09", 60],
  ["2026-09-10", 61],
  ["2026-09-11", 63],
  ["2026-09-12", 52],
  ["2026-09-13", 60],
  ["2026-09-14", 59],
  ["2026-09-15", 50],
  ["2026-09-16", 73],
  ["2026-09-17", 72],
];

/** Its 39 click days, verbatim from prod. Sums to 143. */
const CLICK_DAYS: Array<[string, number]> = [
  ["2026-07-15", 1],
  ["2026-07-16", 1],
  ["2026-07-17", 1],
  ["2026-07-18", 3],
  ["2026-07-21", 5],
  ["2026-07-23", 3],
  ["2026-07-24", 4],
  ["2026-07-27", 3],
  ["2026-07-28", 1],
  ["2026-07-30", 3],
  ["2026-07-31", 2],
  ["2026-08-03", 2],
  ["2026-08-04", 1],
  ["2026-08-06", 1],
  ["2026-08-07", 1],
  ["2026-08-10", 2],
  ["2026-08-13", 6],
  ["2026-08-17", 4],
  ["2026-08-19", 1],
  ["2026-08-20", 3],
  ["2026-08-21", 2],
  ["2026-08-22", 1],
  ["2026-08-25", 1],
  ["2026-08-26", 1],
  ["2026-08-27", 4],
  ["2026-08-30", 1],
  ["2026-08-31", 8],
  ["2026-09-02", 1],
  ["2026-09-03", 6],
  ["2026-09-04", 4],
  ["2026-09-07", 6],
  ["2026-09-08", 7],
  ["2026-09-09", 8],
  ["2026-09-10", 12],
  ["2026-09-11", 5],
  ["2026-09-14", 10],
  ["2026-09-15", 5],
  ["2026-09-16", 7],
  ["2026-09-17", 6],
];

const CONTACTED_TOTAL = CONTACTED_DAYS.reduce((s, [, c]) => s + c, 0);
const CLICK_TOTAL = CLICK_DAYS.reduce((s, [, c]) => s + c, 0);

/** The SECOND campaign, on another funnel: its own reach and its own far worse conversion. */
const SECOND_CONTACTED_DAYS: Array<[string, number]> = [
  ["2026-09-15", 200],
  ["2026-09-16", 300],
];
const SECOND_CLICK_DAYS: Array<[string, number]> = [["2026-09-16", 5]];

interface Fixture {
  legKey?: string | null;
  /** How many of the clicked leads carry NO click timestamp — in the total, on no day. */
  undatedClicks?: number;
  /** How many of the reached leads carry NO outreach timestamp. */
  undatedContacted?: number;
  /** Drop every lead's click, to drive the reached-nobody-converted case. */
  noClicks?: boolean;
}

interface FixtureLead {
  id: string;
  campaignId: string;
  clicked: boolean;
  contactedAt: string | null;
  clickedAt: string | null;
}

/** Spread a day-count list into one ISO timestamp per unit, in day order. */
function spread(days: Array<[string, number]>): string[] {
  const out: string[] = [];
  for (const [day, count] of days) for (let i = 0; i < count; i += 1) out.push(`${day}T10:00:00.000Z`);
  return out;
}

/**
 * ONE lead per person reached, on the two campaigns. The click dates are laid over the FIRST N
 * clicked leads, so the fixture's dated click days are prod's own — and the undated share comes off
 * the END, leaving those days untouched.
 */
function fixtureLeads(fixture: Fixture): FixtureLead[] {
  const rows: FixtureLead[] = [];
  const build = (
    prefix: string,
    campaignId: string,
    contactedDays: Array<[string, number]>,
    clickDays: Array<[string, number]>,
    clicksOn: boolean,
    undatedClicks: number,
    undatedContacted: number,
  ): void => {
    const contactedAtByIndex = spread(contactedDays);
    const clickedAtByIndex = spread(clickDays);
    const clickTotal = clicksOn ? clickedAtByIndex.length : 0;
    const datedClicks = Math.max(0, clickTotal - undatedClicks);
    const total = contactedAtByIndex.length + undatedContacted;
    for (let i = 0; i < total; i += 1) {
      const clicked = i < clickTotal;
      rows.push({
        id: `${prefix}-${i + 1}`,
        campaignId,
        clicked,
        contactedAt: i < contactedAtByIndex.length ? contactedAtByIndex[i]! : null,
        clickedAt: clicked && i < datedClicks ? clickedAtByIndex[i]! : null,
      });
    }
  };
  build("l", "c-live", CONTACTED_DAYS, CLICK_DAYS, !fixture.noClicks, fixture.undatedClicks ?? 0, fixture.undatedContacted ?? 0);
  build("s", "c-second", SECOND_CONTACTED_DAYS, SECOND_CLICK_DAYS, !fixture.noClicks, 0, 0);
  return rows;
}

function mockFetch(fixture: Fixture): void {
  const leads = fixtureLeads(fixture);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const cid = (init?.headers as Record<string, string> | undefined)?.["x-campaign-id"];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/campaigns?")) {
      return json({
        campaigns: [
          {
            id: "c-live", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: SALES,
            funnelKey: FUNNEL, acquisitionChannel: "cold_email",
            legKey: fixture.legKey === undefined ? VISIT_LEG : fixture.legKey,
            status: "ongoing", createdAt: "2026-07-01T00:00:00.000Z",
          },
          {
            // The brand's OTHER campaign — its own funnel, so its own identity. A campaign-scoped
            // read must never see it, and a brand-scoped read must.
            id: "c-second", orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: SALES,
            funnelKey: "website_purchases", acquisitionChannel: "linkedin",
            legKey: fixture.legKey === undefined ? VISIT_LEG : fixture.legKey,
            status: "ongoing", createdAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      });
    }
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/daily-budget")) {
      return json({ brandId: "b1", legKey: VISIT_LEG, dailyBudgetCents: "5000", updatedAt: null, funnels: [], channels: [], offers: [], legs: [] });
    }
    // The brand declares the ONE funnel the reported campaign sells, so `funnelSteps` walks a single
    // chain and its first rung is the figure this curve must terminate on.
    if (url.includes("/sales-funnels")) {
      return json({
        funnels: [{ funnelKey: FUNNEL, name: "Form magnet", lifetimeRevenueUsd: 5000, arrows: [] }],
      });
    }
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (url.includes("/costs/timeseries")) {
      return json({
        buckets: [{ period: "2026-09-16", totalCostInUsdCents: "35496", netTotalCostInUsdCents: "35496", actualCostInUsdCents: "35435" }],
      });
    }

    if (url.includes("/orgs/stats")) {
      const group = (key: string) => ({
        key,
        broadcast: { recipientStats: { contacted: CONTACTED_TOTAL, clicked: fixture.noClicks ? 0 : CLICK_TOTAL, repliesPositive: 0 } },
      });
      if (url.includes("groupBy=campaignId")) return json({ groups: [group("c-live")] });
      if (url.includes("groupBy=workflowSlug")) return json({ groups: [group("azalea")] });
      return json({ groups: [] });
    }

    if (url.includes("/stats/costs")) {
      const row = (dimensions: Record<string, unknown>) => ({
        dimensions, totalCostInUsdCents: "35496", actualCostInUsdCents: "35435",
        runCount: 1, minStartedAt: null, maxStartedAt: null,
      });
      if (url.includes("groupBy=campaignId")) return json({ groups: [row({ campaignId: "c-live" })] });
      if (url.includes("groupBy=workflowSlug")) return json({ groups: [row({ workflowSlug: "azalea", campaignId: cid ?? "c-live" })] });
      return json({ groups: [row({ campaignId: cid ?? "c-live", costName: "email-send" })] });
    }

    if (url.includes("/orgs/leads")) {
      // lead-service narrows on `x-campaign-id` for a single-member scope, so the mock must too —
      // otherwise every campaign-scoped case silently reads the brand's whole population, which is
      // precisely the defect these tests exist to catch.
      const scoped = cid ? leads.filter((l) => l.campaignId === cid) : leads;
      return json({
        leads: scoped.map((l) => ({
          leadId: l.id,
          campaignId: l.campaignId,
          workflowSlug: "azalea",
          email: `${l.id}@example.com`,
          contacted: true,
          sent: true,
          delivered: true,
          clicked: l.clicked,
          replied: false,
          lead: { firstName: "A", lastName: "B", organization: { id: `o-${l.id}`, name: `Org ${l.id}` } },
        })),
      });
    }
    if (url.includes("/orgs/status")) {
      return json({
        results: leads.map((l) => ({
          email: `${l.id}@example.com`,
          broadcast: {
            campaign: { firstContactedAt: l.contactedAt, firstClickedAt: l.clickedAt },
            brand: { firstContactedAt: l.contactedAt, firstClickedAt: l.clickedAt },
          },
        })),
      });
    }
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    return json({});
  });
}

async function body(query = "brandId=b1&campaignId=c-live"): Promise<Record<string, any>> {
  const res = await request(app).get(`/features/${SALES}/revenue?${query}`).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}

describe("what share of this campaign's outreach converts, day by day", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(SALES) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("terminates on the conversion figure the SAME body already serves", async () => {
    mockFetch({});
    const res = await body();
    const history = res.conversionRateHistory;

    expect(history).not.toBeNull();
    expect(res.outcomes.recipientsContacted).toBe(CONTACTED_TOTAL);
    expect(res.outcomes.recipientsClicked).toBe(CLICK_TOTAL);

    // THE RECONCILIATION, three ways round and all to the digit: the served scalar IS the outcomes
    // block divided, IS the funnelSteps rung for the same leg, and IS the curve's last point (nothing
    // here is undated). A consumer never divides anything.
    const expected = (CLICK_TOTAL / CONTACTED_TOTAL) * 100;
    expect(expected).toBeCloseTo(5.0925925925, 9);
    expect(history.scopeConversionRatePct).toBeCloseTo(expected, 9);
    const rung = res.funnelSteps.steps.find((s: { legKey: string }) => s.legKey === VISIT_LEG);
    expect(rung.fromStep).toBe("Contacted");
    expect(rung.conversionFromPreviousPct).toBeCloseTo(history.scopeConversionRatePct, 9);
    expect(history.daily.at(-1).conversionRatePct).toBeCloseTo(expected, 9);
    expect(history.daily.at(-1).cumulativeContacted).toBe(CONTACTED_TOTAL);
    expect(history.daily.at(-1).cumulativeOutcomes).toBe(CLICK_TOTAL);
  });

  it("divides the CAMPAIGN'S OWN population, never the brand's", async () => {
    mockFetch({});
    const campaign = (await body()).conversionRateHistory;
    const brand = (await body("brandId=b1")).conversionRateHistory;

    // The brand reached 500 more people for 5 more visits, so the two rates MUST differ. An
    // implementation dividing the brand's population under the campaign's name reads the second
    // number for both — which is the defect the sibling spend curve shipped with.
    expect(campaign.datedContacted).toBe(CONTACTED_TOTAL);
    expect(brand.datedContacted).toBe(CONTACTED_TOTAL + 500);
    expect(brand.datedOutcomes).toBe(CLICK_TOTAL + 5);
    expect(campaign.scopeConversionRatePct).toBeCloseTo((143 / 2808) * 100, 9);
    expect(brand.scopeConversionRatePct).toBeCloseTo((148 / 3308) * 100, 9);
    expect(campaign.scopeConversionRatePct).toBeGreaterThan(brand.scopeConversionRatePct);
  });

  it("is CUMULATIVE — the per-day rate it must not chart oscillates instead", async () => {
    mockFetch({});
    const daily: Array<{ date: string; cumulativeContacted: number; cumulativeOutcomes: number; conversionRatePct: number }> =
      (await body()).conversionRateHistory.daily;

    // Prod's own first reach day: 32 people, nobody converted. A per-day chart prints 0% here and
    // 100% on a day whose single click happened to land — neither describes the campaign.
    expect(daily[0]!.date).toBe("2026-07-09");
    expect(daily[0]!.conversionRatePct).toBe(0);

    for (const [i, point] of daily.entries()) {
      if (i === 0) continue;
      expect(point.cumulativeContacted).toBeGreaterThanOrEqual(daily[i - 1]!.cumulativeContacted);
      expect(point.cumulativeOutcomes).toBeGreaterThanOrEqual(daily[i - 1]!.cumulativeOutcomes);
    }
    expect(daily.map((p) => p.date)).toEqual([...daily.map((p) => p.date)].sort());
  });

  it("names the step it is denominated in — the SAME one the two sibling curves name", async () => {
    mockFetch({});
    const res = await body();
    expect(res.conversionRateHistory.outcomeStep).toEqual(res.learningPhase.outcomeStep);
    expect(res.conversionRateHistory.outcomeStep).toEqual(res.costPerOutcomeHistory.outcomeStep);
    expect(res.conversionRateHistory.legKey).toBe(VISIT_LEG);
    expect(res.conversionRateHistory.outcomeObserved).toBe(true);
  });

  it("reads a DEEPER leg a fifth as often on identical evidence", async () => {
    mockFetch({});
    const entry = (await body()).conversionRateHistory;
    mockFetch({ legKey: FORM_LEG });
    const deeper = (await body()).conversionRateHistory;

    expect(deeper.outcomeStep.key).toBe("form_filled");
    expect(deeper.outcomeObserved).toBe(false);
    expect(deeper.datedOutcomes).toBeCloseTo(CLICK_TOTAL * 0.2, 9);
    // THE DIVERGENCE: same people, same clicks, a fifth the rate. An implementation charting the
    // driver signal under the outcome's name reports one number for both legs.
    expect(deeper.scopeConversionRatePct).toBeCloseTo(entry.scopeConversionRatePct / 5, 9);
  });

  it("states the UNDATED share rather than folding it in or dropping it", async () => {
    mockFetch({ undatedClicks: 43, undatedContacted: 192 });
    const res = await body();
    const history = res.conversionRateHistory;

    expect(history.datedContacted).toBe(CONTACTED_TOTAL);
    expect(history.undatedContacted).toBe(192);
    expect(history.datedOutcomes).toBe(CLICK_TOTAL - 43);
    expect(history.undatedOutcomes).toBe(43);

    // THE DIVERGENCE this pair of fields exists for: the curve describes 100/2,808 while the scope is
    // 143/3,000, so the last point and the served scalar legitimately differ — and only the stated
    // undated counts explain the gap. Neither leg is floored onto the other.
    expect(history.daily.at(-1).conversionRatePct).toBeCloseTo((100 / 2808) * 100, 9);
    expect(history.scopeConversionRatePct).toBeCloseTo((143 / 3000) * 100, 9);
    expect(res.outcomes.recipientsClicked).toBe(CLICK_TOTAL);
    expect(res.outcomes.recipientsContacted).toBe(CONTACTED_TOTAL + 192);
  });

  it("answers a MEASURED 0 for a campaign that reached people and converted nobody", async () => {
    mockFetch({ noClicks: true });
    const res = await body();
    const history = res.conversionRateHistory;

    expect(history).not.toBeNull();
    expect(history.daily.length).toBeGreaterThan(0);
    // 0 is the answer, not a gap: nulling it would hide the very period a customer is asking about.
    // Note the COST curve nulls on the same fixture, and the two rules must not be harmonised.
    expect(history.daily.every((p: { conversionRatePct: number | null }) => p.conversionRatePct === 0)).toBe(true);
    expect(history.scopeConversionRatePct).toBe(0);
    expect(res.costPerOutcomeHistory.daily.every((p: { costPerOutcomeUsd: number | null }) => p.costPerOutcomeUsd === null)).toBe(true);
  });

  it("is NULL when the scope names no outcome step, and nothing else on the body moves", async () => {
    mockFetch({});
    const priced = await body();
    mockFetch({ legKey: null });
    const unstated = await body();

    expect(unstated.conversionRateHistory).toBeNull();
    // `learningPhase` beside it names WHY, so no reason vocabulary is duplicated on this block.
    expect(unstated.learningPhase.unmeasuredReason).toBe("no_leg_stated");
    const strip = (b: Record<string, any>) => {
      const { conversionRateHistory, costPerOutcomeHistory, learningPhase, ...rest } = b;
      return rest;
    };
    expect(strip(unstated)).toEqual(strip(priced));
  });

  it("costs NO producer read — it survives the dated-spend read that nulls the two sibling curves", async () => {
    mockFetch({});
    const res = await body();
    // Both legs are the leads already in hand, so the conversion curve is answerable wherever the
    // outcomes block is. A consumer never has to explain a blank chart beside a populated one.
    expect(res.conversionRateHistory).not.toBeNull();
    expect(res.conversionRateHistory.daily.at(-1).cumulativeContacted).toBe(res.outcomes.recipientsContacted);
  });

  it("is absent from the lean grouped rows and null on the lensed read", async () => {
    mockFetch({});
    const grouped = await body("brandId=b1&groupBy=campaignId");
    expect(grouped.groups[0]).not.toHaveProperty("conversionRateHistory");

    const lensed = await body("brandId=b1&campaignId=c-live&lens=signups");
    expect(lensed.conversionRateHistory).toBeNull();
  });
});
