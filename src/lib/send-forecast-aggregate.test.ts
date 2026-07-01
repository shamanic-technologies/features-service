import { describe, it, expect, vi } from "vitest";

// aggregate imports pipeline-activity (the dashboard forecast source we reuse), which transitively
// pulls in the db module — stub it so importing this pure-logic module under test doesn't require a
// DB connection string. All aggregation deps are injected, so the real db is never touched.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { aggregateFleetNewSequences, type FleetDeps } from "./send-forecast-aggregate.js";

const NOW = new Date("2026-07-01T12:00:00Z");
const COLD = ["sales-cold-email-outreach", "pr-cold-email-outreach"];

/** Build a deps stub from plain fixture maps. */
function deps(fixture: {
  outreachUsd: Record<string, number | null>;
  memberships: Record<string, Array<{ orgId: string; brandId: string }>>;
  budgetUsd: Record<string, number | null>;
  spentTodayUsd?: Record<string, number>;
}): FleetDeps {
  return {
    featureOutreachUsd: async (slug) => fixture.outreachUsd[slug] ?? null,
    featureMemberships: async (slug) => fixture.memberships[slug] ?? [],
    brandDailyBudgetUsd: async (brandId) => fixture.budgetUsd[brandId] ?? null,
    brandSpentTodayUsd: async (brandId) => fixture.spentTodayUsd?.[brandId] ?? 0,
  };
}

describe("aggregateFleetNewSequences", () => {
  it("computes R_b = budget × (1/outreachUsd) per brand and sums the fleet", async () => {
    // outreachUsd $2 → 0.5 seq/$; brand budget $100 → 50 new sequences/day.
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 2, "pr-cold-email-outreach": 2 },
      memberships: { "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }] },
      budgetUsd: { b1: 100 },
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.totalNewPerDay).toBe(50);
    expect(r.totalDailyBudgetUsd).toBe(100);
    expect(r.activeBrandCount).toBe(1);
    // No spend today → remaining == budget → today cohort == full.
    expect(r.remainingTodayUsd).toBe(100);
    expect(r.todayNewOverride).toBe(50);
  });

  it("takes the CHEAPEST feature (max sequences/$) for a multi-feature brand, budget counted once", async () => {
    const d = deps({
      // sales $4 → 0.25/$, pr $2 → 0.5/$ ; brand on both → uses pr (0.5).
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
    expect(r.totalDailyBudgetUsd).toBe(100); // budget counted once despite two features
  });

  it("scales today's cohort to remaining budget (budget − committed spent-today)", async () => {
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 2 },
      memberships: { "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }] },
      budgetUsd: { b1: 100 },
      spentTodayUsd: { b1: 60 }, // $60 already spent → $40 remaining → 40% factor
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.totalNewPerDay).toBe(50);
    expect(r.remainingTodayUsd).toBe(40);
    expect(r.todayNewOverride).toBeCloseTo(20); // 50 × 0.4
  });

  it("skips brands with no budget and brands whose features have no usable cost", async () => {
    const d = deps({
      outreachUsd: { "sales-cold-email-outreach": 2, "pr-cold-email-outreach": null },
      memberships: {
        "sales-cold-email-outreach": [{ orgId: "o1", brandId: "b1" }],
        "pr-cold-email-outreach": [{ orgId: "o2", brandId: "b2" }], // only pr (null cost) → skipped
      },
      budgetUsd: { b1: 100, b2: 100, b3: 0 },
    });
    const r = await aggregateFleetNewSequences(COLD, NOW, d);
    expect(r.activeBrandCount).toBe(1); // only b1
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
});
