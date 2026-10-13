import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.unmock("./tactic-judgments.js");
const state = vi.hoisted(() => ({ stored: [] as any[], inserted: [] as any[], assignments: [] as any[] }));
vi.mock("./workflow-leg-assignments.js", () => ({ listLegAssignments: async () => state.assignments }));
vi.mock("./plays-store.js", async () => {
  const { buildPlayCatalogue } = await import("./plays.js");
  return {
    loadPlayCatalogue: async () =>
      buildPlayCatalogue({ tactics: [{ id: "catch-all", name: "Catch-all", description: "Sends to catch-all addresses.", createdBy: "t", createdAt: "" }], strategies: [], plays: [], verdicts: [] }),
    listVerdicts: async () => state.stored,
    insertVerdict: async (r: any) => void state.inserted.push(r),
    refreshVersionActive: vi.fn(async () => undefined),
    invalidatePlayCatalogue: () => {},
  };
});

const { sweepTacticJudgments, tacticQuestion, judgedState } = await import("./tactic-judgments.js");

const def = (slug: string, dynasty: string, version: number, active: boolean) => ({ workflowSlug: slug, workflowDynastySlug: dynasty, version, versionActive: active, description: "d", dag: { nodes: [{ id: "serve", params: { emailStatus: "valid" } }] } });

beforeEach(() => {
  state.stored = [];
  state.inserted = [];
  state.assignments = [
    { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "orion", state: "active" },
    { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "nova", state: "deprecated" },
  ];
});

describe("Jev judges every assigned workflow version on every tactic, once", () => {
  it("judges each unjudged version, skips stored ones and unassigned dynasties, stores p and the model", async () => {
    state.stored = [{ workflowSlug: "orion-v1", tacticId: "catch-all", workflowDynastySlug: "orion", version: 1, versionActive: false, verdict: false, probability: 0.1, model: "m", judgedAt: "" }];
    const judge = vi.fn(async (_t: any, w: any) => ({ verdict: w.workflowDynastySlug === "nova", probability: w.workflowDynastySlug === "nova" ? 0.93 : 0.04, model: "typesafe-x" }));
    const r = await sweepTacticJudgments({
      judge,
      definitions: async () => [def("orion-v1", "orion", 1, false), def("orion-v2", "orion", 2, true), def("nova-v1", "nova", 1, true), def("stray-v1", "stray", 1, true)],
    });
    expect(r).toEqual({ versions: 3, judged: 2, failed: 0, alreadyJudged: 1 });
    expect(state.inserted.map((x) => [x.workflowSlug, x.verdict, x.probability, x.model, x.featureSlug])).toEqual([
      ["orion-v2", false, 0.04, "typesafe-x", "sales-cold-email-outreach"],
      ["nova-v1", true, 0.93, "typesafe-x", "sales-cold-email-outreach"],
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
