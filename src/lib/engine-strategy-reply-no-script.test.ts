import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPlayCatalogue, type Strategy, type Tactic, type WriterTacticVerdictRow } from "./plays.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { engineOptionEffect, engineStrategyOptions } from "./engine-strategy.js";

/**
 * REPLY-NO-SCRIPT-1119 (prod 2026-11-19, Doc Dinners campaigns ace5f43e + 2b179763): the brief's targeting sentence
 * (« people the brand already knows whose next follow-up date has passed ») was judged onto Message sent as « Lead
 * follow-up due ». That strategy names find tactics (the script's lead.serve `serve` body); no Message sent script states
 * `serve`, every one is judged NO on them, so it kept no answerer and every prospect reply went unanswered. Held as the
 * carried verdict, it stayed on the options and the judge re-picked it (0.27, 0.36).
 */
const at = "2026-11-19T06:44:00.000Z";
const tactic = (id: string, decidedByFields: string[] | null = null): Tactic => ({ id, name: id, description: `${id} description`, createdBy: "t", createdAt: at, appliesTo: "script", decidedByFields });
const strategy = (id: string, requires: string[], excludes: string[] = []): Strategy => ({ id, name: id, description: id, requiresTacticIds: requires, excludesTacticIds: excludes, createdBy: "t", createdAt: at });
const script = (outcome: string, dynasty: string, tactics: Record<string, unknown> = {}): RunnableScript => ({ id: `${outcome}-${dynasty}`, outcome, dynasty, version: 1, description: dynasty, tactics, code: "" });
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

const DUE = "script-lead-follow-up-due";
const FRESH = "script-fresh-contacts-3-months";
const LEADS = "script-answers-leads-only";
// Prod 2026-11-19: the runnable Message sent scripts (none states `serve`) and the find scripts (each states it).
const senders = [
  script("message_sent", "dy_answer_lead", { asks: ["booking_call", "message_written"], relationships: "pure_prospect" }),
  script("message_sent", "dy_intro_answer", { asks: ["llm_completion"], relationships: "pure_prospect" }),
  script("message_sent", "dy_send_gate"),
];
const finders = [
  script("lead_found", "dy_lead_serve", { serve: {} }),
  script("lead_found", "dy_lead_serve_follow_up_due", { serve: { population: "lead_followup_due" } }),
];
const runnable = [...senders, ...finders];
const followUpDue = strategy("lead-follow-up-due", [DUE], [FRESH]);
const leadsOnly = strategy("leads-only", [LEADS]);
const writerVerdicts = [
  ...senders.flatMap((s) => [verdict(s, DUE, false), verdict(s, FRESH, false), verdict(s, LEADS, s.dynasty !== "dy_send_gate")]),
  ...finders.flatMap((s) => [verdict(s, DUE, s.dynasty.endsWith("follow_up_due")), verdict(s, FRESH, false), verdict(s, LEADS, false)]),
];
const catalogueOf = (serveFields: string[] | null) =>
  buildPlayCatalogue({ tactics: [tactic(DUE, serveFields), tactic(FRESH, serveFields), tactic(LEADS, ["relationships"])], strategies: [followUpDue, leadsOnly], plays: [], verdicts: [], writerVerdicts });

describe("REPLY-NO-SCRIPT-1119: a person who wrote to us always has an answering script", () => {
  it("before: « Lead follow-up due » held on Message sent kept no script there and stayed on the judge's options", () => {
    const c = catalogueOf(null);
    expect(scriptsKeptByStrategy(senders, followUpDue, c).keptDynasties).toEqual([]);
    expect(engineOptionEffect("message_sent", runnable, followUpDue, c).runs).toEqual([]);
    // The carried-option rule is untouched: a strategy keeping none ON PURPOSE (« No rep calls ») must stay offered.
    expect(engineStrategyOptions("message_sent", runnable, c, ["lead-follow-up-due"]).map((x) => x.strategyId)).toContain("lead-follow-up-due");
  });

  it("with the serve tactics stating `serve`, « Lead follow-up due » narrows Lead found only and keeps every Message sent script", () => {
    const c = catalogueOf(["serve"]);
    expect(scriptsKeptByStrategy(senders, followUpDue, c).keptDynasties).toEqual(["dy_answer_lead", "dy_intro_answer", "dy_send_gate"]);
    expect(scriptsKeptByStrategy(finders, followUpDue, c).keptDynasties).toEqual(["dy_lead_serve_follow_up_due"]);
    expect(engineStrategyOptions("message_sent", runnable, c, ["lead-follow-up-due"]).map((x) => x.strategyId)).toEqual([null, "leads-only"]);
    expect(engineStrategyOptions("lead_found", runnable, c).map((x) => x.strategyId)).toEqual([null, "lead-follow-up-due"]);
  });

  it("migration 0078 states `serve` on every lead.serve tactic, and only on those", () => {
    const sql = readFileSync(new URL("../../drizzle/0078_serve_tactics_decided_by_serve.sql", import.meta.url), "utf8");
    expect(sql).toContain(`ARRAY['serve'] WHERE "id" IN (`);
    for (const id of ["script-lead-follow-up-due", "script-fresh-contacts-3-months", "script-warm-never-converted", "script-contacted-pure-prospects", "script-catch-all-emails", "script-unknown-emails", "script-email-reach", "script-phone-reach", "script-business-contacts-only"]) expect(sql).toContain(`'${id}'`);
    expect(sql).not.toContain("script-answers-leads-only");
    expect(sql).toContain(`AND "decided_by_fields" IS NULL`);
  });
});
