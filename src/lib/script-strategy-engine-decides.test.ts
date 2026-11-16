import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPlayCatalogue, strategyOnEngine, type Strategy, type Tactic, type WriterTacticVerdictRow } from "./plays.js";
import { excludedPipeCandidates, scriptsKeptByStrategy } from "./script-strategy.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { engineOptionEffect, engineStrategyOptions } from "./engine-strategy.js";

/**
 * ONE-WRITER-N-MODELS-1116-LEADS-ONLY (prod 2026-11-16 ~21:20 UTC, campaign ad9faeb1 « Leads only »): on Message written
 * the strategy kept only the answer writer, so every cold email run of three live campaigns refused at the writer. A
 * tactic states the script tactics fields it is about; it narrows an Engine only where a runnable script states one.
 */
const at = "2026-11-16T21:20:00.000Z";
const tactic = (id: string, decidedByFields: string[] | null = null): Tactic => ({ id, name: id, description: `${id} description`, createdBy: "t", createdAt: at, appliesTo: "script", decidedByFields });
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

// The prod shape of 2026-11-16: no writer states `relationships`; every claiming sender does.
const COLD_WRITERS = ["dy_blind_intro_offer", "dy_eight_second_pitch", "dy_free_offer", "dy_named_intro_offer", "dy_three_line_reply"];
const writers = [
  ...COLD_WRITERS.map((d) => script("message_written", d, { asks: ["llm_completion"], template: `cold-reply-${d}` })),
  script("message_written", "dy_template_writer_full"),
  script("message_written", "dy_answer_lead", { asks: ["llm_completion"], personFields: ["message"] }),
];
const senders = [
  script("message_sent", "dy_answer_lead", { asks: ["booking_call", "message_written"], relationships: "pure_prospect" }),
  script("message_sent", "dy_answer_lead__glm", { asks: ["booking_call"], relationships: "pure_prospect" }),
  script("message_sent", "dy_send_gate"),
];
const callers = [script("booking_call", "dy_ring_rep"), script("booking_call", "dy_ring_rep_email_replies")];
const runnable = [...writers, ...senders, ...callers];

const LEADS = "script-answers-leads-only";
const RINGS = "script-rings-the-sales-rep";
const RINGS_EMAIL = "script-rings-on-email-replies-only";
const leadsOnly = strategy("leads-only", [LEADS]);
const ringsRep = strategy("rings-the-sales-rep", [RINGS], [RINGS_EMAIL]);

// Jev's script verdicts as stored in prod: on Message written only the answer writer « answers leads only ».
const writerVerdicts = [
  ...writers.map((s) => verdict(s, LEADS, s.dynasty === "dy_answer_lead")),
  ...senders.map((s) => verdict(s, LEADS, s.dynasty.startsWith("dy_answer_lead"))),
  ...callers.flatMap((s) => [verdict(s, RINGS, true), verdict(s, RINGS_EMAIL, s.dynasty === "dy_ring_rep_email_replies")]),
];
const catalogue = buildPlayCatalogue({ tactics: [tactic(LEADS, ["relationships"]), tactic(RINGS), tactic(RINGS_EMAIL)], strategies: [leadsOnly, ringsRep], plays: [], verdicts: [], writerVerdicts });

describe("a strategy narrows an Engine only by the tactics about what its scripts decide (ONE-WRITER-N-MODELS-1116-LEADS-ONLY)", () => {
  it("script-strategy on ad9faeb1 x message_written: Leads only keeps the five cold email writers and dy_template_writer_full", () => {
    const r = scriptsKeptByStrategy(writers, leadsOnly, catalogue);
    for (const d of [...COLD_WRITERS, "dy_template_writer_full"]) expect(r.keptDynasties).toContain(d);
    expect(r.scripts.every((s) => s.kept && s.reason === null)).toBe(true);
    expect(r.scriptTacticIds).toEqual([]);
  });

  it("outcome=message_sent on a Leads only campaign answers as today: only the scripts that answer leads only", () => {
    const r = scriptsKeptByStrategy(senders, leadsOnly, catalogue);
    expect(r.keptDynasties).toEqual(["dy_answer_lead", "dy_answer_lead__glm"]);
    expect(r.scriptTacticIds).toEqual([LEADS]);
    expect(r.scripts.find((s) => s.dynasty === "dy_send_gate")!.reason).toContain("does not follow it");
  });

  it("the rep call's strategy keeps narrowing Booking call (a child pick; its tactic states no field)", () => {
    expect(scriptsKeptByStrategy(callers, ringsRep, catalogue).keptDynasties).toEqual(["dy_ring_rep"]);
  });

  it("a tactic stating no field applies on every Engine (as before)", () => {
    const strict = buildPlayCatalogue({ tactics: [tactic(LEADS)], strategies: [], plays: [], verdicts: [], writerVerdicts });
    expect(scriptsKeptByStrategy(writers, leadsOnly, strict).keptDynasties).toEqual(["dy_answer_lead"]);
    expect(strategyOnEngine(leadsOnly, writers, catalogue.tactics).requiresTacticIds).toEqual([]);
    expect(strategyOnEngine(leadsOnly, senders, catalogue.tactics).requiresTacticIds).toEqual([LEADS]);
  });

  it("the pipe price subtraction, the option effect and the judge's options read the same rule", () => {
    const keys = [...writers, ...senders].map(scriptDynastyKey);
    const full = { ...catalogue, tacticsByDynasty: new Map() };
    expect([...excludedPipeCandidates(leadsOnly, keys, full, runnable)].sort()).toEqual(["message_sent/dy_send_gate"]);
    // Scripts unread = every script tactic applies, as strict as before.
    expect(excludedPipeCandidates(leadsOnly, keys, full).size).toBe(7);
    expect(engineOptionEffect("message_written", runnable, leadsOnly, catalogue).neverRuns).toEqual([]);
    // Leads only no longer splits Message written: the judge is never offered it there.
    expect(engineStrategyOptions("message_written", runnable, catalogue).map((o) => o.strategyId)).not.toContain("leads-only");
    expect(engineStrategyOptions("message_sent", runnable, catalogue).map((o) => o.strategyId)).toContain("leads-only");
  });

  it("migration 0075 states `relationships` on the three who-is-answered tactics only", () => {
    const sql = readFileSync(new URL("../../drizzle/0075_tactic_decided_by_fields.sql", import.meta.url), "utf8");
    expect(sql).toContain(`ARRAY['relationships'] WHERE "id" IN ('script-answers-leads-only', 'script-current-clients-only', 'script-answers-the-brand-s-team-only')`);
  });
});
