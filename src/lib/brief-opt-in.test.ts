import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPlayCatalogue, type Strategy, type Tactic, type WriterTacticVerdictRow } from "./plays.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { askedByBrief, briefAsksByCampaignEngine, briefAsksByEngine, briefAsksQuestions, briefAsksState, briefAsksToJudge } from "./brief-opt-in.js";

/**
 * PLAN-RECURSIVE-PER-ENGINE-1124-SOURCES (owner 2026-11-24: « add the instructions in the brief, so the source chosen is
 * filtered by what the user wants »): a campaign keeps ONE strategy per Engine, about who is found; where people are
 * found is an opt-in script tactic its BRIEF asks for directly, beside that strategy.
 */
const at = "2026-11-24T10:00:00.000Z";
const tactic = (id: string, extra: Partial<Tactic> = {}): Tactic => ({ id, name: id, description: `${id} description`, createdBy: "t", createdAt: at, appliesTo: "script", ...extra });
const strategy = (id: string, requires: string[], excludes: string[] = []): Strategy => ({ id, name: id, description: id, requiresTacticIds: requires, excludesTacticIds: excludes, createdBy: "t", createdAt: at });
const script = (dynasty: string, tactics: Record<string, unknown>): RunnableScript => ({ id: `lead_found-${dynasty}`, outcome: "lead_found", dynasty, version: 1, description: `${dynasty} does`, tactics, code: "export default function run() { return null; }" }) as RunnableScript;
const verdict = (s: RunnableScript, tacticId: string, v: boolean): WriterTacticVerdictRow => ({ subjectKind: "script", subjectKey: scriptDynastyKey(s), tacticId, subjectVersion: "v1", verdict: v, probability: v ? 0.9 : 0.1, model: "jev", judgedDescription: `${tacticId} description`, judgedAt: at });

const OTHER_SOURCE = "finds-people-elsewhere";
const FRESH = "script-fresh-contacts-3-months";
const ownBase = script("dy_own_base", { serve: { excludeEmailedWithin: "3_months" } });
const elsewhere = script("dy_elsewhere", { serve: { excludeEmailedWithin: "3_months" } });
const scripts = [ownBase, elsewhere];
const freshOnly = strategy("valid-only", [FRESH]);
const catalogue = buildPlayCatalogue({
  tactics: [tactic(OTHER_SOURCE, { optIn: true, decidedByFields: ["serve"] }), tactic(FRESH, { decidedByFields: ["serve"] })],
  strategies: [freshOnly],
  plays: [],
  verdicts: [],
  writerVerdicts: scripts.flatMap((s) => [verdict(s, OTHER_SOURCE, s === elsewhere), verdict(s, FRESH, true)]),
});
const optIn = catalogue.tactics.get(OTHER_SOURCE)!;
const row = (asks: boolean, extra: Record<string, unknown> = {}) => ({ campaignId: "c1", outcome: "lead_found", tacticId: OTHER_SOURCE, asks, briefHash: "h1", judgedDescription: optIn.description, ...extra });

describe("a brief asks for an opt-in script tactic, enforced", () => {
  beforeEach(() => vi.stubEnv("BRIEF_OPT_IN_ENFORCE", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("lets the script in beside a strategy about another matter, and only then", () => {
    const silent = scriptsKeptByStrategy(scripts, freshOnly, catalogue);
    expect(silent.keptDynasties).toEqual(["dy_own_base"]);
    expect(silent.scripts.find((s) => s.dynasty === "dy_elsewhere")?.reason).toBe(`this script runs only for a campaign whose brief asks for "${OTHER_SOURCE}", and this campaign's brief does not`);
    const asked = scriptsKeptByStrategy(scripts, freshOnly, catalogue, null, new Set(askedByBrief([row(true)], "lead_found", [optIn])));
    expect(asked.keptDynasties.sort()).toEqual(["dy_elsewhere", "dy_own_base"]);
    // no strategy at all: the brief's ask alone lets it in
    expect(scriptsKeptByStrategy(scripts, null, catalogue, null, new Set([OTHER_SOURCE])).keptDynasties.sort()).toEqual(["dy_elsewhere", "dy_own_base"]);
    expect(scriptsKeptByStrategy(scripts, null, catalogue).keptDynasties).toEqual(["dy_own_base"]);
  });

  it("reads stored answers per Engine and per campaign, a no never asks", () => {
    expect(askedByBrief([row(false)], "lead_found", [optIn])).toEqual([]);
    expect(askedByBrief([row(true, { outcome: "email_sent" })], "lead_found", [optIn])).toEqual([]);
    expect([...(briefAsksByEngine([row(true)]).get("lead_found") ?? [])]).toEqual([OTHER_SOURCE]);
    const of = briefAsksByCampaignEngine([row(true), row(false, { campaignId: "c2" })]);
    expect([...of("c1", "lead_found")]).toEqual([OTHER_SOURCE]);
    expect([...of("c2", "lead_found")]).toEqual([]);
    expect([...of("c1", "email_sent")]).toEqual([]);
  });
});

describe("a brief's answers, measured before they are enforced", () => {
  it("lets no script in while BRIEF_OPT_IN_ENFORCE is not on: every reader sees no ask", () => {
    expect(askedByBrief([row(true)], "lead_found", [optIn])).toEqual([]);
    expect(briefAsksByEngine([row(true)]).size).toBe(0);
    expect([...briefAsksByCampaignEngine([row(true)])("c1", "lead_found")]).toEqual([]);
  });
});

describe("when the judge is asked", () => {
  it("never without a brief; once per tactic until the brief or the tactic's words move", () => {
    expect(briefAsksToJudge([optIn], [], null)).toEqual([]);
    expect(briefAsksToJudge([optIn], [], "h1")).toEqual([optIn]);
    expect(briefAsksToJudge([optIn], [row(false)], "h1")).toEqual([]);
    expect(briefAsksToJudge([optIn], [row(true)], "h2")).toEqual([optIn]);
    expect(briefAsksToJudge([optIn], [row(true, { judgedDescription: "older words" })], "h1")).toEqual([optIn]);
  });

  it("shows Jev the whole brief, the Engine's scripts and which are of the kind asked about", () => {
    const state = briefAsksState("Find new people on Apollo.", { outcome: "lead_found", label: "Lead found" }, [optIn], scripts, catalogue) as { brief: string; engine: { scripts: unknown[]; scriptsOfEachKind: Record<string, string[]> } };
    expect(state.brief).toBe("Find new people on Apollo.");
    expect(state.engine.scripts).toHaveLength(2);
    expect(state.engine.scriptsOfEachKind[optIn.name]).toEqual(["dy_elsewhere"]);
    const q = briefAsksQuestions([optIn]);
    expect(Object.keys(q)).toEqual(["t0"]);
    expect(q.t0!.type).toBe("noul");
  });
});
