import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const store = vi.hoisted(() => ({
  readLatestFleetIndexPoints: vi.fn(),
  readFleetIndexSeries: vi.fn(),
  recordFleetIndexPoints: vi.fn(),
}));
vi.mock("../lib/fleet-index-store.js", () => store);
const ranking = vi.hoisted(() => ({
  readLegWorkflowRanking: vi.fn(),
  // Unreadable unless a test says otherwise: an unreadable input records nothing.
  readPublicRanked: vi.fn(async (): Promise<unknown> => {
    throw new Error("ranked read not under test");
  }),
  readFleetReturnOnSpend: vi.fn(async (): Promise<unknown> => ({ measured: false, reason: "no_snapshot_yet", brandCount: 0, minSpendUsd: 100, medianReturnPerDollar: null })),
}));
vi.mock("./public.js", () => ranking);
const meeting = vi.hoisted(() => ({ getInternalPipeFleet: vi.fn() }));
vi.mock("../lib/meeting-leg-fleet.js", () => ({ ...meeting, MEETING_BOOKING_FEATURE_SLUG: "ai-meeting-booking", MEETING_BOOKING_LEG_KEY: "conversation_to_meeting_booked" }));

const { default: router, recordFleetIndexesNow } = await import("./fleet-indexes.js");
const app = express().use(router);

function pointRow(indexSlug: string, day: string, value: number | null) {
  return {
    id: `${indexSlug}-${day}`,
    indexSlug,
    day,
    value,
    status: "signal",
    outcomes: 15,
    contacted: 720,
    workflowDynastySlug: "sales-cold-email-outreach-rampart",
    workflowDynastyName: "Sales Cold Email Outreach Rampart",
    unavailableReason: null,
    inputs: { spentUsd: 65 },
    basis: "recorded",
    recordedAt: new Date(`${day}T12:00:00Z`),
  };
}

function rankingRow(over: Record<string, unknown>) {
  return {
    rank: 1, workflowDynastySlug: "w", workflowDynastyName: "W", assignment: "active", executable: true, selectable: true,
    isMature: true, basis: "mature", costPerOutcomeUsd: 4.35, conversionRatePct: 2.08, outcomes: 15, contacted: 720, spentUsd: 65,
    roiMultiple: null, goesFirst: true, moneyGoesHere: true, explorePriceUsd: null, place: "money", ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /public/indexes", () => {
  it("lists every index with its latest value; one never recorded reads not_recorded_yet, never 0", async () => {
    store.readLatestFleetIndexPoints.mockResolvedValue([pointRow("cold-email-cost-per-click", "2026-10-18", 4.35)]);
    const res = await request(app).get("/public/indexes");
    expect(res.status).toBe(200);
    expect(res.body.statusRule).toEqual({ signalMinOutcomes: 10, robustMinOutcomes: 30 });
    const bySlug = new Map(res.body.indexes.map((i: { slug: string }) => [i.slug, i]));
    expect(bySlug.size).toBe(8);
    expect(bySlug.get("cold-email-cost-per-click")).toMatchObject({ value: 4.35, unit: "usd", valuePer: "per website visit", status: "signal", day: "2026-10-18" });
    expect(bySlug.get("cold-email-meeting-rate")).toMatchObject({ value: null, status: "noise", unavailableReason: "not_recorded_yet", day: null });
  });
});

describe("GET /public/indexes/:slug", () => {
  it("serves the series oldest first, the summary on the last day", async () => {
    store.readFleetIndexSeries.mockResolvedValue([pointRow("cold-email-click-rate", "2026-10-18", 2.08), pointRow("cold-email-click-rate", "2026-10-19", 2.1)]);
    const res = await request(app).get("/public/indexes/cold-email-click-rate");
    expect(res.status).toBe(200);
    expect(res.body.index).toMatchObject({ slug: "cold-email-click-rate", value: 2.1, unit: "percent", day: "2026-10-19" });
    expect(res.body.points.map((p: { day: string }) => p.day)).toEqual(["2026-10-18", "2026-10-19"]);
    expect(res.body.points[0]).toMatchObject({ value: 2.08, basis: "recorded", status: "signal" });
  });

  it("labels a recomputed day apart from a recorded one (INDEX-HISTORY-BACKFILL-1019)", async () => {
    store.readFleetIndexSeries.mockResolvedValue([{ ...pointRow("cold-email-click-rate", "2026-09-01", 1.5), basis: "recomputed" }, pointRow("cold-email-click-rate", "2026-10-18", 2.08)]);
    const res = await request(app).get("/public/indexes/cold-email-click-rate");
    expect(res.status).toBe(200);
    expect(res.body.points.map((p: { basis: string }) => p.basis)).toEqual(["recomputed", "recorded"]);
    expect(res.body.basisRule.recorded).toMatch(/live/);
    expect(res.body.basisRule.recomputed).toMatch(/end of that day/);
  });

  it("404 on an unknown index", async () => {
    const res = await request(app).get("/public/indexes/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("index_not_found");
  });

  it("serves the six SEO slugs with the positive reply names; a retired sceo-* slug is not found (INDEX-SLUGS-SEO-1019)", async () => {
    store.readLatestFleetIndexPoints.mockResolvedValue([]);
    const list = await request(app).get("/public/indexes");
    expect(list.body.indexes.map((i: { slug: string; name: string }) => [i.slug, i.name])).toEqual([
      ["cold-email-cost-per-click", "Cold Email Cost Per Click Index"],
      ["cold-email-click-rate", "Cold Email Click Rate Index"],
      ["cold-email-cost-per-positive-reply", "Cold Email Cost Per Positive Reply Index"],
      ["cold-email-positive-reply-rate", "Cold Email Positive Reply Rate Index"],
      ["cold-email-cost-per-meeting", "Cold Email Cost Per Meeting Index"],
      ["cold-email-meeting-rate", "Cold Email Meeting Rate Index"],
      ["cold-email-cost-per-engaged-lead", "Cold Email Cost Per Engaged Lead Index"],
      ["cold-email-roi", "Cold Email ROI Index"],
    ]);
    expect(JSON.stringify(list.body.indexes)).not.toMatch(/Distribute\.you/);
    expect(JSON.stringify(list.body.indexes)).not.toMatch(/interest/i);
    const old = await request(app).get("/public/indexes/sceo-cost-per-click");
    expect(old.status).toBe(404);
    expect(old.body.error).toBe("index_not_found");
  });
});

describe("recording", () => {
  it("records every index from the three pipes' rankings, and the meeting pipe's Research points", async () => {
    ranking.readLegWorkflowRanking.mockImplementation(async (_f: string, leg: string) => ({
      computedAt: "2026-10-18T12:00:00Z",
      rows: [
        leg === "start_to_website_visit"
          ? rankingRow({})
          : leg === "conversation_to_meeting_booked"
            ? rankingRow({ workflowDynastySlug: "rhodium", basis: "flash", isMature: false, moneyGoesHere: false, spentUsd: 51, contacted: 12, outcomes: 3 })
            : rankingRow({ costPerOutcomeUsd: 128.8, conversionRatePct: 0.15, outcomes: 5 }),
      ],
    }));
    meeting.getInternalPipeFleet.mockResolvedValue({
      pooled: { spentUsd: 60, contacted: 20, outcomes: 3, spentByDynasty: {} },
      byOrg: [
        { orgId: "a", spentUsd: 40, contacted: 12, outcomes: 3 },
        { orgId: "b", spentUsd: 20, contacted: 8, outcomes: 0 },
      ],
    });
    const n = await recordFleetIndexesNow(new Date("2026-10-18T13:00:00Z"));
    // 6 pipe indexes + 2 meeting Research points; the client indexes' inputs are unreadable here.
    expect(n).toBe(8);
    // Asked on the legs' computation spelling: the served outbound one reads as an unknown leg (no maturity).
    expect(ranking.readLegWorkflowRanking.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(["conversation_to_meeting_booked", "start_to_conversation", "start_to_website_visit"]);
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    const bySlug = new Map(points.map((p: { indexSlug: string }) => [p.indexSlug, p]));
    expect((bySlug.get("cold-email-cost-per-meeting") as { value: number }).value).toBeCloseTo(128.8 / 0.25 + 17, 6);
    expect(bySlug.get("research:meeting-booking:best-workflow")).toMatchObject({ value: 17, workflowDynastySlug: "rhodium", outcomes: 3 });
    // two clients: $13.33 and no meeting (the most expensive) -> the median client has no meeting
    expect(bySlug.get("research:meeting-booking:client-median")).toMatchObject({ value: null, unavailableReason: "median_client_has_no_meeting" });
  });

  it("an unreadable ranking records none of its indexes (no fake point)", async () => {
    ranking.readLegWorkflowRanking.mockImplementation(async (_f: string, leg: string) =>
      leg === "start_to_website_visit" ? null : { computedAt: "2026-10-18T12:00:00Z", rows: [rankingRow({})] },
    );
    meeting.getInternalPipeFleet.mockRejectedValue(new Error("lead-service down"));
    await recordFleetIndexesNow(new Date("2026-10-18T13:00:00Z"));
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    expect(points.map((p: { indexSlug: string }) => p.indexSlug).sort()).toEqual(["cold-email-cost-per-positive-reply", "cold-email-positive-reply-rate"]);
  });
});

describe("client indexes (INDEX-ENGAGED-ROI-1019)", () => {
  beforeEach(() => {
    ranking.readLegWorkflowRanking.mockResolvedValue(null);
    meeting.getInternalPipeFleet.mockResolvedValue(null);
  });

  it("records the hero's median cost per engaged lead and the median client ROI from the same reads the landing makes", async () => {
    ranking.readPublicRanked.mockResolvedValueOnce({
      costBasis: "incurred", objective: "emailsSent", sortDirection: "desc",
      results: [
        { brand: { id: "a", name: null, domain: null }, stats: { recipientsRepliesPositive: 2, recipientsClicked: 8, totalCostInUsdCents: 5000 } },
        { brand: { id: "b", name: null, domain: null }, stats: { recipientsRepliesPositive: 0, recipientsClicked: 4, totalCostInUsdCents: 6000 } },
        { brand: { id: "c", name: null, domain: null }, stats: { recipientsRepliesPositive: 1, recipientsClicked: 0, totalCostInUsdCents: 0 } },
      ],
    });
    ranking.readFleetReturnOnSpend.mockResolvedValueOnce({ measured: true, reason: null, brandCount: 12, minSpendUsd: 100, medianReturnPerDollar: 3.6 });
    const n = await recordFleetIndexesNow(new Date("2026-10-19T13:00:00Z"));
    expect(n).toBe(2);
    expect(ranking.readPublicRanked).toHaveBeenCalledWith("sales-cold-email-outreach", "emailsSent", "brand", 200);
    expect(ranking.readFleetReturnOnSpend).toHaveBeenCalledWith("sales-cold-email-outreach", 100);
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    const bySlug = new Map(points.map((p: { indexSlug: string }) => [p.indexSlug, p]));
    // a: $50 / 10 = $5, b: $60 / 4 = $15, c has no spend (out) -> median of [5, 15] = 10
    expect(bySlug.get("cold-email-cost-per-engaged-lead")).toMatchObject({ value: 10, outcomes: 2, status: "noise", inputs: { clients: 2, engagedLeads: 14 } });
    expect(bySlug.get("cold-email-roi")).toMatchObject({ value: 3.6, outcomes: 12, status: "signal", unavailableReason: null });
  });

  it("too few clients = a null value with its reason; a return not computed yet records nothing", async () => {
    ranking.readPublicRanked.mockResolvedValueOnce({ costBasis: "incurred", objective: "emailsSent", sortDirection: "desc", results: [{ stats: { recipientsClicked: 3, totalCostInUsdCents: 900 } }] });
    const n = await recordFleetIndexesNow(new Date("2026-10-19T13:00:00Z"));
    expect(n).toBe(1);
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    expect(points[0]).toMatchObject({ indexSlug: "cold-email-cost-per-engaged-lead", value: null, unavailableReason: "not_enough_clients" });
  });

  it("a return median below the brand bar is recorded as not measured, never a 0", async () => {
    ranking.readFleetReturnOnSpend.mockResolvedValueOnce({ measured: false, reason: "not_enough_brands", brandCount: 3, minSpendUsd: 100, medianReturnPerDollar: null });
    await recordFleetIndexesNow(new Date("2026-10-19T13:00:00Z"));
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    expect(points.find((p: { indexSlug: string }) => p.indexSlug === "cold-email-roi")).toMatchObject({ value: null, status: "noise", outcomes: 3, unavailableReason: "not_enough_brands" });
  });
});
