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
    expect(n).toBe(8);
    // Asked on the legs' computation spelling: the served outbound one reads as an unknown leg (no maturity).
    expect(ranking.readLegWorkflowRanking.mock.calls.map((c: unknown[]) => c[1]).sort()).toEqual(["conversation_to_meeting_booked", "start_to_conversation", "start_to_website_visit"]);
    const [points] = store.recordFleetIndexPoints.mock.calls[0];
    const bySlug = new Map(points.map((p: { indexSlug: string }) => [p.indexSlug, p]));
    expect((bySlug.get("sceo-cost-per-meeting") as { value: number }).value).toBeCloseTo(128.8 / 0.25 + 17, 6);
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
    expect(points.map((p: { indexSlug: string }) => p.indexSlug).sort()).toEqual(["sceo-cost-per-interest", "sceo-interest-rate"]);
  });
});
