import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPlayCatalogue, optInTacticsOnEngine, type Strategy, type Tactic, type WriterTacticVerdictRow } from "./plays.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";

/**
 * NO-IMPERSONATION-DEFAULT-1126 (owner 2026-11-26: « impersonating could be a tactic, but the default strategy for this
 * engine should be to discard this tactic. So only if this is part of the brief, then this tactic becomes part of the
 * Ranking of the given node »). The tactic « Signs as a person of the client's team » is DATA: an opt-in script tactic
 * about the scripts' `signedBy` field (`decidedByFields`), so it gates only the Engine whose scripts state who signs.
 * A script judged yes on it runs only where the campaign's brief asks for it; no brief, a brief silent on who signs, or
 * a brief saying never = the script is out, and the Rating picks among the others. No dynasty or Engine named in code:
 * the shapes below mirror the prod catalogue of 2026-11-26.
 */
const at = "2026-11-26T10:00:00.000Z";
const SIGNS = "signs-as-a-person-of-the-client-s-team";
const description = "Judge on the script's tactics field `signedBy` only.";
const signs: Tactic = { id: SIGNS, name: "Signs as a person of the client's team", description, createdBy: "t", createdAt: at, appliesTo: "script", optIn: true, decidedByFields: ["signedBy"] };
const script = (outcome: string, dynasty: string, tactics: Record<string, unknown> = {}): RunnableScript => ({ id: `${outcome}-${dynasty}`, outcome, dynasty, version: 1, description: dynasty, tactics, code: "export default async () => ({})" });
const verdict = (s: RunnableScript, v: boolean): WriterTacticVerdictRow => ({
  subjectKind: "script",
  subjectKey: scriptDynastyKey(s),
  tacticId: SIGNS,
  subjectVersion: "v1",
  verdict: v,
  probability: v ? 0.95 : 0.05,
  model: "jev",
  judgedDescription: description,
  judgedAt: at,
});

const asPerson = script("email_sent", "dy_signed_as_client_person", { signedBy: "client_person_with_client_brand" });
const asSender = script("email_sent", "dy_signed_as_sender", { signedBy: "sender_with_client_brand" });
const plain = script("email_sent", "dy_plain");
const aiPersona = script("email_sent", "dy_ai_persona", { persona: { name: "Sophie" } });
const senders = [asPerson, asSender, plain, aiPersona];
const writer = script("message_written", "dy_writer", { asks: ["llm_completion"] });
const answerer = script("message_sent", "dy_answerer", { relationships: ["lead"] });

const catalogue = buildPlayCatalogue({
  tactics: [signs],
  strategies: [],
  plays: [],
  verdicts: [],
  writerVerdicts: senders.map((s) => verdict(s, s === asPerson)),
});
const allSenders = ["dy_ai_persona", "dy_plain", "dy_signed_as_client_person", "dy_signed_as_sender"];

describe("an email signed as a real person of the client's team runs only when the brief asks for it (NO-IMPERSONATION-DEFAULT-1126)", () => {
  it("no brief (no strategy, nothing asked): the client-person script is out, every other sender runs", () => {
    const r = scriptsKeptByStrategy(senders, null, catalogue);
    expect(r.keptDynasties).toEqual(["dy_ai_persona", "dy_plain", "dy_signed_as_sender"]);
    expect(r.scripts.find((s) => s.dynasty === "dy_signed_as_client_person")!.reason).toContain(`brief asks for "Signs as a person of the client's team"`);
  });

  it("a brief saying never (Jev answers no) or a strategy silent on it: still out", () => {
    const ourOwnEmails: Strategy = { id: "our-own-emails", name: "Our own emails", description: "x", requiresTacticIds: [], excludesTacticIds: [], createdBy: "t", createdAt: at };
    expect(scriptsKeptByStrategy(senders, ourOwnEmails, catalogue).keptDynasties).not.toContain("dy_signed_as_client_person");
    expect(scriptsKeptByStrategy(senders, null, catalogue, null, new Set<string>()).keptDynasties).not.toContain("dy_signed_as_client_person");
  });

  it("a brief asking every email signed as the founder: the client-person script is kept beside the others, the Rating picks", () => {
    expect(scriptsKeptByStrategy(senders, null, catalogue, null, new Set([SIGNS])).keptDynasties).toEqual(allSenders);
  });

  it("gates only the Engine whose scripts state who signs: writers and answerers are untouched", () => {
    expect(optInTacticsOnEngine(senders, catalogue.tactics).map((t) => t.id)).toEqual([SIGNS]);
    expect(optInTacticsOnEngine([writer], catalogue.tactics)).toEqual([]);
    expect(optInTacticsOnEngine([answerer], catalogue.tactics)).toEqual([]);
    expect(scriptsKeptByStrategy([writer, answerer], null, catalogue).keptDynasties).toEqual(["dy_answerer", "dy_writer"]);
  });
});
