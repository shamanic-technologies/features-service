import { describe, expect, it } from "vitest";
import { GUARD_DECISIONS, drivenDynastyOf, guardOf, withEngineDrive } from "./engine-drive.js";
import type { EnginePlace } from "./engine-shadow.js";

const ref = (pipe: string, wf: string) => ({ candidateId: `${pipe}::${wf}`, pipeId: pipe, channelName: pipe, workflowDynastySlug: wf, workflowDynastyName: wf });
const place = (engine: ReturnType<typeof ref> | null, rows: Array<[string, string, number]>): EnginePlace =>
  ({
    outcome: "lead_found",
    engine,
    candidates: rows.map(([p, w, share]) => ({ ...ref(p, w), pickSharePct: share })),
  }) as unknown as EnginePlace;

describe("which workflow the Engine drives on the unit's pipe", () => {
  it("its tick pick when that pick is a workflow of the unit's pipe", () => {
    expect(drivenDynastyOf(place(ref("src", "b"), [["src", "a", 40], ["src", "b", 60]]), "src")).toEqual({ dynasty: "b", source: "engine_tick_pick" });
  });
  it("else the pipe's workflow most draws pick (moving to another pipe is the plan's job)", () => {
    expect(drivenDynastyOf(place(ref("apollo", "x"), [["apollo", "x", 70], ["src", "a", 10], ["src", "b", 20]]), "src")).toEqual({ dynasty: "b", source: "pipe_most_drawn" });
    expect(drivenDynastyOf(place(ref("apollo", "x"), [["apollo", "x", 100]]), "src")).toBeNull();
  });
});

describe("the roll-back guard", () => {
  const before = [{ day: "2026-10-20", decisions: 100, outcomes: 50, spentUsd: 10 }]; // $0.20 per lead before
  it("measures until 50 decisions", () => {
    expect(guardOf([...before, { day: "2026-11-02", decisions: GUARD_DECISIONS - 1, outcomes: 1, spentUsd: 100 }], "2026-11-01", "2026-11-05", 0, null).verdict).toBe("measuring");
  });
  it("holds when the cost per outcome since the switch is at or below the unit's own before it", () => {
    const g = guardOf([...before, { day: "2026-11-02", decisions: 60, outcomes: 40, spentUsd: 6 }], "2026-11-01", "2026-11-05", 0, null);
    expect(g).toMatchObject({ verdict: "holds", serviceBasis: "unit_before_switch", serviceCostPerOutcomeUsd: 0.2, costPerOutcomeUsd: 0.15 });
  });
  it("rolls back when it is worse, or made nothing", () => {
    expect(guardOf([...before, { day: "2026-11-02", decisions: 60, outcomes: 10, spentUsd: 6 }], "2026-11-01", "2026-11-05", 0, null).verdict).toBe("worse");
    expect(guardOf([...before, { day: "2026-11-02", decisions: 60, outcomes: 0, spentUsd: 6 }], "2026-11-01", "2026-11-05", 0, null).verdict).toBe("worse");
  });
  it("reads the fleet service workflow's cost when the unit has no history, and holds when nothing compares", () => {
    expect(guardOf([{ day: "2026-11-02", decisions: 60, outcomes: 10, spentUsd: 6 }], "2026-11-01", "2026-11-05", 0, 1).verdict).toBe("holds");
    expect(guardOf([{ day: "2026-11-02", decisions: 60, outcomes: 10, spentUsd: 6 }], "2026-11-01", "2026-11-05", 0, null).verdict).toBe("no_service_figure");
  });
  it("does not blame open decisions: a young day's cost reads on the outcomes already due", () => {
    const g = guardOf([{ day: "2026-11-04", decisions: 100, outcomes: 1, spentUsd: 10 }], "2026-11-01", "2026-11-05", 10, 0.5);
    expect(g.costPerOutcomeUsd).toBeCloseTo((10 * 0.1) / 1, 5);
  });
});

describe("the leg-keyed answer of a driven unit", () => {
  const body = {
    rows: [
      { audienceId: null, workflow: { workflowDynastySlug: "a" }, rank: 1, legAssignment: { selectable: true } },
      { audienceId: null, workflow: { workflowDynastySlug: "b" }, rank: 2, legAssignment: { selectable: true } },
      { audienceId: null, workflow: { workflowDynastySlug: "c" }, rank: 3, legAssignment: { selectable: false } },
    ],
    recommendedWorkflowDynastySlug: "a",
  };
  it("puts the Engine's workflow at rank 1 and names it the recommendation, the rest in their order", () => {
    const d = withEngineDrive(body, "b");
    expect(d.rows.map((r) => [r.workflow.workflowDynastySlug, r.rank])).toEqual([["a", 2], ["b", 1], ["c", 3]]);
    expect(d).toMatchObject({ recommendedWorkflowDynastySlug: "b", engineDrive: { applied: true } });
  });
  it("leaves the service order when the Engine's workflow cannot run here", () => {
    expect(withEngineDrive(body, "c")).toMatchObject({ recommendedWorkflowDynastySlug: "a", engineDrive: { applied: false, reason: "not_selectable" } });
    expect(withEngineDrive(body, "z").engineDrive.reason).toBe("not_listed");
  });
});
