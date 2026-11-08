import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildPlayCatalogue, type Strategy, type Tactic, type WriterTacticVerdictRow } from "./plays.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import {
  briefHashOf,
  engineDefaultStrategy,
  engineStrategyNeed,
  engineStrategyOptions,
  engineStrategyQuestion,
  optionsSignatureOf,
  strategyOfStored,
} from "./engine-strategy.js";

const at = "2026-11-07T00:00:00.000Z";
const tactic = (id: string, appliesTo: Tactic["appliesTo"]): Tactic => ({ id, name: id, description: `${id} description`, createdBy: "t", createdAt: at, appliesTo });
const strategy = (id: string, requires: string[], excludes: string[]): Strategy => ({ id, name: id, description: `${id} words`, requiresTacticIds: requires, excludesTacticIds: excludes, createdBy: "t", createdAt: at });
const script = (outcome: string, dynasty: string): RunnableScript => ({ id: `${dynasty}-id`, outcome, dynasty, version: 1, description: dynasty, tactics: {}, code: "" });
const verdict = (outcome: string, dynasty: string, tacticId: string, v: boolean): WriterTacticVerdictRow => ({
  subjectKind: "script",
  subjectKey: scriptDynastyKey({ outcome, dynasty }),
  tacticId,
  subjectVersion: "v1",
  verdict: v,
  probability: v ? 0.9 : 0.1,
  model: "jev",
  judgedDescription: `${tacticId} description`,
  judgedAt: at,
});

const scripts = [script("email_sent", "dy_cold_email"), script("email_sent", "dy_pushed_email"), script("lead_found", "dy_lead_serve")];
const catalogue = buildPlayCatalogue({
  tactics: [tactic("client-mailbox", "script"), tactic("blind-angle", "template")],
  strategies: [
    strategy("our-own-emails", [], ["client-mailbox"]),
    strategy("client-s-own-emails", ["client-mailbox"], []),
    strategy("blind-only", ["blind-angle"], []),
    strategy("leads-only", [], []),
  ],
  plays: [],
  verdicts: [],
  writerVerdicts: [verdict("email_sent", "dy_cold_email", "client-mailbox", false), verdict("email_sent", "dy_pushed_email", "client-mailbox", true)],
});

describe("engineStrategyOptions (MIGRATE-1105 S6)", () => {
  it("offers no condition first, then every strategy whose script tactics split the Engine's scripts, by name", () => {
    const o = engineStrategyOptions("email_sent", scripts, catalogue);
    expect(o.map((x) => x.strategyId)).toEqual([null, "client-s-own-emails", "our-own-emails"]);
  });

  it("a strategy naming no script tactic of the Engine, or keeping all or none of its scripts, is no choice there", () => {
    expect(engineStrategyOptions("lead_found", scripts, catalogue).map((x) => x.strategyId)).toEqual([null]);
  });

  it("a carried strategy is offered whatever its scripts say (an Engine a workflow still runs)", () => {
    expect(engineStrategyOptions("meeting_booked", scripts, catalogue, ["leads-only"]).map((x) => x.strategyId)).toEqual([null, "leads-only"]);
  });

  it("the signature moves when a strategy is reworded", () => {
    const a = optionsSignatureOf(engineStrategyOptions("email_sent", scripts, catalogue));
    const b = optionsSignatureOf(engineStrategyOptions("email_sent", scripts, { ...catalogue, strategies: new Map([...catalogue.strategies, ["our-own-emails", { ...catalogue.strategies.get("our-own-emails")!, description: "other words" }]]) }));
    expect(a).not.toEqual(b);
  });

  it("the question marks no condition and maps o0..oN to the options", () => {
    const q = engineStrategyQuestion(engineStrategyOptions("email_sent", scripts, catalogue));
    expect(Object.keys(q.criteria)).toEqual(["o0", "o1", "o2"]);
    expect(q.criteria.o0).toMatch(/^DEFAULT\. No condition/);
    expect(q.instructions).not.toMatch(/pipe|play|leg|funnel/i);
  });
});

describe("an Engine's DEFAULT strategy (data): a silent brief never widens it (MIGRATE-1105 S6)", () => {
  const withDefault = { ...catalogue, strategies: new Map([...catalogue.strategies, ["our-own-emails", { ...catalogue.strategies.get("our-own-emails")!, defaultForOutcomes: ["email_sent"] }]]) };
  it("the default strategy is the first option, marked DEFAULT; no condition is no longer offered there", () => {
    const o = engineStrategyOptions("email_sent", scripts, withDefault);
    expect(o.map((x) => [x.strategyId, x.isDefault === true])).toEqual([["our-own-emails", true], ["client-s-own-emails", false]]);
    const q = engineStrategyQuestion(o);
    expect(q.criteria.o0).toMatch(/^DEFAULT\. our-own-emails/);
    expect(q.instructions).toMatch(/pick the option marked DEFAULT/);
  });
  it("an Engine stating no default keeps no condition as its default", () => {
    expect(engineStrategyOptions("email_sent", scripts, catalogue)[0]).toMatchObject({ strategyId: null, isDefault: true });
    expect(engineDefaultStrategy("email_sent", catalogue.strategies)).toBeNull();
    expect(engineDefaultStrategy("email_sent", withDefault.strategies)?.id).toBe("our-own-emails");
  });
  it("marking a default moves the options signature (a judged verdict is asked again)", () => {
    expect(optionsSignatureOf(engineStrategyOptions("email_sent", scripts, catalogue))).not.toEqual(optionsSignatureOf(engineStrategyOptions("email_sent", scripts, withDefault)));
  });
});

describe("engineStrategyNeed (MIGRATE-1105 S6)", () => {
  const h = briefHashOf("Send from our own mailboxes.");
  it("a carried verdict stands while its brief is unchanged, whatever the options", () => {
    expect(engineStrategyNeed({ source: "carried", briefHash: h, optionsSignature: null }, h, "x")).toBe("stored");
  });
  it("a judged verdict stands only on the same brief AND the same options", () => {
    expect(engineStrategyNeed({ source: "judge", briefHash: h, optionsSignature: "a" }, h, "a")).toBe("stored");
    expect(engineStrategyNeed({ source: "judge", briefHash: h, optionsSignature: "a" }, h, "b")).toBe("ask");
  });
  it("a brief that moved is judged again; no brief keeps the verdict held, and holds the Engine when none is held", () => {
    expect(engineStrategyNeed({ source: "carried", briefHash: h, optionsSignature: null }, briefHashOf("Use the client's mailboxes."), null)).toBe("ask");
    expect(engineStrategyNeed({ source: "carried", briefHash: h, optionsSignature: null }, null, null)).toBe("stored");
    expect(engineStrategyNeed(null, null, null)).toBe("hold");
    expect(engineStrategyNeed(null, h, "x")).toBe("ask");
  });
});

describe("strategyOfStored", () => {
  it("null = no condition; a strategy the catalogue lost fails loud", () => {
    expect(strategyOfStored({ campaignId: "c", outcome: "email_sent", strategyId: null }, catalogue.strategies)).toBeNull();
    expect(strategyOfStored({ campaignId: "c", outcome: "email_sent", strategyId: "our-own-emails" }, catalogue.strategies)?.id).toBe("our-own-emails");
    expect(() => strategyOfStored({ campaignId: "c", outcome: "email_sent", strategyId: "gone" }, catalogue.strategies)).toThrow(/does not hold/);
  });
});
