import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { ledgerLlmBars, llmCandidates, servedRankings, templateCandidates, type LegWriterRankingPayload } from "./leg-writer-ranking.js";
import { buildPlayCatalogue, strategyOnSubject, type Strategy, type Tactic } from "../lib/plays.js";
import type { TemplateDynasty } from "../lib/research/template-dynasties.js";
import type { ServedModel } from "../lib/model-ids-client.js";
import { llmDynastyIndex, type LlmDynasty } from "../lib/llm-dynasties.js";

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
        { subjectKind: "llm", subjectKey: "claude-opus-5.5", tacticId: "anthropic-models", subjectVersion: "claude-opus-5-5", verdict: true, probability: 0.99, model: "jev", judgedDescription: "anthropic-models", judgedAt: "2026-10-22T00:00:00Z" },
        { subjectKind: "llm", subjectKey: "gemini-3-flash", tacticId: "anthropic-models", subjectVersion: "gemini-3-flash-001", verdict: false, probability: 0.01, model: "jev", judgedDescription: "anthropic-models", judgedAt: "2026-10-22T00:00:00Z" },
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
    // Each template row serves its tactics (TPL-TACTICS-ROWS-1022): judged yes = listed, judged no = [], unjudged = null + reason.
    const noStrategy = servedRankings(payload(), c, null);
    expect(noStrategy.templates.rows.find((r) => r.key === "blind")).toMatchObject({ tactics: [{ id: "blind-text", name: "blind-text" }], tacticsUnavailableReason: null });
    expect(noStrategy.templates.rows.find((r) => r.key === "offer")).toMatchObject({ tactics: [], tacticsUnavailableReason: null });
    expect(noStrategy.templates.rows.find((r) => r.key === "retired")).toMatchObject({ tactics: null, tacticsUnavailableReason: "not_judged_yet" });
    expect(noStrategy.templates.best && "tactics" in noStrategy.templates.best).toBe(true);
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

  it("a pipe with no writer on record yet still picks, every candidate Learning at $0 (WA-PIPE-RESEARCH-1023)", () => {
    const zero = <T extends { figures: { spentUsd: number; contacted: number; outcomes: number }; basis: string }>(c: T): T => ({ ...c, basis: "flash", figures: { spentUsd: 0, contacted: 0, outcomes: 0 } });
    const base = payload();
    const p = {
      ...base,
      writerEvidence: "no_sequence_recorded_on_pipe" as const,
      templates: { ...base.templates, candidates: base.templates.candidates.map(zero) },
      llms: { ...base.llms, candidates: base.llms.candidates.map(zero) },
    };
    const served = servedRankings(p, buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [] }), null);
    // never used = explore at $0, ties on the key; a template / LLM nobody may write with is never picked
    expect(served.templates.best).toMatchObject({ key: "blind", place: "explore", explorePriceUsd: 0, isMature: false });
    expect(served.templates.unavailableReason).toBeNull();
    expect(served.llms.best).toMatchObject({ key: "claude-opus-5.5", isMature: false });
    // no template candidate at all (content-generation lists none for the pipe yet): no pick, named
    const none = servedRankings({ ...p, templates: { candidates: [], unavailableReason: null } }, buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [] }), null);
    expect(none.templates.best).toBeNull();
    expect(none.templates.unavailableReason).toBe("no_candidate");
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

// LLM-DYNASTY-1022-FS: the LLM side pools per chat-service DYNASTY, its versions as the detail.
const FLASH: LlmDynasty = {
  slug: "gemini-flash",
  name: "Gemini Flash",
  provider: "google",
  capabilityTier: "cheap",
  headModelId: "gemini-3.8-flash",
  servedToday: true,
  models: [
    { modelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", servedToday: true },
    { modelId: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", servedToday: false },
  ],
  legacyAliases: ["flash-pro"],
};
const OPUS: LlmDynasty = {
  slug: "claude-opus",
  name: "Claude Opus",
  provider: "anthropic",
  capabilityTier: "frontier",
  headModelId: "claude-opus-5-5",
  servedToday: true,
  models: [{ modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", servedToday: true }],
  legacyAliases: ["opus"],
};
const DS_FLASH: LlmDynasty = { slug: "deepseek-flash", name: "DeepSeek Flash", provider: "deepseek", capabilityTier: "cheap", headModelId: "deepseek-flash", servedToday: true, models: [{ modelId: "deepseek-flash", displayName: "DeepSeek V4.1 Flash", servedToday: true }], legacyAliases: ["deepseek-flash", "deepseek-pro"] };
const DS_PRO: LlmDynasty = { slug: "deepseek-pro", name: "DeepSeek Pro", provider: "deepseek", capabilityTier: "strong", headModelId: "deepseek-v4-pro", servedToday: false, models: [{ modelId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", servedToday: false }], legacyAliases: [] };
const LLM_DYN = llmDynastyIndex([FLASH, OPUS, DS_FLASH, DS_PRO]);

describe("LLM dynasties on the writer ranking (LLM-DYNASTY-1022-FS)", () => {
  it("resolves a name in chat-service's order: served slug, model id, served legacy alias", () => {
    expect(LLM_DYN.dynastyOfName("gemini-flash")?.slug).toBe("gemini-flash");
    expect(LLM_DYN.dynastyOfName("gemini-3.7-flash")?.slug).toBe("gemini-flash");
    expect(LLM_DYN.dynastyOfName("flash-pro")?.slug).toBe("gemini-flash");
    expect(LLM_DYN.dynastyOfName("opus")?.slug).toBe("claude-opus");
    // `deepseek-pro`: slug of a line nothing serves AND a legacy alias of DeepSeek Flash: it runs DeepSeek Flash
    expect(LLM_DYN.dynastyOfName("deepseek-pro")?.slug).toBe("deepseek-flash");
    // the concrete V4 Pro id is DeepSeek Pro's history
    expect(LLM_DYN.dynastyOfName("deepseek-v4-pro")?.slug).toBe("deepseek-pro");
    expect(LLM_DYN.dynastyOfName("mystery-model")).toBeNull();
  });

  it("one row per dynasty, its versions pooled (the sum of its models), each model as the detail", () => {
    const bars = [{ key: "gemini-flash", label: "Gemini Flash", basis: "mature" as const, figures: { spentUsd: 50, contacted: 1000, outcomes: 4 } }];
    const modelBars = [
      { key: "gemini-3.7-flash", label: "Gemini 3.7 Flash", dynastyKey: "gemini-flash", basis: "mature" as const, figures: { spentUsd: 30, contacted: 600, outcomes: 3 } },
      { key: "gemini-3.8-flash", label: "Gemini 3.8 Flash", dynastyKey: "gemini-flash", basis: "mature" as const, figures: { spentUsd: 20, contacted: 400, outcomes: 1 } },
    ];
    const c = llmCandidates(
      bars,
      [
        { alias: "flash-pro", provider: "google", status: "active" },
        { alias: "opus", provider: "anthropic", status: "active" },
        { alias: "deepseek-pro", provider: "deepseek", status: "active" },
        // content-generation lists every name chat-service accepts (LLM-DYNASTY-1022-CG): slugs and head ids fold in
        { alias: "gemini-flash", provider: "google", status: "active" },
        { alias: "gemini-3.8-flash", provider: "google", status: "active" },
        { alias: "claude-opus", provider: "anthropic", status: "active" },
      ],
      [],
      LLM_DYN,
      modelBars,
    );
    const flash = c.find((x) => x.key === "gemini-flash")!;
    expect(flash).toMatchObject({ llmDynastySlug: "gemini-flash", label: "Gemini Flash", headModelId: "gemini-3.8-flash", selectable: true });
    expect(flash.models.map((m) => [m.key, m.head, m.spentUsd, m.outcomes])).toEqual([
      ["gemini-3.8-flash", true, 20, 1],
      ["gemini-3.7-flash", false, 30, 3],
    ]);
    const sum = flash.models.reduce((a, m) => ({ spentUsd: a.spentUsd + m.spentUsd, contacted: a.contacted + m.contacted, outcomes: a.outcomes + m.outcomes }), { spentUsd: 0, contacted: 0, outcomes: 0 });
    expect(sum).toEqual(flash.figures);
    // `deepseek-pro` alias runs DeepSeek Flash: one row, never a DeepSeek Pro pick
    expect(c.map((x) => x.key).sort()).toEqual(["claude-opus", "deepseek-flash", "gemini-flash"]);
    expect(flash.aliases.map((a) => a.alias)).toEqual(["flash-pro", "gemini-3.8-flash", "gemini-flash"]);
  });

  it("rank 1 names a dynasty; the pick calls an active alias of it; an LLM tactic judges the dynasty", () => {
    const base = payload();
    const p: LegWriterRankingPayload = {
      ...base,
      llms: {
        candidates: llmCandidates(
          [{ key: "gemini-flash", label: "Gemini Flash", basis: "mature", figures: { spentUsd: 430, contacted: 4000, outcomes: 10 } }],
          [
            { alias: "flash-pro", provider: "google", status: "active" },
            { alias: "opus", provider: "anthropic", status: "active" },
          ],
          [],
          LLM_DYN,
          [],
        ),
        unavailableReason: null,
      },
    };
    const none = servedRankings(p, buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [] }), null);
    expect(none.llms.best).toMatchObject({ key: "claude-opus", llmDynastySlug: "claude-opus" });
    const t = tactic("anthropic-models", "llm");
    const st = strategy("no-anthropic", [], ["anthropic-models"]);
    const c = buildPlayCatalogue({
      tactics: [t],
      strategies: [st],
      plays: [],
      verdicts: [],
      writerVerdicts: [
        { subjectKind: "llm", subjectKey: "claude-opus", tacticId: "anthropic-models", subjectVersion: "claude-opus-5-5", verdict: true, probability: 0.99, model: "jev", judgedDescription: "anthropic-models", judgedAt: "2026-10-22T00:00:00Z" },
        { subjectKind: "llm", subjectKey: "gemini-flash", tacticId: "anthropic-models", subjectVersion: "gemini-3.8-flash", verdict: false, probability: 0.01, model: "jev", judgedDescription: "anthropic-models", judgedAt: "2026-10-22T00:00:00Z" },
      ],
    });
    const narrowed = servedRankings(p, c, st);
    expect(narrowed.llms.best).toMatchObject({ key: "gemini-flash", llmDynastySlug: "gemini-flash", aliases: [{ alias: "flash-pro", provider: "google", status: "active" }] });
    expect(narrowed.llms.excluded.map((x) => x.key)).toEqual(["claude-opus"]);
  });
});
