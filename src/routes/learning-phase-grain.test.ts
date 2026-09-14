/**
 * WHEN DO THIS SCOPE'S FIGURES STOP BEING NOISE — driven end to end, from ONE fixture shaped like the
 * campaign that reported it.
 *
 * Prod 2026-09-13, brand `a179bbd9…` / campaign `3922c8e1…` / leg `start_to_conversation`: `azalea`
 * produced **4 conversations on $310.73**, `tango` — the workflow the campaign currently runs —
 * produced **none on $127.27**, and `alioth` carries the cross-org **$21.22** explore floor with
 * nothing observed at all. Committed **$438.00**, ceiling **$8/day**.
 *
 * The dashboard derived the countdown itself and picked `alioth`: a $212.20 target the campaign
 * passed weeks ago, so it rendered "0 days left" on a campaign 4 outcomes into 10. Every case here
 * asserts what the served answer DISAGREES with that one about — a suite that only checked "a block
 * came back" would pass on the implementation this replaces.
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
const CONVERSATION_LEG = "start_to_conversation";
const MEETING_LEG = "conversation_to_meeting_booked";
const FUNNEL = "sales_meetings_from_conversation";

function feature(slug: string): Record<string, unknown> {
  return {
    id: "feat-1", slug, name: slug, description: "x", status: "active",
    outputs: [], charts: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
}

/** 20% reply→meeting, so the deeper leg's count and price diverge from the entry leg's by exactly 5x. */
const ECONOMICS = {
  lifetimeRevenueUsd: 5000,
  replyToMeetingPct: 20,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

/** The three workflows, each its own dynasty (none upgrades into another). */
const WORKFLOWS = ["azalea", "tango", "alioth"].map((slug, i) => ({
  id: `wf-${i}`,
  workflowSlug: slug,
  workflowName: slug,
  workflowDynastyName: slug,
  workflowDynastySlug: slug,
  version: 1,
  status: "active",
  featureSlug: SALES,
  createdForBrandId: null,
  upgradedTo: null,
}));

interface CampaignShape {
  id: string;
  status?: string;
  legKey?: string | null;
  funnelKey?: string | null;
  acquisitionChannel?: string;
  createdAt?: string;
}

function campaign(shape: CampaignShape): Record<string, unknown> {
  return {
    id: shape.id,
    orgId: "org-1",
    brandId: "b1",
    brandIds: ["b1"],
    featureSlug: SALES,
    funnelKey: shape.funnelKey === undefined ? FUNNEL : shape.funnelKey,
    acquisitionChannel: shape.acquisitionChannel ?? "cold_email",
    legKey: shape.legKey === undefined ? CONVERSATION_LEG : shape.legKey,
    status: shape.status ?? "ongoing",
    createdAt: shape.createdAt ?? "2026-08-01T00:00:00.000Z",
  };
}

interface Fixture {
  campaigns: Array<Record<string, unknown>>;
  /** Per-campaign positive replies, as email-gateway's `groupBy=campaignId` serves them. */
  repliesByCampaign: Record<string, number>;
  /** Per-WORKFLOW spend cents + replies for the campaign-grain read — the (campaign × workflow) cells. */
  cells: Record<string, { cents: number; replies: number }>;
  /** Cents a campaign committed on a workflow the DYNASTY rollup drops (a lineage since retired). It
   *  is real spend the ledger reports and the cells do not — the divergence the committed figure has
   *  to be read from the ledger to avoid. Keyed by campaign id. */
  retiredLineageCents?: Record<string, number>;
  /** billing's per-leg ceiling, in cents. `null` = this leg has none. */
  dailyBudgetCents?: string | null;
  /** Make campaign-service unreachable, to drive the degrade. */
  campaignsDown?: boolean;
  /** Make billing unreachable. */
  billingDown?: boolean;
}

/** prod's own numbers: azalea produced everything, tango produced nothing, alioth never ran here. */
const PROD_CELLS = {
  azalea: { cents: 31073, replies: 4 },
  tango: { cents: 12727, replies: 0 },
};

function broadcastGroup(key: string, replies: number): Record<string, unknown> {
  return {
    key,
    broadcast: { recipientStats: { contacted: 100, clicked: 0, repliesPositive: replies } },
  };
}

function mockFetch(fixture: Fixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const cid = (init?.headers as Record<string, string> | undefined)?.["x-campaign-id"];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/campaigns?")) {
      if (fixture.campaignsDown) return new Response("boom", { status: 503 });
      return json({ campaigns: fixture.campaigns });
    }
    if (url.includes("/public/workflows")) return json({ workflows: WORKFLOWS });
    if (url.includes("/daily-budget")) {
      if (fixture.billingDown) return new Response("boom", { status: 503 });
      const cents = fixture.dailyBudgetCents === undefined ? "800" : fixture.dailyBudgetCents;
      return json({ brandId: "b1", legKey: CONVERSATION_LEG, dailyBudgetCents: cents, updatedAt: null, funnels: [], channels: [], offers: [], legs: [] });
    }
    if (url.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (url.includes("/orgs/stats")) {
      // The learning read's own per-campaign counts — one bucket per campaign that sent.
      if (url.includes("groupBy=campaignId")) {
        return json({
          groups: Object.entries(fixture.repliesByCampaign).map(([id, replies]) => broadcastGroup(id, replies)),
        });
      }
      // The leading campaign's per-(campaign × workflow) cells.
      if (url.includes("groupBy=workflowSlug")) {
        return json({
          groups: Object.entries(fixture.cells).map(([slug, cell]) => broadcastGroup(slug, cell.replies)),
        });
      }
      return json({ groups: [] });
    }

    if (url.includes("/stats/costs")) {
      const cellCents = Object.values(fixture.cells).reduce((sum, c) => sum + c.cents, 0);
      // THE LEDGER: every campaign's committed cents, including spend on a lineage the dynasty rollup
      // drops. This is what the committed figure is read from, and what costEconomics rides.
      if (url.includes("groupBy=campaignId")) {
        const ids = new Set([...Object.keys(fixture.repliesByCampaign), ...Object.keys(fixture.retiredLineageCents ?? {})]);
        return json({
          groups: [...ids].map((id) => ({
            dimensions: { campaignId: id },
            totalCostInUsdCents: String(cellCents + (fixture.retiredLineageCents?.[id] ?? 0)),
            actualCostInUsdCents: String(cellCents + (fixture.retiredLineageCents?.[id] ?? 0)),
            runCount: 1,
            minStartedAt: null,
            maxStartedAt: null,
          })),
        });
      }
      // The campaign grain asks per workflow; everything else takes the scope's one total.
      if (url.includes("groupBy=workflowSlug")) {
        return json({
          groups: Object.entries(fixture.cells).map(([slug, cell]) => ({
            dimensions: { workflowSlug: slug, campaignId: cid ?? "c-live" },
            totalCostInUsdCents: String(cell.cents),
            actualCostInUsdCents: String(cell.cents),
            runCount: 1,
            minStartedAt: null,
            maxStartedAt: null,
          })),
        });
      }
      const total = cellCents + (fixture.retiredLineageCents?.[cid ?? "c-live"] ?? 0);
      return json({
        groups: [{
          dimensions: { campaignId: cid ?? "c-live", costName: "email-send" },
          totalCostInUsdCents: String(total),
          actualCostInUsdCents: String(total),
          runCount: 1,
          minStartedAt: null,
          maxStartedAt: null,
        }],
      });
    }

    if (url.includes("/orgs/leads")) return json({ leads: [] });
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.includes("/orgs/status")) return json({ results: [] });
    return json({});
  });
}

async function learningPhase(query = "brandId=b1&campaignId=c-live"): Promise<Record<string, any>> {
  const res = await request(app).get(`/features/${SALES}/revenue?${query}`).set(AUTH);
  expect(res.status).toBe(200);
  return res.body.learningPhase;
}

const LIVE_ONLY: Fixture = {
  campaigns: [campaign({ id: "c-live" })],
  repliesByCampaign: { "c-live": 4 },
  cells: PROD_CELLS,
};

describe("the countdown a browser could not compute", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(SALES) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("prices the prod campaign at azalea's $77.6825 and serves 43 days — where the browser served 0", async () => {
    mockFetch(LIVE_ONLY);
    const phase = await learningPhase();

    expect(phase.status).toBe("learning");
    expect(phase.unmeasuredReason).toBeNull();
    expect(phase.legKey).toBe(CONVERSATION_LEG);
    expect(phase.outcomeStep.key).toBe("conversation");
    expect(phase.outcomesObserved).toBe(4);
    expect(phase.outcomesRequired).toBe(10);
    expect(phase.progressPct).toBe(40);
    expect(phase.outcomeObserved).toBe(true);

    expect(phase.expectedCostPerOutcomeUsd).toBeCloseTo(77.6825, 4);
    expect(phase.spendTargetUsd).toBeCloseTo(776.825, 3);
    expect(phase.committedSpentUsd).toBeCloseTo(438, 6);
    expect(phase.spendRemainingUsd).toBeCloseTo(338.825, 3);
    expect(phase.dailyCeilingUsd).toBe(8);
    expect(phase.daysRemaining).toBe(43);
    expect(phase.outcomeLagDays).toBe(14);

    // THE DIVERGENCE: the cheapest workflow's figure is an explore FLOOR. Ten of it is a target the
    // campaign passed weeks ago, which is why the browser rendered a finished countdown.
    expect(21.22 * 10).toBeLessThan(phase.committedSpentUsd);
    expect(phase.spendTargetUsd).toBeGreaterThan(phase.committedSpentUsd);
    // ...and it is not the campaign's whole spend over its outcomes either ($109.50).
    expect(phase.expectedCostPerOutcomeUsd).not.toBeCloseTo(438 / 4, 2);
  });

  it("reads the committed spend from the LEDGER, so it cannot contradict the money beside it", async () => {
    // $59.82 of this campaign's spend sits on a lineage the dynasty rollup drops. Summing the cells
    // would report $438.00 against a costEconomics that says $497.82 — two numbers about one
    // campaign's money, on one body. Measured in prod at $790.53 against $850.35.
    mockFetch({ ...LIVE_ONLY, retiredLineageCents: { "c-live": 5982 } });
    const res = await request(app).get(`/features/${SALES}/revenue?brandId=b1&campaignId=c-live`).set(AUTH);
    expect(res.status).toBe(200);
    const phase = res.body.learningPhase;
    expect(phase.committedSpentUsd).toBeCloseTo(497.82, 6);
    expect(phase.committedSpentUsd).toBeCloseTo(res.body.costEconomics.committedCostUsd, 6);
    // THE DIVERGENCE: the cells alone would have said $438 — the price's numerator, not the spend.
    expect(phase.committedSpentUsd).not.toBeCloseTo(438, 2);
    // The PRICE is still pooled over the cells that observed an outcome — the retired lineage's spend
    // bought no outcome, so it belongs in what was SPENT and not in what an outcome COSTS.
    expect(phase.expectedCostPerOutcomeUsd).toBeCloseTo(77.6825, 4);
    expect(phase.spendRemainingUsd).toBeCloseTo(776.825 - 497.82, 6);
  });

  it("states what raising the ceiling buys, in days, so the consumer divides nothing", async () => {
    mockFetch(LIVE_ONLY);
    const phase = await learningPhase();
    expect(phase.ceilingScenarios).toEqual([
      { dailyCeilingUsd: 16, daysRemaining: 22 },
      { dailyCeilingUsd: 24, daysRemaining: 15 },
      { dailyCeilingUsd: 40, daysRemaining: 9 },
    ]);
  });

  it("tells the spend-is-in-outcomes-are-not case apart from still-spending and from priced", async () => {
    // Same campaign, three times its spend: the target is reached and the outcomes did not arrive.
    mockFetch({
      ...LIVE_ONLY,
      cells: { azalea: { cents: 31073, replies: 4 }, tango: { cents: 100000, replies: 0 } },
    });
    const limited = await learningPhase();
    expect(limited.status).toBe("learning_limited");
    expect(limited.spendRemainingUsd).toBe(0);
    expect(limited.daysRemaining).toBeNull();
    expect(limited.ceilingScenarios).toEqual([]);
    // NOT priced — the evidence did not arrive — and `outcomeLagDays` says why it is not terminal.
    expect(limited.outcomesObserved).toBeLessThan(10);
    expect(limited.outcomeLagDays).toBe(14);

    mockFetch(LIVE_ONLY);
    expect((await learningPhase()).status).toBe("learning");

    mockFetch({ ...LIVE_ONLY, repliesByCampaign: { "c-live": 11 } });
    expect((await learningPhase()).status).toBe("priced");
  });

  it("measures a campaign on its OWN leg, never on the funnel's first step", async () => {
    mockFetch({
      campaigns: [campaign({ id: "c-live", legKey: MEETING_LEG })],
      repliesByCampaign: { "c-live": 4 },
      cells: PROD_CELLS,
    });
    const phase = await learningPhase();
    expect(phase.legKey).toBe(MEETING_LEG);
    expect(phase.outcomeStep.key).toBe("meeting_booked");
    // THE DIVERGENCE: the same 4 replies, counted as the meetings they are forecast to become.
    expect(phase.outcomesObserved).toBeCloseTo(0.8, 6);
    expect(phase.outcomeObserved).toBe(false);
    // A meeting is five times dearer than the reply that buys it, on the identical spend.
    expect(phase.expectedCostPerOutcomeUsd).toBeCloseTo(77.6825 / 0.2, 4);
  });

  it("carries NO countdown on a paused campaign, and keeps its counts", async () => {
    mockFetch({ ...LIVE_ONLY, campaigns: [campaign({ id: "c-live", status: "stopped" })] });
    const phase = await learningPhase();
    expect(phase.status).toBe("paused");
    expect(phase.daysRemaining).toBeNull();
    expect(phase.spendTargetUsd).toBeNull();
    expect(phase.campaigns[0].outcomesObserved).toBe(4);
  });

  it("reads a scope with no campaigns as unmeasured, never as gathering", async () => {
    mockFetch({ campaigns: [], repliesByCampaign: {}, cells: {} });
    const phase = await learningPhase("brandId=b1");
    expect(phase.status).toBe("unmeasured");
    expect(phase.unmeasuredReason).toBe("no_campaigns");
    expect(phase.campaigns).toEqual([]);
  });

  it("names the missing ingredient rather than 502-ing the page", async () => {
    mockFetch({ ...LIVE_ONLY, campaignsDown: true });
    const down = await learningPhase();
    expect(down.status).toBe("unmeasured");
    expect(down.unmeasuredReason).toBe("campaigns_unreadable");

    mockFetch({ ...LIVE_ONLY, billingDown: true });
    const noCeiling = await learningPhase();
    expect(noCeiling.status).toBe("unmeasured");
    expect(noCeiling.unmeasuredReason).toBe("no_daily_ceiling");
    // The figures it DID resolve are still stated — a degrade narrows the answer, never blanks it.
    expect(noCeiling.expectedCostPerOutcomeUsd).toBeCloseTo(77.6825, 4);

    mockFetch({ ...LIVE_ONLY, dailyBudgetCents: null });
    expect((await learningPhase()).unmeasuredReason).toBe("no_daily_ceiling");
  });

  it("has a FLOOR rather than a price when no cell has observed an outcome, and says so", async () => {
    mockFetch({
      ...LIVE_ONLY,
      repliesByCampaign: { "c-live": 0 },
      cells: { tango: { cents: 12727, replies: 0 } },
    });
    const phase = await learningPhase();
    expect(phase.status).toBe("unmeasured");
    expect(phase.unmeasuredReason).toBe("no_expected_price");
    expect(phase.expectedCostPerOutcomeUsd).toBeNull();
    // A measured 0, not an absence: it reached people and none of them answered.
    expect(phase.outcomesObserved).toBe(0);
  });
});

describe("a scope wider than one campaign", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(SALES) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  /** Two identities on one brand: the slow one still gathering, the other already across the bar. */
  const TWO: Fixture = {
    campaigns: [
      campaign({ id: "c-live" }),
      campaign({ id: "c-other", acquisitionChannel: "crm_email" }),
    ],
    repliesByCampaign: { "c-live": 4, "c-other": 11 },
    cells: PROD_CELLS,
  };

  it("reads the BRAND as priced once one of its campaigns is, whatever the siblings are doing", async () => {
    mockFetch(TWO);
    const phase = await learningPhase("brandId=b1");
    expect(phase.status).toBe("priced");
    expect(phase.campaignId).toBe("c-other");
    expect(phase.progressPct).toBe(100);
    // Both are listed with their own counts, so a consumer can SEE why the scope reads priced.
    expect(phase.campaigns.map((c: { outcomesObserved: number }) => c.outcomesObserved).sort((a: number, b: number) => a - b)).toEqual([4, 11]);

    // THE DIVERGENCE: narrowed to the slow campaign, the very same fixture is still gathering.
    mockFetch(TWO);
    const narrowed = await learningPhase("brandId=b1&campaignId=c-live");
    expect(narrowed.status).toBe("learning");
    expect(narrowed.campaigns).toHaveLength(1);
    expect(narrowed.campaigns[0].campaignId).toBe("c-live");
  });

  it("takes the LEADING LIVE campaign's countdown, never a stopped sibling's", async () => {
    mockFetch({
      campaigns: [
        campaign({ id: "c-dead", status: "stopped", acquisitionChannel: "crm_email" }),
        campaign({ id: "c-live" }),
      ],
      repliesByCampaign: { "c-dead": 9, "c-live": 4 },
      cells: PROD_CELLS,
    });
    const phase = await learningPhase("brandId=b1");
    expect(phase.status).toBe("learning");
    expect(phase.campaignId).toBe("c-live");
    expect(phase.outcomesObserved).toBe(4);
  });
});

describe("nothing a live caller already receives moves", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(SALES) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("leaves every other field on the body identical whatever the verdict says", async () => {
    const read = async (fixture: Fixture) => {
      mockFetch(fixture);
      const res = await request(app).get(`/features/${SALES}/revenue?brandId=b1&campaignId=c-live`).set(AUTH);
      expect(res.status).toBe(200);
      const { learningPhase: _drop, ...rest } = res.body;
      return rest;
    };
    // billing is read by the verdict and by NOTHING else on this body, so taking it away changes the
    // verdict and may change nothing else. It does not.
    const withVerdict = await read(LIVE_ONLY);
    const degraded = await read({ ...LIVE_ONLY, billingDown: true });
    expect(degraded).toEqual(withVerdict);
  });

  it("is absent from the lean per-campaign groups and null on the lensed read", async () => {
    mockFetch(LIVE_ONLY);
    const grouped = await request(app)
      .get(`/features/${SALES}/revenue?brandId=b1&groupBy=campaignId`)
      .set(AUTH);
    expect(grouped.status).toBe(200);
    for (const group of grouped.body.groups) expect(group).not.toHaveProperty("learningPhase");

    mockFetch(LIVE_ONLY);
    const lensed = await request(app)
      .get(`/features/${SALES}/revenue?brandId=b1&campaignId=c-live&lens=signups`)
      .set(AUTH);
    expect(lensed.status).toBe(200);
    expect(lensed.body.learningPhase).toBeNull();
  });
});
