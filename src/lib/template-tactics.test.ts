import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { buildPlayCatalogue, type Tactic } from "./plays.js";
import { templateTacticsFrom, withTemplateTactics } from "./template-tactics.js";

const tactic = (id: string, name: string, appliesTo: Tactic["appliesTo"]): Tactic => ({ id, name, description: id, appliesTo }) as Tactic;
const verdict = (key: string, tacticId: string, v: boolean) => ({ subjectKind: "template" as const, subjectKey: key, tacticId, subjectVersion: `${key}-v2`, verdict: v, probability: v ? 0.9 : 0.1, model: "jev", judgedDescription: tacticId, judgedAt: "2026-10-22T00:00:00Z" });

describe("template tactics on every template row (TPL-TACTICS-ROWS-1022)", () => {
  const c = buildPlayCatalogue({
    tactics: [tactic("blind", "Blind angle", "template"), tactic("named", "Named angle", "template"), tactic("catch-all", "Catch-all", "workflow")],
    strategies: [],
    plays: [],
    verdicts: [],
    writerVerdicts: [verdict("cold-blind", "blind", true), verdict("cold-blind", "named", false), verdict("cold-plain", "blind", false), verdict("cold-plain", "named", false), verdict("half", "blind", true)],
  });
  const of = templateTacticsFrom(c);

  it("lists the template tactics judged yes (a workflow tactic never), [] when judged and following none, unknown when any is unjudged", () => {
    expect(withTemplateTactics([{ key: "cold-blind" }, { key: "cold-plain" }, { key: "half" }, { key: "never-v1" }], of)).toEqual([
      { key: "cold-blind", tactics: [{ id: "blind", name: "Blind angle" }], tacticsUnavailableReason: null },
      { key: "cold-plain", tactics: [], tacticsUnavailableReason: null },
      { key: "half", tactics: null, tacticsUnavailableReason: "not_judged_yet" },
      { key: "never-v1", tactics: null, tacticsUnavailableReason: "not_judged_yet" },
    ]);
  });

  it("an unreadable tactics store says so, never an empty list", () => {
    expect(withTemplateTactics([{ key: "cold-blind" }], null)).toEqual([{ key: "cold-blind", tactics: null, tacticsUnavailableReason: "tactics_unreadable" }]);
  });
});
