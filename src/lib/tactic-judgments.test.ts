import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.unmock("./tactic-judgments.js");
const state = vi.hoisted(() => ({ stored: [] as any[], inserted: [] as any[], assignments: [] as any[], sweeps: [] as any[] }));
vi.mock("./workflow-leg-assignments.js", () => ({ listLegAssignments: async () => state.assignments }));
vi.mock("./plays-store.js", async () => {
  const { buildPlayCatalogue } = await import("./plays.js");
  return {
    loadPlayCatalogue: async () =>
      buildPlayCatalogue({ tactics: [{ id: "catch-all", name: "Catch-all", description: "Sends to catch-all addresses.", createdBy: "t", createdAt: "" }], strategies: [], plays: [], verdicts: [] }),
    listVerdicts: async () => state.stored,
    insertVerdict: async (r: any) => void state.inserted.push(r),
    recordJudgingSweeps: async (rows: any[]) => void state.sweeps.push(...rows),
    refreshVersionActive: vi.fn(async () => undefined),
    invalidatePlayCatalogue: () => {},
  };
});

const { sweepTacticJudgments, tacticQuestion, judgedState } = await import("./tactic-judgments.js");

const def = (slug: string, dynasty: string, version: number, active: boolean) => ({ workflowSlug: slug, workflowDynastySlug: dynasty, version, versionActive: active, description: "d", dag: { nodes: [{ id: "serve", params: { emailStatus: "valid" } }] } });

beforeEach(() => {
  state.stored = [];
  state.inserted = [];
  state.sweeps = [];
  state.assignments = [
    { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "orion", state: "active" },
    { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "nova", state: "deprecated" },
  ];
});

describe("Jev judges every assigned workflow version on every tactic, once", () => {
  it("judges each unjudged version, skips stored ones and unassigned dynasties, stores p and the model", async () => {
    state.stored = [{ workflowSlug: "orion-v1", tacticId: "catch-all", workflowDynastySlug: "orion", version: 1, versionActive: false, verdict: false, probability: 0.1, model: "m", judgedDescription: "Sends to catch-all addresses.", judgedAt: "" }];
    const judge = vi.fn(async (_t: any, w: any) => ({ verdict: w.workflowDynastySlug === "nova", probability: w.workflowDynastySlug === "nova" ? 0.93 : 0.04, model: "typesafe-x" }));
    const r = await sweepTacticJudgments({
      judge,
      definitions: async () => [def("orion-v1", "orion", 1, false), def("orion-v2", "orion", 2, true), def("nova-v1", "nova", 1, true), def("stray-v1", "stray", 1, true)],
    });
    // Every version of the feature, an unassigned (retired) lineage included: a play's price picks among them all.
    expect(r).toEqual({ versions: 4, judged: 3, failed: 0, alreadyJudged: 1 });
    expect(state.inserted.map((x) => [x.workflowSlug, x.verdict, x.probability, x.model, x.featureSlug])).toEqual([
      ["orion-v2", false, 0.04, "typesafe-x", "sales-cold-email-outreach"],
      ["nova-v1", true, 0.93, "typesafe-x", "sales-cold-email-outreach"],
      ["stray-v1", false, 0.04, "typesafe-x", "sales-cold-email-outreach"],
    ]);
  });

  it("a failed judgment stores nothing (no default verdict) and is counted", async () => {
    const r = await sweepTacticJudgments({ judge: async () => { throw new Error("chat-service 502"); }, definitions: async () => [def("orion-v2", "orion", 2, true)] });
    expect(r.failed).toBe(1);
    expect(state.inserted).toEqual([]);
  });

  it("asks on the tactic's description and the workflow's definition, never its name", () => {
    const q = tacticQuestion({ name: "Catch-all", description: "Sends to catch-all addresses." });
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain("Sends to catch-all addresses.");
    expect(q.instructions).toContain("Ignore its name");
    expect(judgedState(def("orion-v2", "orion", 2, true) as any)).toMatchObject({ definition: { nodes: [{ id: "serve" }] } });
  });
});

describe("an edited description re-judges every version in place (owner 2026-10-14)", () => {
  it("re-asks a verdict judged on an older text and stores the new text with it; a current one is skipped", async () => {
    state.stored = [
      { workflowSlug: "orion-v2", tacticId: "catch-all", workflowDynastySlug: "orion", version: 2, versionActive: true, verdict: true, probability: 0.56, model: "m", judgedDescription: "Old words.", judgedAt: "" },
      { workflowSlug: "nova-v1", tacticId: "catch-all", workflowDynastySlug: "nova", version: 1, versionActive: true, verdict: false, probability: 0.1, model: "m", judgedDescription: "Sends to catch-all addresses.", judgedAt: "" },
    ];
    const judge = vi.fn(async (t: any) => ({ verdict: true, probability: 0.95, model: "m2", seen: t.description }));
    const r = await sweepTacticJudgments({ judge, definitions: async () => [def("orion-v2", "orion", 2, true), def("nova-v1", "nova", 1, true)] });
    expect(r).toEqual({ versions: 2, judged: 1, failed: 0, alreadyJudged: 1 });
    expect(judge.mock.calls[0][0].description).toBe("Sends to catch-all addresses.");
    expect(state.inserted.map((x) => [x.workflowSlug, x.verdict, x.probability, x.judgedDescription])).toEqual([["orion-v2", true, 0.95, "Sends to catch-all addresses."]]);
  });
});

describe("a registration kick judges only the dynasty it names", () => {
  it("narrows to the registered dynasty", async () => {
    const r = await sweepTacticJudgments(
      { judge: async () => ({ verdict: false, probability: 0.1, model: "m" }), definitions: async () => [def("orion-v2", "orion", 2, true), def("nova-v1", "nova", 1, true)] },
      new Set(["nova"]),
    );
    expect(r.judged).toBe(1);
    expect(state.inserted.map((x) => x.workflowSlug)).toEqual(["nova-v1"]);
  });
});

describe("every full sweep records each tactic's judging (owner 2026-10-14: a failing judge looked pending forever)", () => {
  it("a sweep where Jev fails records versions, judged, failed and the reason", async () => {
    state.stored = [{ workflowSlug: "orion-v1", tacticId: "catch-all", workflowDynastySlug: "orion", version: 1, versionActive: false, verdict: false, probability: 0.1, model: "m", judgedDescription: "Sends to catch-all addresses.", judgedAt: "" }];
    await sweepTacticJudgments({
      judge: async () => { throw new Error("chat-service platform-judgments 502: no credits"); },
      definitions: async () => [def("orion-v1", "orion", 1, false), def("orion-v2", "orion", 2, true)],
      now: () => new Date("2026-10-14T09:00:00.000Z"),
    });
    expect(state.sweeps).toEqual([
      { tacticId: "catch-all", judgedDescription: "Sends to catch-all addresses.", sweptAt: "2026-10-14T09:00:00.000Z", versions: 2, judged: 1, failed: 1, lastFailure: "chat-service platform-judgments 502: no credits", lastFailureAt: "2026-10-14T09:00:00.000Z" },
    ]);
  });

  it("a clean sweep records no failure; a narrowed registration kick records nothing", async () => {
    const judge = async () => ({ verdict: false, probability: 0.1, model: "m" });
    await sweepTacticJudgments({ judge, definitions: async () => [def("orion-v2", "orion", 2, true)] });
    expect(state.sweeps).toMatchObject([{ versions: 1, judged: 1, failed: 0, lastFailure: null, lastFailureAt: null }]);
    state.sweeps = [];
    await sweepTacticJudgments({ judge, definitions: async () => [def("nova-v1", "nova", 1, true)] }, new Set(["nova"]));
    expect(state.sweeps).toEqual([]);
  });

  it("an unreadable feature counts as a failure of every tactic, with its reason", async () => {
    await sweepTacticJudgments({ judge: async () => ({ verdict: false, probability: 0.1, model: "m" }), definitions: async () => { throw new Error("workflow-service 503"); } });
    expect(state.sweeps).toMatchObject([{ failed: 1, lastFailure: expect.stringContaining("workflow-service 503") }]);
  });
});
