/**
 * EACH PIPE OF A SALES FUNNEL CAMPAIGN READS ITS OWN SPEND on its own `/features/:slug/revenue?campaignId=` read
 * (lib/pipe-spend-attribution.ts). Fixture = prod funnel 7fcf42ab (2026-10-11): $32.71 of cold filters cost filed
 * under the cold email pipe before 10-08, $0 under the cold filters pipe; the buying-signals pipe books its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.unmock("../lib/pipe-spend-attribution-io.js");
vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const ORG = "0e9a0000-0000-4000-8000-000000000001";
const AUTH = { "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };
const COLD_EMAIL = "sales-cold-email-outreach";
const COLD_FILTERS = "sourcing-apollo-cold-filters";
const BUYING = "sourcing-apollo-buying-signals";

/** Cost rows as runs-service files them: (campaign, the RUN's feature slug, day, cents). */
const COSTS: Array<{ campaignId: string; featureSlug: string; day: string; cents: number }> = [
  { campaignId: "ce", featureSlug: COLD_EMAIL, day: "2026-10-02", cents: 9202 },
  { campaignId: "ce", featureSlug: COLD_FILTERS, day: "2026-09-29", cents: 3271 },
  { campaignId: "bs", featureSlug: BUYING, day: "2026-10-10", cents: 1013 },
];

const UNITS = [
  { campaignId: "cf", pipeId: "p-cf", featureSlug: COLD_FILTERS, legKey: "start_to_lead_found", status: "ongoing" },
  { campaignId: "bs", pipeId: "p-bs", featureSlug: BUYING, legKey: "start_to_lead_found", status: "ongoing" },
  { campaignId: "ce", pipeId: "p-ce", featureSlug: COLD_EMAIL, legKey: "lead_found_to_conversation", status: "ongoing" },
];

function campaignRow(id: string, featureSlug: string, legKey: string) {
  return { id, orgId: ORG, brandId: "b1", brandIds: ["b1"], featureSlug, offerId: "o1", acquisitionChannel: null, legKey, status: "ongoing", createdAt: "2026-09-28T00:00:00.000Z" };
}

function mockFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    const q = new URL(url).searchParams;

    if (url.includes("/sales-funnel-campaigns")) {
      return json({ salesFunnelCampaigns: [{ id: "7fcf42ab", brandId: "b1", offerId: "o1", salesFunnelId: "sf", salesFunnelName: "Bliss", status: "ongoing", stopReason: null, createdAt: "2026-10-07T00:00:00Z", units: UNITS }] });
    }
    if (url.includes("/campaigns?")) {
      const slug = q.get("featureSlug");
      return json({ campaigns: UNITS.filter((u) => u.featureSlug === slug).map((u) => campaignRow(u.campaignId, u.featureSlug, u.legKey)) });
    }

    // runs-service: the filters it applies (campaign, campaign list, run feature slugs), then the asked grouping.
    if (url.includes("runs:3000")) {
      if (q.get("startedAfter")) return url.includes("timeseries") ? json({ buckets: [] }) : json({ groups: [] });
      const slugs = (q.get("featureSlugs") ?? "").split(",");
      const named = q.get("campaignIds")?.split(",") ?? (q.get("campaignId") ? [q.get("campaignId")!] : null);
      const rows = COSTS.filter((c) => slugs.includes(c.featureSlug) && (!named || named.includes(c.campaignId)));
      const money = (cents: number) => ({ totalCostInUsdCents: String(cents), actualCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), netActualCostInUsdCents: String(cents) });
      if (url.includes("timeseries")) {
        const byDay = new Map<string, number>();
        for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.cents);
        return json({ buckets: [...byDay].sort().map(([period, cents]) => ({ period, campaignId: "x", ...money(cents) })) });
      }
      const groupBy = (q.get("groupBy") ?? "").split(",").filter(Boolean);
      const groups = new Map<string, { dimensions: Record<string, string>; cents: number }>();
      for (const r of rows) {
        const dimensions: Record<string, string> = {};
        for (const g of groupBy) dimensions[g] = g === "campaignId" ? r.campaignId : g === "costName" ? "apollo-enrichment" : "wf-v1";
        const k = JSON.stringify(dimensions);
        const prev = groups.get(k) ?? { dimensions, cents: 0 };
        prev.cents += r.cents;
        groups.set(k, prev);
      }
      return json({ groups: [...groups.values()].map((g) => ({ dimensions: g.dimensions, runCount: 1, ...money(g.cents) })) });
    }
    if (url.includes("/orgs/stats")) return json({ groups: [] });
    return new Response("not found", { status: 404 });
  });
}

const revenue = (slug: string, campaignId: string) =>
  request(app).get(`/features/${slug}/revenue?brandId=b1&campaignId=${campaignId}&windowDays=all`).set(AUTH);

describe("a sales funnel pipe reads its own spend on its campaign read", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockImplementation((async () => ({ id: "f", slug: COLD_FILTERS, name: "x", description: "x", status: "active", outputs: [], charts: [], createdAt: new Date(), updatedAt: new Date() })) as never);
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("the cold filters pipe reads the cold filters history filed under its outreach sibling, total and per day", async () => {
    const res = await revenue(COLD_FILTERS, "cf");
    expect(res.status).toBe(200);
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(32.71, 2);
    expect(res.body.spend.totalSpentCents).toBe(3271);
    expect(res.body.window.spend.totalSpentCents).toBe(3271);
  });

  it("the buying signals pipe, which books its own, is unchanged", async () => {
    const res = await revenue(BUYING, "bs");
    expect(res.status).toBe(200);
    expect(res.body.spend.totalSpentCents).toBe(1013);
  });
});
