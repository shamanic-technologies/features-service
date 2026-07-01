import { describe, it, expect } from "vitest";

// accounts-compute imports pipeline-activity (for the reused daily-budget client), which transitively
// pulls in the db module — stub it so importing this pure-logic module doesn't need a DB connection.
// All reads are injected, so the real db / clients are never touched.
import { vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildAccountsAudit, isActive, type AccountsDeps } from "./accounts-compute.js";
import type { OrgIdentity, BrandBasic } from "./accounts-client.js";

const NOW = new Date("2026-07-01T12:00:00Z");
const COLD = "sales-cold-email-outreach,pr-cold-email-outreach";

function deps(fixture: {
  memberships: Array<{ orgId: string; brandId: string }>;
  balanceUsd: Record<string, number>;
  identity?: Record<string, OrgIdentity>;
  budgetUsd: Record<string, number | null>; // keyed by brandId
  brands?: Record<string, BrandBasic>;
}): AccountsDeps {
  return {
    featureMemberships: async () => fixture.memberships,
    orgBalanceUsd: async (orgId) => fixture.balanceUsd[orgId] ?? 0,
    orgIdentity: async (orgId) => fixture.identity?.[orgId] ?? { orgExternalId: null, ownerEmail: null },
    brandDailyBudgetUsd: async (brandId) => fixture.budgetUsd[brandId] ?? null,
    brandsBasic: async (ids) => new Map(ids.map((id) => [id, fixture.brands?.[id] ?? { name: null, domain: null }])),
  };
}

describe("isActive — the exact active rule", () => {
  it("active only when budget non-null, positive, and balance strictly exceeds it", () => {
    expect(isActive(10, 100)).toBe(true); // balance 100 > budget 10
    expect(isActive(10, 10)).toBe(false); // balance == budget → cannot cover next day
    expect(isActive(10, 9)).toBe(false); // balance < budget
    expect(isActive(0, 100)).toBe(false); // $0 budget → paused
    expect(isActive(null, 100)).toBe(false); // no budget
    expect(isActive(-5, 100)).toBe(false); // negative budget guarded by > 0
  });
});

describe("buildAccountsAudit", () => {
  it("builds a row per (org,brand) with money + status, stats sum ACTIVE only, mrr=×30 arr=×365", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b1" }, // active: budget 10, balance 100
        { orgId: "o1", brandId: "b2" }, // inactive: budget 0
        { orgId: "o2", brandId: "b3" }, // inactive: balance 5 <= budget 5
        { orgId: "o3", brandId: "b4" }, // inactive: budget null
        { orgId: "o4", brandId: "b5" }, // active: budget 20, balance 21
      ],
      balanceUsd: { o1: 100, o2: 5, o3: 0, o4: 21 },
      budgetUsd: { b1: 10, b2: 0, b3: 5, b4: null, b5: 20 },
      identity: { o1: { orgExternalId: "org_1", ownerEmail: "a@x.com" } },
      brands: { b1: { name: "Brand One", domain: "one.com" } },
    });

    const r = await buildAccountsAudit(COLD, NOW, d);

    expect(r.rows).toHaveLength(5);
    expect(r.asOf).toBe("2026-07-01T12:00:00.000Z");

    const byBrand = Object.fromEntries(r.rows.map((row) => [row.brandId, row]));
    expect(byBrand.b1.status).toBe("active");
    expect(byBrand.b2.status).toBe("inactive"); // $0 budget
    expect(byBrand.b3.status).toBe("inactive"); // balance == budget
    expect(byBrand.b4.status).toBe("inactive"); // null budget
    expect(byBrand.b5.status).toBe("active");

    // Row field passthrough.
    expect(byBrand.b1.orgExternalId).toBe("org_1");
    expect(byBrand.b1.ownerEmail).toBe("a@x.com");
    expect(byBrand.b1.brandName).toBe("Brand One");
    expect(byBrand.b1.brandDomain).toBe("one.com");
    expect(byBrand.b1.orgBalanceUsd).toBe(100);
    expect(byBrand.b1.dailyBudgetUsd).toBe(10);
    // Missing identity / brand info → null, still listed.
    expect(byBrand.b3.orgExternalId).toBeNull();
    expect(byBrand.b3.brandName).toBeNull();

    // Stats: active budgets 10 + 20 = 30.
    expect(r.stats.totalDailyBudgetUsd).toBe(30);
    expect(r.stats.mrrUsd).toBe(900);
    expect(r.stats.arrUsd).toBe(30 * 365);
    expect(r.stats.activeCount).toBe(2);
    expect(r.stats.inactiveCount).toBe(3);
    expect(r.stats.totalCount).toBe(5);
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
      inactiveCount: 0,
      totalCount: 0,
    });
  });

  it("sorts active rows first, then by daily budget desc", async () => {
    const d = deps({
      memberships: [
        { orgId: "o1", brandId: "b_small" }, // active budget 5
        { orgId: "o2", brandId: "b_big" }, // active budget 50
        { orgId: "o3", brandId: "b_off" }, // inactive
      ],
      balanceUsd: { o1: 100, o2: 100, o3: 100 },
      budgetUsd: { b_small: 5, b_big: 50, b_off: 0 },
    });
    const r = await buildAccountsAudit(COLD, NOW, d);
    expect(r.rows.map((row) => row.brandId)).toEqual(["b_big", "b_small", "b_off"]);
  });
});
