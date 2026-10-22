import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { ledgerLlmBars, llmCandidates, servedRankings, templateCandidates, type LegWriterRankingPayload } from "./leg-writer-ranking.js";
import { buildPlayCatalogue, strategyOnSubject, type Strategy, type Tactic } from "../lib/plays.js";
import type { TemplateDynasty } from "../lib/research/template-dynasties.js";
import type { ServedModel } from "../lib/model-ids-client.js";

const dynasty = (slug: string, status: "active" | "deprecated" = "active"): TemplateDynasty => ({
  slug,
  name: slug.toUpperCase(),
  description: "",
  signature: null,
  identity: "",
  head: `${slug}-v2`,
  versions: [`${slug}-v1`, `${slug}-v2`],
  status,
  statusSource: "content_generation",
  versionStatuses: {},
});
const model = (modelId: string, displayName: string, aliases: string[]): ServedModel => ({ modelId, displayName, aliases, formerAliases: [], provider: "google", capabilityTier: "cheap" });

const tactic = (id: string, appliesTo: Tactic["appliesTo"]): Tactic => ({ id, name: id, description: id, createdBy: "t", createdAt: "2026-10-22T00:00:00Z", appliesTo });
const strategy = (id: string, requires: string[], excludes: string[]): Strategy => ({ id, name: id, description: id, requiresTacticIds: requires, excludesTacticIds: excludes, createdBy: "t", createdAt: "2026-10-22T00:00:00Z" });

function payload(): LegWriterRankingPayload {
  return {
    featureSlug: "sales-cold-email-outreach",
    legKey: "start_to_conversation",
    pipeId: "sales-cold-email-outreach|lead_found_to_conversation",
    computedAt: "2026-10-22T00:00:00Z",
    costBasis: "incurred",
    rankBasis: "cost_per_outcome",
    maturity: { durationDays: 21, outcomesRequired: 1, cutoffIso: "2026-10-01T00:00:00Z" },
    writerEvidence: "measured",
    templates: {
      candidates: templateCandidates(
        [
          { key: "blind", label: "Blind", basis: "mature", figures: { spentUsd: 430, contacted: 4000, outcomes: 10 } },
          { key: "old-v3", label: "old v3", basis: "flash", figures: { spentUsd: 5, contacted: 40, outcomes: 0 } },
        ],
        [dynasty("blind"), dynasty("offer"), dynasty("retired", "deprecated")],
      ),
      unavailableReason: null,
    },
    llms: {
      candidates: llmCandidates(
        [{ key: "gemini-3-flash", label: "Gemini 3 Flash", basis: "mature", figures: { spentUsd: 430, contacted: 4000, outcomes: 10 } }],
        [
          { alias: "gemini-flash", provider: "google", status: "active" },
          { alias: "opus", provider: "anthropic", status: "active" },
          { alias: "haiku-old", provider: "anthropic", status: "deprecated" },
        ],
        [model("gemini-3-flash-001", "Gemini 3 Flash", ["gemini-flash"]), model("claude-opus-5-5", "Claude Opus 5.5", ["opus"]), model("claude-haiku-x", "Claude Haiku X", ["haiku-old"])],
      ),
      unavailableReason: null,
    },
    leftOut: { templates: { contacted: 0, outcomes: 0 }, llms: { contacted: 0, outcomes: 0 } },
  };
}

describe("leg writer ranking route helpers (BEST-TPL-LLM-1022)", () => {
  it("lists every dynasty of the pipe (zero until it writes) and a standalone version that wrote, never pickable", () => {
    const p = payload();
    expect(p.templates.candidates.map((x) => [x.key, x.selectable, x.notSelectableReason])).toEqual([
      ["blind", true, null],
      ["offer", true, null],
      ["retired", false, "template_dynasty_deprecated"],
      ["old-v3", false, "no_dynasty_on_pipe"],
    ]);
  });

  it("an LLM is a model, keyed like its Research page; selectable through an active writer alias", () => {
    const p = payload();
    expect(p.llms.candidates.map((x) => [x.key, x.selectable, x.aliases.map((a) => a.alias)])).toEqual([
      ["gemini-3-flash", true, ["gemini-flash"]],
      ["claude-opus-5.5", true, ["opus"]],
      ["claude-haiku-x", false, ["haiku-old"]],
    ]);
  });

  it("with no strategy: the unused template and the unused LLM go first, each chosen independently", () => {
    const served = servedRankings(payload(), buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [] }), null);
    expect(served.templates.best?.key).toBe("offer");
    expect(served.templates.best?.explorePriceUsd).toBe(0);
    expect(served.llms.best?.key).toBe("claude-opus-5.5");
    expect(served.templates.rows.find((r) => r.key === "blind")?.place).toBe("money");
  });

  it("a strategy's template / LLM tactics narrow the candidates; an item it excludes is never returned", () => {
    const tactics = [tactic("anthropic-models", "llm"), tactic("blind-text", "template"), tactic("catch-all", "workflow")];
    const st = strategy("no-anthropic-blind", ["blind-text"], ["anthropic-models", "catch-all"]);
    const c = buildPlayCatalogue({
      tactics,
      strategies: [st],
      plays: [],
      verdicts: [],
      writerVerdicts: [
        { subjectKind: "llm", subjectKey: "opus", tacticId: "anthropic-models", subjectVersion: "claude-opus-5-5", verdict: true, probability: 0.99, model: "jev", judgedDescription: "anthropic-models", judgedAt: "2026-10-22T00:00:00Z" },
        { subjectKind: "llm", subjectKey: "gemini-flash", tacticId: "anthropic-models", subjectVersion: "gemini-3-flash-001", verdict: false, probability: 0.01, model: "jev", judgedDescription: "anthropic-models", judgedAt: "2026-10-22T00:00:00Z" },
        { subjectKind: "template", subjectKey: "blind", tacticId: "blind-text", subjectVersion: "blind-v2", verdict: true, probability: 0.9, model: "jev", judgedDescription: "blind-text", judgedAt: "2026-10-22T00:00:00Z" },
        { subjectKind: "template", subjectKey: "offer", tacticId: "blind-text", subjectVersion: "offer-v2", verdict: false, probability: 0.1, model: "jev", judgedDescription: "blind-text", judgedAt: "2026-10-22T00:00:00Z" },
      ],
    });
    const served = servedRankings(payload(), c, st);
    expect(served.llms.rows.map((r) => r.key)).not.toContain("claude-opus-5.5");
    expect(served.llms.best?.key).toBe("gemini-3-flash");
    expect(served.templates.rows.map((r) => r.key)).not.toContain("offer");
    expect(served.templates.best?.key).toBe("blind");
    // every selectable LLM ruled out = a strategy refusal, named apart from "nothing selectable"
    const allOut = servedRankings(payload(), c, strategy("anthropic-only", ["anthropic-models"], []));
    expect(allOut.llms.best?.key).toBe("claude-opus-5.5");
    const noneLeft = servedRankings({ ...payload(), llms: { ...payload().llms, candidates: payload().llms.candidates.filter((x) => x.key !== "claude-opus-5.5") } }, c, strategy("anthropic-only", ["anthropic-models"], []));
    expect(noneLeft.llms.best).toBeNull();
    expect(noneLeft.llms.unavailableReason).toBe("strategy_excludes_every_candidate");
    // A template never judged on a tactic the strategy names is ruled out (the workflow rule).
    expect(served.templates.excluded.map((x) => x.key).sort()).toEqual(["offer", "old-v3", "retired"]);
  });

  it("a workflow strategy reads only its workflow tactics (a template tactic never gates a workflow)", () => {
    const tactics = new Map([tactic("blind-text", "template"), tactic("catch-all", "workflow")].map((t) => [t.id, t]));
    const st = strategy("s", ["blind-text"], ["catch-all"]);
    expect(strategyOnSubject(st, "workflow", tactics)).toMatchObject({ requiresTacticIds: [], excludesTacticIds: ["catch-all"] });
    expect(strategyOnSubject(st, "template", tactics)).toMatchObject({ requiresTacticIds: ["blind-text"], excludesTacticIds: [] });
    expect(strategyOnSubject(st, "llm", tactics)).toMatchObject({ requiresTacticIds: [], excludesTacticIds: [] });
  });

  it("a pipe with no writer evidence picks nothing and says why (its runs keep the workflow's own writer)", () => {
    const p = { ...payload(), writerEvidence: "no_sequence_recorded_on_pipe" as const };
    const served = servedRankings(p, buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [] }), null);
    expect(served.templates.best).toBeNull();
    expect(served.templates.unavailableReason).toBe("no_sequence_recorded_on_pipe");
    expect(served.llms.best).toBeNull();
  });

  it("a chat /complete internal pipe: each campaign's spend shared on its acted people, filed under the LLM the ledger states", () => {
    const writerOf = (campaignId: string, person: string) => {
      const aliases: Record<string, string> = { "c1|b:l1": "opus", "c1|b:l2": "opus", "c1|b:l3": "flash", "c2|b:l4": "flash" };
      const alias = aliases[`${campaignId}|${person}`];
      return alias ? { key: alias === "opus" ? "claude-opus-5.5" : "gemini-3-flash", label: alias } : null;
    };
    const r = ledgerLlmBars(
      [
        { campaignId: "c1", spentUsd: 40, acted: ["b:l1", "b:l2", "b:l3", "b:l9"], reached: ["b:l1", "b:l9"] },
        { campaignId: "c2", spentUsd: 6, acted: ["b:l4"], reached: [] },
      ],
      writerOf,
      "conversation_to_meeting_booked",
    );
    expect(r.rows.map((x) => [x.key, x.figures])).toEqual([
      ["claude-opus-5.5", { spentUsd: 20, contacted: 2, outcomes: 1 }],
      ["gemini-3-flash", { spentUsd: 16, contacted: 2, outcomes: 0 }],
    ]);
    expect(r.leftOut).toEqual({ contacted: 1, outcomes: 1 });
    expect(r.recorded).toBe(4);
    // 0-day leg, bar 10 outcomes: one outcome is still learning
    expect(r.rows.every((x) => x.basis === "flash")).toBe(true);
  });
});
