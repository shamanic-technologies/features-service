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
  fetchHeldPersonCompanies: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.LEAD_SERVICE_URL = "http://lead";
process.env.LEAD_SERVICE_API_KEY = "lk";

const { fetchServeRunCosts, fetchListBuildCosts, fetchHeldPersonCompanies } = await import("../lib/sourcing-investment.js");
const app = (await import("../index.js")).default;
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const serveRecord = (campaignId: string, r: { runId: string; leadId: string; ap: string; domain: string | null }) => ({
  runId: r.runId,
  leadId: r.leadId,
  campaignId,
  audienceId: "A",
  servedAt: null,
  apolloPersonId: r.ap,
  email: `${r.leadId}@x.com`,
  firstName: "F",
  lastName: "L",
  company: { name: "Co", primaryDomain: r.domain, websiteUrl: null },
});

describe("GET /brands/:brandId/sourcing-investment[/people|/companies]", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.mocked(fetchServeRunCosts).mockReset().mockResolvedValue([
      { runId: "r1", audienceId: "A", campaignId: "c1", billedCents: "10", netCents: "9", vendorCents: "4", unpricedBilledCents: "0" },
      { runId: "r2", audienceId: "A", campaignId: "c2", billedCents: "6", netCents: "5", vendorCents: "2", unpricedBilledCents: "0" },
      { runId: "r3", audienceId: "A", campaignId: "c1", billedCents: "1", netCents: "1", vendorCents: "1", unpricedBilledCents: "0" },
    ]);
    vi.mocked(fetchListBuildCosts).mockReset().mockResolvedValue([
      { audienceId: "A", billedCents: "100", netCents: "90", vendorCents: "80", unpricedBilledCents: "0" },
    ]);
    vi.mocked(fetchHeldPersonCompanies).mockReset().mockResolvedValue(
      new Map([["AP1", { companyKey: "domain:acme.com", name: "Acme", domain: "acme.com" }]]),
    );
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe("/internal/brands/b1/serve-records");
      const serves = [
        serveRecord("c1", { runId: "r1", leadId: "p1", ap: "AP1", domain: "Acme.com" }),
        serveRecord("c2", { runId: "r2", leadId: "p1", ap: "AP1", domain: "acme.com" }),
      ];
      return new Response(JSON.stringify({ serves, count: serves.length }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("summary: totals + per audience, people/companies not inlined", async () => {
    const res = await request(app).get("/brands/b1/sourcing-investment").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total.billedUsd).toBeCloseTo(1.17, 10);
    expect(res.body.total.vendorUsd).toBeCloseTo(0.87, 10);
    expect(res.body.total.netUsd).toBeCloseTo(1.05, 10);
    expect(res.body.notOnAPerson.billedUsd).toBeCloseTo(0.01, 10);
    expect(res.body.audiences).toHaveLength(1);
    expect(res.body.audiences[0].personCount).toBe(1);
    expect(res.body.people).toBeUndefined();
    expect(res.body.definition.basis).toBe("actual");
    // ONE lead-service read for the whole brand (every campaign, never the deduped brand list)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-org-id": "0e9a0000-0000-4000-8000-000000000001" });
  });

  it("people: a person served by two campaigns carries both serves; keyed by apolloPersonIds", async () => {
    const res = await request(app).get("/brands/b1/sourcing-investment/people?apolloPersonIds=AP1,ZZ").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.people[0]).toMatchObject({ apolloPersonId: "AP1", serveCount: 2, companyKey: "domain:acme.com", companyDomain: "acme.com" });
    expect(res.body.people[0].invested.billedUsd).toBeCloseTo(0.16, 10);
  });

  it("companies: keyed by domain, case-insensitive", async () => {
    const res = await request(app).get("/brands/b1/sourcing-investment/companies?domains=ACME.com").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.companies[0].invested.billedUsd).toBeCloseTo(0.16, 10);
  });

  it("companies: keyed by human-service companyKey", async () => {
    const res = await request(app).get("/brands/b1/sourcing-investment/companies?companyKeys=domain:acme.com,name:x").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.companies.map((c: { companyKey: string }) => c.companyKey)).toEqual(["domain:acme.com"]);
    expect((await request(app).get("/brands/b1/sourcing-investment/companies?companyKeys=a&domains=b").set(AUTH)).status).toBe(400);
  });

  it("bad paging is a 400, never ignored", async () => {
    expect((await request(app).get("/brands/b1/sourcing-investment/people?limit=0").set(AUTH)).status).toBe(400);
    expect((await request(app).get("/brands/b1/sourcing-investment/companies?offset=x").set(AUTH)).status).toBe(400);
  });

  it("a downstream failure is a 502, never zeros", async () => {
    vi.mocked(fetchServeRunCosts).mockRejectedValueOnce(new Error("runs down"));
    expect((await request(app).get("/brands/b1/sourcing-investment").set(AUTH)).status).toBe(502);
  });

  it("a short lead-service body (count disagrees) is a 502, never a partial figure", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ serves: [serveRecord("c1", { runId: "r1", leadId: "p1", ap: "AP1", domain: null })], count: 2 }), { status: 200 }),
    );
    expect((await request(app).get("/brands/b1/sourcing-investment").set(AUTH)).status).toBe(502);
  });

  it("a lead-service error status is a 502", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    expect((await request(app).get("/brands/b1/sourcing-investment").set(AUTH)).status).toBe(502);
  });
});
