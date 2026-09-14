import { describe, it, expect, vi } from "vitest";

// revenue-history-compute transitively imports accounts-compute → pipeline-activity → the db module.
// Stub it so this pure-logic suite needs no DB connection (all reads are injected).
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildRevenueHistory, bucketizeRevenue, type RevenueHistoryDeps } from "./revenue-history-compute.js";
import { enumerateBuckets } from "./active-users-compute.js";

const NOW = new Date("2026-07-15T12:00:00Z"); // Wednesday
const COLD = "sales-cold-email-outreach,pr-cold-email-outreach";

describe("bucketizeRevenue — summed spend per bucket + growth", () => {
  it("SUMS cents across orgs (not distinct-counts) and converts to 2-decimal USD + growth", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 3); // 13,14,15
    const orgDaily = new Map<string, Map<string, number>>([
      ["orgA", new Map([["2026-07-13", 1000], ["2026-07-14", 2000], ["2026-07-15", 4000]])],
      ["orgB", new Map([["2026-07-14", 2000]])], // second org adds to the same bucket
      ["orgC", new Map([["2026-07-15", 4000]])],
    ]);
    const series = bucketizeRevenue(orgDaily, buckets, "day");
    // 13:1000c=$10  14:(2000+2000)=$40  15:(4000+4000)=$80
    expect(series.map((s) => s.revenueUsd)).toEqual([10, 40, 80]);
    expect(series[0].growthPct).toBeNull(); // first bucket
    expect(series[1].growthPct).toBe(300); // 1000→4000
    expect(series[2].growthPct).toBe(100); // 4000→8000
  });

  it("spend on two days of the SAME week rolls into one weekly bucket", () => {
    const buckets = enumerateBuckets("2026-07-15", "week", 1); // week of 07-13
    const orgDaily = new Map<string, Map<string, number>>([["orgA", new Map([["2026-07-13", 1500], ["2026-07-15", 3500]])]]);
    const series = bucketizeRevenue(orgDaily, buckets, "week");
    expect(series[0].revenueUsd).toBe(50); // 5000c
  });

  it("growthPct is null when the previous bucket is 0 (no % from zero base)", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 2); // 14,15
    const orgDaily = new Map<string, Map<string, number>>([["orgA", new Map([["2026-07-15", 5000]])]]);
    const series = bucketizeRevenue(orgDaily, buckets, "day");
    expect(series.map((s) => s.revenueUsd)).toEqual([0, 50]);
    expect(series[1].growthPct).toBeNull(); // 0→50 → null, never Infinity
  });

  it("days outside the displayed window are ignored", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 2); // 14,15
    const orgDaily = new Map<string, Map<string, number>>([["orgA", new Map([["2026-01-01", 9999], ["2026-07-15", 5000]])]]);
    const series = bucketizeRevenue(orgDaily, buckets, "day");
    expect(series.map((s) => s.revenueUsd)).toEqual([0, 50]); // 01-01 dropped from the trailing window
  });
});

describe("buildRevenueHistory — integration via injected deps", () => {
  function deps(fixture: {
    orgs: string[];
    dailyCents: Record<string, Record<string, number>>;
    currentMrrUsd: number;
    activeCount?: number;
    snapshots?: Array<{ date: string; mrrUsd: number }>;
    capture?: { startedAfter?: string; recorded?: { dailyBudgetUsd: number; activeCount: number } };
  }): RevenueHistoryDeps {
    return {
      featureMemberships: async () => fixture.orgs.map((orgId) => ({ orgId })),
      orgDailySpendCents: async (orgId, _csv, startedAfterIso) => {
        if (fixture.capture) fixture.capture.startedAfter = startedAfterIso;
        return new Map(Object.entries(fixture.dailyCents[orgId] ?? {}));
      },
      currentFleetStats: async () => ({
        mrrUsd: fixture.currentMrrUsd,
        dailyBudgetUsd: fixture.currentMrrUsd / 30,
        activeCount: fixture.activeCount ?? 0,
        pairs: [],
      }),
      recordCommittedSnapshot: async (dailyBudgetUsd, activeCount) => {
        if (fixture.capture) fixture.capture.recorded = { dailyBudgetUsd, activeCount };
      },
      readCommittedSnapshots: async () => fixture.snapshots ?? [],
      readStatedAmounts: async () => [],
      budgetByDay: async () => ({ recordBeginsAt: null, byDay: new Map() }),
      currentDailyBudget: async () => null,
      paymentStopped: async () => ({ recordBeginsOn: null, periods: [] }),
      fleetCampaigns: async () => [],
      campaignEarningOnDay: async () => [],
      brandSpendByDay: async () => new Map(),
      firstBilledDay: async () => null,
    };
  }

  it("assembles totals, trailing series, the since-inception line, and the live MRR", async () => {
    const capture: { startedAfter?: string } = {};
    const history = await buildRevenueHistory(
      COLD,
      NOW,
      { days: 3, weeks: 2, months: 2 },
      deps({
        orgs: ["orgA", "orgB"],
        dailyCents: {
          orgA: { "2026-07-15": 4000, "2026-05-10": 1000 }, // today + a May day (before the trailing daily/weekly windows)
          orgB: { "2026-06-20": 3000 }, // June, in the monthly window
        },
        currentMrrUsd: 12345.67,
        capture,
      }),
    );

    // Total since inception = 4000+1000+3000 = 8000c = $80. Live MRR is a passthrough, NOT reconstructed.
    expect(history.totalRevenueUsd).toBe(80);
    expect(history.currentMrrUsd).toBe(12345.67);
    expect(history.asOf).toBe("2026-07-15T12:00:00.000Z");

    // Monthly (2026-06, 2026-07): $30 in June (orgB), $40 in July (orgA today).
    expect(history.monthly.map((m) => [m.period, m.revenueUsd])).toEqual([
      ["2026-06", 30],
      ["2026-07", 40],
    ]);

    // Daily (07-13,07-14,07-15): only orgA today → $40.
    expect(history.daily.map((d) => d.revenueUsd)).toEqual([0, 0, 40]);

    // Since-inception line spans the earliest billed day (2026-05-10) → today, first & last carry the spend.
    const first = history.sinceInceptionDaily[0];
    const last = history.sinceInceptionDaily[history.sinceInceptionDaily.length - 1];
    expect(first).toMatchObject({ period: "2026-05-10", revenueUsd: 10 });
    expect(last).toMatchObject({ period: "2026-07-15", revenueUsd: 40 });
    // The June orgB day is in the line too; the middle days between billed days read $0.
    expect(history.sinceInceptionDaily.find((d) => d.period === "2026-06-20")?.revenueUsd).toBe(30);
    expect(history.sinceInceptionDaily.find((d) => d.period === "2026-05-11")?.revenueUsd).toBe(0);

    // The all-time fetch uses the inception floor, NOT the trailing-window lower bound.
    expect(capture.startedAfter).toBe("2020-01-01T00:00:00.000Z");

    // Committed MRR current period reconciles with the live MRR; ARR = MRR × 12.
    expect(history.committedMrr.currentMrrUsd).toBe(12345.67);
    expect(history.committedMrr.currentArrUsd).toBe(12345.67 * 12);
    const lastMonth = history.committedMrr.monthly[history.committedMrr.monthly.length - 1];
    expect(lastMonth).toMatchObject({ period: "2026-07", mrrUsd: 12345.67, arrUsd: 12345.67 * 12 });
    const lastWeek = history.committedMrr.weekly[history.committedMrr.weekly.length - 1];
    expect(lastWeek.mrrUsd).toBe(12345.67);
    expect(lastWeek.arrUsd).toBe(12345.67 * 12);
  });

  it("committed MRR series: past periods from recorded snapshots, current period = live MRR, growth + ARR coherent", async () => {
    const capture: { recorded?: { dailyBudgetUsd: number; activeCount: number } } = {};
    const history = await buildRevenueHistory(
      COLD,
      NOW,
      { days: 3, weeks: 2, months: 3 },
      deps({
        orgs: ["orgA"],
        dailyCents: { orgA: { "2026-07-15": 4000 } },
        currentMrrUsd: 3000, // live current-month committed MRR
        activeCount: 4,
        // June has two snapshots (last one = end-of-June run-rate $2000); May has one ($1000).
        snapshots: [
          { date: "2026-05-20", mrrUsd: 1000 },
          { date: "2026-06-10", mrrUsd: 1500 },
          { date: "2026-06-28", mrrUsd: 2000 },
        ],
        capture,
      }),
    );

    // Today's snapshot recorded going forward (budget = mrr/30, active count passed through).
    expect(capture.recorded).toEqual({ dailyBudgetUsd: 100, activeCount: 4 });

    // Monthly: May $1000 → June $2000 (last snapshot) → July $3000 (live). Growth point-over-point.
    expect(history.committedMrr.monthly.map((m) => [m.period, m.mrrUsd, m.arrUsd, m.growthPct])).toEqual([
      ["2026-05", 1000, 12000, null],
      ["2026-06", 2000, 24000, 100],
      ["2026-07", 3000, 36000, 50],
    ]);
  });

  it("NRR rides the SAME realized-revenue basis as the series, on both grains", async () => {
    const history = await buildRevenueHistory(
      COLD,
      NOW,
      { days: 3, weeks: 2, months: 2 },
      deps({
        orgs: ["existing", "newLogo"],
        dailyCents: {
          existing: { "2026-06-10": 100_00, "2026-07-02": 80_00 }, // contraction: 80%
          newLogo: { "2026-07-05": 500_00 }, // acquired in July — must not inflate NRR
        },
        currentMrrUsd: 0,
      }),
    );

    // The realized-revenue series still sees BOTH orgs (July = 80 + 500 = $580) …
    expect(history.monthly.at(-1)).toMatchObject({ period: "2026-07", revenueUsd: 580 });
    // … while NRR sees only the start-of-July cohort: 80/100 = 80%, not 580/100.
    expect(history.netRevenueRetention.monthly.at(-1)).toMatchObject({
      period: "2026-07",
      retentionPct: 80,
      cohortSize: 1,
      priorRevenueUsd: 100,
      retainedRevenueUsd: 80,
    });
    expect(history.netRevenueRetention.monthly).toHaveLength(2);
    expect(history.netRevenueRetention.weekly).toHaveLength(2);
  });

  it("empty cold-email universe → zero totals + empty since-inception line, never throws", async () => {
    const history = await buildRevenueHistory("", NOW, { days: 2, weeks: 1, months: 1 }, deps({ orgs: [], dailyCents: {}, currentMrrUsd: 0 }));
    expect(history.totalRevenueUsd).toBe(0);
    expect(history.currentMrrUsd).toBe(0);
    expect(history.daily.every((d) => d.revenueUsd === 0)).toBe(true);
    expect(history.sinceInceptionDaily).toEqual([]);
    expect(history.monthly.length).toBe(1);
  });
});

/**
 * WIRING of the agency / self-serve split into the revenue payload. The split's own arithmetic is
 * guarded in agency-self-serve-compute.test.ts; these cases assert what only this layer decides —
 * which producer each fact is read from, that the read set is bounded by the REFERENCE DATES rather
 * than by the displayed window, that the activity fallback is paid for only while it is needed, and
 * that a failed read NULLS the split instead of 502-ing a payload whose every other figure is right.
 */
describe("buildRevenueHistory — the agency / self-serve split", () => {
  const SPLIT_NOW = new Date("2026-09-12T12:00:00Z");
  const TODAY = "2026-09-12";
  const AGENCY_ORG = "org-agency";
  const SAAS_ORG = "org-saas";
  const BRAND_BIG = "brand-big";
  const BRAND_SAAS = "brand-saas";

  interface Calls {
    budget: Array<{ brandId: string; from: string; to: string }>;
  liveBudget: Array<{ brandId: string; orgId: string }>;
    payment: string[];
    fleetCampaigns: number;
    earningDays: string[];
    activity: string[];
    firstBilled: number;
  }

  function emptyCalls(): Calls {
    return { budget: [], liveBudget: [], payment: [], fleetCampaigns: 0, earningDays: [], activity: [], firstBilled: 0 };
  }

  const STATED_ROW = {
    id: "row-1",
    orgId: AGENCY_ORG,
    brandId: BRAND_BIG,
    amountUsd: 5000,
    startDate: "2026-08-01",
    endDate: null,
    note: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };

  function splitDeps(over: Partial<RevenueHistoryDeps> = {}, calls: Calls = emptyCalls()): RevenueHistoryDeps {
    return {
      featureMemberships: async () => [{ orgId: AGENCY_ORG }, { orgId: SAAS_ORG }],
      orgDailySpendCents: async () => new Map(),
      currentFleetStats: async () => ({
        mrrUsd: 7350,
        dailyBudgetUsd: 245,
        activeCount: 2,
        pairs: [
          { orgId: AGENCY_ORG, brandId: BRAND_BIG, brandName: "Big Agency Brand", brandDomain: "big.example", runningDailyBudgetUsd: 143, active: true },
          { orgId: SAAS_ORG, brandId: BRAND_SAAS, brandName: "Self Serve Co", brandDomain: "saas.example", runningDailyBudgetUsd: 102, active: true },
        ],
      }),
      recordCommittedSnapshot: async () => {},
      readCommittedSnapshots: async () => [{ date: "2026-08-31", mrrUsd: 6000 }],
      readStatedAmounts: async () => [],
      budgetByDay: async (brandId, _orgId, from, to) => {
        calls.budget.push({ brandId, from, to });
        const byDay = new Map<string, number>();
        for (const d of ["2026-08-31", TODAY]) byDay.set(d, brandId === BRAND_BIG ? 143 : 102);
        return { recordBeginsAt: "2026-07-15T00:00:00.000Z", byDay };
      },
      currentDailyBudget: async (brandId, orgId) => {
        calls.liveBudget.push({ brandId, orgId });
        return brandId === BRAND_BIG ? 143 : 102;
      },
      paymentStopped: async (orgId) => {
        calls.payment.push(orgId);
        return { recordBeginsOn: "2026-06-12", periods: [] };
      },
      fleetCampaigns: async () => {
        calls.fleetCampaigns += 1;
        return [
          { campaignId: "camp-agency", orgId: AGENCY_ORG, brandId: BRAND_BIG },
          { campaignId: "camp-saas", orgId: SAAS_ORG, brandId: BRAND_SAAS },
          { campaignId: "camp-orphan", orgId: SAAS_ORG, brandId: null },
        ];
      },
      campaignEarningOnDay: async (campaignIds, day) => {
        calls.earningDays.push(day);
        return campaignIds.map((campaignId) => ({
          campaignId,
          status: "ongoing" as const,
          audience: "available" as const,
          earning: true,
          statusRecordedSince: "2026-09-01T00:00:00.000Z",
          audienceRecordedSince: "2026-09-01T00:00:00.000Z",
        }));
      },
      brandSpendByDay: async (_orgId, brandId) => {
        calls.activity.push(brandId);
        return new Map([["2026-08-31", 12]]);
      },
      firstBilledDay: async () => {
        calls.firstBilled += 1;
        return "2026-07-25";
      },
      ...over,
    };
  }

  const WINDOWS = { days: 7, weeks: 4, months: 3 };

  it("sums the self-serve side rather than subtracting, and reads each fact from its own producer", async () => {
    const calls = emptyCalls();
    const out = await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps({ readStatedAmounts: async () => [STATED_ROW] }, calls));

    const split = out.mrrSplit!;
    expect(split.currentAgencyMrrUsd).toBe(5000); // the STATED amount
    expect(split.currentSelfServeMrrUsd).toBe(102 * 30); // a SUM over the self-serve pair
    expect(split.currentAgencyBudgetMrrUsd).toBe(143 * 30);
    expect(split.currentTotalMrrUsd).toBe(5000 + 102 * 30);
    expect(split.agencyOrgIds).toEqual([AGENCY_ORG]);

    // One budget replay per pair, one payment read per org, one fleet campaign list.
    expect(calls.budget.map((c) => c.brandId).sort()).toEqual([BRAND_BIG, BRAND_SAAS]);
    expect(calls.payment.sort()).toEqual([AGENCY_ORG, SAAS_ORG]);
    expect(calls.fleetCampaigns).toBe(1);
    expect(calls.firstBilled).toBe(0); // the stated row carries a start date
  });

  it("reads TODAY's amount from billing's LIVE budget and the PAST from its replay, one call per pair", async () => {
    // The production shape, measured 2026-09-14: the self-serve brand's live budget is $15/day while
    // the newest row in billing's change log still says $1 — the figure was 15x too small — and the
    // agency brand is funded live with NOTHING in the log at all, so the replay dropped it entirely.
    const calls = emptyCalls();
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps(
        {
          readStatedAmounts: async () => [STATED_ROW], // so BRAND_BIG is the agency side
          budgetByDay: async (brandId, _orgId, from, to) => {
            calls.budget.push({ brandId, from, to });
            const byDay = new Map<string, number>();
            if (brandId === BRAND_SAAS) {
              byDay.set("2026-08-31", 102);
              byDay.set(TODAY, 1); // the stale change row
            }
            // BRAND_BIG has no change rows whatsoever.
            return { recordBeginsAt: "2026-07-15T00:00:00.000Z", byDay };
          },
          currentDailyBudget: async (brandId, orgId) => {
            calls.liveBudget.push({ brandId, orgId });
            return brandId === BRAND_SAAS ? 15 : 8;
          },
        },
        calls,
      ),
    );

    const split = out.mrrSplit!;
    // $15/day, not the log's $1 — and not the $102 the earlier fixture's replay carried either.
    expect(split.currentSelfServeMrrUsd).toBe(450);
    expect(split.currentSelfServeMrrUsd).not.toBe(30);
    // The agency brand billing never logged is funded too, so its budget half is no longer zero.
    expect(split.currentAgencyBudgetMrrUsd).toBe(240);

    const row = split.selfServeBreakdown.rows.find((r) => r.brandId === BRAND_SAAS)!;
    expect([row.configuredDailyBudgetUsd, row.amountSource, row.countedMrrUsd]).toEqual([15, "live", 450]);
    expect(row.excludedBy).toBeNull(); // never "no_recorded_amount" for a brand that is plainly funded
    expect(split.selfServeBreakdown.countedMrrUsd).toBe(split.currentSelfServeMrrUsd);

    // The PAST bucket still reads the replay: August is $102/day for the self-serve brand, and the
    // agency brand the log never recorded contributes nothing there.
    const aug = split.monthly.find((b) => b.period === "2026-08")!;
    expect(aug.selfServeMrrUsd).toBe(102 * 30);
    expect(aug.agencyBudgetMrrUsd).toBe(0);

    // ONE live read per pair, beside the one replay per pair — no second round trip per day.
    expect(calls.liveBudget.map((c) => c.brandId).sort()).toEqual([BRAND_BIG, BRAND_SAAS]);
    expect(calls.liveBudget.find((c) => c.brandId === BRAND_SAAS)!.orgId).toBe(SAAS_ORG);
    expect(calls.budget.map((c) => c.brandId).sort()).toEqual([BRAND_BIG, BRAND_SAAS]);
  });

  it("leaves a pair billing holds no live amount for uncounted, and says the gap is there", async () => {
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({ readStatedAmounts: async () => [STATED_ROW], currentDailyBudget: async () => null }),
    );
    const split = out.mrrSplit!;
    // Both pairs are running and neither has an amount billing will state — nothing is invented.
    expect(split.currentSelfServeMrrUsd).toBe(0);
    const row = split.selfServeBreakdown.rows.find((r) => r.brandId === BRAND_SAAS)!;
    expect(row.configuredDailyBudgetUsd).toBeNull();
    expect(row.amountSource).toBeNull();
    expect(row.excludedBy).toBe("no_recorded_amount");
    const sep = split.monthly.find((b) => b.period === "2026-09")!;
    expect(sep.selfServeUnrecordedBudgetPairCount).toBe(1);
  });

  it("asks campaign-service about the REFERENCE DATES only, never every day of the window", async () => {
    const calls = emptyCalls();
    await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps({}, calls));
    // The window spans months; the split is read on a handful of dates, and today is always one.
    expect(calls.earningDays).toContain(TODAY);
    expect(new Set(calls.earningDays).size).toBeLessThanOrEqual(6);
    expect(calls.earningDays.every((d) => d >= "2026-08-31")).toBe(true);
    // The budget replay is bounded by the same dates, not by the displayed window.
    expect(calls.budget.every((c) => c.from >= "2026-08-31" && c.to === TODAY)).toBe(true);
  });

  it("pays for the ACTIVITY fallback only while some reference date predates campaign-service's record", async () => {
    // Record begins AFTER the oldest reference date → the fallback is needed and is read.
    const needed = emptyCalls();
    await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps({}, needed));
    expect(needed.activity.sort()).toEqual([BRAND_BIG, BRAND_SAAS]);

    // Record reaches back past every reference date → nothing is approximated, so nothing is fetched.
    const covered = emptyCalls();
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps(
        {
          campaignEarningOnDay: async (campaignIds, day) => {
            covered.earningDays.push(day);
            return campaignIds.map((campaignId) => ({
              campaignId,
              status: "ongoing" as const,
              audience: "available" as const,
              earning: true,
              statusRecordedSince: "2026-01-01T00:00:00.000Z",
              audienceRecordedSince: "2026-01-01T00:00:00.000Z",
            }));
          },
        },
        covered,
      ),
    );
    expect(covered.activity).toEqual([]);
    expect(out.mrrSplit!.currentSelfServeBasis).toBe("recorded");
    expect(out.mrrSplit!.earningRecordBeginsOn).toBe("2026-01-01");
  });

  it("MARKS an approximated period, so a consumer can label it rather than present it as measured", async () => {
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({
        readStatedAmounts: async () => [STATED_ROW],
        // campaign-service knows nothing about any of these days…
        campaignEarningOnDay: async (campaignIds) =>
          campaignIds.map((campaignId) => ({
            campaignId,
            status: "not_recorded" as const,
            audience: "not_recorded" as const,
            earning: null,
            statusRecordedSince: null,
            audienceRecordedSince: null,
          })),
        // …but the pair billed spend on the August reference date.
        brandSpendByDay: async () => new Map([["2026-08-31", 12]]),
      }),
    );
    const split = out.mrrSplit!;
    const aug = split.monthly.find((b) => b.period === "2026-08")!;
    expect(aug.selfServeBasis).toBe("approximated");
    expect(aug.selfServeMrrUsd).toBe(102 * 30); // still a figure, not a hole
    expect(aug.selfServeApproximatedPairCount).toBe(1);
    expect(split.earningRecordBeginsOn).toBeNull();
  });

  it("a campaign row naming no brand joins to no pair and is never asked about", async () => {
    const asked: string[][] = [];
    await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({
        campaignEarningOnDay: async (campaignIds, day) => {
          asked.push(campaignIds);
          return campaignIds.map((campaignId) => ({
            campaignId,
            status: "ongoing" as const,
            audience: "available" as const,
            earning: true,
            statusRecordedSince: "2026-09-01T00:00:00.000Z",
            audienceRecordedSince: "2026-09-01T00:00:00.000Z",
          }));
        },
      }),
    );
    expect(asked.flat()).not.toContain("camp-orphan");
    expect(asked.flat()).toContain("camp-agency");
  });

  it("reads the first billed day only for a stated row with NO start date", async () => {
    const calls = emptyCalls();
    await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({ readStatedAmounts: async () => [{ ...STATED_ROW, startDate: null }] }, calls),
    );
    expect(calls.firstBilled).toBe(1);
  });

  it("NULLS the split when a producer read fails, leaving every other figure intact", async () => {
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({
        readStatedAmounts: async () => [STATED_ROW],
        budgetByDay: async () => {
          throw new Error("billing-service unreachable");
        },
      }),
    );

    expect(out.mrrSplit).toBeNull(); // "we could not read this" — never a zero agency
    expect(out.currentMrrUsd).toBe(7350);
    expect(out.committedMrr.currentMrrUsd).toBe(7350);
    expect(out.asOf).toBe(SPLIT_NOW.toISOString());
  });

  it("nulls the split when the STORE itself is unreadable, distinct from an empty store", async () => {
    const out = await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps({ readStatedAmounts: async () => null }));
    expect(out.mrrSplit).toBeNull();
  });

  it("leaves every other figure byte-identical whether or not anything is stated", async () => {
    const withNone = await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps());
    const withStated = await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps({ readStatedAmounts: async () => [STATED_ROW] }));

    expect(withStated.committedMrr).toEqual(withNone.committedMrr);
    expect(withStated.currentMrrUsd).toBe(withNone.currentMrrUsd);
    expect(withStated.totalRevenueUsd).toBe(withNone.totalRevenueUsd);
    expect(withStated.netRevenueRetention).toEqual(withNone.netRevenueRetention);
    // …while the split itself DIVERGES, which is the whole point: with nothing stated the agency's
    // brand sits on the SaaS side, so the self-serve figure is LARGER.
    expect(withNone.mrrSplit!.currentSelfServeMrrUsd!).toBeGreaterThan(withStated.mrrSplit!.currentSelfServeMrrUsd!);
    expect(withNone.mrrSplit!.currentAgencyMrrUsd).toBe(0);
  });

  it("never reports a NEGATIVE self-serve half, whatever the recorded fleet figure says", async () => {
    // The recorded snapshot is far SMALLER than the agency's replayed budget — the shape that used
    // to produce −$720/month and force the period to be published as unmeasurable.
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({
        readStatedAmounts: async () => [STATED_ROW],
        readCommittedSnapshots: async () => [{ date: "2026-08-31", mrrUsd: 100 }],
      }),
    );
    const aug = out.mrrSplit!.monthly.find((b) => b.period === "2026-08")!;
    expect(aug.committedMrrUsd).toBe(100);
    expect(aug.agencyBudgetMrrUsd).toBeGreaterThan(aug.committedMrrUsd);
    expect(aug.selfServeMrrUsd).toBe(102 * 30);
    expect(aug.selfServeMrrUsd!).toBeGreaterThan(0);
    expect(aug.selfServeUnmeasurableReason).toBeNull();
  });
});
