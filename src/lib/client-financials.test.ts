import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("./fleet-cell-store.js", () => ({
  loadFleetCell: vi.fn(async () => null),
  storeFleetCell: vi.fn(async () => undefined),
  claimFleetCellBuild: vi.fn(async () => true),
}));

import { clientFinancialRowOf, clientFinancialTotalsOf, statedAmountAccruedCents, type FinancialOrgIdentity, type FinancialOrgLedger } from "./client-financials.js";
import { buildClientFinancials, type ClientFinancialsDeps } from "./client-financials-io.js";

const identity = (orgId: string, over: Partial<FinancialOrgIdentity> = {}): FinancialOrgIdentity => ({
  orgId,
  orgName: orgId,
  customerStatus: "current",
  ownOrg: false,
  ownOrgReason: null,
  orgDeleted: false,
  cardFeesCents: "0",
  cardFeesOtherCurrencies: [],
  ...over,
});

const ledger = (over: Partial<FinancialOrgLedger> = {}): FinancialOrgLedger => ({
  billedCostInUsdCents: "0",
  netBilledCostInUsdCents: "0",
  vendorCostInUsdCents: "0",
  unpricedBilledCostInUsdCents: "0",
  refundedCostInUsdCents: "0",
  vendorRefundedCostInUsdCents: "0",
  unpricedRefundedCostInUsdCents: "0",
  ...over,
});

describe("clientFinancialRowOf", () => {
  it("revenue is the cash-funded part of what billing charged; cost = vendor + refunded vendor + card fees", () => {
    // Paid $400, got a $400 welcome match, was charged $600: half of it is cash → $300 revenue.
    const row = clientFinancialRowOf({
      identity: identity("a", { cardFeesCents: "1200" }),
      billing: { creditedCents: 80_000, cashPaidCents: 40_000, nonCashCreditCents: 40_000, actualBalanceCents: 20_000, spendableBalanceCents: 19_000 },
      ledger: ledger({
        billedCostInUsdCents: "75000",
        netBilledCostInUsdCents: "60000",
        vendorCostInUsdCents: "20000",
        refundedCostInUsdCents: "5000",
        vendorRefundedCostInUsdCents: "2500",
      }),
      agencyStatedCents: null,
    });
    expect(row.chargedUsd).toBe(600);
    expect(row.revenueUsd).toEqual({ net: 300, beforeDiscount: 375 });
    expect(row.costUsd).toMatchObject({ total: 237, vendorOnChargedSpend: 200, vendorOnRefundedSpend: 25, cardFees: 12 });
    expect(row.marginUsd).toEqual({ net: 63, beforeDiscount: 138 });
    expect(row.marginPct).toEqual({ net: 21, beforeDiscount: 36.8 });
    expect(row.balanceUsd).toBe(200);
  });

  it("a client that never paid shows its cost and a NEGATIVE margin, never a blank", () => {
    // Aireena: $0 cash, $30 advance, $9.51 consumed.
    const row = clientFinancialRowOf({
      identity: identity("aireena"),
      billing: { creditedCents: 3000, cashPaidCents: 0, nonCashCreditCents: 3000, actualBalanceCents: 2049, spendableBalanceCents: 2049 },
      ledger: ledger({ billedCostInUsdCents: "951", netBilledCostInUsdCents: "951", vendorCostInUsdCents: "400" }),
      agencyStatedCents: null,
    });
    expect(row.revenueUsd).toEqual({ net: 0, beforeDiscount: 0 });
    expect(row.costUsd.total).toBe(4);
    expect(row.marginUsd).toEqual({ net: -4, beforeDiscount: -4 });
    expect(row.marginPct).toEqual({ net: null, beforeDiscount: null });
    expect(row.marginPctUnavailableReason).toBe("no_revenue");
  });

  it("an agency org's revenue is its stated amounts accrued, never its on-platform charges; no billing account earns nothing", () => {
    const agency = clientFinancialRowOf({
      identity: identity("ag"),
      billing: { creditedCents: 10_000, cashPaidCents: 5_000, nonCashCreditCents: 5_000, actualBalanceCents: 0, spendableBalanceCents: 0 },
      ledger: ledger({ billedCostInUsdCents: "10000", netBilledCostInUsdCents: "10000", vendorCostInUsdCents: "30000" }),
      agencyStatedCents: 120_000,
    });
    expect(agency.revenueUsd).toEqual({ net: 1200, beforeDiscount: 1200 });
    expect(agency.statedAmountsAccruedUsd).toBe(1200);
    expect(agency.chargedUsd).toBe(100);
    expect(agency.marginUsd!.net).toBe(900);
    const none = clientFinancialRowOf({ identity: identity("x"), billing: null, ledger: ledger({ vendorCostInUsdCents: "150" }), agencyStatedCents: null });
    expect(none.hasBillingAccount).toBe(false);
    expect(none.marginUsd!.net).toBe(-1.5);
  });

  it("over 1% of billed spend with no vendor cost: margin null, cost still served", () => {
    const row = clientFinancialRowOf({
      identity: identity("u"),
      billing: null,
      ledger: ledger({ billedCostInUsdCents: "10000", netBilledCostInUsdCents: "10000", vendorCostInUsdCents: "3000", unpricedBilledCostInUsdCents: "200" }),
      agencyStatedCents: null,
    });
    expect(row.marginUsd).toBeNull();
    expect(row.marginUnavailableReason).toBe("vendor_cost_unknown");
    expect(row.costUsd.total).toBe(30);
    expect(row.costUsd.vendorCostUnknownOnUsd).toBe(2);
  });
});

describe("statedAmountAccruedCents", () => {
  it("accrues amount x 12 / 365 per day in force, inclusive, up to today", () => {
    // $1,825 a month for 10 days = 1825 x 12 / 365 x 10 = $600.
    expect(statedAmountAccruedCents([{ amountUsd: 1825, startDate: "2026-11-01", endDate: "2026-11-10" }], "2026-11-19")).toBeCloseTo(60_000, 6);
    // still running: Nov 10..19 = 10 days.
    expect(statedAmountAccruedCents([{ amountUsd: 1825, startDate: "2026-11-10", endDate: null }], "2026-11-19")).toBeCloseTo(60_000, 6);
    // not started yet.
    expect(statedAmountAccruedCents([{ amountUsd: 1825, startDate: "2026-12-01", endDate: null }], "2026-11-19")).toBe(0);
  });
});

describe("clientFinancialTotalsOf", () => {
  it("totals are the sum of the rows to the cent", () => {
    const rows = [1, 2, 3].map((i) =>
      clientFinancialRowOf({
        identity: identity(`o${i}`),
        billing: { creditedCents: 1000 * i + 0.4, cashPaidCents: 333 * i, nonCashCreditCents: 0, actualBalanceCents: 0.3, spendableBalanceCents: 0 },
        ledger: ledger({ billedCostInUsdCents: "1000.333", netBilledCostInUsdCents: "999.777", vendorCostInUsdCents: `${101.555 * i}` }),
        agencyStatedCents: null,
      }),
    );
    const t = clientFinancialTotalsOf(rows);
    const sum = (f: (r: (typeof rows)[number]) => number) => Math.round(rows.reduce((s, r) => s + Math.round(f(r) * 100), 0)) / 100;
    expect(t.revenueUsd.net).toBe(sum((r) => r.revenueUsd.net));
    expect(t.costUsd.total).toBe(sum((r) => r.costUsd.total));
    expect(t.marginUsd.net).toBe(sum((r) => r.marginUsd!.net));
    expect(t.clients).toBe(3);
  });
});

describe("buildClientFinancials", () => {
  const deps = (over: Partial<ClientFinancialsDeps> = {}): ClientFinancialsDeps => ({
    identities: async () => [
      identity("client"),
      identity("ours", { ownOrg: true, ownOrgReason: "staff_test_org" }),
      identity("broken"),
    ],
    billing: async (orgId) => {
      if (orgId === "broken") throw new Error("billing timeout");
      return { creditedCents: 1000, cashPaidCents: 1000, nonCashCreditCents: 0, actualBalanceCents: 0, spendableBalanceCents: 0 };
    },
    ledger: async (orgId) =>
      orgId === null
        ? ledger({ billedCostInUsdCents: "2500", vendorCostInUsdCents: "900" })
        : ledger({ billedCostInUsdCents: "1000", netBilledCostInUsdCents: "1000", vendorCostInUsdCents: "400" }),
    statedAmounts: async () => [],
    firstSpendDay: async () => null,
    recurring: async () => ({ orgs: [{ orgId: "client", mrrCents: "9900" }, { orgId: "ours", mrrCents: "5000" }], unreadableOrgIds: [] }),
    now: () => new Date("2026-11-19T12:00:00Z"),
    ...over,
  });

  it("lists our orgs apart, names unread orgs, MRR over clients only", async () => {
    const body = await buildClientFinancials(deps());
    expect(body.clients.map((c) => c.orgId)).toEqual(["client"]);
    expect(body.ownOrgs.map((c) => c.orgId)).toEqual(["ours"]);
    expect(body.unreadOrgs).toEqual([{ orgId: "broken", orgName: "broken", reason: "billing timeout" }]);
    expect(body.totals.revenueUsd.net).toBe(10);
    expect(body.totals.marginUsd.net).toBe(6);
    expect(body.recurringRevenue).toMatchObject({ mrrUsd: 99, arrUsd: 1188, payingOrgs: 1 });
    expect(body.ledgerCoverage).toBeNull();
    expect(body.ledgerCoverageUnavailableReason).toBe("some_orgs_unread");
  });

  it("ledger coverage names spend no listed org holds", async () => {
    const body = await buildClientFinancials(
      deps({ identities: async () => [identity("client"), identity("ours", { ownOrg: true, ownOrgReason: "platform_org" })] }),
    );
    expect(body.ledgerCoverage).toEqual({
      fleetBilledUsd: 25,
      fleetVendorCostUsd: 9,
      listedBilledUsd: 20,
      listedVendorCostUsd: 8,
      notOnAnyListedOrgBilledUsd: 5,
      notOnAnyListedOrgVendorCostUsd: 1,
    });
  });

  it("an agency org reads its stated amounts; a stated row with no start runs from the brand's first spend day", async () => {
    const stated = [
      { id: "1", orgId: "client", brandId: "b", amountUsd: 1825, startDate: null, endDate: "2026-11-10", note: null, createdAt: "", updatedAt: "" },
    ];
    const body = await buildClientFinancials(
      deps({
        identities: async () => [identity("client")],
        statedAmounts: async () => stated,
        firstSpendDay: async (orgId, brandId) => (orgId === "client" && brandId === "b" ? "2026-11-01" : null),
      }),
    );
    expect(body.clients[0]).toMatchObject({ agency: true, statedAmountsAccruedUsd: 600, revenueUsd: { net: 600 } });
    expect(body.agencyBasisUnknown).toBe(false);
  });

  it("MRR unreadable = null + reason, the financials still serve", async () => {
    const body = await buildClientFinancials(deps({ recurring: async () => { throw new Error("down"); } }));
    expect(body.recurringRevenue).toMatchObject({ mrrUsd: null, unavailableReason: "billing_revenue_unavailable" });
    expect(body.clients).toHaveLength(1);
  });
});

describe("readClientFinancials", () => {
  it("never built: 503-able error, build starts behind, next read serves it", async () => {
    const { readClientFinancials, ClientFinancialsNotBuiltError, __resetClientFinancials } = await import("./client-financials-io.js");
    __resetClientFinancials();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps = {
      identities: async () => {
        await gate;
        return [];
      },
      billing: async () => null,
      ledger: async () => ledger(),
      statedAmounts: async () => [],
      firstSpendDay: async () => null,
      recurring: async () => ({ orgs: [], unreadableOrgIds: [] }),
      now: () => new Date(),
    };
    await expect(readClientFinancials(deps)).rejects.toBeInstanceOf(ClientFinancialsNotBuiltError);
    release();
    await new Promise((r) => setTimeout(r, 20));
    const body = await readClientFinancials(deps);
    expect(body.clients).toEqual([]);
  });
});
