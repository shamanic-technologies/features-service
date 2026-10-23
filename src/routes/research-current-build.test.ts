import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { isCurrentBuild } from "./research.js";

// RESEARCH-PERFORMANCE-1023: a build stored before the Performance tab's current rules is rebuilt at once.
describe("isCurrentBuild", () => {
  const file = {} as never;
  it("a build without the Performance tab, or on its first rules, is not current", () => {
    expect(isCurrentBuild({ file, catalog: null, texts: null })).toBe(false);
    expect(isCurrentBuild({ file, catalog: null, texts: null, performance: { "cold-email-positive-reply": { figuresBasis: "since_inception" } } as never })).toBe(false);
    // RESEARCH-PICK-ORDER-1023: rows sorted by ROI (no `rowOrder`) are rebuilt in the pick order
    expect(isCurrentBuild({ file, catalog: null, texts: null, performance: { "cold-email-positive-reply": { figuresBasis: "workflow_bars" } } as never })).toBe(false);
    // RESEARCH-COMBO-ESTIMATE-1023: rows in the nested pick order are rebuilt on each combination's estimate
    expect(isCurrentBuild({ file: { view: "mature" } as never, catalog: null, texts: null, performance: { "cold-email-positive-reply": { figuresBasis: "workflow_bars", rowOrder: "pick_order" } } as never })).toBe(false);
    // RESEARCH-ALL-COMBOS-1023: a build listing only the combinations that wrote is rebuilt with every valid one
    expect(isCurrentBuild({ file: { view: "mature" } as never, catalog: null, texts: null, performance: { "cold-email-positive-reply": { figuresBasis: "workflow_bars", rowOrder: "estimated_cost" } } as never })).toBe(false);
    // PRIOR-PART-EFFECTS-1023: priors read as the geometric mean of each part are rebuilt on the pipe's model
    expect(isCurrentBuild({ file: { view: "mature" } as never, catalog: null, texts: null, performance: { "cold-email-positive-reply": { figuresBasis: "workflow_bars", rowOrder: "estimated_cost", rowsCover: "all_valid_combinations" } } as never })).toBe(false);
  });
  it("a build on the workflow-bar rules, read on the asked view, is current (MATURITY-VIEW-1023)", () => {
    const perf = { "cold-email-positive-reply": { figuresBasis: "workflow_bars", rowOrder: "estimated_cost", rowsCover: "all_valid_combinations", estimateModel: "part_effects" } } as never;
    expect(isCurrentBuild({ file: { view: "mature" } as never, catalog: null, texts: null, performance: perf })).toBe(true);
    expect(isCurrentBuild({ file: { view: "flash" } as never, catalog: null, texts: null, performance: perf }, "flash")).toBe(true);
    // a mixed build (stored before the views) or the other view is rebuilt
    expect(isCurrentBuild({ file, catalog: null, texts: null, performance: perf })).toBe(false);
    expect(isCurrentBuild({ file: { view: "mature" } as never, catalog: null, texts: null, performance: perf }, "flash")).toBe(false);
  });
});
