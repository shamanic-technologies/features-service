import { describe, expect, it } from "vitest";
import { carriedVerdictsToReask } from "./carried-verdicts.js";
import { engineStrategyNeed, engineStrategyOptions, optionsSignatureOf, type StoredEngineStrategy } from "./engine-strategy.js";
import { writerSubjectKey, type Strategy, type Tactic } from "./plays.js";
import type { RunnableScript } from "./script-catalogue-client.js";

/** PLAN-RECURSIVE-PER-ENGINE-1124: the carried verdicts a judged-row reading would re-ask, measured, nothing changed. */
const script = (outcome: string, dynasty: string): RunnableScript => ({ id: `${outcome}-${dynasty}`, outcome, dynasty, version: 1, description: "", code: "", tactics: {} });
const scripts = [script("signup", "dy_signup_path"), script("signup", "dy_signup_threads_post"), script("message_sent", "dy_sender")];
const tactic: Tactic = { id: "threads", name: "Works through a Threads post", description: "x", createdBy: "t", createdAt: "2026-11-21", appliesTo: "script", optIn: true };
const through: Strategy = { id: "through-threads-posts", name: "Through Threads posts", description: "Signups from Threads posts", requiresTacticIds: ["threads"], excludesTacticIds: [], createdBy: "t", createdAt: "2026-11-21" };
const catalogue = {
  tactics: new Map([["threads", tactic]]),
  strategies: new Map([[through.id, through]]),
  tacticsByWriter: new Map(scripts.map((s) => [writerSubjectKey("script", `${s.outcome}/${s.dynasty}`), new Map([["threads", s.dynasty === "dy_signup_threads_post"]])])),
};
const row = (over: Partial<StoredEngineStrategy>): StoredEngineStrategy => ({
  campaignId: "c1",
  outcome: "signup",
  orgId: "org-1",
  strategyId: null,
  source: "carried",
  briefHash: "h",
  optionsSignature: null,
  confidence: null,
  model: null,
  carriedFrom: "play-x",
  judgedAt: "2026-11-08T00:00:00.000Z",
  ...over,
});
const today = (outcome: string, held: string | null = null) => optionsSignatureOf(engineStrategyOptions(outcome, scripts, catalogue, held ? [held] : []));

describe("carriedVerdictsToReask", () => {
  it("lists a carried verdict whose options moved since: a strategy created after it is one of today's options", () => {
    const r = carriedVerdictsToReask([row({})], scripts, catalogue);
    expect([r.carriedRows, r.carriedCampaigns, r.unchangedRows, r.wouldReaskRows, r.wouldReaskCampaigns, r.wouldCallJudgeRows]).toEqual([1, 1, 0, 1, 1, 1]);
    expect(r.rows).toEqual([
      {
        campaignId: "c1",
        orgId: "org-1",
        outcome: "signup",
        storedStrategyId: null,
        storedStrategyName: null,
        storedStrategyKnown: true,
        carriedFrom: "play-x",
        judgedAt: "2026-11-08T00:00:00.000Z",
        reason: "no_signature_stored",
        optionsToday: 2,
        otherOptionsToday: [{ strategyId: "through-threads-posts", name: "Through Threads posts" }],
        briefStatedAtVerdict: true,
        wouldCallJudge: true,
      },
    ]);
  });

  it("a stored signature equal to today's is not listed; a different one is `options_moved`", () => {
    const same = carriedVerdictsToReask([row({ optionsSignature: today("signup") })], scripts, catalogue);
    expect([same.rows, same.unchangedRows]).toEqual([[], 1]);
    const moved = carriedVerdictsToReask([row({ optionsSignature: "older" })], scripts, catalogue);
    expect(moved.rows[0]!.reason).toBe("options_moved");
  });

  it("an Engine with one option is re-asked with no judge call; a verdict stored with no brief is listed apart", () => {
    const r = carriedVerdictsToReask([row({ outcome: "message_sent" }), row({ campaignId: "c2", briefHash: null })], scripts, catalogue);
    expect(r.rows.map((x) => [x.campaignId, x.outcome, x.optionsToday, x.briefStatedAtVerdict, x.wouldCallJudge])).toEqual([
      ["c1", "message_sent", 1, true, false],
      ["c2", "signup", 2, false, false],
    ]);
    expect([r.wouldReaskRows, r.wouldReaskCampaigns, r.wouldCallJudgeRows]).toEqual([1, 1, 0]);
  });

  it("reads only carried rows, and names a held strategy the catalogue lost instead of throwing", () => {
    const r = carriedVerdictsToReask([row({ source: "judge" }), row({ campaignId: "c3", source: "empty_brief", briefHash: null }), row({ campaignId: "c4", strategyId: "gone" })], scripts, catalogue);
    expect(r.carriedRows).toBe(1);
    expect(r.rows.map((x) => [x.campaignId, x.storedStrategyId, x.storedStrategyName, x.storedStrategyKnown])).toEqual([["c4", "gone", null, false]]);
  });

  it("measures the gap and leaves the rule alone: today a carried row stands whatever its options", () => {
    expect(engineStrategyNeed({ briefHash: "h", optionsSignature: null, source: "carried" }, "h", today("signup"))).toBe("stored");
    expect(engineStrategyNeed({ briefHash: "h", optionsSignature: "older", source: "judge" }, "h", today("signup"))).toBe("ask");
  });
});
