import { describe, it, expect } from "vitest";
import { foldFleetPipelines } from "./fleet-workflow-return.js";

describe("foldFleetPipelines", () => {
  it("sums each pair's daily INCREMENTS per dynasty and re-accumulates — never a sum of cumulatives", () => {
    const out = foldFleetPipelines([
      [{ workflowDynastySlug: "a", totalPipelineUsd: 30, pipelineTimeSeries: [
        { date: "2026-09-01T08:00:00Z", cumulativePipelineUsd: 5 },
        { date: "2026-09-01T18:00:00Z", cumulativePipelineUsd: 10 },
        { date: "2026-09-03T00:00:00Z", cumulativePipelineUsd: 25 },
      ] }],
      [{ workflowDynastySlug: "a", totalPipelineUsd: 7, pipelineTimeSeries: [{ date: "2026-09-02T00:00:00Z", cumulativePipelineUsd: 7 }] }],
    ]);
    expect(out.get("a")).toEqual({
      totalPipelineUsd: 37,
      pipelineTimeSeries: [
        { date: "2026-09-01", cumulativePipelineUsd: 10 },
        { date: "2026-09-02", cumulativePipelineUsd: 17 },
        { date: "2026-09-03", cumulativePipelineUsd: 32 },
      ],
    });
  });

  it("keeps dynasties apart, and a dynasty no pair could price reads null, never 0", () => {
    const out = foldFleetPipelines([
      [
        { workflowDynastySlug: "a", totalPipelineUsd: 1, pipelineTimeSeries: [{ date: "2026-09-01", cumulativePipelineUsd: 1 }] },
        { workflowDynastySlug: "b", totalPipelineUsd: null, pipelineTimeSeries: [] },
      ],
    ]);
    expect(out.get("a")!.totalPipelineUsd).toBe(1);
    expect(out.get("b")).toEqual({ totalPipelineUsd: null, pipelineTimeSeries: [] });
  });
});
