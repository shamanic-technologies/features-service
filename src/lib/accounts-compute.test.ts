import { describe, it, expect } from "vitest";

// accounts-compute pulls in the client module, which transitively reaches the db module — stub it so
// importing this pure-logic module doesn't need a DB connection. All reads are injected, so the real
// db / clients are never touched.
import { vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildAccountsAudit, accountStatus, type AccountsDeps } from "./accounts-compute.js";
import { spendableKey, type OrgIdentity, type BrandBasic, type BrandSpendableBudget } from "./accounts-client.js";

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
  // Optional per-org usage-discount percent (0..100); accepted in fixtures to PROVE it never affects a
  // daily budget (a config ceiling, not a charge), but the audit no longer reads it.
  discountPct?: Record<string, number>;
  // Configured ceilings per brandId — what the customer set.
  configuredUsd: Record<string, number>;
  // Running ceilings per brandId — the part behind an ongoing campaign. Defaults to the configured one,
  // i.e. "everything this brand funded is actually running".
  runningUsd?: Record<string, number>;
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
    spendableBudgets: async (pairs) => {
      const out = new Map<string, BrandSpendableBudget>();
      for (const p of pairs) {
        const configuredUsd = fixture.configuredUsd[p.brandId] ?? 0;
        out.set(spendableKey(p.orgId, p.brandId), {
          configuredUsd,
          runningUsd: fixture.runningUsd?.[p.brandId] ?? configuredUsd,
        });
      }
      return out;
    },
    brandsBasic: async (ids) => new Map(ids.map((id) => [id, fixture.brands?.[id] ?? { name: null, domain: null }])),
  };
}

// accountStatus(configuredDailyBudgetUsd, runningDailyBudgetUsd, actualBalanceUsd, autoTopupEnabled)
describe("accountStatus — the exact status rule (active > paused > inactive)", () => {
  it("money posted with NOTHING running is paused, however well funded the org is", () => {
    // The production shape this rule exists for: a brand funds a funnel whose campaign is stopped, or
    // was never created at all. It cannot spend a cent, so it is not an active customer.
    expect(accountStatus(10, 0, 1000, false)).toBe("paused");
    expect(accountStatus(10, 0, 1000, true)).toBe("paused"); // auto-topup does not rescue it
    expect(accountStatus(15, 0, 100, false)).toBe("paused");
  });

  it("running money decides active, not the configured ceiling above it", () => {
    // A brand configured at 60 with only 50 of it running is active on the 50 — and a balance that
    // covers the running figure but not the configured one is enough.
    expect(accountStatus(60, 50, 55, false)).toBe("active");
    // The same brand read on its configured ceiling loses its active status: 55 no longer covers a
    // day, so it falls to paused — money posted that the org cannot fund.
    expect(accountStatus(60, 60, 55, false)).toBe("paused");
  });

  it("auto-topup enabled + running>0 → active even when the actual balance is below one day's budget", () => {
    // The concrete case: distribute.you — running 20, actual 53.17, auto-topup ON.
    expect(accountStatus(20, 20, 53.17, true)).toBe("active");
    // Auto-topup covers even a near-empty balance (never runs dry).
    expect(accountStatus(20, 20, 1, true)).toBe("active");
    expect(accountStatus(20, 20, 0, true)).toBe("active");
  });

  it("actual balance > running budget + auto-topup OFF → active", () => {
    expect(accountStatus(10, 10, 100, false)).toBe("active");
    expect(accountStatus(20, 20, 53.17, false)).toBe("active");
  });

  it("nothing configured and nothing running → inactive, whatever the balance", () => {
    expect(accountStatus(0, 0, 100, false)).toBe("inactive");
    expect(accountStatus(0, 0, 100, true)).toBe("inactive"); // auto-topup does not rescue a 0 budget
  });

  it("actual balance <= running budget AND auto-topup OFF → paused, not inactive: the money is posted", () => {
    expect(accountStatus(10, 10, 10, false)).toBe("paused"); // actual == budget → cannot cover next day
    expect(accountStatus(10, 10, 9, false)).toBe("paused");
  });
});

describe("buildAccountsAudit", () => {
  it("builds a row per (org,brand) with both budgets + 3-way status, stats sum ACTIVE only, mrr=×30 arr=×365", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b1" }, // active: running 10, balance 100
        { orgId: "o1", brandId: "b2" }, // inactive: nothing configured
        { orgId: "o2", brandId: "b3" }, // paused: money posted, balance 5 <= running 5
        { orgId: "o3", brandId: "b4" }, // inactive: nothing configured
        { orgId: "o4", brandId: "b5" }, // active: running 20, balance 21
        { orgId: "o5", brandId: "b6" }, // paused: configured 40, nothing running
      ],
      balanceUsd: { o1: 100, o2: 5, o3: 0, o4: 21, o5: 100 },
      configuredUsd: { b1: 10, b2: 0, b3: 5, b4: 0, b5: 20, b6: 40 },
      runningUsd: { b6: 0 },
      identity: { o1: { orgExternalId: "org_1", ownerEmail: "a@x.com" } },
      brands: { b1: { name: "Brand One", domain: "one.com" } },
    });

    const r = await buildAccountsAudit(COLD, NOW, d);

    expect(r.rows).toHaveLength(6);
    expect(r.asOf).toBe("2026-07-01T12:00:00.000Z");

    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));
    expect(byBrand.b1.status).toBe("active");
    expect(byBrand.b2.status).toBe("inactive"); // nothing configured
    expect(byBrand.b3.status).toBe("paused"); // posted, but balance == running
    expect(byBrand.b4.status).toBe("inactive");
    expect(byBrand.b5.status).toBe("active");
    expect(byBrand.b6.status).toBe("paused"); // funded, nothing running

    // Row field passthrough.
    expect(byBrand.b1.orgExternalId).toBe("org_1");
    expect(byBrand.b1.ownerEmail).toBe("a@x.com");
    expect(byBrand.b1.brandName).toBe("Brand One");
    expect(byBrand.b1.brandDomain).toBe("one.com");
    expect(byBrand.b1.orgBalanceUsd).toBe(100);
    expect(byBrand.b1.orgActualBalanceUsd).toBe(100);
    expect(byBrand.b1.autoTopupEnabled).toBe(false);
    expect(byBrand.b1.configuredDailyBudgetUsd).toBe(10);
    expect(byBrand.b1.runningDailyBudgetUsd).toBe(10);
    expect(byBrand.b6.configuredDailyBudgetUsd).toBe(40);
    expect(byBrand.b6.runningDailyBudgetUsd).toBe(0);
    // Missing identity / brand info → null, still listed.
    expect(byBrand.b3.orgExternalId).toBeNull();
    expect(byBrand.b3.brandName).toBeNull();

    // Stats: active running budgets 10 + 20 = 30 (the paused rows are NOT counted).
    expect(r.stats.totalRunningDailyBudgetUsd).toBe(30);
    expect(r.stats.totalConfiguredDailyBudgetUsd).toBe(30);
    expect(r.stats.mrrUsd).toBe(900);
    expect(r.stats.arrUsd).toBe(30 * 365);
    expect(r.stats.activeCount).toBe(2);
    expect(r.stats.pausedCount).toBe(2);
    expect(r.stats.inactiveCount).toBe(2);
    expect(r.stats.totalCount).toBe(6);
  });

  it("counts only the RUNNING part of a partly-stopped brand, and says what it configured", async () => {
    // The production case (brand 75d7e3e8): two funded funnels, $50 on the one whose campaign is
    // ongoing and $10 on the one whose campaign is stopped. Reading billing's configured total would
    // have put $60/day — $1,800 of MRR — behind a brand that can spend $50.
    const d = deps({
      memberships: [{ orgId: "o1", brandId: "b_partly" }],
      balanceUsd: { o1: 500 },
      configuredUsd: { b_partly: 60 },
      runningUsd: { b_partly: 50 },
    });

    const r = await buildAccountsAudit(COLD, NOW, d);
    const row = r.rows[0];

    expect(row.status).toBe("active");
    expect(row.configuredDailyBudgetUsd).toBe(60);
    expect(row.runningDailyBudgetUsd).toBe(50);
    expect(r.stats.totalRunningDailyBudgetUsd).toBe(50);
    expect(r.stats.totalConfiguredDailyBudgetUsd).toBe(60);
    expect(r.stats.mrrUsd).toBe(1500); // not 1800
  });

  it("a brand that spends while a stale pause flag called it paused is ACTIVE — the flag is not read", async () => {
    // Production case (brand a179bbd9): campaign ongoing, $8/day running, $56 spent the prior week,
    // and a brand-level pause flag frozen since July that used to exclude it from MRR entirely.
    const d = deps({
      memberships: [{ orgId: "o1", brandId: "b_spending" }],
      balanceUsd: { o1: 100 },
      configuredUsd: { b_spending: 8 },
    });

    const r = await buildAccountsAudit(COLD, NOW, d);
    expect(r.rows[0].status).toBe("active");
    expect(r.stats.totalRunningDailyBudgetUsd).toBe(8);
    expect(r.stats.activeCount).toBe(1);
  });

  it("flips an auto-topup account with low spendable balance to ACTIVE (the distribute.you case)", async () => {
    // distribute.you: running 20, spendable 13.97 (< budget), actual 53.17, auto-topup ON.
    // Old spendable-only rule → inactive; the rule (auto-topup OR actual>running) → active.
    const d = deps({
      memberships: [
        { orgId: "o_dy", brandId: "b_dy" }, // auto-topup ON, spendable < budget
        { orgId: "o_actual", brandId: "b_actual" }, // auto-topup OFF, spendable < budget but actual > budget
        { orgId: "o_dry", brandId: "b_dry" }, // auto-topup OFF, actual <= budget → paused (money posted)
      ],
      balanceUsd: { o_dy: 53.17, o_actual: 25, o_dry: 5 }, // ACTUAL balances
      spendableUsd: { o_dy: 13.97, o_actual: 8, o_dry: 5 }, // spendable (holds subtracted)
      autoTopup: { o_dy: true },
      configuredUsd: { b_dy: 20, b_actual: 20, b_dry: 20 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));

    expect(byBrand.b_dy.status).toBe("active"); // auto-topup rescues the low spendable balance
    expect(byBrand.b_dy.orgBalanceUsd).toBe(13.97); // spendable (display)
    expect(byBrand.b_dy.orgActualBalanceUsd).toBe(53.17); // actual (verdict basis)
    expect(byBrand.b_dy.autoTopupEnabled).toBe(true);

    expect(byBrand.b_actual.status).toBe("active"); // actual 25 > budget 20 despite spendable 8 < budget
    expect(byBrand.b_dry.status).toBe("paused"); // actual 5 <= budget 20, no auto-topup

    // Fleet stats count only the two active budgets (20 + 20 = 40); the dry account is excluded.
    expect(r.stats.totalRunningDailyBudgetUsd).toBe(40);
    expect(r.stats.activeCount).toBe(2);
    expect(r.stats.pausedCount).toBe(1);
    expect(r.stats.mrrUsd).toBe(1200);
  });

  it("dedupes (org,brand) pairs that appear under multiple workflows/features", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b1" },
        { orgId: "o1", brandId: "b1" }, // duplicate (e.g. two workflows for the same account)
      ],
      balanceUsd: { o1: 100 },
      configuredUsd: { b1: 10 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    expect(r.rows).toHaveLength(1);
    expect(r.stats.totalCount).toBe(1);
    expect(r.stats.activeCount).toBe(1);
  });

  it("shares the org balance across an org's brands (per-org read, per-brand budget)", async () => {
    const d = deps({
      // Balance 15 covers b1 (running 10) but not b2 (running 20).
      memberships: [
        { orgId: "o1", brandId: "b1" },
        { orgId: "o1", brandId: "b2" },
      ],
      balanceUsd: { o1: 15 },
      configuredUsd: { b1: 10, b2: 20 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));
    expect(byBrand.b1.status).toBe("active");
    expect(byBrand.b2.status).toBe("paused");
    expect(byBrand.b1.orgBalanceUsd).toBe(15);
    expect(byBrand.b2.orgBalanceUsd).toBe(15);
    expect(r.stats.totalRunningDailyBudgetUsd).toBe(10);
  });

  it("throws when the producer answered for no such (org, brand) — a missing figure is never a zero", async () => {
    const d: AccountsDeps = {
      ...deps({ memberships: [{ orgId: "o1", brandId: "b1" }], balanceUsd: { o1: 100 }, configuredUsd: { b1: 10 } }),
      spendableBudgets: async () => new Map(),
    };
    await expect(buildAccountsAudit(COLD, NOW, d)).rejects.toThrow(/no spendable budget for o1\/b1/);
  });

  it("empty cold-email slug set → empty audit with zeroed stats", async () => {
    const d = deps({ memberships: [], balanceUsd: {}, configuredUsd: {} });
    const r = await buildAccountsAudit("", NOW, d);
    expect(r.rows).toHaveLength(0);
    expect(r.stats).toEqual({
      totalRunningDailyBudgetUsd: 0,
      totalConfiguredDailyBudgetUsd: 0,
      mrrUsd: 0,
      arrUsd: 0,
      activeCount: 0,
      pausedCount: 0,
      inactiveCount: 0,
      totalCount: 0,
    });
  });

  it("the per-org usage discount is NEVER applied to either budget (config ceiling, not a charge)", async () => {
    // Two orgs, SAME budgets, DIFFERENT discounts (25% vs 0%). A ceiling is a config value, not a
    // charge — the discount must not reduce it, so both rows show 20 identically.
    const d = deps({
      memberships: [
        { orgId: "o_disc", brandId: "b_disc" }, // 25% discount, budget 20 → still 20
        { orgId: "o_full", brandId: "b_full" }, // no discount, budget 20 → 20
      ],
      balanceUsd: { o_disc: 1000, o_full: 1000 },
      configuredUsd: { b_disc: 20, b_full: 20 },
      discountPct: { o_disc: 25 }, // present in the fixture but must have NO effect on the budget
    });

    const r = await buildAccountsAudit(COLD, NOW, d);
    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));

    expect(byBrand.b_disc.runningDailyBudgetUsd).toBe(20);
    expect(byBrand.b_full.runningDailyBudgetUsd).toBe(20);
    expect(byBrand.b_disc.status).toBe("active");

    // Fleet total is the undiscounted budget projection: 20 + 20 = 40.
    expect(r.stats.totalRunningDailyBudgetUsd).toBe(40);
    expect(r.stats.mrrUsd).toBe(40 * 30);
    expect(r.stats.arrUsd).toBe(40 * 365);
    expect(r.stats.activeCount).toBe(2);
  });

  it("the active verdict gates on the running budget vs the actual balance — running 20 >= balance 18 → paused", async () => {
    const d = deps({
      memberships: [{ orgId: "o1", brandId: "b1" }],
      balanceUsd: { o1: 18 },
      configuredUsd: { b1: 20 },
      discountPct: { o1: 50 }, // no effect on budget or verdict
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    const row = r.rows[0];
    expect(row.runningDailyBudgetUsd).toBe(20); // undiscounted ceiling
    expect(row.status).toBe("paused"); // running 20 >= balance 18 → cannot cover a day
    expect(r.stats.totalRunningDailyBudgetUsd).toBe(0); // no active rows
    expect(r.stats.activeCount).toBe(0);
  });

  it("sorts active → paused → inactive, then by running budget desc", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b_small" }, // active running 5
        { orgId: "o2", brandId: "b_big" }, // active running 50
        { orgId: "o3", brandId: "b_off" }, // inactive: nothing configured
        { orgId: "o4", brandId: "b_paused" }, // paused: 30 configured, nothing running
      ],
      balanceUsd: { o1: 100, o2: 100, o3: 100, o4: 100 },
      configuredUsd: { b_small: 5, b_big: 50, b_off: 0, b_paused: 30 },
      runningUsd: { b_paused: 0 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    expect(r.rows.map((row) => row.brandId)).toEqual(["b_big", "b_small", "b_paused", "b_off"]);
  });
});
