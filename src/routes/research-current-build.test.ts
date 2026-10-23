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
  });
  it("a build on the workflow-bar rules is current", () => {
    expect(isCurrentBuild({ file, catalog: null, texts: null, performance: { "cold-email-positive-reply": { figuresBasis: "workflow_bars", rowOrder: "pick_order" } } as never })).toBe(true);
  });
});
