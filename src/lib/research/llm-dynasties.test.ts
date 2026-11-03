import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
import type { SlugCell } from "./buckets.js";
import { generationBuckets, generationStudies, type GenerationsInput } from "./generations.js";
import { pipeCatalog } from "./catalog.js";
import { llmDynastyIndex, type LlmDynasty } from "../llm-dynasties.js";

// LLM-DYNASTY-1022-FS: a Research model page and bar is an LLM DYNASTY (chat-service's), its versions pooled.

const terms = {
  pipe: "cold-email-positive-reply" as const,
  noun: "positive reply",
  nounPlural: "positive replies",
  exposureNoun: "people emailed",
  exposureNounOne: "person emailed",
  outcomesRequired: 1,
  partialMonth: null,
  note: "rule",
};
const half = (spentUsd: number, contacted: number, outcomes: number) => ({
  figures: { spentUsd, contacted, outcomes },
  months: { "2026-09": { spentUsd, contacted, outcomes } },
  strata: { "o1|2026-09": { spentUsd, contacted, outcomes } },
});
const pb = (slug: string, model: string, contacted: number, replies: number) => ({
  orgId: "o1",
  brandId: "b1",
  campaignId: "c1",
  country: null,
  workflowSlug: slug,
  servedDay: "2026-09-10",
  contacted,
  clicked: 0,
  positiveReplies: replies,
  screenedContacted: 0,
  humanClicked: 0,
  generation: { model, promptType: "cold-email-v35", layout: "double_line_breaks", opening: "greeting", dash: "none" },
});

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
    { modelId: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", servedToday: false },
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

const cells: SlugCell[] = [
  { slug: "azalea-v1", flash: half(400, 400, 8), mature: half(300, 300, 6) },
  { slug: "azalea-v2", flash: half(100, 200, 1), mature: half(100, 200, 1) },
];
// The line moved from 3.7 to 3.8 Flash; Opus and a model chat-service places nowhere wrote too.
const persons = [
  pb("azalea-v1", "gemini-3.7-flash", 200, 5),
  pb("azalea-v1", "claude-opus-5-5", 100, 0),
  pb("azalea-v1", "mystery-model", 100, 3),
  pb("azalea-v2", "gemini-3.8-flash", 200, 1),
];
const NAMES = new Map(
  [
    ["gemini-3.8-flash", "Gemini 3.8 Flash"],
    ["gemini-3.7-flash", "Gemini 3.7 Flash"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
  ].map(([id, label]) => [id!, { label: label!, tier: "Flash" as const }]),
);
const input = (dynasties: readonly LlmDynasty[] | "llm_dynasties_unreadable"): GenerationsInput => ({
  terms,
  legKey: "start_to_conversation",
  cells,
  persons,
  split: { screened: false, signal: "positiveReply", cutoffDay: "2026-09-27" },
  models: NAMES,
  templateTexts: new Map(),
  naming: false,
  llmDynasties: llmDynastyIndex(dynasties),
});

describe("LLM dynasties on the Research pages (LLM-DYNASTY-1022-FS)", () => {
  it("pools every version into its dynasty's bar; the model bars add up to it exactly, on its basis", () => {
    const g = generationBuckets(input([FLASH, OPUS]));
    expect(g.llm.rows.map((r) => [r.key, r.label]).sort()).toEqual([
      ["claude-opus", "Claude Opus"],
      ["gemini-flash", "Gemini Flash"],
      ["mystery-model", "mystery-model"],
    ]);
    const bar = g.llm.rows.find((r) => r.key === "gemini-flash")!;
    const ms = g.llmModels.filter((m) => m.dynastyKey === "gemini-flash");
    expect(ms.map((m) => m.key).sort()).toEqual(["gemini-3.7-flash", "gemini-3.8-flash"]);
    expect(ms.every((m) => m.basis === bar.basis)).toBe(true);
    for (const k of ["spentUsd", "contacted", "outcomes"] as const) {
      expect(ms.reduce((a, m) => a + m.figures[k], 0)).toBeCloseTo(bar.figures[k], 9);
    }
    // the dynasty bar holds both versions' people: 200 (3.7) + 200 (3.8)
    expect(bar.figures.contacted).toBeCloseTo(ms.reduce((a, m) => a + m.figures.contacted, 0), 9);
  });

  it("the LLM study's bars are the dynasties", () => {
    const study = generationStudies(input([FLASH, OPUS])).find((s) => s.id === "cold-email-positive-reply-llm-roi")!;
    // a cost bar needs an outcome: Claude Opus (0 replies) is not drawn; no single-version bar is
    expect(study.charts[0]!.points.map((p) => p.key).sort()).toEqual(["gemini-flash", "mystery-model"]);
  });

  it("dynasties unreadable: every model is its own bar (the per-model rows of before)", () => {
    const g = generationBuckets(input("llm_dynasties_unreadable"));
    expect(g.llm.rows.map((r) => r.key).sort()).toEqual(["claude-opus-5.5", "gemini-3.7-flash", "gemini-3.8-flash", "mystery-model"]);
  });

  it("serves one model page per dynasty with every version as its detail; workflow refs point at the dynasty page", () => {
    const dyn = llmDynastyIndex([FLASH, OPUS]);
    const g = generationBuckets(input([FLASH, OPUS]));
    const served = [
      { modelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", aliases: ["flash-pro"], formerAliases: [] },
      { modelId: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", aliases: [], formerAliases: ["flash-pro"] },
      { modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", aliases: ["opus"], formerAliases: [] },
    ];
    const c = pipeCatalog({
      terms,
      workflows: [{ key: "azalea", label: "Azalea", basis: "mature", figures: { spentUsd: 400, contacted: 600, outcomes: 7 }, learning: false, months: null, strata: null }],
      templates: g.tpl.rows,
      models: g.llm.rows,
      modelVersions: g.llmModels,
      llmDynasties: dyn,
      nameOf: () => null,
      mainOf: () => ({ model: "gemini-3.7-flash", template: null }),
      modelLabel: g.modelLabel,
      dynastyOf: (s) => s.replace(/-v\d+$/, ""),
      workflowRuns: [],
      generationRuns: [
        { createdAt: "2026-10-18T10:00:00Z", model: "gemini-3.8-flash", promptType: "cold-email-v35", workflowSlug: "azalea-v2", tokensInput: 5000, tokensOutput: 300 },
        { createdAt: "2026-10-17T10:00:00Z", model: "gemini-3.7-flash", promptType: "cold-email-v35", workflowSlug: "azalea-v1" },
      ],
      templateTexts: new Set(),
      runnableWorkflows: null,
      writerOf: () => ({ ok: true, workflowSlug: "azalea-v2", version: 2, template: "cold-email-v35", modelAlias: "flash-pro", model: { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" } }),
      servedModels: served,
      generationCosts: [
        { createdAt: "2026-10-17T10:00:00Z", model: "gemini-3.7-flash", inputCents: 0.3, outputCents: 0.1, tokensInput: 3000, tokensOutput: 200 },
        { createdAt: "2026-10-18T10:00:00Z", model: "gemini-3.8-flash", inputCents: 0.5, outputCents: 0.3, tokensInput: 5000, tokensOutput: 300 },
        { createdAt: "2026-10-18T11:00:00Z", model: "gemini-3.8-flash", inputCents: null, outputCents: null, tokensInput: null, tokensOutput: null },
        { createdAt: "2026-10-18T12:00:00Z", model: "claude-opus-5-5", inputCents: 4, outputCents: 6, tokensInput: 4000, tokensOutput: 400 },
      ],
    });
    // MODEL-RUN-COST-1024: one writing run's cost per page, its versions partition the page's runs
    const flashCost = c.models.find((m) => m.key === "gemini-flash")!.runCost;
    expect(flashCost).toMatchObject({ runs: 2, runsWithoutCost: 1, unavailableReason: null });
    expect(flashCost.averageUsd).toBeCloseTo(0.006);
    expect(flashCost.history.at(-1)!.averageUsd).toBeCloseTo(flashCost.averageUsd!);
    const versions = c.models.find((m) => m.key === "gemini-flash")!.models;
    expect(versions.map((v) => [v.key, v.runCost.runs])).toEqual([["gemini-3.8-flash", 1], ["gemini-3.7-flash", 1], ["gemini-3.5-flash", 0]]);
    expect(versions[2]!.runCost.unavailableReason).toBe("no_run_on_pipe");
    expect(versions.reduce((a, v) => a + v.runCost.totalUsd, 0)).toBeCloseTo(flashCost.totalUsd);
    expect(c.models.find((m) => m.key === "claude-opus")!.runCost.averageUsd).toBeCloseTo(0.1);
    expect(c.models.find((m) => m.key === "gemini-flash")!.runs[0]!.tokens).toBe("5,000 in / 300 out");
    const page = c.models.find((m) => m.key === "gemini-flash")!;
    expect(page.label).toBe("Gemini Flash");
    expect(page.dynasty).toEqual({ slug: "gemini-flash", name: "Gemini Flash", provider: "google", capabilityTier: "cheap", headModelId: "gemini-3.8-flash", servedToday: true, legacyAliases: ["flash-pro"] });
    expect(page.standaloneReason).toBeNull();
    expect(page.modelIds).toEqual(["gemini-3.7-flash", "gemini-3.8-flash"]);
    expect(page.aliases).toEqual(["flash-pro"]);
    expect(page.models.map((m) => [m.key, m.head, m.emails])).toEqual([
      ["gemini-3.8-flash", true, "200"],
      ["gemini-3.7-flash", false, "150"],
      ["gemini-3.5-flash", false, "0"],
    ]);
    // read mature (the dynasty's basis): 3.7 = 150 of azalea-v1's 300 mature people, 3.8 = azalea-v2's 200
    expect(page.emails).toBe("350");
    expect(page.runs).toHaveLength(2);
    const wf = c.workflows.find((w) => w.key === "azalea")!;
    expect(wf.model).toEqual({ key: "gemini-flash", label: "Gemini Flash", linked: true });
    expect(wf.writesWithNow?.model).toEqual({ key: "gemini-flash", label: "Gemini Flash", linked: true });
    const mystery = c.models.find((m) => m.key === "mystery-model")!;
    expect(mystery).toMatchObject({ dynasty: null, standaloneReason: "no_dynasty_in_chat_service" });
    expect(mystery.models.map((m) => m.key)).toEqual(["mystery-model"]);
  });

  it("places a pipe's run costs in linear time, each page and version holding exactly its rows (BOX-OVERLOAD-1026)", () => {
    // The page / version grouping re-spread a list per row and re-filtered every row per page: a pipe with tens of
    // thousands of writing runs spent most of a Research build there. Same partition, now one pass.
    const dyn = llmDynastyIndex([FLASH, OPUS]);
    const g = generationBuckets(input([FLASH, OPUS]));
    const models = ["gemini-3.7-flash", "gemini-3.8-flash", "claude-opus-5-5", "mystery-model"];
    const generationCosts = Array.from({ length: 120_000 }, (_, i) => ({
      createdAt: `2026-10-${String(10 + (i % 15)).padStart(2, "0")}T10:00:00Z`,
      model: models[i % models.length]!,
      inputCents: 0.1,
      outputCents: 0.1,
      tokensInput: 1000,
      tokensOutput: 100,
    }));
    const began = Date.now();
    const c = pipeCatalog({
      terms,
      workflows: [{ key: "azalea", label: "Azalea", basis: "mature", figures: { spentUsd: 400, contacted: 600, outcomes: 7 }, learning: false, months: null, strata: null }],
      templates: g.tpl.rows,
      models: g.llm.rows,
      modelVersions: g.llmModels,
      llmDynasties: dyn,
      nameOf: () => null,
      mainOf: () => ({ model: "gemini-3.7-flash", template: null }),
      modelLabel: g.modelLabel,
      dynastyOf: (s) => s.replace(/-v\d+$/, ""),
      workflowRuns: [],
      generationRuns: [],
      templateTexts: new Set(),
      runnableWorkflows: null,
      writerOf: () => ({ ok: true, workflowSlug: "azalea-v2", version: 2, template: "cold-email-v35", modelAlias: "flash-pro", model: { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" } }),
      servedModels: [],
      generationCosts,
    });
    expect(Date.now() - began).toBeLessThan(1_500);
    const flash = c.models.find((m) => m.key === "gemini-flash")!;
    expect(flash.runCost.runs).toBe(60_000);
    expect(flash.models.map((v) => [v.key, v.runCost.runs])).toEqual([["gemini-3.8-flash", 30_000], ["gemini-3.7-flash", 30_000], ["gemini-3.5-flash", 0]]);
    expect(c.models.find((m) => m.key === "claude-opus")!.runCost.runs).toBe(30_000);
    expect(c.models.find((m) => m.key === "mystery-model")!.runCost.runs).toBe(30_000);
  });
});

describe("model pages and model versions serve no return (ROI-CONSISTENCY-1103)", () => {
  const catalogWith = (ps = persons, cs = cells) => {
    const g = generationBuckets({ ...input([FLASH, OPUS]), persons: ps, cells: cs });
    return pipeCatalog({
      terms,
      workflows: [{ key: "azalea", label: "Azalea", basis: "mature", figures: { spentUsd: 500, contacted: 600, outcomes: 9 }, learning: false, months: null, strata: null }],
      templates: g.tpl.rows,
      models: g.llm.rows,
      modelVersions: g.llmModels,
      llmDynasties: llmDynastyIndex([FLASH, OPUS]),
      nameOf: () => null,
      mainOf: () => ({ model: "gemini-3.7-flash", template: null }),
      modelLabel: g.modelLabel,
      dynastyOf: (s) => s.replace(/-v\d+$/, ""),
      workflowRuns: [],
      generationRuns: [],
      templateTexts: new Set(),
      runnableWorkflows: null,
      writerOf: () => ({ ok: true, workflowSlug: "azalea-v2", version: 2, template: "cold-email-v35", modelAlias: "opus", model: { id: "claude-opus-5-5", label: "Claude Opus 5.5" } }),
    });
  };

  it("every version row adds up to its page; no page or version carries a return", () => {
    const c = catalogWith();
    const flash = c.models.find((m) => m.key === "gemini-flash")!;
    const v = (k: string) => flash.models.find((m) => m.key === k)!;
    // The printed spend (the bar's basis, mature here) adds up: $150 + $100 = $250.
    expect([v("gemini-3.7-flash").spend, v("gemini-3.8-flash").spend, flash.spend]).toEqual(["$150", "$100", "$250"]);
    const keys = c.models.flatMap((m) => [m, ...m.models]).flatMap((x) => Object.keys(x));
    expect(keys.filter((k) => /roi/i.test(k))).toEqual([]);
  });
});
