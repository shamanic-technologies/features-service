import { describe, expect, it } from "vitest";
import { GUARD_DECISIONS, RETRY_AFTER_DAYS, RETRY_MAX_DAYS, driveStepOf, drivenDynastyOf, guardOf, retryAtOf, withEngineDrive, type DriveGuard, type DriveState } from "./engine-drive.js";
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

describe("ENGINE-FULL-MIGRATION-1102: every unit is driven, a roll-back recovers", () => {
  const g = (verdict: DriveGuard["verdict"]): DriveGuard => ({ decisions: 60, outcomes: 1, spentUsd: 6, costPerOutcomeUsd: 6, serviceCostPerOutcomeUsd: 1, serviceBasis: "unit_before_switch", verdict });
  const at = (iso: string) => new Date(iso);
  const pick = { dynasty: "b", source: "engine_tick_pick" };

  it("a brand-new unit (nothing stored, no field on its campaign) is driven at once", () => {
    const d = driveStepOf({ kept: null, driven: pick, now: at("2026-11-02T10:00:00Z"), outcomeName: "Lead", guardAt: () => g("measuring") });
    expect(d).toMatchObject({ state: "driving", workflowDynastySlug: "b", switchedAt: "2026-11-02T10:00:00.000Z", rolledBackAt: null });
  });

  it("nothing to drive without an Engine pick and nothing stored", () => {
    expect(driveStepOf({ kept: null, driven: null, now: at("2026-11-02T10:00:00Z"), outcomeName: "Lead", guardAt: () => g("measuring") })).toBeNull();
  });

  it("a worse unit rolls back and states when it re-trials", () => {
    const kept: DriveState = { state: "driving", workflowDynastySlug: "b", switchedAt: "2026-10-20T00:00:00.000Z", rolledBackAt: null, guard: null };
    const d = driveStepOf({ kept, driven: pick, now: at("2026-11-02T10:00:00Z"), outcomeName: "Lead", guardAt: () => g("worse") })!;
    expect(d.state).toBe("rolled_back");
    expect(d.guard).toMatchObject({ rollBacks: 1, retryAt: "2026-11-16T10:00:00.000Z" });
  });

  it("stays rolled back during its cool-down, then re-trials from zero against the cool-down's service figures", () => {
    const kept: DriveState = {
      state: "rolled_back",
      workflowDynastySlug: "b",
      switchedAt: "2026-10-20T00:00:00.000Z",
      rolledBackAt: "2026-11-02T10:00:00.000Z",
      guard: { ...g("worse"), outcomeName: "Lead", source: "engine_tick_pick", rollBacks: 1, retryAt: "2026-11-16T10:00:00.000Z" },
    };
    const calls: Array<[string, string | null]> = [];
    const guardAt = (day: string, since: string | null) => (calls.push([day, since]), g("measuring"));
    expect(driveStepOf({ kept, driven: pick, now: at("2026-11-10T00:00:00Z"), outcomeName: "Lead", guardAt })!.state).toBe("rolled_back");
    const back = driveStepOf({ kept, driven: pick, now: at("2026-11-16T10:00:00Z"), outcomeName: "Lead", guardAt })!;
    expect(back).toMatchObject({ state: "driving", switchedAt: "2026-11-16T10:00:00.000Z", rolledBackAt: "2026-11-02T10:00:00.000Z", guard: { verdict: "measuring", rollBacks: 1, retryAt: null } });
    expect(calls).toEqual([["2026-11-16", "2026-11-02"]]);
  });

  it("re-trials at once when the Engine's pick on its pipe moved to another workflow", () => {
    const kept: DriveState = { state: "rolled_back", workflowDynastySlug: "a", switchedAt: "2026-10-20T00:00:00.000Z", rolledBackAt: "2026-11-01T00:00:00.000Z", guard: { ...g("worse"), outcomeName: "Lead", source: "engine_tick_pick", rollBacks: 1, retryAt: "2026-11-15T00:00:00.000Z" } };
    expect(driveStepOf({ kept, driven: pick, now: at("2026-11-02T00:00:00Z"), outcomeName: "Lead", guardAt: () => g("measuring") })).toMatchObject({ state: "driving", workflowDynastySlug: "b" });
  });

  it("a repeated roll-back waits twice as long, capped", () => {
    expect(retryAtOf("2026-11-01T00:00:00.000Z", 1)).toBe(new Date(Date.parse("2026-11-01T00:00:00Z") + RETRY_AFTER_DAYS * 86_400_000).toISOString());
    expect(retryAtOf("2026-11-01T00:00:00.000Z", 2)).toBe("2026-11-29T00:00:00.000Z");
    expect(retryAtOf("2026-11-01T00:00:00.000Z", 9)).toBe(new Date(Date.parse("2026-11-01T00:00:00Z") + RETRY_MAX_DAYS * 86_400_000).toISOString());
  });

  it("a re-trial's service figure reads only the cool-down days", () => {
    const days = [
      { day: "2026-10-25", decisions: 100, outcomes: 1, spentUsd: 100 }, // the Engine's bad days: $100 per lead
      { day: "2026-11-05", decisions: 100, outcomes: 50, spentUsd: 10 }, // the cool-down: $0.20 per lead
      { day: "2026-11-17", decisions: 60, outcomes: 10, spentUsd: 6 }, // the re-trial: $0.60 per lead
    ];
    expect(guardOf(days, "2026-11-16", "2026-11-20", 0, null, "2026-11-02")).toMatchObject({ verdict: "worse", serviceCostPerOutcomeUsd: 0.2 });
  });
});
