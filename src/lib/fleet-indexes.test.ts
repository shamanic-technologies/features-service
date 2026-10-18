import { describe, expect, it } from "vitest";
import { computeFleetIndexPoints, FLEET_INDEXES, indexStatus, weakestStatus } from "./fleet-indexes.js";
import type { LegWorkflowRankingRow } from "./leg-workflow-ranking.js";

function row(over: Partial<LegWorkflowRankingRow>): LegWorkflowRankingRow {
  return {
    rank: 1,
    workflowDynastySlug: "sales-cold-email-outreach-x",
    workflowDynastyName: "X",
    assignment: "active",
    executable: true,
    selectable: true,
    isMature: true,
    basis: "mature",
    costPerOutcomeUsd: 4,
    conversionRatePct: 2,
    outcomes: 15,
    contacted: 720,
    spentUsd: 60,
    roiMultiple: null,
    goesFirst: true,
    moneyGoesHere: true,
    explorePriceUsd: null,
    place: "money",
    ...over,
  };
}

const byslug = (points: ReturnType<typeof computeFleetIndexPoints>) => new Map(points.map((p) => [p.indexSlug, p]));

describe("fleet indexes", () => {
  it("status: noise under 10 outcomes or not mature, signal under 30, robust from 30", () => {
    expect(indexStatus(9, true)).toBe("noise");
    expect(indexStatus(50, false)).toBe("noise");
    expect(indexStatus(10, true)).toBe("signal");
    expect(indexStatus(29, true)).toBe("signal");
    expect(indexStatus(30, true)).toBe("robust");
    expect(weakestStatus("robust", "noise")).toBe("noise");
    expect(weakestStatus("signal", "robust")).toBe("signal");
  });

  it("a leg index reads the row the money goes to, never a learning or retired one", () => {
    const visitRows = [
      row({ workflowDynastySlug: "learning", basis: "flash", isMature: false, moneyGoesHere: false, costPerOutcomeUsd: 0.1, outcomes: 2 }),
      row({ workflowDynastySlug: "rampart", costPerOutcomeUsd: 4.35, conversionRatePct: 2.08, outcomes: 15, contacted: 720 }),
    ];
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: visitRows, positiveReplyRows: null, meetingFromReply: null }));
    expect(p.get("sceo-cost-per-click")).toMatchObject({ value: 4.35, status: "signal", outcomes: 15, contacted: 720, workflowDynastySlug: "rampart" });
    expect(p.get("sceo-click-rate")).toMatchObject({ value: 2.08, status: "signal" });
    // An unreadable input records nothing (never a null pretending to be a measure).
    expect(p.has("sceo-cost-per-interest")).toBe(false);
    expect(p.has("sceo-cost-per-meeting")).toBe(false);
  });

  it("no mature workflow that can run = a null value with its reason, status noise", () => {
    const rows = [row({ moneyGoesHere: false, basis: "flash", isMature: false })];
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: rows, meetingFromReply: null }));
    expect(p.get("sceo-cost-per-interest")).toMatchObject({ value: null, status: "noise", unavailableReason: "no_mature_workflow" });
  });

  it("meeting indexes chain the reply index through the fleet's measured reply -> meeting rate", () => {
    const replyRows = [row({ workflowDynastySlug: "azalea", costPerOutcomeUsd: 128.8, conversionRatePct: 0.15, outcomes: 5, contacted: 3423 })];
    const p = byslug(
      computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: replyRows, meetingFromReply: { positiveReplyPeople: 48, bookedPeople: 8, brandCount: 5 } }),
    );
    expect(p.get("sceo-cost-per-meeting")!.value).toBeCloseTo(128.8 / (8 / 48), 6);
    expect(p.get("sceo-meeting-rate")!.value).toBeCloseTo(0.15 * (8 / 48), 6);
    expect(p.get("sceo-cost-per-meeting")).toMatchObject({ status: "noise", outcomes: 5, contacted: null, workflowDynastySlug: "azalea" });
    expect(p.get("sceo-cost-per-meeting")!.inputs).toMatchObject({ positiveReplyPeople: 48, meetingsBookedPeople: 8, brandCount: 5 });
  });

  it("a chain is as trustworthy as its weakest link", () => {
    const replyRows = [row({ outcomes: 40 })];
    const p = byslug(
      computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: replyRows, meetingFromReply: { positiveReplyPeople: 100, bookedPeople: 12, brandCount: 3 } }),
    );
    expect(p.get("sceo-cost-per-interest")!.status).toBe("robust");
    expect(p.get("sceo-cost-per-meeting")!.status).toBe("signal");
  });

  it("no meeting ever booked = null meeting index, never infinite", () => {
    const p = byslug(
      computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: [row({})], meetingFromReply: { positiveReplyPeople: 20, bookedPeople: 0, brandCount: 2 } }),
    );
    expect(p.get("sceo-cost-per-meeting")).toMatchObject({ value: null, unavailableReason: "no_meeting_measured", status: "noise" });
  });

  it("every index has a unique slug and states its unit", () => {
    expect(new Set(FLEET_INDEXES.map((d) => d.slug)).size).toBe(FLEET_INDEXES.length);
    for (const d of FLEET_INDEXES) expect(d.unit).toBe(d.metric === "cost_per_outcome" ? "usd" : "percent");
  });
});
