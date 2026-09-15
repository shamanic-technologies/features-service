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
// The pair-economics read fans out cross-org; its dataset is irrelevant here — an empty one answers
// `no_spend_recorded` for every pair, which still carries the commitment field on every row.
vi.mock("../lib/cross-org-cost-per-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchFunnelBucketDataset: vi.fn(async () => []),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;
const { __resetChannelCatalogueCache } = await import("./public.js");

const CONVERSATION = "sales_meetings_from_conversation";
const FORM = "form_magnet";

const CHANNEL_BLOB = {
  family: "outbound_one_to_one",
  operatedBy: "platform",
  stepTransitions: [{ from: null, to: "conversation" }, { from: null, to: "website_visit" }],
  terms: { dailyOperatingCostCents: 800, minimumCommitmentDays: 30, maxDaysToFirstProduction: 14 },
};

const FEATURE_ROW = (slug: string) => ({
  id: `feat-${slug}`,
  slug,
  name: slug,
  description: "x",
  status: "active",
  acquisitionChannel: CHANNEL_BLOB,
  outputs: [],
  charts: [],
  entities: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

beforeEach(() => {
  vi.mocked(db.query.features.findMany).mockReset();
  __resetChannelCatalogueCache();
});

describe("the public catalogue states a PER-FUNNEL minimum commitment", () => {
  it("GET /public/channels — each sellable funnel carries its own commitment, null = none", async () => {
    vi.mocked(db.query.features.findMany).mockImplementation((async () => [FEATURE_ROW("sales-cold-email-outreach")]) as never);
    const res = await request(app).get("/public/channels");
    expect(res.status).toBe(200);
    const funnels = res.body.channels[0].salesFunnels as Array<{ key: string; minimumCommitmentDays: number | null }>;
    expect(funnels).toHaveLength(4);
    expect(funnels.find((f) => f.key === CONVERSATION)!.minimumCommitmentDays).toBe(30);
    for (const key of ["sales_meetings_from_website", "website_purchases", FORM]) {
      expect(funnels.find((f) => f.key === key)!.minimumCommitmentDays).toBeNull();
    }
    // The CHANNEL's own terms stand beside it, unchanged.
    expect(res.body.channels[0].terms.minimumCommitmentDays).toBe(30);
  });

  it("GET /public/channel-funnel-economics — every pair row carries the funnel's commitment", async () => {
    vi.mocked(db.query.features.findMany).mockImplementation((async () => [FEATURE_ROW("sales-cold-email-outreach")]) as never);
    const res = await request(app).get("/public/channel-funnel-economics");
    expect(res.status).toBe(200);
    const rows = res.body.pairs as Array<{ funnelKey: string; minimumCommitmentDays: number | null; result: { measured: boolean } }>;
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.funnelKey === CONVERSATION)!.minimumCommitmentDays).toBe(30);
    for (const key of ["sales_meetings_from_website", "website_purchases", FORM]) {
      expect(rows.find((r) => r.funnelKey === key)!.minimumCommitmentDays).toBeNull();
    }
    // An unmeasured pair still states the commercial term — it does not wait on the economics.
    expect(rows.every((r) => r.result.measured === false)).toBe(true);
  });
});
