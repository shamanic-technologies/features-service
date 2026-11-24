import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPlayCatalogue, type Strategy, type Tactic, type WriterTacticVerdictRow } from "./plays.js";
import { excludedPipeCandidates, scriptsKeptByStrategy, scriptsOnPipeOf } from "./script-strategy.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { engineOptionEffect, engineStrategyOptions } from "./engine-strategy.js";

/**
 * OUTREACH-3WAYS-1121: a script serving people who are not the offer's buyers (the brand's investors, its peers) runs
 * ONLY for a campaign whose strategy ASKS for them. An opt-in script tactic: a script judged yes on it is kept under a
 * strategy requiring it, ruled out under no strategy (no brief) and under a strategy silent on it.
 */
const at = "2026-11-21T10:00:00.000Z";
const tactic = (id: string, extra: Partial<Tactic> = {}): Tactic => ({ id, name: id, description: `${id} description`, createdBy: "t", createdAt: at, appliesTo: "script", ...extra });
const strategy = (id: string, requires: string[], excludes: string[] = []): Strategy => ({ id, name: id, description: id, requiresTacticIds: requires, excludesTacticIds: excludes, createdBy: "t", createdAt: at });
const script = (outcome: string, dynasty: string, tactics: Record<string, unknown> = {}): RunnableScript => ({ id: `${outcome}-${dynasty}`, outcome, dynasty, version: 1, description: dynasty, tactics, code: "export default async () => ({})" });
const verdict = (s: RunnableScript, tacticId: string, v: boolean): WriterTacticVerdictRow => ({
  subjectKind: "script",
  subjectKey: scriptDynastyKey(s),
  tacticId,
  subjectVersion: "v1",
  verdict: v,
  probability: v ? 0.9 : 0.1,
  model: "jev",
  judgedDescription: `${tacticId} description`,
  judgedAt: at,
});

const INVESTORS = "script-serves-the-brand-s-investors";
const PEERS = "script-serves-the-brand-s-industry-peers";
const FRESH = "script-fresh-contacts-3-months";

const buyers = script("lead_found", "dy_find_buyers", { serve: { relationship: "pure_prospect" } });
const investors = script("lead_found", "dy_find_investors", { serve: { population: "investors" } });
const peers = script("lead_found", "dy_find_peers", { serve: { population: "peers" } });
const finders = [buyers, investors, peers];
const writer = script("message_written", "dy_cold_writer", { asks: ["llm_completion"] });
const all = [...finders, writer];

const verdicts = [
  ...finders.flatMap((s) => [verdict(s, INVESTORS, s === investors), verdict(s, PEERS, s === peers), verdict(s, FRESH, s === buyers)]),
  verdict(writer, FRESH, false),
];
const askInvestors = strategy("serves-the-brand-s-investors", [INVESTORS]);
const askPeers = strategy("serves-the-brand-s-industry-peers", [PEERS]);
const freshOnly = strategy("fresh-contacts", [FRESH]);
const freshNoDecided = strategy("any-contact", [], [FRESH]);
const catalogueOf = (optIn: boolean, more: WriterTacticVerdictRow[] = []) =>
  buildPlayCatalogue({
    tactics: [tactic(INVESTORS, { optIn, decidedByFields: ["serve"] }), tactic(PEERS, { optIn, decidedByFields: ["serve"] }), tactic(FRESH, { decidedByFields: ["serve"] })],
    strategies: [askInvestors, askPeers, freshOnly, freshNoDecided],
    plays: [],
    verdicts: [],
    writerVerdicts: [...verdicts, ...more],
  });
const optInCatalogue = catalogueOf(true);

describe("an opt-in script tactic (OUTREACH-3WAYS-1121)", () => {
  it("a strategy requiring it keeps the script judged yes on it", () => {
    expect(scriptsKeptByStrategy(finders, askInvestors, optInCatalogue).keptDynasties).toEqual(["dy_find_investors"]);
    expect(scriptsKeptByStrategy(finders, askPeers, optInCatalogue).keptDynasties).toEqual(["dy_find_peers"]);
  });

  it("no strategy (no brief, no condition) rules it out with a reason an agent can relay", () => {
    const r = scriptsKeptByStrategy(finders, null, optInCatalogue);
    expect(r.keptDynasties).toEqual(["dy_find_buyers"]);
    const inv = r.scripts.find((s) => s.dynasty === "dy_find_investors")!;
    expect(inv.kept).toBe(false);
    expect(inv.reason).toContain(`runs only for a campaign whose brief asks for "${INVESTORS}"`);
  });

  it("a strategy not naming it rules it out (a buyer campaign never reaches the investors)", () => {
    // Excludes « fresh »: the buyer finder is out by that rule, the investor finder by the opt-in rule, never kept.
    const ex = scriptsKeptByStrategy(finders, freshNoDecided, optInCatalogue);
    expect(ex.keptDynasties).toEqual([]);
    expect(ex.scripts.find((s) => s.dynasty === "dy_find_investors")!.reason).toContain("brief does not");
    expect(scriptsKeptByStrategy(finders, freshOnly, optInCatalogue).keptDynasties).toEqual(["dy_find_buyers"]);
    // Asking for investors keeps the investors only: the peer script stays out.
    expect(scriptsKeptByStrategy(finders, askInvestors, optInCatalogue).scripts.find((s) => s.dynasty === "dy_find_peers")!.kept).toBe(false);
  });

  it("an Engine whose scripts do not decide the matter (no `serve`) is not gated", () => {
    expect(scriptsKeptByStrategy([writer], null, optInCatalogue).keptDynasties).toEqual(["dy_cold_writer"]);
  });

  it("a brand-new dynasty judged on nothing yet is kept out until judged; one judged on other tactics stays in", () => {
    const newborn = script("lead_found", "dy_find_newborn", { serve: {} });
    const r = scriptsKeptByStrategy([...finders, newborn], null, optInCatalogue);
    expect(r.scripts.find((s) => s.dynasty === "dy_find_newborn")!.reason).toContain("not judged yet");
    // Judged on a non-opt-in tactic only (the opt-in ones are new): kept while the sweep judges it.
    const older = script("lead_found", "dy_find_older", { serve: {} });
    const c = catalogueOf(true, [verdict(older, FRESH, false)]);
    expect(scriptsKeptByStrategy([...finders, older], null, c).keptDynasties).toContain("dy_find_older");
  });

  it("every existing campaign's kept scripts are unchanged while no tactic is opt-in", () => {
    const plain = catalogueOf(false);
    for (const st of [null, askInvestors, askPeers, freshOnly, freshNoDecided]) {
      const before = scriptsKeptByStrategy(all, st, plain);
      // Today's rule: no strategy = every script; a strategy naming tactics = requires yes / excludes no.
      if (!st) expect(before.keptDynasties).toEqual(all.map((s) => s.dynasty).sort());
      expect(before.scripts.every((s) => s.reason === null || !s.reason.includes("only a campaign asking"))).toBe(true);
    }
    expect(scriptsKeptByStrategy(finders, freshOnly, plain).keptDynasties).toEqual(["dy_find_buyers"]);
    expect(excludedPipeCandidates(null, finders.map(scriptDynastyKey), plain, all).size).toBe(0);
  });

  it("pricing, Monitoring and the judge's options read the same gate", () => {
    const keys = finders.map(scriptDynastyKey);
    expect([...excludedPipeCandidates(null, keys, optInCatalogue, all)].sort()).toEqual(["lead_found/dy_find_investors", "lead_found/dy_find_peers"]);
    expect([...excludedPipeCandidates(askInvestors, keys, optInCatalogue, all)].sort()).toEqual(["lead_found/dy_find_buyers", "lead_found/dy_find_peers"]);
    expect([...excludedPipeCandidates(null, keys, optInCatalogue, null)].sort()).toEqual(["lead_found/dy_find_investors", "lead_found/dy_find_peers"]);
    expect(engineOptionEffect("lead_found", all, null, optInCatalogue)).toEqual({ runs: ["dy_find_buyers"], neverRuns: ["dy_find_investors", "dy_find_peers"] });
    const ids = engineStrategyOptions("lead_found", all, optInCatalogue).map((o) => o.strategyId);
    expect(ids).toContain(askInvestors.id);
    expect(ids).toContain(askPeers.id);
    const onPipe = scriptsOnPipeOf(finders, [{ campaignId: "c1", outcome: "lead_found", strategyId: null }], optInCatalogue)("c1");
    expect(onPipe).toBeDefined();
  });
});
