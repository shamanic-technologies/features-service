import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * Guard suite for `GET /public/stats/funnel-return-on-spend` — the per-(channel × funnel) median return
 * the offer page's "other ways to sell this offer" cards read.
 *
 * Each property is a way this could silently fail:
 *   • it answers with NO identity of any kind — the page is public;
 *   • EVERY pair in the catalogue is listed, measured or not, so an unmeasured pair can never read as
 *     "this channel does not sell this funnel";
 *   • a pair below the brand bar answers `not_enough_brands` and NOTHING widens the population to make
 *     a number appear — not a neighbouring funnel, not the channel;
 *   • one funnel's population is that funnel's rows and nobody else's;
 *   • the spend floor is a parameter of the QUESTION, so one snapshot answers at any floor;
 *   • it NEVER awaits the heavy compute, cold or stale;
 *   • a bad floor is a 400 and an unknown channel is a 404, never a quiet empty answer.
 */

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn(async () => [] as unknown[]);

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: { findFirst: (...a: unknown[]) => mockFindFirst(...a), findMany: (...a: unknown[]) => mockFindMany() },
    },
  },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

const CONVERSATION = "sales_meetings_from_conversation";
const WEBSITE_MEETING = "sales_meetings_from_website";

/** Two channels: the cold-email one (which the warm covers) and a channel selling the same two funnels. */
const CHANNELS = [
  {
    slug: "sales-cold-email-outreach",
    name: "Cold Email",
    salesFunnels: [
      { key: CONVERSATION, name: "Sales meetings from a conversation", steps: ["Positive reply", "Meeting booked", "Paid client"] },
      { key: WEBSITE_MEETING, name: "Sales meetings from the website", steps: ["Website visit", "Meeting booked", "Paid client"] },
    ],
  },
  {
    slug: "agency-meeting-booking",
    name: "Agency Meeting Booking",
    salesFunnels: [
      { key: CONVERSATION, name: "Sales meetings from a conversation", steps: ["Positive reply", "Meeting booked", "Paid client"] },
    ],
  },
];

vi.mock("../lib/channel-catalogue.js", () => ({
  buildChannelCatalogue: () => CHANNELS,
  channelStepCatalogue: () => [],
  funnelLegCatalogue: () => [],
}));

const mockReadSnapshots = vi.fn();
vi.mock("../lib/fleet-funnel-return-store.js", () => ({
  readFleetFunnelReturnSnapshotsSoft: (...a: unknown[]) => mockReadSnapshots(...a),
  writeFleetFunnelReturnSnapshotSoft: vi.fn(async () => {}),
}));
vi.mock("../lib/fleet-return-store.js", () => ({
  readFleetReturnSnapshotSoft: vi.fn(async () => null),
  writeFleetReturnSnapshotSoft: vi.fn(async () => {}),
}));

/** The warm's only downstream on this path — an empty membership set keeps the engine out of the test. */
const mockFetchMemberships = vi.fn(async () => [] as unknown[]);
vi.mock("../lib/feature-memberships-client.js", () => ({
  fetchFeatureMemberships: (...a: unknown[]) => mockFetchMemberships(...(a as [])),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const { __awaitFleetReturnWarm } = await import("./public.js");

const PATH = "/public/stats/funnel-return-on-spend";

/** One brand's stored row for a funnel: spent `spend`, returns `spend × multiple`, off `clients`. */
const row = (brandId: string, funnelKey: string, spend: number, multiple: number | null, clients: number | null = 1) => ({
  brandId,
  funnelKey,
  committedSpendUsd: spend,
  expectedPipelineUsd: multiple === null ? null : spend * multiple,
  expectedPaidClients: clients,
});

/** Today's production shape: conversation n=4 near 2x, website-meeting n=1. */
const PROD_SHAPE = [
  row("b1", CONVERSATION, 1000, 1.8),
  row("b2", CONVERSATION, 1000, 2),
  row("b3", CONVERSATION, 1000, 2.2),
  row("b4", CONVERSATION, 1000, 0.02),
  row("b5", WEBSITE_MEETING, 1000, 5),
];

function snapshotOf(rows: unknown[], computedAt = new Date()) {
  return new Map([["sales-cold-email-outreach", { rows, computedAt }]]);
}

const pairOf = (body: { pairs: Array<Record<string, unknown>> }, channelSlug: string, funnelKey: string) =>
  body.pairs.find((p) => p.channelSlug === channelSlug && p.funnelKey === funnelKey)!;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockFetchMemberships.mockResolvedValue([]);
  mockReadSnapshots.mockResolvedValue(snapshotOf(PROD_SHAPE));
});

describe("GET /public/stats/funnel-return-on-spend", () => {
  it("answers with NO identity of any kind — the consumer is a public page", async () => {
    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body.costBasis).toBe("charged");
    expect(res.body.unit).toBe("brand");
    await __awaitFleetReturnWarm();
  });

  it("states the conversation funnel's median around 2x, and the mean would have said otherwise", async () => {
    const res = await request(app).get(PATH);
    const pair = pairOf(res.body, "sales-cold-email-outreach", CONVERSATION);
    expect(pair.measured).toBe(true);
    expect(pair.reason).toBeNull();
    // Returns 0.02, 1.8, 2, 2.2 → median 1.9. The MEAN is 1.505, dragged by the one near-zero brand —
    // which is exactly the failure of the projected surface beside this one.
    expect(pair.medianReturnPerDollar as number).toBeCloseTo(1.9, 10);
    expect(pair.brandCount).toBe(4);
    expect(pair.minReturnPerDollar as number).toBeCloseTo(0.02, 10);
    expect(pair.maxReturnPerDollar as number).toBeCloseTo(2.2, 10);
    await __awaitFleetReturnWarm();
  });

  it("answers the one-brand funnel UNMEASURED, and never borrows the funnel beside it", async () => {
    const res = await request(app).get(PATH);
    const pair = pairOf(res.body, "sales-cold-email-outreach", WEBSITE_MEETING);
    expect(pair.measured).toBe(false);
    expect(pair.reason).toBe("not_enough_brands");
    expect(pair.brandCount).toBe(1);
    expect(pair.medianReturnPerDollar).toBeNull();
    expect(pair.medianCostPerPaidClientUsd).toBeNull();
    // The measured neighbour on the SAME channel proves nothing was pooled to rescue this pair.
    expect(pairOf(res.body, "sales-cold-email-outreach", CONVERSATION).measured).toBe(true);
    await __awaitFleetReturnWarm();
  });

  it("keeps each funnel's population to ITS OWN rows — one funnel's brands never price another", async () => {
    // Five brands on the website-meeting funnel at 5x, four on the conversation funnel near 2x.
    mockReadSnapshots.mockResolvedValue(
      snapshotOf([
        ...PROD_SHAPE,
        row("b6", WEBSITE_MEETING, 1000, 5),
        row("b7", WEBSITE_MEETING, 1000, 5),
      ]),
    );
    const res = await request(app).get(PATH);
    expect(pairOf(res.body, "sales-cold-email-outreach", WEBSITE_MEETING).medianReturnPerDollar as number).toBeCloseTo(5, 10);
    expect(pairOf(res.body, "sales-cold-email-outreach", CONVERSATION).medianReturnPerDollar as number).toBeCloseTo(1.9, 10);
    await __awaitFleetReturnWarm();
  });

  it("lists EVERY pair in the catalogue — a channel with no snapshot says so rather than being absent", async () => {
    const res = await request(app).get(PATH);
    expect(res.body.pairs).toHaveLength(3);
    const other = pairOf(res.body, "agency-meeting-booking", CONVERSATION);
    expect(other.measured).toBe(false);
    expect(other.reason).toBe("no_snapshot_yet");
    expect(other.computedAt).toBeNull();
    // A pair renders without the consumer knowing the catalogue.
    expect(other.funnelName).toBe("Sales meetings from a conversation");
    expect(other.funnelSteps).toEqual(["Positive reply", "Meeting booked", "Paid client"]);
    await __awaitFleetReturnWarm();
  });

  it("makes the spend floor a parameter of the QUESTION — one snapshot, two answers", async () => {
    mockReadSnapshots.mockResolvedValue(
      snapshotOf([
        row("s1", CONVERSATION, 50, 10),
        row("s2", CONVERSATION, 60, 10),
        row("s3", CONVERSATION, 70, 10),
        ...PROD_SHAPE.filter((r) => r.funnelKey === CONVERSATION),
      ]),
    );
    const high = await request(app).get(`${PATH}?minSpendUsd=100`);
    expect(pairOf(high.body, "sales-cold-email-outreach", CONVERSATION).brandCount).toBe(4);
    expect(high.body.minSpendUsd).toBe(100);

    const low = await request(app).get(`${PATH}?minSpendUsd=10`);
    const lowPair = pairOf(low.body, "sales-cold-email-outreach", CONVERSATION);
    expect(lowPair.brandCount).toBe(7);
    expect(lowPair.medianReturnPerDollar as number).toBeCloseTo(2.2, 10);
    // ONE snapshot answered both floors — no recompute was needed to move the population.
    expect(mockFetchMemberships).not.toHaveBeenCalled();
    await __awaitFleetReturnWarm();
  });

  it("narrows to one channel, and 404s an unknown one rather than answering an empty list", async () => {
    const ok = await request(app).get(`${PATH}?channelSlug=agency-meeting-booking`);
    expect(ok.status).toBe(200);
    expect(ok.body.channelSlug).toBe("agency-meeting-booking");
    expect(ok.body.pairs).toHaveLength(1);

    const missing = await request(app).get(`${PATH}?channelSlug=nope`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("nope");
    await __awaitFleetReturnWarm();
  });

  it("400s a floor it cannot read, and never falls back to the default", async () => {
    for (const bad of ["abc", "-1"]) {
      const res = await request(app).get(`${PATH}?minSpendUsd=${bad}`);
      expect(res.status).toBe(400);
    }
    await __awaitFleetReturnWarm();
  });

  it("NEVER awaits the compute — a cold read answers now and kicks the warm behind it", async () => {
    mockReadSnapshots.mockResolvedValue(new Map());
    let released: (() => void) | undefined;
    mockFetchMemberships.mockImplementation(
      () => new Promise((resolve) => { released = () => resolve([]); }),
    );

    const res = await request(app).get(PATH);
    expect(res.status).toBe(200);
    expect(pairOf(res.body, "sales-cold-email-outreach", CONVERSATION).reason).toBe("no_snapshot_yet");
    // The warm was kicked for the cold-email channel and is still running — the answer did not wait.
    expect(mockFetchMemberships).toHaveBeenCalledTimes(1);
    released?.();
    await __awaitFleetReturnWarm();
  });

  it("does NOT kick a warm for a channel the boot warm never covers", async () => {
    mockReadSnapshots.mockResolvedValue(new Map());
    await request(app).get(`${PATH}?channelSlug=agency-meeting-booking`);
    expect(mockFetchMemberships).not.toHaveBeenCalled();
    await __awaitFleetReturnWarm();
  });

  it("serves a FRESH snapshot without kicking anything", async () => {
    await request(app).get(PATH);
    expect(mockFetchMemberships).not.toHaveBeenCalled();
    await __awaitFleetReturnWarm();
  });

  it("kicks a refresh behind a STALE snapshot while still answering from it", async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    mockReadSnapshots.mockResolvedValue(snapshotOf(PROD_SHAPE, old));
    const res = await request(app).get(PATH);
    const pair = pairOf(res.body, "sales-cold-email-outreach", CONVERSATION);
    expect(pair.measured).toBe(true);
    expect(pair.computedAt).toBe(old.toISOString());
    expect(mockFetchMemberships).toHaveBeenCalledTimes(1);
    await __awaitFleetReturnWarm();
  });

  it("states the median cost per paying client on its own count", async () => {
    mockReadSnapshots.mockResolvedValue(
      snapshotOf([
        row("c1", CONVERSATION, 1000, 2, 10),
        row("c2", CONVERSATION, 1000, 2, 5),
        row("c3", CONVERSATION, 1000, 2, 2),
        row("c4", CONVERSATION, 1000, 2, null),
      ]),
    );
    const res = await request(app).get(PATH);
    const pair = pairOf(res.body, "sales-cold-email-outreach", CONVERSATION);
    // 100, 200, 500 → 200. The fourth brand states no lifetime revenue and is in the return only.
    expect(pair.medianCostPerPaidClientUsd as number).toBeCloseTo(200, 6);
    expect(pair.costPerPaidClientBrandCount).toBe(3);
    expect(pair.brandCount).toBe(4);
    await __awaitFleetReturnWarm();
  });
});
