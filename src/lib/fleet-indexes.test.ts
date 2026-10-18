import { describe, expect, it } from "vitest";
import { bestMeetingPipePick, computeFleetIndexPoints, FLEET_INDEXES, indexStatus, weakestStatus, type MeetingPipeEvidence } from "./fleet-indexes.js";
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
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: visitRows, positiveReplyRows: null, meetingPipe: null }));
    expect(p.get("sceo-cost-per-click")).toMatchObject({ value: 4.35, status: "signal", outcomes: 15, contacted: 720, workflowDynastySlug: "rampart" });
    expect(p.get("sceo-click-rate")).toMatchObject({ value: 2.08, status: "signal" });
    // An unreadable input records nothing (never a null pretending to be a measure).
    expect(p.has("sceo-cost-per-interest")).toBe(false);
    expect(p.has("sceo-cost-per-meeting")).toBe(false);
  });

  it("no mature workflow that can run = a null value with its reason, status noise", () => {
    const rows = [row({ moneyGoesHere: false, basis: "flash", isMature: false })];
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: rows, meetingPipe: null }));
    expect(p.get("sceo-cost-per-interest")).toMatchObject({ value: null, status: "noise", unavailableReason: "no_mature_workflow" });
  });

  const mbRow = (over: Partial<LegWorkflowRankingRow>) =>
    row({ workflowDynastySlug: "ai-meeting-booking-rhodium", workflowDynastyName: "Rhodium", basis: "flash", isMature: false, moneyGoesHere: false, place: "explore", ...over });
  const noPool = { spentUsd: 0, contacted: 0, outcomes: 0, spentByDynasty: {} };

  it("MB-INDEX-PIPES-1018: cost per meeting = interest cost ÷ the best meeting workflow's rate + its cost per meeting", () => {
    const replyRows = [row({ workflowDynastySlug: "azalea", costPerOutcomeUsd: 182, conversionRatePct: 0.15, outcomes: 5, contacted: 3423 })];
    const meetingPipe: MeetingPipeEvidence = {
      rows: [mbRow({ workflowDynastySlug: "torcular", spentUsd: 20, contacted: 10, outcomes: 1 }), mbRow({ spentUsd: 17 * 3, contacted: 12, outcomes: 3 })],
      pooled: { spentUsd: 1000, contacted: 100, outcomes: 50, spentByDynasty: {} },
    };
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: replyRows, meetingPipe }));
    // rhodium: $17 per meeting, 25% of positive replies booked (cheaper than torcular's $20)
    expect(p.get("sceo-cost-per-meeting")!.value).toBeCloseTo(182 / 0.25 + 17, 6);
    expect(p.get("sceo-meeting-rate")!.value).toBeCloseTo(0.15 * 0.25, 6);
    expect(p.get("sceo-cost-per-meeting")).toMatchObject({ status: "noise", outcomes: 3, contacted: null, workflowDynastySlug: "azalea" });
    expect(p.get("sceo-cost-per-meeting")!.inputs).toMatchObject({
      interestWorkflowDynastySlug: "azalea",
      meetingWorkflowDynastySlug: "ai-meeting-booking-rhodium",
      meetingPipeSource: "best_workflow_learning",
      meetingsBooked: 3,
      positiveRepliesActedOn: 12,
      interestToMeetingPct: 25,
      meetingPipeCostPerMeetingUsd: 17,
      population: "brands_reporting_meetings",
    });
  });

  it("a mature meeting workflow wins; the chain is as trustworthy as its weakest link", () => {
    const replyRows = [row({ outcomes: 40 })];
    const meetingPipe: MeetingPipeEvidence = {
      rows: [mbRow({ basis: "mature", isMature: true, moneyGoesHere: true, spentUsd: 120, contacted: 60, outcomes: 12 }), mbRow({ workflowDynastySlug: "cheap", spentUsd: 1, contacted: 2, outcomes: 1 })],
      pooled: noPool,
    };
    expect(bestMeetingPipePick(meetingPipe)).toMatchObject({ source: "mature_workflow", mature: true, costPerMeetingUsd: 10, ratePct: 20 });
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: replyRows, meetingPipe }));
    expect(p.get("sceo-cost-per-interest")!.status).toBe("robust");
    expect(p.get("sceo-cost-per-meeting")!.status).toBe("signal");
  });

  it("no workflow alone owns a meeting = the pipe as a whole stands in, named, noise", () => {
    const meetingPipe: MeetingPipeEvidence = {
      rows: [mbRow({ spentUsd: 0.15, contacted: 1, outcomes: 0 })],
      pooled: { spentUsd: 3.8, contacted: 10, outcomes: 3, spentByDynasty: { "ai-meeting-booking-rhodium": 3.67, "ai-meeting-booking-avior": 0.13 } },
    };
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: [row({ costPerOutcomeUsd: 182 })], meetingPipe }));
    expect(p.get("sceo-cost-per-meeting")!.value).toBeCloseTo(182 / 0.3 + 3.8 / 3, 6);
    expect(p.get("sceo-cost-per-meeting")).toMatchObject({ status: "noise", outcomes: 3 });
    expect(p.get("sceo-cost-per-meeting")!.inputs).toMatchObject({ meetingPipeSource: "pipe_all_workflows", meetingWorkflowDynastySlug: null });
    expect(String(p.get("sceo-cost-per-meeting")!.inputs.meetingPipeSpentByDynasty)).toContain("avior");
  });

  it("a workflow that cannot run never stands in", () => {
    const meetingPipe: MeetingPipeEvidence = { rows: [mbRow({ selectable: false, spentUsd: 1, contacted: 2, outcomes: 1 })], pooled: noPool };
    expect(bestMeetingPipePick(meetingPipe)).toBeNull();
  });

  it("no meeting on the pipe at all = null meeting index, never infinite", () => {
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: [row({})], meetingPipe: { rows: [], pooled: { ...noPool, spentUsd: 5, contacted: 20 } } }));
    expect(p.get("sceo-cost-per-meeting")).toMatchObject({ value: null, unavailableReason: "no_meeting_on_pipe", status: "noise" });
  });

  it("every index has a unique slug and states its unit", () => {
    expect(new Set(FLEET_INDEXES.map((d) => d.slug)).size).toBe(FLEET_INDEXES.length);
    for (const d of FLEET_INDEXES) expect(d.unit).toBe(d.metric === "cost_per_outcome" ? "usd" : "percent");
  });
});

describe("public index names (owner 2026-10-18)", () => {
  it("read \"Distribute.you <metric> Index\" and never carry the internal SCEO prefix", () => {
    for (const def of FLEET_INDEXES) {
      expect(def.name).toMatch(/^Distribute\.you .+ Index$/);
      expect(def.name).not.toContain("SCEO");
    }
  });
});
