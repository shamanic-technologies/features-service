import { describe, it, expect, vi } from "vitest";

// customer-health-compute transitively imports accounts-compute / routes (revenue, workflow-projection),
// which pull in the db module. Stub it — all reads are injected via deps, so the real db is never touched.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildCustomerHealthBoard,
  AUDIENCE_NEAR_EXHAUSTED_PCT,
  type CustomerHealthDeps,
} from "./customer-health-compute.js";
import type { AccountsAudit, AccountRow, AccountStatus } from "./accounts-compute.js";
import type { ActiveUsersByUser, ActiveUserRow } from "./active-users-by-user-compute.js";
import type { AudienceStatsEnvelope, AudienceStatsRow } from "./audience-stats-compute.js";
import type { WorkflowProjectionResponse } from "../routes/workflow-projection.js";
import type { SalesEconomics } from "./funnel-registry.js";
import type { SalesFunnelKey } from "./sales-funnels.js";
import type { ConversionCounts } from "./conversion-counts-client.js";
import type { BudgetChangeEntry, PauseTransition } from "./history-clients.js";
import type { DashboardReturnSignal } from "./posthog-client.js";
import { BrandOwnershipError } from "./sales-economics-client.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const COLD_CSV = "cold-a";

function econ(ltr: number): SalesEconomics {
  return {
    lifetimeRevenueUsd: ltr,
    replyToMeetingPct: 10,
    visitToMeetingPct: 5,
    meetingToClosePct: 20,
    visitToSignupPct: 8,
    signupToPaidClientPct: 25,
    visitToClosePct: 2,
  };
}

function account(over: Partial<AccountRow> & { orgId: string; brandId: string; status: AccountStatus }): AccountRow {
  const merged: AccountRow = {
    orgExternalId: `org_${over.orgId}`,
    ownerEmail: `${over.orgId}@ex.com`,
    brandName: `Brand ${over.brandId}`,
    brandDomain: `${over.brandId}.com`,
    dailyBudgetUsd: 50,
    orgBalanceUsd: 1000,
    orgActualBalanceUsd: 1000,
    autoTopupEnabled: false,
    ...over,
  };
  return merged;
}

function recency(orgId: string, lastActiveDay: string, retentionWeeks = 4): ActiveUserRow {
  return {
    orgId,
    orgExternalId: `org_${orgId}`,
    ownerEmail: `${orgId}@ex.com`,
    brands: [],
    firstActiveDay: "2026-06-01",
    lastActiveDay,
    firstActiveWeek: "2026-W23",
    lastActiveWeek: "2026-W28",
    firstActiveMonth: "2026-06",
    lastActiveMonth: "2026-07",
    retentionWeeks,
    activeThisWeek: true,
    activeThisMonth: true,
    activeDays: ["2026-07-01", lastActiveDay],
    activeWeeks: ["2026-W28"],
    activeMonths: ["2026-07"],
  };
}

function audienceRow(id: string, memberCount: number, contacted: number, cpcCents: number | null): AudienceStatsRow {
  return {
    audienceId: id,
    brandProfileId: null,
    audience: { id, name: `Aud ${id}`, status: "active", filters: null },
    evidence: {
      totalCostInUsdCents: 1000,
      completedRuns: 1,
      firstRunAt: null,
      lastRunAt: null,
      memberCount,
      contacted,
      opened: 0,
      websiteClicks: contacted,
      positiveReplies: 0,
    },
    metrics: { cpcCents, cpprCents: null, cpfsCents: null, cpsCents: null, cpsaleCents: null },
    projection: { costPerPaidClientUsd: null, returnPerDollar: null, costOfAcquisitionPct: null },
  };
}

function audienceEnvelope(brandId: string, rows: AudienceStatsRow[]): AudienceStatsEnvelope {
  return {
    featureSlug: COLD_CSV,
    brandId,
    goal: "signup",
    brandProfileId: null,
    sortMetric: "cpc",
    audiences: rows,
    brandProjection: {
      lifetimeRevenueUsd: null,
      costPerPaidClientUsd: null,
      returnPerDollar: null,
      costOfAcquisitionPct: null,
    },
  };
}

function workflowResponse(rows: WorkflowProjectionResponse["rows"]): WorkflowProjectionResponse {
  return {
    featureSlug: COLD_CSV,
    objective: "signup",
    goal: "signup",
    economics: null,
    rows,
    recommendedWorkflowDynastySlug: null,
    recommendedBudgetUsd: null,
  };
}

function wfRow(slug: string, name: string | null, cost: number | null, grain: "crossOrg" | "brand" | "audience"): WorkflowProjectionResponse["rows"][number] {
  return {
    audienceId: null,
    workflow: { workflowDynastySlug: slug, workflowDynastyName: name },
    estimatesByGrain: {},
    resolved: {
      grain,
      costPerClickUsd: cost ?? 0,
      costPerOutcomeUsd: cost,
      costPerPaidClientUsd: cost,
      costPerMeetingBookedUsd: null,
      roiMultiple: null,
      cacPct: null,
    },
  };
}

/** Deps builder keyed per-brand from simple fixtures. */
function makeDeps(fixtures: {
  accounts: AccountRow[];
  recencies: ActiveUserRow[];
  perBrand: Record<string, {
    economics: SalesEconomics | null;
    funnels: SalesFunnelKey[];
    counts?: ConversionCounts;
    revenue?: { actualCostUsd: number; expectedPipelineUsd: number | null; roiMultiple: number | null; cacPct: number | null };
    audiences?: AudienceStatsRow[];
    workflow?: WorkflowProjectionResponse["rows"];
    throwOwnership?: boolean;
    budgetHistory?: BudgetChangeEntry[];
    pauseHistory?: PauseTransition[];
    budgetHistoryThrow?: boolean;
    pauseHistoryThrow?: boolean;
  }>;
  /** Per-org dashboard-return signal keyed on the Clerk org id (orgExternalId). Absent → empty map. */
  dashboardReturns?: Map<string, DashboardReturnSignal>;
  /** When true, the dashboard-returns dep throws (exercises the fail-soft degrade → null on every row). */
  dashboardReturnsThrow?: boolean;
}): CustomerHealthDeps {
  const audit: AccountsAudit = {
    rows: fixtures.accounts,
    stats: { totalDailyBudgetUsd: 0, mrrUsd: 0, arrUsd: 0, activeCount: 0, pausedCount: 0, inactiveCount: 0, totalCount: fixtures.accounts.length },
    asOf: NOW.toISOString(),
  };
  const byUser: ActiveUsersByUser = {
    users: fixtures.recencies,
    stats: { totalUsers: fixtures.recencies.length, activeThisWeekCount: 0, activeThisMonthCount: 0 },
    currentWeek: "2026-W29",
    currentMonth: "2026-07",
    asOf: NOW.toISOString(),
  };
  const memberships = fixtures.accounts.map((a) => ({ orgId: a.orgId, brandId: a.brandId, workflowSlug: "wf" }));

  return {
    featureMemberships: async () => memberships,
    accountsAudit: async () => audit,
    activeUsersByUser: async () => byUser,
    savedEconomics: async (brandId) => {
      const f = fixtures.perBrand[brandId];
      if (f?.throwOwnership) throw new BrandOwnershipError(brandId, "org", "stale membership");
      return { economics: f?.economics ?? null };
    },
    declaredFunnels: async (brandId) => {
      const f = fixtures.perBrand[brandId];
      if (f?.throwOwnership) throw new BrandOwnershipError(brandId, "org", "stale membership");
      return f?.funnels ?? [];
    },
    conversionCounts: async (brandId) =>
      fixtures.perBrand[brandId]?.counts ?? { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 },
    brandRevenue: async (_f, brandId) => {
      const r = fixtures.perBrand[brandId]?.revenue;
      if (!r) throw new Error(`no revenue fixture for ${brandId}`);
      return r;
    },
    audienceStats: async (_f, brandId) => {
      const a = fixtures.perBrand[brandId]?.audiences;
      return a ? audienceEnvelope(brandId, a) : null;
    },
    workflowProjection: async (_f, brandId) => workflowResponse(fixtures.perBrand[brandId]?.workflow ?? []),
    dashboardReturns: async () => {
      if (fixtures.dashboardReturnsThrow) throw new Error("posthog unreachable");
      return fixtures.dashboardReturns ?? new Map<string, DashboardReturnSignal>();
    },
    budgetHistory: async (brandId) => {
      if (fixtures.perBrand[brandId]?.budgetHistoryThrow) throw new Error("billing unreachable");
      return fixtures.perBrand[brandId]?.budgetHistory ?? [];
    },
    pauseHistory: async (brandId) => {
      if (fixtures.perBrand[brandId]?.pauseHistoryThrow) throw new Error("campaign unreachable");
      return fixtures.perBrand[brandId]?.pauseHistory ?? [];
    },
  };
}

describe("buildCustomerHealthBoard", () => {
  it("composes a GREEN row: active, ROI>=1, audience not near-exhausted; economics coherent", async () => {
    const deps = makeDeps({
      accounts: [account({ orgId: "a", brandId: "ba", status: "active" })],
      recencies: [recency("a", "2026-07-14")],
      perBrand: {
        ba: {
          economics: econ(100),
          funnels: ["website_purchases"],
          counts: { signup: 5, meeting_booked: 0, form_submission: 0, sale: 0 },
          revenue: { actualCostUsd: 50, expectedPipelineUsd: 100, roiMultiple: 2, cacPct: 50 },
          audiences: [audienceRow("aud1", 100, 20, 500), audienceRow("aud2", 50, 40, 800)],
          workflow: [wfRow("wf-x", "Workflow X", 5, "brand"), wfRow("wf-y", "Workflow Y", 9, "crossOrg")],
        },
      },
    });
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, deps);
    expect(board.customers).toHaveLength(1);
    const row = board.customers[0];

    // identity + recency
    expect(row.brandId).toBe("ba");
    expect(row.lastActiveDay).toBe("2026-07-14");
    expect(row.retentionWeeks).toBe(4);

    // economics coherence: breakeven = LTR = 100; currentCac = cacPct/100 * LTR = 50; roi passthrough
    expect(row.breakevenCacUsd).toBe(100);
    expect(row.ltrUsd).toBe(100);
    expect(row.currentEconomics.currentCacUsd).toBe(50);
    expect(row.currentEconomics.roiMultiple).toBe(2);
    expect(row.currentEconomics.cacPct).toBe(50);
    expect(row.currentEconomics.realizedSpendUsd).toBe(50);

    // tracker: signup needs a tracker; observed=5 → firing true (inferred)
    expect(row.conversionTracker.needed).toBe(true);
    expect(row.conversionTracker.observedConversions).toBe(5);
    expect(row.conversionTracker.firing).toBe(true);
    expect(row.conversionTracker.inferred).toBe(true);

    // audiences rollup: size 150, contacted 60, remaining 90, pctUsed 40
    expect(row.audiences).toEqual({ count: 2, totalSize: 150, totalRemaining: 90, pctUsed: 40 });
    // best audience = lowest cpc (aud1 500) — sorted first in the envelope we pass; cac=5.00
    expect(row.bestAudience).toEqual({ audienceId: "aud1", name: "Aud aud1", cacUsd: 5, size: 100, remaining: 80, pctRemaining: 80 });

    // best workflow = lowest cost (wf-x, 5, brand)
    expect(row.bestWorkflow).toEqual({ workflowDynastySlug: "wf-x", name: "Workflow X", cacUsd: 5, grain: "brand" });

    // health
    expect(row.health.badge).toBe("green");
    expect(row.health.inputs.roiHealthy).toBe(true);
    expect(row.health.inputs.audienceNearExhausted).toBe(false);
    expect(row.health.inputs.audienceNearExhaustedThresholdPct).toBe(AUDIENCE_NEAR_EXHAUSTED_PCT);

    // known gaps explicit null
    // dashboard-return null (no PostHog fixture); budget/pause history default to empty arrays (tracked, none).
    expect(row.notTrackedYet).toEqual({ dashboardReturnFrequency: null, budgetChangeHistory: [], pauseHistory: [] });
    expect(board.stats.greenCount).toBe(1);
  });

  it("YELLOW when active but ROI<1 OR audience near-exhausted; RED when paused/inactive; ordering active-first then recency", async () => {
    const deps = makeDeps({
      accounts: [
        account({ orgId: "b", brandId: "bb", status: "active", dailyBudgetUsd: 50 }),
        account({ orgId: "c", brandId: "bc", status: "active", dailyBudgetUsd: 50 }),
        account({ orgId: "d", brandId: "bd", status: "paused", dailyBudgetUsd: 50 }),
        account({ orgId: "e", brandId: "be", status: "inactive", dailyBudgetUsd: null }),
      ],
      recencies: [recency("b", "2026-07-10"), recency("c", "2026-07-12"), recency("d", "2026-07-05")],
      perBrand: {
        // active, ROI<1 → yellow
        bb: {
          economics: econ(100),
          funnels: ["website_purchases"],
          revenue: { actualCostUsd: 200, expectedPipelineUsd: 100, roiMultiple: 0.5, cacPct: 200 },
          audiences: [audienceRow("x", 100, 10, 300)],
          workflow: [wfRow("wf", "WF", 3, "crossOrg")],
        },
        // active, ROI ok but audience near-exhausted (pctUsed 90) → yellow
        bc: {
          economics: econ(100),
          funnels: ["website_purchases"],
          revenue: { actualCostUsd: 50, expectedPipelineUsd: 200, roiMultiple: 4, cacPct: 25 },
          audiences: [audienceRow("y", 100, 90, 300)],
          workflow: [],
        },
        // paused → red
        bd: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], revenue: { actualCostUsd: 10, expectedPipelineUsd: 100, roiMultiple: 10, cacPct: 10 }, audiences: [] },
        // inactive, no economics → red
        be: { economics: null, funnels: [] },
      },
    });
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, deps);
    // Ordering: active (bc lastActive 07-12, bb 07-10) → paused (bd) → inactive (be)
    expect(board.customers.map((c) => c.brandId)).toEqual(["bc", "bb", "bd", "be"]);

    const byId = Object.fromEntries(board.customers.map((c) => [c.brandId, c]));
    expect(byId.bb.health.badge).toBe("yellow"); // ROI<1
    expect(byId.bb.health.inputs.roiHealthy).toBe(false);
    expect(byId.bc.health.badge).toBe("yellow"); // audience near-exhausted
    expect(byId.bc.health.inputs.audienceNearExhausted).toBe(true);
    expect(byId.bd.health.badge).toBe("red"); // paused
    expect(byId.be.health.badge).toBe("red"); // inactive

    expect(board.stats).toMatchObject({ totalCustomers: 4, activeCount: 2, pausedCount: 1, inactiveCount: 1, yellowCount: 2, redCount: 2, greenCount: 0 });
  });

  it("no own economics → all economics-derived fields null (never an averaged ROI); revenue engine not called", async () => {
    let revenueCalled = false;
    const deps = makeDeps({
      accounts: [account({ orgId: "f", brandId: "bf", status: "active" })],
      recencies: [recency("f", "2026-07-01")],
      perBrand: { bf: { economics: null, funnels: ["website_purchases"] as SalesFunnelKey[], audiences: [audienceRow("z", 100, 10, 200)] } },
    });
    const wrapped: CustomerHealthDeps = { ...deps, brandRevenue: async (...a) => { revenueCalled = true; return deps.brandRevenue(...a); } };
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, wrapped);
    const row = board.customers[0];
    expect(revenueCalled).toBe(false);
    expect(row.breakevenCacUsd).toBeNull();
    expect(row.ltrUsd).toBeNull();
    expect(row.economics).toBeNull();
    expect(row.currentEconomics).toEqual({ realizedSpendUsd: null, expectedPipelineUsd: null, currentCacUsd: null, roiMultiple: null, cacPct: null });
    // The website-purchase chain converts on the CLIENT's site, so it DOES need a tracker there — and
    // with no observed conversions the tracker reads not-firing (0), never null.
    expect(row.conversionTracker.needed).toBe(true);
    expect(row.conversionTracker.observedConversions).toBe(0);
    expect(row.conversionTracker.firing).toBe(false);
    // audience rollup still computed (chain-independent)
    expect(row.audiences.totalSize).toBe(100);
    // a declared chain IS present, so bestAudience is picked
    expect(row.bestAudience?.audienceId).toBe("z");
    // ROI unknown + active → yellow (not green)
    expect(row.health.badge).toBe("yellow");
  });

  it("asks brand-service for the ROW'S OWN org's economics — a brand id is shared across every org claiming the domain", async () => {
    // Two customers on the SAME brand id: distinct orgs claiming one domain. Each row's goal must come
    // from that row's own org, so the read has to be told which one — never resolved from the brand.
    const seen: Array<[string, string]> = [];
    const deps = makeDeps({
      accounts: [
        account({ orgId: "org-A", brandId: "shared", status: "active" }),
        account({ orgId: "org-B", brandId: "shared", status: "active" }),
      ],
      recencies: [recency("org-A", "2026-07-10"), recency("org-B", "2026-07-10")],
      perBrand: { shared: { economics: null, funnels: [] } },
    });
    const wrapped: CustomerHealthDeps = {
      ...deps,
      savedEconomics: async (brandId, orgId) => {
        seen.push([brandId, orgId]);
        return { economics: null };
      },
      declaredFunnels: async (_brandId, orgId) =>
        orgId === "org-A" ? ["sales_meetings_from_conversation"] : ["website_purchases"],
    };
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, wrapped);

    expect(seen.sort()).toEqual([
      ["shared", "org-A"],
      ["shared", "org-B"],
    ]);
    const byOrg = new Map(board.customers.map((c) => [c.orgId, c.primarySalesFunnel]));
    expect(byOrg.get("org-A")).toBe("sales_meetings_from_conversation");
    expect(byOrg.get("org-B")).toBe("website_purchases");
  });

  it("BrandOwnershipError on a stale membership → enrichment nulled, row still listed with identity + status", async () => {
    const deps = makeDeps({
      accounts: [account({ orgId: "g", brandId: "bg", status: "active" })],
      recencies: [recency("g", "2026-07-08")],
      perBrand: { bg: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], throwOwnership: true } },
    });
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, deps);
    const row = board.customers[0];
    expect(row.brandId).toBe("bg");
    expect(row.status).toBe("active");
    expect(row.primarySalesFunnel).toBeNull();
    expect(row.salesFunnels).toEqual([]);
    expect(row.economics).toBeNull();
    expect(row.currentEconomics.roiMultiple).toBeNull();
    expect(row.bestAudience).toBeNull();
    expect(row.bestWorkflow).toBeNull();
  });

  it("populates budget/pause history from billing + campaign, and fail-softs each column to null independently", async () => {
    const budget: BudgetChangeEntry[] = [{ dailyBudgetUsd: 50, changedAt: "2026-07-01T00:00:00.000Z" }];
    const pause: PauseTransition[] = [{ paused: true, transitionedAt: "2026-07-05T00:00:00.000Z" }];
    const deps = makeDeps({
      accounts: [
        account({ orgId: "p", brandId: "bp", status: "active" }),
        account({ orgId: "q", brandId: "bq", status: "active" }),
      ],
      recencies: [recency("p", "2026-07-10"), recency("q", "2026-07-11")],
      perBrand: {
        // full history both columns
        bp: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], revenue: { actualCostUsd: 10, expectedPipelineUsd: 100, roiMultiple: 10, cacPct: 10 }, budgetHistory: budget, pauseHistory: pause },
        // billing degrades → budgetChangeHistory null; campaign ok → pauseHistory empty array
        bq: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], revenue: { actualCostUsd: 10, expectedPipelineUsd: 100, roiMultiple: 10, cacPct: 10 }, budgetHistoryThrow: true },
      },
    });
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, deps);
    const byId = Object.fromEntries(board.customers.map((c) => [c.brandId, c]));
    expect(byId.bp.notTrackedYet.budgetChangeHistory).toEqual(budget);
    expect(byId.bp.notTrackedYet.pauseHistory).toEqual(pause);
    // fail-soft: only the failing column is null, the other still resolves ([])
    expect(byId.bq.notTrackedYet.budgetChangeHistory).toBeNull();
    expect(byId.bq.notTrackedYet.pauseHistory).toEqual([]);
    // a billing blip must not degrade the row's economics
    expect(byId.bq.currentEconomics.roiMultiple).toBe(10);
  });

  it("tracker firing=false when a NEEDED tracker observes zero conversions", async () => {
    const deps = makeDeps({
      accounts: [account({ orgId: "h", brandId: "bh", status: "active" })],
      recencies: [recency("h", "2026-07-09")],
      perBrand: {
        bh: {
          economics: econ(100),
          funnels: ["form_magnet"],
          counts: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 },
          revenue: { actualCostUsd: 10, expectedPipelineUsd: 50, roiMultiple: 5, cacPct: 20 },
          audiences: [],
        },
      },
    });
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, deps);
    const t = board.customers[0].conversionTracker;
    expect(t.needed).toBe(true);
    expect(t.observedConversions).toBe(0);
    expect(t.firing).toBe(false);
  });

  it("dashboardReturnFrequency: PostHog signal joined per org (orgExternalId); orgs with no PostHog data → null", async () => {
    const signal: DashboardReturnSignal = {
      sessions7d: 9,
      sessions30d: 40,
      pageviews7d: 55,
      pageviews30d: 220,
      lastSeen: "2026-07-14T10:00:00.000Z",
      daysSinceLastSeen: 1,
    };
    const deps = makeDeps({
      accounts: [
        account({ orgId: "i", brandId: "bi", status: "active" }), // orgExternalId org_i → has signal
        account({ orgId: "j", brandId: "bj", status: "active" }), // orgExternalId org_j → no signal → null
      ],
      recencies: [recency("i", "2026-07-14"), recency("j", "2026-07-13")],
      perBrand: {
        bi: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], revenue: { actualCostUsd: 10, expectedPipelineUsd: 100, roiMultiple: 10, cacPct: 10 }, audiences: [] },
        bj: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], revenue: { actualCostUsd: 10, expectedPipelineUsd: 100, roiMultiple: 10, cacPct: 10 }, audiences: [] },
      },
      dashboardReturns: new Map([["org_i", signal]]),
    });
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, deps);
    const byId = Object.fromEntries(board.customers.map((c) => [c.brandId, c]));
    expect(byId.bi.notTrackedYet.dashboardReturnFrequency).toEqual(signal);
    expect(byId.bj.notTrackedYet.dashboardReturnFrequency).toBeNull();
    // the other two are now tracked upstream; no fixture → default empty arrays (tracked, nothing yet)
    expect(byId.bi.notTrackedYet.budgetChangeHistory).toEqual([]);
    expect(byId.bi.notTrackedYet.pauseHistory).toEqual([]);
  });

  it("dashboardReturns fails → fail-soft: dashboardReturnFrequency null on every row, board still built", async () => {
    const deps = makeDeps({
      accounts: [account({ orgId: "k", brandId: "bk", status: "active" })],
      recencies: [recency("k", "2026-07-11")],
      perBrand: { bk: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], revenue: { actualCostUsd: 10, expectedPipelineUsd: 100, roiMultiple: 10, cacPct: 10 }, audiences: [] } },
      dashboardReturnsThrow: true,
    });
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, deps);
    expect(board.customers).toHaveLength(1);
    expect(board.customers[0].notTrackedYet.dashboardReturnFrequency).toBeNull();
  });

  it("per-row fail-soft: a non-ownership downstream error on ONE customer degrades that row but the board still builds (200) with every row + a healthy sibling", async () => {
    const deps = makeDeps({
      accounts: [
        account({ orgId: "m", brandId: "bm", status: "active" }), // enrichment throws → degraded
        account({ orgId: "n", brandId: "bn", status: "active" }), // healthy sibling, fully enriched
      ],
      recencies: [recency("m", "2026-07-14"), recency("n", "2026-07-13")],
      perBrand: {
        bm: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], audiences: [] },
        bn: { economics: econ(100), funnels: ["website_purchases"] as SalesFunnelKey[], revenue: { actualCostUsd: 10, expectedPipelineUsd: 100, roiMultiple: 10, cacPct: 10 }, audiences: [] },
      },
    });
    // A real (non-BrandOwnershipError) downstream failure for brand bm — e.g. a revenue composite whose
    // transient retries exhausted, or a downstream 5xx. Must NOT reject the whole board.
    const wrapped: CustomerHealthDeps = {
      ...deps,
      brandRevenue: async (f, brandId, orgId, e, funnels) => {
        if (brandId === "bm") throw new Error("downstream revenue 503");
        return deps.brandRevenue(f, brandId, orgId, e, funnels);
      },
    };
    const board = await buildCustomerHealthBoard(COLD_CSV, NOW, wrapped);
    expect(board.customers).toHaveLength(2);
    const byId = Object.fromEntries(board.customers.map((c) => [c.brandId, c]));
    // Degraded row: still listed with identity + status, economics-derived enrichment nulled.
    expect(byId.bm.status).toBe("active");
    expect(byId.bm.currentEconomics.roiMultiple).toBeNull();
    // Healthy sibling unaffected — full enrichment.
    expect(byId.bn.currentEconomics.roiMultiple).toBe(10);
    expect(byId.bn.health.badge).toBe("green");
    // Fleet stats still computed over ALL rows.
    expect(board.stats.totalCustomers).toBe(2);
    expect(board.stats.activeCount).toBe(2);
  });
});
