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
const ranking = vi.hoisted(() => ({ readLegWorkflowRanking: vi.fn() }));
vi.mock("./public.js", () => ranking);
const meeting = vi.hoisted(() => ({ fetchMeetingBookingBeforeAfter: vi.fn() }));
vi.mock("../lib/meeting-booking-before-after.js", () => meeting);

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
    store.readLatestFleetIndexPoints.mockResolvedValue([pointRow("sceo-cost-per-click", "2026-10-18", 4.35)]);
    const res = await request(app).get("/public/indexes");
    expect(res.status).toBe(200);
    expect(res.body.statusRule).toEqual({ signalMinOutcomes: 10, robustMinOutcomes: 30 });
    const bySlug = new Map(res.body.indexes.map((i: { slug: string }) => [i.slug, i]));
    expect(bySlug.size).toBe(6);
    expect(bySlug.get("sceo-cost-per-click")).toMatchObject({ value: 4.35, unit: "usd", valuePer: "per website visit", status: "signal", day: "2026-10-18" });
    expect(bySlug.get("sceo-meeting-rate")).toMatchObject({ value: null, status: "noise", unavailableReason: "not_recorded_yet", day: null });
  });
});

describe("GET /public/indexes/:slug", () => {
  it("serves the series oldest first, the summary on the last day", async () => {
    store.readFleetIndexSeries.mockResolvedValue([pointRow("sceo-click-rate", "2026-10-18", 2.08), pointRow("sceo-click-rate", "2026-10-19", 2.1)]);
    const res = await request(app).get("/public/indexes/sceo-click-rate");
    expect(res.status).toBe(200);
    expect(res.body.index).toMatchObject({ slug: "sceo-click-rate", value: 2.1, unit: "percent", day: "2026-10-19" });
    expect(res.body.points.map((p: { day: string }) => p.day)).toEqual(["2026-10-18", "2026-10-19"]);
    expect(res.body.points[0]).toMatchObject({ value: 2.08, basis: "recorded", status: "signal" });
  });

  it("404 on an unknown index", async () => {
    const res = await request(app).get("/public/indexes/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("index_not_found");
  });
});

describe("recording", () => {
  it("records every index from the two rankings + the meeting attribution", async () => {
    ranking.readLegWorkflowRanking.mockImplementation(async (_f: string, leg: string) => ({
      computedAt: "2026-10-18T12:00:00Z",
      rows: [leg === "start_to_website_visit" ? rankingRow({}) : rankingRow({ costPerOutcomeUsd: 128.8, conversionRatePct: 0.15, outcomes: 5 })],
    }));
    const win = (people: number, booked: number) => ({ positiveReplyPeople: people, bookedPeople: booked });
    meeting.fetchMeetingBookingBeforeAfter.mockResolvedValue({ fleet: { brandCount: 5, before: win(36, 6), after: win(12, 2) } });
    const n = await recordFleetIndexesNow(new Date("2026-10-18T13:00:00Z"));
    expect(n).toBe(6);
    // Asked on the legs' computation spelling: the served outbound one reads as an unknown leg (no maturity).
    expect(ranking.readLegWorkflowRanking.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(["start_to_conversation", "start_to_website_visit"]);
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    const meetingCost = points.find((p: { indexSlug: string }) => p.indexSlug === "sceo-cost-per-meeting");
    expect(meetingCost.value).toBeCloseTo(128.8 * 6, 6);
  });

  it("an unreadable ranking records none of its indexes (no fake point)", async () => {
    ranking.readLegWorkflowRanking.mockImplementation(async (_f: string, leg: string) =>
      leg === "start_to_website_visit" ? null : { computedAt: "2026-10-18T12:00:00Z", rows: [rankingRow({})] },
    );
    meeting.fetchMeetingBookingBeforeAfter.mockResolvedValue({ fleet: null });
    await recordFleetIndexesNow(new Date("2026-10-18T13:00:00Z"));
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    expect(points.map((p: { indexSlug: string }) => p.indexSlug).sort()).toEqual(["sceo-cost-per-interest", "sceo-interest-rate"]);
  });
});
