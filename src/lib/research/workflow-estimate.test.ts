import { describe, expect, it } from "vitest";
import { workflowEstimateStudy } from "./workflow-estimate.js";

// half the replies on day 1, the rest by day 5 (22 bins: Day 1..21 + 21+)
const dayBins = [50, 20, 10, 10, 10, ...Array(17).fill(0)].map((count) => ({ count }));
const old = (contacted: number) => ({ contacted, ageDays: 60 });

describe("estimated workflow study (COST-ACCOUNTING-1023-P3)", () => {
  it("sits on the pipe, orders workflows by estimated cost, states each 95% range", () => {
    const st = workflowEstimateStudy({
      pipe: "cold-email-positive-reply",
      outcomesRequired: 1,
      dayBins,
      groups: [
        { key: "cheap", label: "Cheap", slices: [old(20_000)], outcomes: 200, spendUsd: 400 },
        { key: "dear", label: "Dear", slices: [old(20_000)], outcomes: 40, spendUsd: 400 },
      ],
    });
    expect(st).toMatchObject({ id: "cold-email-positive-reply-workflow-estimate", pipe: "cold-email-positive-reply", topic: "workflow", status: "measured", crowned: false, winner: null });
    expect(st.charts[0]!.points.map((p) => p.key)).toEqual(["cheap", "dear"]);
    expect(st.charts[0]!.points[0]!.note).toMatch(/^95% range \$/);
    // ranges far apart: a signal, never a conclusion
    expect(st.verdict.kind).toBe("signal");
    expect(st.headline).toMatch(/^Estimated, young cohorts included: Cheap at \$2\.\d\d per positive reply/);
  });

  it("a young cohort is not read as a poor one", () => {
    // same true rate, one cohort emailed yesterday: its raw rate is half, its estimate is not
    const st = workflowEstimateStudy({
      pipe: "cold-email-positive-reply",
      outcomesRequired: 1,
      dayBins,
      groups: [
        { key: "mature", label: "Mature", slices: [old(10_000)], outcomes: 100, spendUsd: 100 },
        { key: "young", label: "Young", slices: [{ contacted: 10_000, ageDays: 1 }], outcomes: 50, spendUsd: 100 },
      ],
    });
    const [a, b] = st.charts[0]!.points;
    expect(Math.abs(a!.value - b!.value) / a!.value).toBeLessThan(0.1);
    expect(st.verdict.kind).toBe("noise");
  });

  it("no delay curve = not readable; nobody emailed = said so", () => {
    expect(workflowEstimateStudy({ pipe: "p", outcomesRequired: 1, dayBins: null, groups: [] }).headline).toBe("Not readable right now.");
    expect(workflowEstimateStudy({ pipe: "p", outcomesRequired: 1, dayBins, groups: [] }).headline).toBe("No one emailed yet.");
  });
});
