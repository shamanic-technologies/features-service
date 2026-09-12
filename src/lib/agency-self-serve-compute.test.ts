/**
 * Guards for the AGENCY / SELF-SERVE split of the fleet monthly run-rate.
 *
 * ONE fixture, shaped like the production account that motivated it: an AGENCY org funding two brands
 * ($142/day + $1/day) beside self-serve orgs funding $102/day, so the fleet committed run-rate is
 * $245/day → $7,350/month. Every case asserts the DIVERGENCE between what the split says and what the
 * undivided figure says — a suite that only checked "a number came back" would pass on an
 * implementation that quietly reported the agency's budget × 30 as its MRR, which is the exact bug
 * this feature exists to remove.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  agencyBudgetMrrOn,
  agencyOrgIdsOf,
  agencyPairKeysOf,
  agencyStatedMrrOn,
  budgetUsdOn,
  buildMrrSplit,
  pairKey,
  statedAmountInForce,
  type MrrSplitInputs,
} from "./agency-self-serve-compute.js";
import type { StatedAmountRow } from "./stated-monthly-amounts-store.js";

const AGENCY_ORG = "org-agency";
const SAAS_ORG_A = "org-saas-a";
const SAAS_ORG_B = "org-saas-b";
const BRAND_BIG = "brand-big"; // the agency's funded brand: $142/day
const BRAND_SMALL = "brand-small"; // the agency's other funded brand: $1/day
const BRAND_IDLE = "brand-idle"; // an agency brand nobody has stated an amount for, $0/day
const BRAND_SAAS_A = "brand-saas-a"; // $100/day
const BRAND_SAAS_B = "brand-saas-b"; // $2/day

const TODAY = "2026-09-12";
const NOW = new Date(`${TODAY}T12:00:00Z`);

/** Every cold-email (org, brand) pair, with the running budget the accounts audit reports. */
const ALL_PAIRS = [
  { orgId: AGENCY_ORG, brandId: BRAND_BIG, runningDailyBudgetUsd: 142, active: true },
  { orgId: AGENCY_ORG, brandId: BRAND_SMALL, runningDailyBudgetUsd: 1, active: true },
  { orgId: AGENCY_ORG, brandId: BRAND_IDLE, runningDailyBudgetUsd: 0, active: false },
  { orgId: SAAS_ORG_A, brandId: BRAND_SAAS_A, runningDailyBudgetUsd: 100, active: true },
  { orgId: SAAS_ORG_B, brandId: BRAND_SAAS_B, runningDailyBudgetUsd: 2, active: true },
];

/** Fleet committed MRR = Σ ACTIVE running budget × 30 = (142 + 1 + 100 + 2) × 30. */
const FLEET_MRR = 245 * 30; // 7350
/** What the agency side contributes to that figure: (142 + 1) × 30. */
const AGENCY_BUDGET_MRR = 143 * 30; // 4290
/** What is left once the agency's budget stops standing in for its worth: 102 × 30. */
const SELF_SERVE_MRR = 102 * 30; // 3060

/** billing's append-only per-pair daily-budget timeline, oldest-first. */
const TIMELINES = new Map([
  [
    pairKey(AGENCY_ORG, BRAND_BIG),
    [
      { dailyBudgetUsd: 35, changedAt: "2026-07-28T09:00:00Z" },
      { dailyBudgetUsd: 50, changedAt: "2026-08-10T09:00:00Z" },
      { dailyBudgetUsd: 142, changedAt: "2026-09-09T09:00:00Z" },
    ],
  ],
  [pairKey(AGENCY_ORG, BRAND_SMALL), [{ dailyBudgetUsd: 1, changedAt: "2026-07-25T09:00:00Z" }]],
  [pairKey(AGENCY_ORG, BRAND_IDLE), []],
]);

/** The committed snapshots this service has recorded daily since 2026-07-15. */
const SNAPSHOTS = [
  { date: "2026-07-15", mrrUsd: 3000 },
  { date: "2026-07-31", mrrUsd: 4080 }, // month-end point for July
  { date: "2026-08-31", mrrUsd: 5100 }, // month-end point for August
];

const STATED: StatedAmountRow[] = [
  {
    id: "row-big",
    orgId: AGENCY_ORG,
    brandId: BRAND_BIG,
    amountUsd: 5000,
    startDate: "2026-08-01",
    endDate: null,
    note: "what they actually hand us",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "row-small",
    orgId: AGENCY_ORG,
    brandId: BRAND_SMALL,
    amountUsd: 500,
    startDate: null, // in force since this brand's FIRST DAY OF BILLED SPEND
    endDate: null,
    note: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
];

const FIRST_BILLED = new Map<string, string | null>([[pairKey(AGENCY_ORG, BRAND_SMALL), "2026-07-25"]]);

function inputs(overrides: Partial<MrrSplitInputs> = {}): MrrSplitInputs {
  return {
    statedRows: STATED,
    allPairs: ALL_PAIRS.map((p) => ({ orgId: p.orgId, brandId: p.brandId })),
    budgetTimelines: TIMELINES,
    firstBilledDayByPair: FIRST_BILLED,
    snapshots: SNAPSHOTS,
    currentMrrUsd: FLEET_MRR,
    currentAgencyBudgetMrrUsd: AGENCY_BUDGET_MRR,
    ...overrides,
  };
}

const WINDOWS = { weeks: 12, months: 6 };

describe("agency / self-serve MRR split", () => {
  it("states the agency at what a human STATED, never at its budget × 30 — and the two figures DIVERGE", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);

    expect(split.currentAgencyMrrUsd).toBe(5500); // 5000 + 500, the stated amounts
    expect(split.currentAgencyBudgetMrrUsd).toBe(AGENCY_BUDGET_MRR); // 4290 — what left the self-serve half
    // The whole point: the agency's worth is NOT its budget projection.
    expect(split.currentAgencyMrrUsd).not.toBe(split.currentAgencyBudgetMrrUsd);
  });

  it("drops the self-serve half by EXACTLY the agency's committed contribution (AC4)", () => {
    const withStated = buildMrrSplit(inputs(), NOW, WINDOWS);
    const withoutStated = buildMrrSplit(inputs({ statedRows: [], currentAgencyBudgetMrrUsd: 0 }), NOW, WINDOWS);

    expect(withoutStated.currentSelfServeMrrUsd).toBe(FLEET_MRR);
    expect(withStated.currentSelfServeMrrUsd).toBe(SELF_SERVE_MRR);
    expect(withoutStated.currentSelfServeMrrUsd - withStated.currentSelfServeMrrUsd).toBe(AGENCY_BUDGET_MRR);
  });

  it("with ZERO stated rows the self-serve figure IS the fleet committed MRR and the agency is zero (AC3)", () => {
    const split = buildMrrSplit(inputs({ statedRows: [], currentAgencyBudgetMrrUsd: 0 }), NOW, WINDOWS);

    expect(split.currentAgencyMrrUsd).toBe(0);
    expect(split.currentSelfServeMrrUsd).toBe(FLEET_MRR);
    expect(split.currentTotalMrrUsd).toBe(FLEET_MRR);
    expect(split.agencyOrgIds).toEqual([]);
    expect(split.agencyPairKeys).toEqual([]);
    // Every historical point is the recorded committed figure, untouched.
    for (const b of split.monthly) {
      expect(b.selfServeMrrUsd).toBe(b.committedMrrUsd);
      expect(b.agencyMrrUsd).toBe(0);
    }
  });

  it("the two halves add to the total in EVERY period, live and historical (AC2)", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);

    expect(split.currentAgencyMrrUsd + split.currentSelfServeMrrUsd).toBe(split.currentTotalMrrUsd);
    expect(split.monthly.length).toBeGreaterThan(0);
    expect(split.weekly.length).toBeGreaterThan(0);
    for (const b of [...split.monthly, ...split.weekly]) {
      expect(b.agencyMrrUsd + b.selfServeMrrUsd).toBeCloseTo(b.totalMrrUsd, 2);
      expect(b.selfServeMrrUsd + b.agencyBudgetMrrUsd).toBeCloseTo(b.committedMrrUsd, 2);
      expect(b.agencyArrUsd).toBeCloseTo(b.agencyMrrUsd * 12, 2);
      expect(b.totalArrUsd).toBeCloseTo(b.totalMrrUsd * 12, 2);
    }
  });

  it("reaches back to the first recorded snapshot day and REPLAYS the agency budget there (AC5)", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);

    const july = split.monthly.find((b) => b.period === "2026-07");
    expect(july).toBeDefined();
    // July's point is the 2026-07-31 snapshot; on that day the agency ran $35 + $1 = $36/day.
    expect(july!.referenceDate).toBe("2026-07-31");
    expect(july!.committedMrrUsd).toBe(4080);
    expect(july!.agencyBudgetMrrUsd).toBe(36 * 30);
    expect(july!.selfServeMrrUsd).toBe(4080 - 36 * 30);
    // The big brand's stated amount only starts 2026-08-01, so July carries the small brand's alone.
    expect(july!.agencyMrrUsd).toBe(500);

    const august = split.monthly.find((b) => b.period === "2026-08");
    expect(august!.referenceDate).toBe("2026-08-31");
    expect(august!.agencyBudgetMrrUsd).toBe(51 * 30); // $50 + $1
    expect(august!.agencyMrrUsd).toBe(5500); // both stated amounts now in force
    // The replayed self-serve half DIVERGES from the undivided committed figure it came from.
    expect(august!.selfServeMrrUsd).not.toBe(august!.committedMrrUsd);
  });

  it("omits a period with no recorded snapshot rather than fabricating a point", () => {
    const split = buildMrrSplit(inputs({ snapshots: [{ date: "2026-08-31", mrrUsd: 5100 }] }), NOW, WINDOWS);
    expect(split.monthly.map((b) => b.period)).toEqual(["2026-08", "2026-09"]);
  });

  it("derives the agency orgs from the stated rows and excludes the org's WHOLE brand set", () => {
    const split = buildMrrSplit(inputs(), NOW, WINDOWS);

    expect(split.agencyOrgIds).toEqual([AGENCY_ORG]);
    // BRAND_IDLE carries no stated amount and is still excluded from the self-serve half — agency money
    // is agency money whether or not anyone has got round to stating it.
    expect(split.agencyPairKeys).toEqual([
      pairKey(AGENCY_ORG, BRAND_BIG),
      pairKey(AGENCY_ORG, BRAND_IDLE),
      pairKey(AGENCY_ORG, BRAND_SMALL),
    ]);
    expect(split.agencyPairKeys).not.toContain(pairKey(SAAS_ORG_A, BRAND_SAAS_A));
  });

  it("makes an UNSTATED agency brand visible instead of silent", () => {
    // The agency funds a third brand at $10/day that nobody has stated an amount for: its budget leaves
    // the self-serve half, so the total sits BELOW the committed figure by exactly that amount.
    const pairs = ALL_PAIRS.map((p) => (p.brandId === BRAND_IDLE ? { ...p, runningDailyBudgetUsd: 10, active: true } : p));
    const split = buildMrrSplit(
      inputs({
        allPairs: pairs.map((p) => ({ orgId: p.orgId, brandId: p.brandId })),
        currentMrrUsd: FLEET_MRR + 10 * 30,
        currentAgencyBudgetMrrUsd: AGENCY_BUDGET_MRR + 10 * 30,
      }),
      NOW,
      WINDOWS,
    );

    const stated = buildMrrSplit(inputs(), NOW, WINDOWS);
    // Its $300/month of budget is in NEITHER half — and the difference between what the agency side
    // CONTRIBUTED and what anybody STATED is exactly that, readable straight off the two fields.
    expect(split.currentAgencyBudgetMrrUsd - stated.currentAgencyBudgetMrrUsd).toBe(10 * 30);
    expect(split.currentAgencyMrrUsd).toBe(stated.currentAgencyMrrUsd);
    expect(split.currentSelfServeMrrUsd).toBe(SELF_SERVE_MRR);
    expect(split.currentTotalMrrUsd).toBe(5500 + SELF_SERVE_MRR);
  });
});

describe("a stated amount's date range", () => {
  it("with NO start is in force from the brand's first BILLED day, not before it (AC6)", () => {
    const row = STATED[1]; // startDate null, first billed 2026-07-25
    expect(statedAmountInForce(row, "2026-07-24", "2026-07-25")).toBe(false);
    expect(statedAmountInForce(row, "2026-07-25", "2026-07-25")).toBe(true);
    expect(statedAmountInForce(row, "2026-09-12", "2026-07-25")).toBe(true);
  });

  it("with no start and a brand that has NEVER billed carries no lower bound", () => {
    expect(statedAmountInForce(STATED[1], "2020-01-01", null)).toBe(true);
  });

  it("is inclusive at both ends and closed by an endDate", () => {
    const row: StatedAmountRow = { ...STATED[0], startDate: "2026-08-01", endDate: "2026-08-31" };
    expect(statedAmountInForce(row, "2026-07-31", null)).toBe(false);
    expect(statedAmountInForce(row, "2026-08-01", null)).toBe(true);
    expect(statedAmountInForce(row, "2026-08-31", null)).toBe(true);
    expect(statedAmountInForce(row, "2026-09-01", null)).toBe(false);
  });

  it("with no end is still running today", () => {
    expect(agencyStatedMrrOn(STATED, TODAY, FIRST_BILLED)).toBe(5500);
  });
});

describe("replaying a daily budget from billing's timeline", () => {
  const timeline = TIMELINES.get(pairKey(AGENCY_ORG, BRAND_BIG))!;

  it("answers the value carried by the last change on or before the day", () => {
    expect(budgetUsdOn(timeline, "2026-07-28")).toBe(35);
    expect(budgetUsdOn(timeline, "2026-08-09")).toBe(35);
    expect(budgetUsdOn(timeline, "2026-08-10")).toBe(50);
    expect(budgetUsdOn(timeline, "2026-09-12")).toBe(142);
  });

  it("answers 0 for a day BEFORE the first entry — we hold no record of a budget then", () => {
    expect(budgetUsdOn(timeline, "2026-07-15")).toBe(0);
    expect(budgetUsdOn([], "2026-09-12")).toBe(0);
  });

  it("takes the day's FINAL value when several changes land on one day", () => {
    const sameDay = [
      { dailyBudgetUsd: 210, changedAt: "2026-08-30T08:00:00Z" },
      { dailyBudgetUsd: 150, changedAt: "2026-08-30T18:00:00Z" },
    ];
    expect(budgetUsdOn(sameDay, "2026-08-30")).toBe(150);
  });

  it("sums only the agency pairs", () => {
    const keys = agencyPairKeysOf(STATED, ALL_PAIRS.map((p) => ({ orgId: p.orgId, brandId: p.brandId })));
    expect(agencyBudgetMrrOn(keys, TIMELINES, "2026-09-12")).toBe(143 * 30);
  });
});

describe("deriving the agency side", () => {
  it("is any org carrying at least one stated amount, whatever its date range", () => {
    expect(agencyOrgIdsOf(STATED)).toEqual([AGENCY_ORG]);
    expect(agencyOrgIdsOf([{ ...STATED[0], orgId: "z" }, { ...STATED[1], orgId: "a" }])).toEqual(["a", "z"]);
  });

  it("keeps a stated pair even when the membership read has not caught up to it", () => {
    expect(agencyPairKeysOf(STATED, [])).toEqual([pairKey(AGENCY_ORG, BRAND_BIG), pairKey(AGENCY_ORG, BRAND_SMALL)]);
  });
});
