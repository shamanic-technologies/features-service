import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * GET /internal/stats/accounts — one org's per-org read failing (2026-10-03).
 *
 * billing timed out on ONE org's payment-outlook read while the daily brief ran several fleet reads in
 * parallel; the fail-loud accounts audit threw and the whole staff answer went 500. The route now reads
 * every per-org input (payment-outlook, balance, identity) fail-soft: it answers 200 with every other org,
 * the affected rows say status "unknown" (outlook / balance) or carry null identity, and every failure is
 * NAMED in `unreadOrgReads`. Driven through the real route + real audit, only the clients are mocked.
 */

const mockFindMany = vi.fn();
vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: (...a: unknown[]) => mockFindMany(...a) } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

const failing: { outlook: string | null; balance: string | null; identity: string | null } = { outlook: null, balance: null, identity: null };

vi.mock("../lib/feature-memberships-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/feature-memberships-client.js")>()),
  fetchFeatureMemberships: async () => [
    { orgId: "ok", brandId: "b-ok", workflowSlug: "wf" },
    { orgId: "o-outlook", brandId: "b-outlook", workflowSlug: "wf" },
    { orgId: "o-balance", brandId: "b-balance", workflowSlug: "wf" },
    { orgId: "o-identity", brandId: "b-identity", workflowSlug: "wf" },
  ],
}));
vi.mock("../lib/accounts-client.js", async (orig) => {
  const real = await orig<typeof import("../lib/accounts-client.js")>();
  return {
    ...real,
    fetchOrgBalance: async (orgId: string) => {
      if (orgId === failing.balance) throw new Error("[features-service] billing-service balance failed (502): upstream timeout");
      return { spendableUsd: 900, actualUsd: 900, autoTopupEnabled: false };
    },
    fetchOrgIdentity: async (orgId: string) => {
      if (orgId === failing.identity) throw new Error("[features-service] client-service /internal/orgs failed (503)");
      return { orgExternalId: `org_${orgId}`, ownerEmail: `${orgId}@ex.com` };
    },
    fetchOrgPaymentHold: async (orgId: string) => {
      if (orgId === failing.outlook) {
        throw new Error("[features-service] billing-service /internal/accounts/by-org/:orgId/payment-outlook failed (502): TimeoutError");
      }
      return null;
    },
    fetchSpendableBudgets: async (pairs: Array<{ orgId: string; brandId: string }>) =>
      new Map(pairs.map((p) => [real.spendableKey(p.orgId, p.brandId), { configuredUsd: 40, runningUsd: 40, proactiveRunningUsd: 40, reactiveRunningUsd: 0 }])),
    fetchBrandsBasic: async (ids: string[]) => new Map(ids.map((id) => [id, { name: `Brand ${id}`, domain: `${id}.com` }])),
  };
});
vi.mock("../lib/recurring-revenue-client.js", async (orig) => ({
  ...(await orig<typeof import("../lib/recurring-revenue-client.js")>()),
  fetchFleetRecurringRevenue: async () => ({
    asOf: "2026-10-03T00:00:00.000Z",
    orgs: ["ok", "o-outlook", "o-balance", "o-identity"].map((orgId) => ({
      orgId, paymentMode: "postpaid", revenueClass: "recurring", classReason: "postpaid_chargeable_card", mrrCents: "120000", unknownReason: null,
    })),
    unreadableOrgIds: [],
  }),
}));
vi.mock("../lib/stated-monthly-amounts-store.js", async (orig) => ({
  ...(await orig<typeof import("../lib/stated-monthly-amounts-store.js")>()),
  readStatedAmountsSoft: async () => [],
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const { __resetAccountsCache } = await import("./public.js");

async function read() {
  __resetAccountsCache();
  return request(app).get("/internal/stats/accounts").set("x-api-key", "test-key");
}

describe("GET /internal/stats/accounts — one org's per-org read fails", () => {
  beforeEach(() => {
    mockFindMany.mockResolvedValue([{ slug: "sales-cold-email-outreach" }]);
    failing.outlook = failing.balance = failing.identity = null;
  });

  it("healthy read: 200, unreadOrgReads [] and nobody unknown", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.unreadOrgReads).toEqual([]);
    expect(res.body.stats.statusUnknownCount).toBe(0);
    expect(res.body.stats.activeCount).toBe(4);
  });

  it("outlook, balance and identity each failing for a different org: 200, other orgs intact, every failure named", async () => {
    failing.outlook = "o-outlook";
    failing.balance = "o-balance";
    failing.identity = "o-identity";
    const res = await read();
    expect(res.status).toBe(200);

    const row = (orgId: string) => res.body.rows.find((r: { orgId: string }) => r.orgId === orgId);
    expect(res.body.rows).toHaveLength(4);
    expect(row("ok")).toMatchObject({ status: "active", orgActualBalanceUsd: 900, ownerEmail: "ok@ex.com" });

    expect(row("o-outlook").status).toBe("unknown");
    expect(row("o-outlook").statusUnknownReason).toMatch(/payment-outlook unreadable: .*\(502\)/);
    expect(row("o-outlook").orgActualBalanceUsd).toBe(900);

    expect(row("o-balance").status).toBe("unknown"); // never a verdict on a 0 balance
    expect(row("o-balance").orgBalanceUsd).toBeNull();
    expect(row("o-balance").orgActualBalanceUsd).toBeNull();
    expect(row("o-balance").autoTopupEnabled).toBeNull();
    expect(row("o-balance").statusUnknownReason).toMatch(/billing balance unreadable/);

    expect(row("o-identity").status).toBe("active"); // identity does not decide the verdict
    expect(row("o-identity").ownerEmail).toBeNull();
    expect(row("o-identity").orgExternalId).toBeNull();

    expect(res.body.unreadOrgReads.map((u: { orgId: string; read: string }) => `${u.orgId}:${u.read}`)).toEqual([
      "o-balance:balance",
      "o-identity:identity",
      "o-outlook:payment_outlook",
    ]);
    expect(res.body.stats).toMatchObject({ activeCount: 2, statusUnknownCount: 2, totalCount: 4, totalRunningDailyBudgetUsd: 80 });
    // billing's MRR is its own fleet read: nobody dropped.
    expect(res.body.stats.mrrUsd).toBe(4800);
  });
});
