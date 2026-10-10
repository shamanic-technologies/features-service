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
          {
            orgId: "o1", brandId: "b1", configuredDailyBudgetCents: 6000, runningDailyBudgetCents: 5000, salesFunnels: [],
            rows: [
              { legKey: "start_to_conversation", dailyBudgetCents: 5000, running: true, campaignId: "c1" },
              { legKey: "start_to_website_visit", dailyBudgetCents: 1000, running: false, campaignId: "c2" },
            ],
          },
          {
            orgId: "o2", brandId: "b2", configuredDailyBudgetCents: 1000, runningDailyBudgetCents: 0, salesFunnels: [],
            rows: [{ legKey: "start_to_conversation", dailyBudgetCents: 1000, running: false, campaignId: null }],
          },
        ],
        unavailable: [],
      }),
    );
    const out = await fetchSpendableBudgets([
      { orgId: "o1", brandId: "b1" },
      { orgId: "o2", brandId: "b2" },
    ]);
    expect(out.get(spendableKey("o1", "b1"))).toEqual({ configuredUsd: 60, runningUsd: 50, proactiveRunningUsd: 50, reactiveRunningUsd: 0, salesFunnelRunningUsd: 0 });
    expect(out.get(spendableKey("o2", "b2"))).toEqual({ configuredUsd: 10, runningUsd: 0, proactiveRunningUsd: 0, reactiveRunningUsd: 0, salesFunnelRunningUsd: 0 });
  });

  it("keys on the PAIR, so one brand claimed by two orgs keeps each org's own money", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [
          {
            orgId: "oA", brandId: "shared", configuredDailyBudgetCents: 2000, runningDailyBudgetCents: 2000, salesFunnels: [],
            rows: [{ legKey: "start_to_conversation", dailyBudgetCents: 2000, running: true, campaignId: "cA" }],
          },
          {
            orgId: "oB", brandId: "shared", configuredDailyBudgetCents: 500, runningDailyBudgetCents: 0, salesFunnels: [],
            rows: [{ legKey: "start_to_conversation", dailyBudgetCents: 500, running: false, campaignId: "cB" }],
          },
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

  it("splits the running money into PROACTIVE (entry leg) and REACTIVE (continues a conversation)", async () => {
    // Doc Dinners, prod 2026-10-01: cold email ($107 + $10) stopped, AI meeting booking ($20) still on.
    // Olive: one ongoing cold-email campaign at $20 on start_to_website_visit.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [
          {
            orgId: "oDoc", brandId: "doc", configuredDailyBudgetCents: 13700, runningDailyBudgetCents: 2000, salesFunnels: [],
            rows: [
              { legKey: "conversation_to_meeting_booked", dailyBudgetCents: 2000, running: true, campaignId: "cMeet" },
              { legKey: "start_to_conversation", dailyBudgetCents: 1000, running: false, campaignId: "cFb" },
              { legKey: "start_to_conversation", dailyBudgetCents: 10700, running: false, campaignId: "cCold" },
            ],
          },
          {
            orgId: "oOlive", brandId: "olive", configuredDailyBudgetCents: 2000, runningDailyBudgetCents: 2000, salesFunnels: [],
            rows: [{ legKey: "start_to_website_visit", dailyBudgetCents: 2000, running: true, campaignId: "cOl" }],
          },
        ],
        unavailable: [],
      }),
    );
    const out = await fetchSpendableBudgets([
      { orgId: "oDoc", brandId: "doc" },
      { orgId: "oOlive", brandId: "olive" },
    ]);
    expect(out.get(spendableKey("oDoc", "doc"))).toEqual({ configuredUsd: 137, runningUsd: 20, proactiveRunningUsd: 0, reactiveRunningUsd: 20, salesFunnelRunningUsd: 0 });
    expect(out.get(spendableKey("oOlive", "olive"))).toEqual({ configuredUsd: 20, runningUsd: 20, proactiveRunningUsd: 20, reactiveRunningUsd: 0, salesFunnelRunningUsd: 0 });
  });

  it("reads the leg of the campaign behind a leg-less ceiling (brand-grain pot)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [
          {
            orgId: "o1", brandId: "b1", configuredDailyBudgetCents: 3000, runningDailyBudgetCents: 3000, salesFunnels: [],
            rows: [{ legKey: null, dailyBudgetCents: 3000, running: true, campaignId: "cMeet" }],
            campaigns: [{ campaignId: "cMeet", legKey: "conversation_to_meeting_booked" }],
          },
        ],
        unavailable: [],
      }),
    );
    const out = await fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }]);
    expect(out.get(spendableKey("o1", "b1"))).toMatchObject({ proactiveRunningUsd: 0, reactiveRunningUsd: 30 });
  });

  it("counts a running ceiling naming no published leg as PROACTIVE (pre-leg campaigns were cold email)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [
          {
            orgId: "o1", brandId: "b1", configuredDailyBudgetCents: 1500, runningDailyBudgetCents: 1500, salesFunnels: [],
            rows: [{ legKey: null, dailyBudgetCents: 1500, running: true, campaignId: null }],
          },
        ],
        unavailable: [],
      }),
    );
    const out = await fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }]);
    expect(out.get(spendableKey("o1", "b1"))).toMatchObject({ proactiveRunningUsd: 15, reactiveRunningUsd: 0 });
  });

  it("THROWS when the producer sends no ceiling rows (the split cannot be made)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [{ orgId: "o1", brandId: "b1", configuredDailyBudgetCents: 1000, runningDailyBudgetCents: 1000, salesFunnels: [] }],
        unavailable: [],
      }),
    );
    await expect(fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }])).rejects.toThrow(/no ceiling rows/);
  });

  it("counts a running SALES FUNNEL proactive by its daily figure (fractional), units carrying 0", async () => {
    // campaign-service v0.75.18: a $50/week funnel = 714.2857 cents a day; its unit campaign's row is 0.
    const weekly = 5000 / 7;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [
          {
            orgId: "o1", brandId: "b1",
            configuredDailyBudgetCents: 2000 + weekly + weekly,
            runningDailyBudgetCents: 2000 + weekly,
            rows: [{ legKey: "conversation_to_meeting_booked", dailyBudgetCents: 2000, running: true, campaignId: "cMeet" }],
            salesFunnels: [
              { salesFunnelId: "f-on", running: true, dailyBudgetCents: weekly, unitCampaignIds: ["u1"] },
              { salesFunnelId: "f-off", running: false, dailyBudgetCents: weekly, unitCampaignIds: [] },
            ],
          },
        ],
        unavailable: [],
      }),
    );
    const got = (await fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }])).get(spendableKey("o1", "b1"))!;
    expect(got.salesFunnelRunningUsd).toBeCloseTo(weekly / 100, 10);
    expect(got.proactiveRunningUsd).toBeCloseTo(weekly / 100, 10);
    expect(got.reactiveRunningUsd).toBe(20);
    expect(got.runningUsd).toBeCloseTo((2000 + weekly) / 100, 10);
    expect(got.configuredUsd).toBeCloseTo((2000 + 2 * weekly) / 100, 10);
  });

  it("THROWS when the producer sends no salesFunnels list, or a funnel with no figure", async () => {
    const brand = { orgId: "o1", brandId: "b1", configuredDailyBudgetCents: 0, runningDailyBudgetCents: 0, rows: [] };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonRes({ brands: [brand], unavailable: [] }));
    await expect(fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }])).rejects.toThrow(/no salesFunnels list/);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonRes({ brands: [{ ...brand, salesFunnels: [{ running: true }] }], unavailable: [] }));
    await expect(fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }])).rejects.toThrow(/no running flag or daily figure/);
  });

  it("THROWS when the parts do not add back to the producer's running total", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonRes({
        brands: [{ orgId: "o1", brandId: "b1", configuredDailyBudgetCents: 1000, runningDailyBudgetCents: 1000, rows: [], salesFunnels: [{ running: true, dailyBudgetCents: 999 }] }],
        unavailable: [],
      }),
    );
    await expect(fetchSpendableBudgets([{ orgId: "o1", brandId: "b1" }])).rejects.toThrow(/≠ running 1000/);
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
