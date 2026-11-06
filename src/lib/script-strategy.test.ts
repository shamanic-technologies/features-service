import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPlayCatalogue, type Strategy, type Tactic, type WriterTacticVerdictRow } from "./plays.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";
import { parseRunnableScript, scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { scriptSubjectOf } from "./tactic-judgments.js";

const at = "2026-11-06T00:00:00.000Z";
const tactic = (id: string, appliesTo: Tactic["appliesTo"]): Tactic => ({ id, name: id, description: `${id} description`, createdBy: "t", createdAt: at, appliesTo });
const strategy = (id: string, requires: string[], excludes: string[]): Strategy => ({ id, name: id, description: id, requiresTacticIds: requires, excludesTacticIds: excludes, createdBy: "t", createdAt: at });
const script = (dynasty: string, version = 1): RunnableScript => ({ id: `${dynasty}-id-${version}`, outcome: "lead_found", dynasty, version, description: dynasty, tactics: {}, code: "export default async () => ({})" });
const verdict = (dynasty: string, tacticId: string, v: boolean): WriterTacticVerdictRow => ({
  subjectKind: "script",
  subjectKey: scriptDynastyKey({ outcome: "lead_found", dynasty }),
  tacticId,
  subjectVersion: "v1",
  verdict: v,
  probability: v ? 0.9 : 0.1,
  model: "jev",
  judgedDescription: `${tacticId} description`,
  judgedAt: at,
});

const scripts = [script("dy_valid"), script("dy_catch_all"), script("dy_new")];
const catalogue = buildPlayCatalogue({
  tactics: [tactic("catch-all", "script"), tactic("blind-angle", "template"), tactic("unknown-email", "workflow")],
  strategies: [],
  plays: [],
  verdicts: [],
  // dy_new was never judged
  writerVerdicts: [verdict("dy_valid", "catch-all", false), verdict("dy_catch_all", "catch-all", true)],
});

describe("scriptsKeptByStrategy (MIGRATE-1105 S0-STRATEGY)", () => {
  it("a strategy REQUIRING a script tactic keeps only the scripts judged to follow it, never an unjudged one", () => {
    const r = scriptsKeptByStrategy(scripts, strategy("valid-catch-all", ["catch-all"], []), catalogue);
    expect(r.keptDynasties).toEqual(["dy_catch_all"]);
    expect(r.scriptTacticIds).toEqual(["catch-all"]);
    const unjudged = r.scripts.find((s) => s.dynasty === "dy_new")!;
    expect(unjudged.kept).toBe(false);
    expect(unjudged.reason).toContain("this script has not been judged on it yet");
    expect(r.scripts.find((s) => s.dynasty === "dy_valid")!.reason).toContain("this script does not follow it");
  });

  it("a strategy EXCLUDING a script tactic drops the scripts judged to follow it and the unjudged ones", () => {
    const r = scriptsKeptByStrategy(scripts, strategy("valid-only", [], ["catch-all"]), catalogue);
    expect(r.keptDynasties).toEqual(["dy_valid"]);
    expect(r.scripts.find((s) => s.dynasty === "dy_catch_all")!.reason).toContain("this script follows it");
  });

  it("no strategy keeps every script of the Engine", () => {
    const r = scriptsKeptByStrategy(scripts, null, catalogue);
    expect(r.keptDynasties).toEqual(["dy_catch_all", "dy_new", "dy_valid"]);
    expect(r.scripts.every((s) => s.reason === null)).toBe(true);
  });

  it("a strategy naming only tactics of other subjects (workflow, template) narrows no script", () => {
    const r = scriptsKeptByStrategy(scripts, strategy("blind-only", ["blind-angle"], ["unknown-email"]), catalogue);
    expect(r.scriptTacticIds).toEqual([]);
    expect(r.keptDynasties).toHaveLength(3);
  });

  it("a play the pipe does not catalogue keeps no script (never a silent widen)", () => {
    const r = scriptsKeptByStrategy(scripts, null, catalogue, "ghost-play");
    expect(r.keptDynasties).toEqual([]);
    expect(r.scripts[0].reason).toContain("ghost-play");
  });
});

describe("a strategy naming an AUDIENCE narrows the scripts by who they act for (MIGRATE-1105-S1-AUDIENCE-SCRIPTS)", () => {
  // The Lead event strategies name a workflow audience tactic AND its script twin; Jev judged each script on what it
  // states (its claim's relationships, its tactics, its description). A leads-only script answers nobody on a current
  // clients campaign, so that campaign never keeps it.
  const paid = (dynasty: string): RunnableScript => ({ ...script(dynasty), outcome: "paid_client" });
  const judged = (dynasty: string, tacticId: string, v: boolean): WriterTacticVerdictRow => ({ ...verdict(dynasty, tacticId, v), subjectKey: scriptDynastyKey({ outcome: "paid_client", dynasty }) });
  const leadScripts = [paid("dy_answer_lead_pull"), paid("dy_team_digest")];
  const audiences = buildPlayCatalogue({
    tactics: [
      tactic("answers-leads-only", "workflow"),
      tactic("current-clients-only", "workflow"),
      tactic("answers-the-brand-s-team-only", "workflow"),
      tactic("script-answers-leads-only", "script"),
      tactic("script-current-clients-only", "script"),
      tactic("script-answers-the-brand-s-team-only", "script"),
    ],
    strategies: [],
    plays: [],
    verdicts: [],
    writerVerdicts: [
      judged("dy_answer_lead_pull", "script-answers-leads-only", true),
      judged("dy_answer_lead_pull", "script-current-clients-only", false),
      judged("dy_answer_lead_pull", "script-answers-the-brand-s-team-only", false),
      judged("dy_team_digest", "script-answers-leads-only", false),
      judged("dy_team_digest", "script-current-clients-only", false),
      judged("dy_team_digest", "script-answers-the-brand-s-team-only", true),
    ],
  });
  const leadsOnly = strategy("leads-only", ["answers-leads-only", "script-answers-leads-only"], ["skips-the-brand-s-team"]);
  const currentClients = strategy("current-clients", ["current-clients-only", "script-current-clients-only"], []);
  const brandsTeam = strategy("brand-s-team", ["answers-the-brand-s-team-only", "script-answers-the-brand-s-team-only"], []);
  const notCurrentClients = strategy("not-current-clients-only", [], ["current-clients-only", "script-current-clients-only"]);

  it("a leads-only strategy keeps the leads-only script, never the team one", () => {
    const r = scriptsKeptByStrategy(leadScripts, leadsOnly, audiences);
    expect(r.scriptTacticIds).toEqual(["script-answers-leads-only"]);
    expect(r.keptDynasties).toEqual(["dy_answer_lead_pull"]);
  });

  it("a current clients strategy excludes the leads-only script (and keeps no script judged off-audience)", () => {
    const r = scriptsKeptByStrategy(leadScripts, currentClients, audiences);
    expect(r.keptDynasties).toEqual([]);
    expect(r.scripts.find((s) => s.dynasty === "dy_answer_lead_pull")!.reason).toContain("this script does not follow it");
  });

  it("a brand's team strategy keeps only the script acting for the team", () => {
    expect(scriptsKeptByStrategy(leadScripts, brandsTeam, audiences).keptDynasties).toEqual(["dy_team_digest"]);
  });

  it("a strategy EXCLUDING current clients keeps the leads-only script", () => {
    expect(scriptsKeptByStrategy(leadScripts, notCurrentClients, audiences).keptDynasties).toEqual(["dy_answer_lead_pull", "dy_team_digest"]);
  });

  it("a script made live before its audience verdicts landed is kept by no audience strategy", () => {
    const fresh = [paid("dy_new_answerer")];
    for (const st of [leadsOnly, currentClients, brandsTeam]) expect(scriptsKeptByStrategy(fresh, st, audiences).keptDynasties).toEqual([]);
  });
});

describe("script catalogue rows", () => {
  it("keeps only runnable rows with what Jev judges", () => {
    expect(parseRunnableScript({ id: "a", outcome: "lead_found", dynasty: "dy", version: 2, code: "x", runnable: true, tactics: { serve: { acceptedEmails: ["valid"] } }, description: "d" })).toEqual({
      id: "a",
      outcome: "lead_found",
      dynasty: "dy",
      version: 2,
      code: "x",
      tactics: { serve: { acceptedEmails: ["valid"] } },
      description: "d",
    });
    expect(parseRunnableScript({ id: "a", outcome: "lead_found", dynasty: "dy", version: 2, code: "x", runnable: false })).toBeNull();
    expect(parseRunnableScript({ id: "a", outcome: "lead_found", dynasty: "dy", version: 2 })).toBeNull();
  });

  it("a script is judged on its description, tactics data and WHOLE code, in parts when long (never cut)", () => {
    const s = { ...script("dy_long"), tactics: { serve: { acceptedEmails: ["valid", "catch_all"] } }, code: "a".repeat(25) };
    const one = scriptSubjectOf(s, 30);
    expect(one).toMatchObject({ kind: "script", key: "lead_found/dy_long", version: "v1:dy_long-id-1" });
    expect(one.states).toHaveLength(1);
    expect(one.states[0]).toMatchObject({ engine: "lead_found", tactics: s.tactics, code: s.code });
    const parts = scriptSubjectOf({ ...s, code: "b".repeat(70) }, 30).states;
    expect(parts.map((p) => p.part)).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    expect(parts.map((p) => p.code).join("")).toBe("b".repeat(70));
    expect(parts.every((p) => (p.tactics as object) === s.tactics)).toBe(true);
  });
});
