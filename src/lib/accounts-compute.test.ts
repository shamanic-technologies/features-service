import { describe, it, expect } from "vitest";

// accounts-compute imports pipeline-activity (for the reused daily-budget client), which transitively
// pulls in the db module — stub it so importing this pure-logic module doesn't need a DB connection.
// All reads are injected, so the real db / clients are never touched.
import { vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildAccountsAudit, accountStatus, type AccountsDeps } from "./accounts-compute.js";
import type { OrgIdentity, BrandBasic } from "./accounts-client.js";

const NOW = new Date("2026-07-01T12:00:00Z");
const COLD = "sales-cold-email-outreach,pr-cold-email-outreach";

function deps(fixture: {
  memberships: Array<{ orgId: string; brandId: string }>;
  // ACTUAL balance per org — the figure the active verdict gates on.
  balanceUsd: Record<string, number>;
  // Optional SPENDABLE balance per org (display); defaults to the actual balance when unset.
  spendableUsd?: Record<string, number>;
  // Optional auto-topup flag per org; defaults to false.
  autoTopup?: Record<string, boolean>;
  identity?: Record<string, OrgIdentity>;
  // Optional per-org usage-discount percent (0..100); accepted in fixtures to PROVE it never affects the
  // daily budget (a config ceiling, not a charge), but the audit no longer reads it.
  discountPct?: Record<string, number>;
  budgetUsd: Record<string, number | null>; // keyed by brandId
  paused?: Record<string, boolean>; // keyed by brandId
  brands?: Record<string, BrandBasic>;
}): AccountsDeps {
  return {
    featureMemberships: async () => fixture.memberships,
    orgBalance: async (orgId) => ({
      spendableUsd: fixture.spendableUsd?.[orgId] ?? fixture.balanceUsd[orgId] ?? 0,
      actualUsd: fixture.balanceUsd[orgId] ?? 0,
      autoTopupEnabled: fixture.autoTopup?.[orgId] ?? false,
    }),
    orgIdentity: async (orgId) => fixture.identity?.[orgId] ?? { orgExternalId: null, ownerEmail: null },
    brandDailyBudgetUsd: async (brandId) => fixture.budgetUsd[brandId] ?? null,
    brandPaused: async (brandId) => fixture.paused?.[brandId] ?? false,
    brandsBasic: async (ids) => new Map(ids.map((id) => [id, fixture.brands?.[id] ?? { name: null, domain: null }])),
  };
}

// accountStatus(dailyBudgetUsd, actualBalanceUsd, autoTopupEnabled, paused)
describe("accountStatus — the exact status rule (paused > active > inactive)", () => {
  it("paused wins over everything, even a funded budget or auto-topup", () => {
    expect(accountStatus(10, 100, false, true)).toBe("paused"); // would be active, but paused
    expect(accountStatus(10, 1, true, true)).toBe("paused"); // auto-topup + paused → paused
    expect(accountStatus(0, 100, false, true)).toBe("paused");
    expect(accountStatus(null, 0, false, true)).toBe("paused");
  });

  it("auto-topup enabled + budget>0 → active even when the actual balance is below one day's budget", () => {
    // The concrete failing case: distribute.you — budget 20, actual 53.17, auto-topup ON.
    expect(accountStatus(20, 53.17, true, false)).toBe("active");
    // Auto-topup covers even a near-empty balance (never runs dry).
    expect(accountStatus(20, 1, true, false)).toBe("active");
    expect(accountStatus(20, 0, true, false)).toBe("active");
  });

  it("actual balance > budget + auto-topup OFF → active", () => {
    expect(accountStatus(10, 100, false, false)).toBe("active"); // actual 100 > budget 10
    expect(accountStatus(20, 53.17, false, false)).toBe("active"); // actual 53.17 > budget 20
  });

  it("budget = 0 (or null/negative) → inactive regardless of balance or auto-topup", () => {
    expect(accountStatus(0, 100, false, false)).toBe("inactive"); // $0 budget → budget-paused
    expect(accountStatus(0, 100, true, false)).toBe("inactive"); // auto-topup does not rescue a 0 budget
    expect(accountStatus(null, 100, true, false)).toBe("inactive"); // no budget
    expect(accountStatus(-5, 100, true, false)).toBe("inactive"); // negative budget guarded by > 0
  });

  it("actual balance <= budget AND auto-topup OFF → inactive", () => {
    expect(accountStatus(10, 10, false, false)).toBe("inactive"); // actual == budget → cannot cover next day
    expect(accountStatus(10, 9, false, false)).toBe("inactive"); // actual < budget
  });
});

describe("buildAccountsAudit", () => {
  it("builds a row per (org,brand) with money + 3-way status, stats sum ACTIVE only, mrr=×30 arr=×365", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b1" }, // active: budget 10, balance 100
        { orgId: "o1", brandId: "b2" }, // inactive: budget 0
        { orgId: "o2", brandId: "b3" }, // inactive: balance 5 <= budget 5
        { orgId: "o3", brandId: "b4" }, // inactive: budget null
        { orgId: "o4", brandId: "b5" }, // active: budget 20, balance 21
        { orgId: "o5", brandId: "b6" }, // PAUSED: budget 40, balance 100, but paused
      ],
      balanceUsd: { o1: 100, o2: 5, o3: 0, o4: 21, o5: 100 },
      budgetUsd: { b1: 10, b2: 0, b3: 5, b4: null, b5: 20, b6: 40 },
      paused: { b6: true },
      identity: { o1: { orgExternalId: "org_1", ownerEmail: "a@x.com" } },
      brands: { b1: { name: "Brand One", domain: "one.com" } },
    });

    const r = await buildAccountsAudit(COLD, NOW, d);

    expect(r.rows).toHaveLength(6);
    expect(r.asOf).toBe("2026-07-01T12:00:00.000Z");

    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));
    expect(byBrand.b1.status).toBe("active");
    expect(byBrand.b2.status).toBe("inactive"); // $0 budget
    expect(byBrand.b3.status).toBe("inactive"); // balance == budget
    expect(byBrand.b4.status).toBe("inactive"); // null budget
    expect(byBrand.b5.status).toBe("active");
    expect(byBrand.b6.status).toBe("paused"); // funded but paused → paused

    // Row field passthrough.
    expect(byBrand.b1.orgExternalId).toBe("org_1");
    expect(byBrand.b1.ownerEmail).toBe("a@x.com");
    expect(byBrand.b1.brandName).toBe("Brand One");
    expect(byBrand.b1.brandDomain).toBe("one.com");
    expect(byBrand.b1.orgBalanceUsd).toBe(100);
    expect(byBrand.b1.orgActualBalanceUsd).toBe(100);
    expect(byBrand.b1.autoTopupEnabled).toBe(false);
    expect(byBrand.b1.dailyBudgetUsd).toBe(10);
    expect(byBrand.b5.dailyBudgetUsd).toBe(20);
    // Missing identity / brand info → null, still listed.
    expect(byBrand.b3.orgExternalId).toBeNull();
    expect(byBrand.b3.brandName).toBeNull();

    // Stats: active budgets 10 + 20 = 30 (paused b6's 40 is NOT counted).
    expect(r.stats.totalDailyBudgetUsd).toBe(30);
    expect(r.stats.mrrUsd).toBe(900);
    expect(r.stats.arrUsd).toBe(30 * 365);
    expect(r.stats.activeCount).toBe(2);
    expect(r.stats.pausedCount).toBe(1);
    expect(r.stats.inactiveCount).toBe(3);
    expect(r.stats.totalCount).toBe(6);
  });

  it("flips an auto-topup account with low spendable balance to ACTIVE (the distribute.you case)", async () => {
    // distribute.you: budget 20, spendable 13.97 (< budget), actual 53.17, auto-topup ON.
    // Old spendable-only rule → inactive; new rule (auto-topup OR actual>budget) → active.
    const d = deps({
      memberships: [
        { orgId: "o_dy", brandId: "b_dy" }, // auto-topup ON, spendable < budget
        { orgId: "o_actual", brandId: "b_actual" }, // auto-topup OFF, spendable < budget but actual > budget
        { orgId: "o_dry", brandId: "b_dry" }, // auto-topup OFF, actual <= budget → inactive
      ],
      balanceUsd: { o_dy: 53.17, o_actual: 25, o_dry: 5 }, // ACTUAL balances
      spendableUsd: { o_dy: 13.97, o_actual: 8, o_dry: 5 }, // spendable (holds subtracted)
      autoTopup: { o_dy: true },
      budgetUsd: { b_dy: 20, b_actual: 20, b_dry: 20 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));

    expect(byBrand.b_dy.status).toBe("active"); // auto-topup rescues the low spendable balance
    expect(byBrand.b_dy.orgBalanceUsd).toBe(13.97); // spendable (display)
    expect(byBrand.b_dy.orgActualBalanceUsd).toBe(53.17); // actual (verdict basis)
    expect(byBrand.b_dy.autoTopupEnabled).toBe(true);

    expect(byBrand.b_actual.status).toBe("active"); // actual 25 > budget 20 despite spendable 8 < budget
    expect(byBrand.b_dry.status).toBe("inactive"); // actual 5 <= budget 20, no auto-topup

    // Fleet stats count only the two active budgets (20 + 20 = 40); the dry account is excluded.
    expect(r.stats.totalDailyBudgetUsd).toBe(40);
    expect(r.stats.activeCount).toBe(2);
    expect(r.stats.inactiveCount).toBe(1);
    expect(r.stats.mrrUsd).toBe(1200);
  });

  it("dedupes (org,brand) pairs that appear under multiple workflows/features", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b1" },
        { orgId: "o1", brandId: "b1" }, // duplicate (e.g. two workflows for the same account)
      ],
      balanceUsd: { o1: 100 },
      budgetUsd: { b1: 10 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    expect(r.rows).toHaveLength(1);
    expect(r.stats.totalCount).toBe(1);
    expect(r.stats.activeCount).toBe(1);
  });

  it("shares the org balance across an org's brands (per-org read, per-brand budget)", async () => {
    const d = deps({
      // Balance 15 covers b1 (budget 10) but not b2 (budget 20).
      memberships: [
        { orgId: "o1", brandId: "b1" },
        { orgId: "o1", brandId: "b2" },
      ],
      balanceUsd: { o1: 15 },
      budgetUsd: { b1: 10, b2: 20 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));
    expect(byBrand.b1.status).toBe("active");
    expect(byBrand.b2.status).toBe("inactive");
    expect(byBrand.b1.orgBalanceUsd).toBe(15);
    expect(byBrand.b2.orgBalanceUsd).toBe(15);
    expect(r.stats.totalDailyBudgetUsd).toBe(10);
  });

  it("empty cold-email slug set → empty audit with zeroed stats", async () => {
    const d = deps({ memberships: [], balanceUsd: {}, budgetUsd: {} });
    const r = await buildAccountsAudit("", NOW, d);
    expect(r.rows).toHaveLength(0);
    expect(r.stats).toEqual({
      totalDailyBudgetUsd: 0,
      mrrUsd: 0,
      arrUsd: 0,
      activeCount: 0,
      pausedCount: 0,
      inactiveCount: 0,
      totalCount: 0,
    });
  });

  it("the per-org usage discount is NEVER applied to the daily budget (config ceiling, not a charge)", async () => {
    // Two orgs, SAME configured budget 20, DIFFERENT discounts (25% vs 0%). The daily budget is a config
    // value, not a charge — the discount must not reduce it, so both rows show 20 identically.
    const d = deps({
      memberships: [
        { orgId: "o_disc", brandId: "b_disc" }, // 25% discount, budget 20 → still 20
        { orgId: "o_full", brandId: "b_full" }, // no discount, budget 20 → 20
      ],
      balanceUsd: { o_disc: 1000, o_full: 1000 },
      budgetUsd: { b_disc: 20, b_full: 20 },
      discountPct: { o_disc: 25 }, // present in the fixture but must have NO effect on the budget
    });

    const r = await buildAccountsAudit(COLD, NOW, d);
    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));

    // Same configured budget → same displayed budget regardless of discount.
    expect(byBrand.b_disc.dailyBudgetUsd).toBe(20);
    expect(byBrand.b_full.dailyBudgetUsd).toBe(20);
    expect(byBrand.b_disc.status).toBe("active");

    // Fleet total is the undiscounted budget projection: 20 + 20 = 40.
    expect(r.stats.totalDailyBudgetUsd).toBe(40);
    expect(r.stats.mrrUsd).toBe(40 * 30);
    expect(r.stats.arrUsd).toBe(40 * 365);
    expect(r.stats.activeCount).toBe(2);
  });

  it("the active verdict gates on the raw budget vs the actual balance — budget 20 >= balance 18 → inactive", async () => {
    const d = deps({
      memberships: [{ orgId: "o1", brandId: "b1" }],
      balanceUsd: { o1: 18 },
      budgetUsd: { b1: 20 },
      discountPct: { o1: 50 }, // no effect on budget or verdict
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    const row = r.rows[0];
    expect(row.dailyBudgetUsd).toBe(20); // undiscounted config budget
    expect(row.status).toBe("inactive"); // budget 20 >= balance 18 → inactive
    expect(r.stats.totalDailyBudgetUsd).toBe(0); // no active rows
    expect(r.stats.activeCount).toBe(0);
  });

  it("sorts active → paused → inactive, then by daily budget desc", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b_small" }, // active budget 5
        { orgId: "o2", brandId: "b_big" }, // active budget 50
        { orgId: "o3", brandId: "b_off" }, // inactive
        { orgId: "o4", brandId: "b_paused" }, // paused (funded)
      ],
      balanceUsd: { o1: 100, o2: 100, o3: 100, o4: 100 },
      budgetUsd: { b_small: 5, b_big: 50, b_off: 0, b_paused: 30 },
      paused: { b_paused: true },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    expect(r.rows.map((row) => row.brandId)).toEqual(["b_big", "b_small", "b_paused", "b_off"]);
  });
});
