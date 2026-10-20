import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));
vi.mock("../lib/view-cache.js", async (orig) => {
  const real = await orig<typeof import("../lib/view-cache.js")>();
  return { ...real, servedCachedJson: vi.fn(real.servedCachedJson) };
});

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.RUNS_SERVICE_URL = "http://runs";
process.env.RUNS_SERVICE_API_KEY = "rk";
process.env.BILLING_SERVICE_URL = "http://billing";
process.env.BILLING_SERVICE_API_KEY = "bk";

const { servedCachedJson, campaignLiveTtlMs } = await import("../lib/view-cache.js");
const { buildUsageBreakdown } = await import("../lib/usage-categories.js");
const app = (await import("../index.js")).default;
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const GROUPS = [
  { dimensions: { serviceName: "apollo-service", taskName: "search", campaignId: "c1" }, totalCostInUsdCents: "120.5", actualCostInUsdCents: "100.25", provisionedCostInUsdCents: "20.25", netActualCostInUsdCents: "90.1", netProvisionedCostInUsdCents: "18.2", runCount: 3 },
  { dimensions: { serviceName: "brand-service", taskName: "extract", campaignId: null }, totalCostInUsdCents: "10", actualCostInUsdCents: "10", provisionedCostInUsdCents: "0", netActualCostInUsdCents: "9", netProvisionedCostInUsdCents: "0", runCount: 1 },
];

describe("GET /orgs/usage", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.mocked(servedCachedJson).mockClear();
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      if (url.startsWith("http://runs/internal/org-no-campaign-total")) {
        return new Response(JSON.stringify({ net_spent_cents: "9.0000000000", net_total_expected_cents: "9.0000000000" }), { status: 200 });
      }
      if (url.endsWith("/balance")) {
        return new Response(JSON.stringify({ balance_cents: "-108.3", actual_balance_cents: "-90.1" }), { status: 200 });
      }
      if (url.endsWith("/cash")) return new Response(JSON.stringify({ credited_cents: "0.0000000000" }), { status: 200 });
      return new Response(JSON.stringify({ groups: GROUPS }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("serves the breakdown closed on billing's figures, absorbed setup spend out of billed", async () => {
    const res = await request(app).get("/orgs/usage").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    const expected = buildUsageBreakdown(GROUPS as never, {
      absorbed: { billedCents: "9.0000000000", setAsideCents: "0.0000000000" },
      billing: { billedCents: "90.1", setAsideCents: "18.2" },
    }).breakdown;
    expect(res.text).toBe(JSON.stringify(expected));
    expect(res.body.totalBilledUsd).toBeCloseTo(0.901, 10);
    expect(res.body.totalSetAsideUsd).toBe(0.182);
    expect(res.body.coveredByUs.billedUsd).toBe(0.09);
    expect(res.body.categories.find((c: { key: string }) => c.key === "setup").billedUsd).toBe(0);
    expect(res.body.categories.find((c: { key: string }) => c.key === "account_adjustments").billedUsd).toBe(0);
    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain("http://runs/internal/org-no-campaign-total?org_id=0e9a0000-0000-4000-8000-000000000001&since=2026-10-13T00%3A00%3A00.000Z");
    expect(calls).toContain("http://billing/internal/accounts/by-org/0e9a0000-0000-4000-8000-000000000001/cash");
    const [url, init] = fetchMock.mock.calls.find((c) => (c[0] as string).includes("/v1/stats/costs")) as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://runs/v1/stats/costs?groupBy=serviceName%2CtaskName%2CcampaignId");
    expect(init.headers).toMatchObject({ "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" });
  });

  it("is a Gold cell keyed on the org alone, stale after the live 3s TTL", async () => {
    await request(app).get("/orgs/usage").set(AUTH);
    const args = vi.mocked(servedCachedJson).mock.calls[0][0];
    expect(args.view).toBe("org-usage");
    expect(args.scopeKey).toBe("org-usage|orgId=0e9a0000-0000-4000-8000-000000000001");
    expect(args.orgId).toBe("0e9a0000-0000-4000-8000-000000000001");
    expect(args.ttlMs).toBe(campaignLiveTtlMs());
  });

  it("an org billing holds no account for: totals are the classified spend net of absorbed", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("http://billing") ? new Response("nope", { status: 404 }) : base(url),
    );
    const res = await request(app).get("/orgs/usage").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.totalsSource).toBe("no_billing_account");
    expect(res.body.totalBilledUsd).toBeCloseTo(0.901, 10);
  });

  it("fails loud: a billing-service failure is a 502, never a guessed bill", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/cash") ? new Response("boom", { status: 502 }) : base(url),
    );
    const res = await request(app).get("/orgs/usage").set(AUTH);
    expect(res.status).toBe(502);
  });

  it("fails loud: a runs-service failure is a 502, never a $0 bill", async () => {
    fetchMock.mockImplementation(async () => new Response("boom", { status: 400 }));
    const res = await request(app).get("/orgs/usage").set(AUTH);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to compute usage" });
  });
});
