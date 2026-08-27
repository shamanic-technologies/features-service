import { describe, it, expect, vi, afterEach } from "vitest";

process.env.CLIENT_SERVICE_URL = "http://client:3000";
process.env.CLIENT_SERVICE_API_KEY = "client-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const { fetchOrgIdentity, fetchOrgBalance, fetchSpendableBudgets, spendableKey } = await import("./accounts-client.js");

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchOrgIdentity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns externalId + earliest-user owner email", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/internal/orgs/")) return jsonRes({ id: "o1", externalId: "org_clerk", name: "Acme" });
      return jsonRes({
        users: [
          { email: "late@x.com", createdAt: "2026-02-01T00:00:00Z" },
          { email: "owner@x.com", createdAt: "2026-01-01T00:00:00Z" },
        ],
      });
    });
    expect(await fetchOrgIdentity("o1")).toEqual({ orgExternalId: "org_clerk", ownerEmail: "owner@x.com" });
  });

  it("maps a client-service org 404 to null identity (org row unknown — still resolvable to null), not a throw", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/internal/orgs/")) return jsonRes({ error: "Org not found" }, 404);
      return jsonRes({ users: [] }); // unknown org → empty users → null owner
    });
    expect(await fetchOrgIdentity("ghost")).toEqual({ orgExternalId: null, ownerEmail: null });
  });

  it("fails loud on a non-404 client-service org error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("/internal/orgs/")) return jsonRes({ error: "boom" }, 500);
      return jsonRes({ users: [] });
    });
    await expect(fetchOrgIdentity("o1")).rejects.toThrow(/orgs\/:orgId failed \(500\)/);
  });
});

describe("fetchOrgBalance", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns spendable + actual balances and the has_auto_topup flag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({ balance_cents: "1397", actual_balance_cents: "5317", has_auto_topup: true, depleted: false }),
    );
    expect(await fetchOrgBalance("o1")).toEqual({ spendableUsd: 13.97, actualUsd: 53.17, autoTopupEnabled: true });
  });

  it("treats a MISSING has_auto_topup (older billing deploy) as not-enabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes({ balance_cents: "5000", actual_balance_cents: "5000", depleted: false }));
    expect(await fetchOrgBalance("o1")).toEqual({ spendableUsd: 50, actualUsd: 50, autoTopupEnabled: false });
  });

  it("maps billing 404 (no funded wallet) to zero balances / no auto-topup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes({ error: "Billing account not found" }, 404));
    expect(await fetchOrgBalance("o1")).toEqual({ spendableUsd: 0, actualUsd: 0, autoTopupEnabled: false });
  });

  it("fails loud on a non-404 billing error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes({ error: "boom" }, 500));
    await expect(fetchOrgBalance("o1")).rejects.toThrow(/balance failed \(500\)/);
  });
});

describe("fetchSpendableBudgets", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns both figures per (org, brand), in dollars", async () => {
    // The production shape: a brand funding two funnels, one of whose campaigns is stopped.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [
          { orgId: "o1", brandId: "b1", configuredDailyBudgetCents: 6000, runningDailyBudgetCents: 5000 },
          { orgId: "o2", brandId: "b2", configuredDailyBudgetCents: 1000, runningDailyBudgetCents: 0 },
        ],
        unavailable: [],
      }),
    );
    const out = await fetchSpendableBudgets([
      { orgId: "o1", brandId: "b1" },
      { orgId: "o2", brandId: "b2" },
    ]);
    expect(out.get(spendableKey("o1", "b1"))).toEqual({ configuredUsd: 60, runningUsd: 50 });
    expect(out.get(spendableKey("o2", "b2"))).toEqual({ configuredUsd: 10, runningUsd: 0 });
  });

  it("keys on the PAIR, so one brand claimed by two orgs keeps each org's own money", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [
          { orgId: "oA", brandId: "shared", configuredDailyBudgetCents: 2000, runningDailyBudgetCents: 2000 },
          { orgId: "oB", brandId: "shared", configuredDailyBudgetCents: 500, runningDailyBudgetCents: 0 },
        ],
        unavailable: [],
      }),
    );
    const out = await fetchSpendableBudgets([
      { orgId: "oA", brandId: "shared" },
      { orgId: "oB", brandId: "shared" },
    ]);
    expect(out.get(spendableKey("oA", "shared"))?.runningUsd).toBe(20);
    expect(out.get(spendableKey("oB", "shared"))?.runningUsd).toBe(0);
  });

  it("THROWS on an unavailable pair rather than reading it as zero", async () => {
    // A pair the producer could not price carries no figures. Defaulting it to 0 would silently shrink
    // the fleet total with nothing reporting it — which is why the producer refuses to send a zero.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [],
        unavailable: [{ orgId: "o1", brandId: "b1", reason: "billing unreachable" }],
      }),
    );
    await expect(fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }])).rejects.toThrow(/billing unreachable/);
  });

  it("fails loud on a campaign-service error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes({ error: "boom" }, 500));
    await expect(fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }])).rejects.toThrow(/spendable-budget failed \(500\)/);
  });

  it("makes no call at all for an empty pair list", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect((await fetchSpendableBudgets([])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
