import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * Wave C4 guard for `GET /public/stats/outcome-return-on-spend` — the funnel-keyed realized median,
 * re-keyed per (channel × leg) and (channel × outcome). The same brand rows the funnel read takes its
 * median over, grouped by the legs their campaigns are bought for: a population of one-path brands
 * reads the byte-same figures under both.
 */

const mockFindMany = vi.fn(async () => [] as unknown[]);
vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: (...a: unknown[]) => mockFindMany(...(a as [])) } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

const CONVERSATION = "sales_meetings_from_conversation";
const WEBSITE_MEETING = "sales_meetings_from_website";
const step = (key: string) => ({ key, label: key, description: "" });
const CHANNELS = [
  {
    slug: "sales-cold-email-outreach",
    name: "Cold Email",
    stepTransitions: [
      { legKey: "start_to_conversation", from: null, to: step("conversation") },
      { legKey: "start_to_website_visit", from: null, to: step("website_visit") },
    ],
    salesFunnels: [
      { key: CONVERSATION, name: "c", steps: [] },
      { key: WEBSITE_MEETING, name: "w", steps: [] },
    ],
  },
];
vi.mock("../lib/channel-catalogue.js", () => ({
  buildChannelCatalogue: () => CHANNELS,
  channelStepCatalogue: () => [],
  funnelLegCatalogue: () => [],
  salesFunnelCatalogue: () => [],
}));

const brand = (brandId: string, legKeys: string[] | undefined, multiple: number) => ({
  brandId,
  committedSpendUsd: 1000,
  expectedPipelineUsd: 1000 * multiple,
  expectedPaidClients: 2,
  ...(legKeys === undefined ? {} : { legKeys }),
});
const ROWS = [
  brand("b1", ["start_to_conversation"], 1.8),
  brand("b2", ["start_to_conversation"], 2),
  brand("b3", ["start_to_conversation"], 2.2),
  brand("b4", ["start_to_conversation"], 0.02),
  brand("b5", ["start_to_website_visit"], 5),
];
const mockReadChannel = vi.fn();
vi.mock("../lib/fleet-return-store.js", () => ({
  readFleetReturnSnapshotSoft: (...a: unknown[]) => mockReadChannel(...a),
  writeFleetReturnSnapshotSoft: vi.fn(async () => {}),
}));
const mockReadFunnel = vi.fn();
vi.mock("../lib/fleet-funnel-return-store.js", () => ({
  readFleetFunnelReturnSnapshotsSoft: (...a: unknown[]) => mockReadFunnel(...a),
  writeFleetFunnelReturnSnapshotSoft: vi.fn(async () => {}),
}));
vi.mock("../lib/feature-memberships-client.js", () => ({ fetchFeatureMemberships: vi.fn(async () => []) }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockReadChannel.mockResolvedValue({ brands: ROWS, computedAt: new Date() });
  // The funnel snapshot of the SAME brands: each sells one path, so its funnel row IS its channel row.
  mockReadFunnel.mockResolvedValue(
    new Map([
      [
        "sales-cold-email-outreach",
        {
          rows: ROWS.map((r) => ({ ...r, funnelKey: r.legKeys?.[0] === "start_to_conversation" ? CONVERSATION : WEBSITE_MEETING })),
          computedAt: new Date(),
        },
      ],
    ]),
  );
});

type Figures = { measured: boolean; reason: string | null; brandCount: number; medianReturnPerDollar: number | null; medianCostPerPaidClientUsd: number | null };

describe("GET /public/stats/outcome-return-on-spend", () => {
  it("a leg of one-path brands reads the byte-same median as the funnel read's pair", async () => {
    const funnel = await request(app).get("/public/stats/funnel-return-on-spend?minSpendUsd=0");
    const res = await request(app).get("/public/stats/outcome-return-on-spend?minSpendUsd=0");
    expect(res.status).toBe(200);
    const pair = (funnel.body.pairs as Array<Figures & { funnelKey: string }>).find((p) => p.funnelKey === CONVERSATION)!;
    const ch = res.body.channels[0] as { legs: Array<Figures & { legKey: string }>; outcomes: Array<Figures & { step: { key: string }; legKeys: string[] }> };
    const leg = ch.legs.find((l) => l.legKey === "start_to_conversation")!;
    const outcome = ch.outcomes.find((o) => o.step.key === "conversation")!;
    for (const f of [leg, outcome]) {
      expect(f.measured).toBe(true);
      expect(f.brandCount).toBe(pair.brandCount);
      expect(f.medianReturnPerDollar).toBe(pair.medianReturnPerDollar);
      expect(f.medianCostPerPaidClientUsd).toBe(pair.medianCostPerPaidClientUsd);
    }
    // A thin leg says so, while its neighbour answers — never widened.
    const web = ch.legs.find((l) => l.legKey === "start_to_website_visit")!;
    expect([web.measured, web.reason, web.brandCount]).toEqual([false, "not_enough_brands", 1]);
    expect(res.body.costBasis).toBe("charged");
    const keys: string[] = [];
    JSON.stringify(res.body, (k, v) => (keys.push(k), v));
    expect(keys.filter((k) => /funnel/i.test(k))).toEqual([]);
  });

  it("a snapshot written before legs were recorded says so, not 'not enough brands'", async () => {
    mockReadChannel.mockResolvedValue({ brands: ROWS.map(({ legKeys: _l, ...r }) => r), computedAt: new Date() });
    const res = await request(app).get("/public/stats/outcome-return-on-spend");
    expect(res.body.channels[0].legs[0].reason).toBe("legs_not_recorded_yet");
  });

  it("no snapshot → no_snapshot_yet; a bad floor is 400; an unknown channel is 404", async () => {
    mockReadChannel.mockResolvedValue(null);
    const res = await request(app).get("/public/stats/outcome-return-on-spend");
    expect(res.body.channels[0].outcomes[0].reason).toBe("no_snapshot_yet");
    expect((await request(app).get("/public/stats/outcome-return-on-spend?minSpendUsd=-1")).status).toBe(400);
    expect((await request(app).get("/public/stats/outcome-return-on-spend?channelSlug=nope")).status).toBe(404);
  });
});
