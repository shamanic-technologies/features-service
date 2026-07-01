import { describe, it, expect, vi } from "vitest";

// aggregate imports pipeline-activity + accounts-compute (the dashboard forecast source + the shared
// active rule we reuse), which transitively pull in the db module — stub it so importing this
// pure-logic module under test doesn't require a DB connection string. All deps are injected.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { aggregateFleetNewSequences, type FleetDeps } from "./send-forecast-aggregate.js";

const NOW = new Date("2026-07-01T12:00:00Z");
const COLD = ["sales-cold-email-outreach", "pr-cold-email-outreach"];

/** Build a deps stub from plain fixture maps. Default org balance is huge (active) unless overridden. */
function deps(fixture: {
  outreachUsd: Record<string, number | null>;
  memberships: Record<string, Array<{ orgId: string; brandId: string }>>;
  budgetUsd: Record<string, number | null>;
  balanceUsd?: Record<string, number>;
  paused?: Record<string, boolean>;
  spentTodayUsd?: Record<string, number>;
}): FleetDeps {
  return {
    featureOutreachUsd: async (slug) => fixture.outreachUsd[slug] ?? null,
    featureMemberships: async (slug) => fixture.memberships[slug] ?? [],
    brandDailyBudgetUsd: async (brandId) => fixture.budgetUsd[brandId] ?? null,
    orgBalanceUsd: async (orgId) => fixture.balanceUsd?.[orgId] ?? 1_000_000,
    brandPaused: async (brandId) => fixture.paused?.[brandId] ?? false,
    brandSpentTodayUsd: async (brandId) => fixture.spentTodayUsd?.[brandId] ?? 0,
  };
}

describe("aggregateFleetNewSequences", () => {
  it("computes R_b = budget × (1/outreachUsd) per active brand and sums the fleet", async () => {
    // outreachUsd $2 → 0.5 seq/$; brand budget $100 → 50 new sequences/day.
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 2, "pr-cold-email-outreach": 2 },
      memberships: { "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }] },
      budgetUsd: { b1: 100 },
      balanceUsd: { o1: 500 }, // > budget → active
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.totalNewPerDay).toBe(50);
    expect(r.totalDailyBudgetUsd).toBe(100);
    expect(r.activeBrandCount).toBe(1);
    expect(r.remainingTodayUsd).toBe(100);
    expect(r.todayNewOverride).toBe(50);
  });

  it("takes the CHEAPEST feature (max sequences/$) for a multi-feature brand, budget counted once", async () => {
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 4, "pr-cold-email-outreach": 2 },
      memberships: {
        "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }],
        "pr-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }],
      },
      budgetUsd: { b1: 100 },
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.totalNewPerDay).toBe(50); // 100 × 0.5, NOT 25+50
    expect(r.activeBrandCount).toBe(1);
    expect(r.totalDailyBudgetUsd).toBe(100);
  });

  it("scales today's cohort to remaining budget (budget − committed spent-today)", async () => {
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 2 },
      memberships: { "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }] },
      budgetUsd: { b1: 100 },
      spentTodayUsd: { b1: 60 }, // $60 spent → $40 remaining → 40%
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.totalNewPerDay).toBe(50);
    expect(r.remainingTodayUsd).toBe(40);
    expect(r.todayNewOverride).toBeCloseTo(20);
  });

  describe("ACTIVE gate (budget > 0 && orgBalance > budget) — the over-count fix", () => {
    it("excludes a brand whose org credits do NOT exceed its daily budget", async () => {
      const d = deps({
        outreachUsd: { "sales-cold-email-outreach": 2 },
        memberships: { "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }] },
        budgetUsd: { b1: 100 },
        balanceUsd: { o1: 50 }, // 50 < 100 → inactive
      });
      const r = await aggregateFleetNewSequences(COLD, NOW, d);
      expect(r.activeBrandCount).toBe(0);
      expect(r.totalNewPerDay).toBe(0);
    });

    it("excludes when balance EQUALS budget (strict >, one day of runway is not enough)", async () => {
      const d = deps({
        outreachUsd: { "sales-cold-email-outreach": 2 },
        memberships: { "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }] },
        budgetUsd: { b1: 100 },
        balanceUsd: { o1: 100 }, // == budget → inactive
      });
      const r = await aggregateFleetNewSequences(COLD, NOW, d);
      expect(r.activeBrandCount).toBe(0);
    });

    it("counts only the funded brand when two share the fleet", async () => {
      const d = deps({
        outreachUsd: { "sales-cold-email-outreach": 2 },
        memberships: {
          "sales-cold-email-outreach": [
            { orgId: "o1", brandId: "b1" }, // funded
            { orgId: "o2", brandId: "b2" }, // broke
          ],
        },
        budgetUsd: { b1: 100, b2: 100 },
        balanceUsd: { o1: 500, o2: 0 },
      });
      const r = await aggregateFleetNewSequences(COLD, NOW, d);
      expect(r.activeBrandCount).toBe(1);
      expect(r.totalNewPerDay).toBe(50);
      expect(r.totalDailyBudgetUsd).toBe(100);
    });

    it("excludes a PAUSED brand even with budget>0 and sufficient balance", async () => {
      const d = deps({
        outreachUsd: { "sales-cold-email-outreach": 2 },
        memberships: { "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }] },
        budgetUsd: { b1: 100 },
        balanceUsd: { o1: 500 }, // funded...
        paused: { b1: true }, // ...but paused → excluded
      });
      const r = await aggregateFleetNewSequences(COLD, NOW, d);
      expect(r.activeBrandCount).toBe(0);
      expect(r.totalNewPerDay).toBe(0);
    });

    it("excludes $0 / null budget brands (unset / budget-paused)", async () => {
      const d = deps({
        outreachUsd: { "sales-cold-email-outreach": 2 },
        memberships: {
          "sales-cold-email-outreach": [
            { orgId: "o1", brandId: "b1" }, // budget 0 (paused)
            { orgId: "o2", brandId: "b2" }, // budget null (unset)
          ],
        },
        budgetUsd: { b1: 0, b2: null },
        balanceUsd: { o1: 500, o2: 500 },
      });
      const r = await aggregateFleetNewSequences(COLD, NOW, d);
      expect(r.activeBrandCount).toBe(0);
    });
  });

  it("skips brands whose features have no usable cost", async () => {
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 2, "pr-cold-email-outreach": null },
      memberships: {
        "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }],
        "pr-cold-email-outreach": [{ orgId: "o2", brandId: "b2" }], // only pr (null cost) → skipped
      },
      budgetUsd: { b1: 100, b2: 100 },
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.activeBrandCount).toBe(1);
    expect(r.totalNewPerDay).toBe(50);
  });

  it("dedups the same brand appearing under multiple features (one budget, one count)", async () => {
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 2, "pr-cold-email-outreach": 2 },
      memberships: {
        "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }],
        "pr-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }],
      },
      budgetUsd: { b1: 100 },
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.activeBrandCount).toBe(1);
    expect(r.totalDailyBudgetUsd).toBe(100);
  });

  it("returns all-zero for an empty fleet", async () => {
    const r = await aggregateFleetNewSequences(COLD, NOW, deps({ outreachUsd: {}, memberships: {}, budgetUsd: {} }));
    expect(r).toEqual({ totalNewPerDay: 0, todayNewOverride: 0, totalDailyBudgetUsd: 0, remainingTodayUsd: 0, activeBrandCount: 0 });
  });

  it("fetches org balance ONCE per org, not once per brand", async () => {
    const balanceCalls: string[] = [];
    const d: FleetDeps = {
      featureOutreachUsd: async () => 2,
      featureMemberships: async (slug) =>
        slug === "sales-cold-email-outreach"
          ? [
              { orgId: "o1", brandId: "b1" },
              { orgId: "o1", brandId: "b2" }, // same org, two brands
            ]
          : [],
      brandDailyBudgetUsd: async () => 100,
      orgBalanceUsd: async (orgId) => {
        balanceCalls.push(orgId);
        return 500;
      },
      brandPaused: async () => false,
      brandSpentTodayUsd: async () => 0,
    };
    await aggregateFleetNewSequences(COLD, NOW, d);
    expect(balanceCalls).toEqual(["o1"]); // one call for the shared org
  });
});
