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
vi.mock("../lib/sourcing-investment.js", async (orig) => ({
  ...(await orig<typeof import("../lib/sourcing-investment.js")>()),
  fetchServeRunCosts: vi.fn(),
  fetchListBuildCosts: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.LEAD_SERVICE_URL = "http://lead";
process.env.LEAD_SERVICE_API_KEY = "lk";

const { fetchServeRunCosts, fetchListBuildCosts } = await import("../lib/sourcing-investment.js");
const app = (await import("../index.js")).default;
const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };

const leadPage = (campaignId: string, rows: Array<{ runId: string | null; leadId: string; ap: string; domain: string | null }>) => ({
  leads: rows.map((r) => ({
    leadId: r.leadId,
    runId: r.runId,
    apolloPersonId: r.ap,
    campaignId,
    audienceId: "A",
    email: `${r.leadId}@x.com`,
    lead: { firstName: "F", lastName: "L", organization: { name: "Co", primaryDomain: r.domain, websiteUrl: null } },
  })),
  nextCursor: null,
});

describe("GET /brands/:brandId/sourcing-investment[/people|/companies]", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.mocked(fetchServeRunCosts).mockReset().mockResolvedValue([
      { runId: "r1", audienceId: "A", campaignId: "c1", billedCents: "10", vendorCents: "4", unpricedBilledCents: "0" },
      { runId: "r2", audienceId: "A", campaignId: "c2", billedCents: "6", vendorCents: "2", unpricedBilledCents: "0" },
      { runId: "r3", audienceId: "A", campaignId: "c1", billedCents: "1", vendorCents: "1", unpricedBilledCents: "0" },
    ]);
    vi.mocked(fetchListBuildCosts).mockReset().mockResolvedValue([
      { audienceId: "A", billedCents: "100", vendorCents: "80", unpricedBilledCents: "0" },
    ]);
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const campaignId = u.searchParams.get("campaignId")!;
      expect(u.searchParams.get("view")).toBe("basic");
      expect(u.searchParams.get("status")).toBe("all");
      const rows =
        campaignId === "c1"
          ? [{ runId: "r1", leadId: "p1", ap: "AP1", domain: "Acme.com" }, { runId: null, leadId: "p8", ap: "AP8", domain: null }]
          : [{ runId: "r2", leadId: "p1", ap: "AP1", domain: "acme.com" }];
      return new Response(JSON.stringify(leadPage(campaignId, rows)), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("summary: totals + per audience, people/companies not inlined", async () => {
    const res = await request(app).get("/brands/b1/sourcing-investment").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total.billedUsd).toBeCloseTo(1.17, 10);
    expect(res.body.total.vendorUsd).toBeCloseTo(0.87, 10);
    expect(res.body.notOnAPerson.billedUsd).toBeCloseTo(0.01, 10);
    expect(res.body.audiences).toHaveLength(1);
    expect(res.body.audiences[0].personCount).toBe(1);
    expect(res.body.people).toBeUndefined();
    expect(res.body.definition.basis).toBe("actual");
    // one lead-service walk per campaign the serves ran under (flat, never the deduped brand list)
    expect(fetchMock.mock.calls.map((c) => new URL(c[0] as string).searchParams.get("campaignId")).sort()).toEqual(["c1", "c2"]);
  });

  it("people: a person served by two campaigns carries both serves; keyed by apolloPersonIds", async () => {
    const res = await request(app).get("/brands/b1/sourcing-investment/people?apolloPersonIds=AP1,ZZ").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.people[0]).toMatchObject({ apolloPersonId: "AP1", serveCount: 2, companyDomain: "acme.com" });
    expect(res.body.people[0].invested.billedUsd).toBeCloseTo(0.16, 10);
  });

  it("companies: keyed by domain, case-insensitive", async () => {
    const res = await request(app).get("/brands/b1/sourcing-investment/companies?domains=ACME.com").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.companies[0].invested.billedUsd).toBeCloseTo(0.16, 10);
  });

  it("bad paging is a 400, never ignored", async () => {
    expect((await request(app).get("/brands/b1/sourcing-investment/people?limit=0").set(AUTH)).status).toBe(400);
    expect((await request(app).get("/brands/b1/sourcing-investment/companies?offset=x").set(AUTH)).status).toBe(400);
  });

  it("a downstream failure is a 502, never zeros", async () => {
    vi.mocked(fetchServeRunCosts).mockRejectedValueOnce(new Error("runs down"));
    expect((await request(app).get("/brands/b1/sourcing-investment").set(AUTH)).status).toBe(502);
  });
});
