/**
 * GET /brands/:brandId/companies[/:companyKey] (MON-PAGE-SPEED-2-1112): the rows come from the brand revenue body the
 * revenue read serves first and the brand company lifecycle cell; the route pages, sorts, searches and addresses them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.FEATURES_SERVICE_API_KEY = "test-key";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const revenueFirst = vi.fn();
const lifecycleRead = vi.fn();
class BrandHasNoOfferCampaignsError extends Error {}

vi.mock("./brand-economics.js", () => ({
  brandRevenueBodyFirst: (...a: unknown[]) => revenueFirst(...a),
  handleError: (res: express.Response, error: unknown) => res.status(502).json({ error: String(error) }),
}));
vi.mock("./deals-value.js", () => ({
  brandLifecycleRead: (...a: unknown[]) => lifecycleRead(...a),
  BrandHasNoOfferCampaignsError,
}));

const { SnapshotJson } = await import("../lib/view-cache.js");
const { default: router, __resetBrandCompaniesMemo } = await import("./brand-companies.js");

const app = express();
app.use(router);
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const org = (n: number, value: number) => ({
  organizationKey: `org:${n}`,
  orgId: String(n),
  orgName: `Company ${n}`,
  orgLogoUrl: "https://logo",
  orgDomain: `c${n}.com`,
  topPerson: null,
  peopleCount: 1,
  tags: ["delivered"],
  expectedRevenueUsd: value,
  mostAdvancedDate: null,
});
const REVENUE = { brandId: "b1", spend: {}, organizations: Array.from({ length: 130 }, (_, i) => org(i, 130 - i)) };
const LIFECYCLE = {
  brandId: "b1",
  rungs: [{ key: "contacted", rank: 1, label: "Contacted", organizationCount: 130 }],
  organizations: REVENUE.organizations.map((o) => ({ organizationKey: o.organizationKey, lifecycle: { key: "contacted", rank: 1, label: "Contacted" } })),
};

beforeEach(() => {
  __resetBrandCompaniesMemo();
  revenueFirst.mockReset().mockResolvedValue({ body: new SnapshotJson(JSON.stringify(REVENUE)) });
  lifecycleRead.mockReset().mockResolvedValue(new SnapshotJson(JSON.stringify(LIFECYCLE)));
});

describe("GET /brands/:brandId/companies", () => {
  it("serves the first page of 60, value order, with the totals and the rungs", async () => {
    const res = await request(app).get("/brands/b1/companies?pricing=net").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brandId: "b1", sort: "value", q: null, rung: null, offset: 0, limit: 60, total: 130, organizationCount: 130 });
    expect(res.body.rungs).toEqual(LIFECYCLE.rungs);
    expect(res.body.companies).toHaveLength(60);
    expect(res.body.companies[0]).toMatchObject({ organizationKey: "org:0", companyKey: "c0.com", lifecycle: { key: "contacted" } });
    expect(res.body.companies[0].orgLogoUrl).toBeUndefined();
    // The revenue cell asked is the default one of the pricing: the list's own params never reach it.
    expect(revenueFirst.mock.calls[0][0].query).toEqual({ pricing: "net" });
    expect(lifecycleRead.mock.calls[0][1]).toEqual({ orgId: AUTH["x-org-id"], userId: AUTH["x-user-id"], runId: AUTH["x-run-id"] });
  });

  it("pages, searches and refuses a bad parameter", async () => {
    const page = await request(app).get("/brands/b1/companies?offset=120&limit=60").set(AUTH);
    expect(page.body.companies.map((c: { orgId: string }) => c.orgId)).toEqual(Array.from({ length: 10 }, (_, i) => String(120 + i)));
    const search = await request(app).get("/brands/b1/companies?q=c12.com&limit=6").set(AUTH);
    expect(search.body.total).toBe(1);
    expect(search.body.companies[0].orgId).toBe("12");
    expect((await request(app).get("/brands/b1/companies?sort=size").set(AUTH)).status).toBe(400);
    expect((await request(app).get("/brands/b1/companies?pricing=cheap").set(AUTH)).body.reason).toBe("pricing_unrecognised");
  });

  it("passes the revenue read's own refusal through", async () => {
    revenueFirst.mockResolvedValue({ refused: { status: 400, json: { error: "x", reason: "funnel_retired" } } });
    const res = await request(app).get("/brands/b1/companies").set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("funnel_retired");
  });

  it("a brand selling no offer yet: rows on no rung, no rungs", async () => {
    lifecycleRead.mockRejectedValue(new BrandHasNoOfferCampaignsError("b1"));
    const res = await request(app).get("/brands/b1/companies?limit=1").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.rungs).toEqual([]);
    expect(res.body.companies[0].lifecycle).toBeNull();
  });

  it("any other failure is loud (502), never an empty list", async () => {
    lifecycleRead.mockRejectedValue(new Error("lead-service down"));
    expect((await request(app).get("/brands/b1/companies").set(AUTH)).status).toBe(502);
    revenueFirst.mockResolvedValue({ body: new SnapshotJson(JSON.stringify({ brandId: "b1" })) });
    lifecycleRead.mockResolvedValue(new SnapshotJson(JSON.stringify(LIFECYCLE)));
    expect((await request(app).get("/brands/b1/companies").set(AUTH)).status).toBe(502);
  });
});

describe("GET /brands/:brandId/companies/:companyKey", () => {
  it("one company, its place and its neighbours", async () => {
    const res = await request(app).get("/brands/b1/companies/c5.com?pricing=net").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brandId: "b1", position: 6, previousKey: "c4.com", nextKey: "c6.com", organizationCount: 130 });
    expect(res.body.company).toMatchObject({ orgId: "5", lifecycle: { key: "contacted" } });
  });

  it("an unknown key is a named 404", async () => {
    const res = await request(app).get("/brands/b1/companies/nope.com").set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("company_not_found");
  });
});
