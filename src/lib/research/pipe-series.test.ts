import { describe, expect, it } from "vitest";
import { bestWorkflowByMonth, clientMedian, clientMedianByMonth, meetingResearchPoints, meetingSeriesOf } from "./pipe-series.js";
import type { ResearchBucket } from "./studies.js";

const bucket = (key: string, months: Array<[string, number, number, number]>): ResearchBucket => ({
  key,
  label: key,
  basis: "mature",
  learning: false,
  figures: { spentUsd: 0, contacted: 0, outcomes: 0 },
  months: months.map(([month, spentUsd, contacted, outcomes]) => ({ month, spentUsd, contacted, outcomes })),
  strata: null,
});

describe("MB-INDEX-PIPES-1018: the two Research articles over time", () => {
  it("the median client counts a client with spend and no outcome as the most expensive, never drops it", () => {
    expect(clientMedian([{ spentUsd: 10, outcomes: 1 }, { spentUsd: 30, outcomes: 1 }, { spentUsd: 5, outcomes: 0 }])).toEqual({ clients: 3, clientsWithoutOutcome: 1, medianUsd: 30, medianHasNoOutcome: false });
    // dropping the barren client would read $20; it lands on the upper side instead
    expect(clientMedian([{ spentUsd: 10, outcomes: 1 }, { spentUsd: 5, outcomes: 0 }])).toMatchObject({ medianUsd: null, medianHasNoOutcome: true });
    expect(clientMedian([{ spentUsd: 0, outcomes: 0 }])).toBeNull();
  });

  it("client median by month is cumulative per client", () => {
    const pts = clientMedianByMonth({ "a|2026-09": { exposure: 10, outcomes: 0, spend: 10 }, "a|2026-10": { exposure: 10, outcomes: 2, spend: 10 }, "b|2026-10": { exposure: 5, outcomes: 1, spend: 4 } });
    expect(pts).toEqual([
      { period: "2026-09", clients: 1, clientsWithoutOutcome: 1, medianUsd: null, medianHasNoOutcome: true },
      { period: "2026-10", clients: 2, clientsWithoutOutcome: 0, medianUsd: 7, medianHasNoOutcome: false },
    ]);
  });

  it("best workflow by month: cumulative, competes once mature, only workflows that can run", () => {
    const a = bucket("a", [["2026-08", 100, 500, 10], ["2026-09", 100, 500, 10]]);
    const b = bucket("b", [["2026-09", 30, 100, 5], ["2026-10", 30, 100, 5]]);
    const retired = bucket("retired", [["2026-08", 1, 100, 20]]);
    const pts = bestWorkflowByMonth([a, b, retired], new Set(["a", "b"]), 10);
    expect(pts.map((p) => [p.period, p.key, p.costPerOutcomeUsd])).toEqual([
      ["2026-08", "a", 10],
      ["2026-09", "a", 10],
      ["2026-10", "b", 6],
    ]);
  });

  it("the meeting pipe's series: recorded days, today's live point replacing its own day", () => {
    const today = meetingResearchPoints(
      { source: "pipe_all_workflows", workflowDynastySlug: null, workflowDynastyName: null, mature: false, spentUsd: 3.8, contacted: 10, outcomes: 3, costPerMeetingUsd: 3.8 / 3, ratePct: 30, spentByDynasty: {} },
      [{ spentUsd: 3.65, outcomes: 3 }, { spentUsd: 0.15, outcomes: 0 }],
    );
    const stale = { day: "2026-10-18", value: 99, outcomes: 1, contacted: 1, workflowDynastySlug: "x", workflowDynastyName: "X", inputs: {} };
    const past = { day: "2026-10-17", value: 2, outcomes: 2, contacted: 8, workflowDynastySlug: "ai-meeting-booking-rhodium", workflowDynastyName: null, inputs: { spentUsd: 4, mature: "false" } };
    const s = meetingSeriesOf([past, stale], [], { day: "2026-10-18", points: today }, (d) => (d === "ai-meeting-booking-rhodium" ? "Rhodium" : d));
    expect(s.best.map((p) => [p.period, p.label, p.costPerOutcomeUsd])).toEqual([
      ["2026-10-17", "Rhodium", 2],
      ["2026-10-18", "Every workflow of the pipe", 3.8 / 3],
    ]);
    expect(s.median).toEqual([{ period: "2026-10-18", clients: 2, clientsWithoutOutcome: 1, medianUsd: null, medianHasNoOutcome: true }]);
  });
});
