import { describe, it, expect, vi, afterEach } from "vitest";

process.env.CLIENT_SERVICE_URL = "http://client:3000";
process.env.CLIENT_SERVICE_API_KEY = "client-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";

const { fetchOrgIdentity, fetchOrgBalance } = await import("./accounts-client.js");

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
