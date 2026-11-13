import { describe, expect, it } from "vitest";
import {
  engineCatalogOf,
  engineFileOf,
  engineLiveScriptsOf,
  enginePerformanceOf,
  enginesOf,
  enumInEngineWords,
  inEngineWords,
  proseInEngineWords,
  sourceWordsLeft,
  studyIdInEngineWords,
  type EngineSource,
} from "./by-engine.js";

// RESEARCH-BY-ENGINE-1113 (owner 2026-11-13, go « A »): Research by Engine and script, no pipe anywhere.
const name = (k: string) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");
const SOURCES: EngineSource[] = [
  { sourceId: "cold-email-positive-reply", engine: "email_sent", startsFrom: "lead_found", counts: "conversation" },
  { sourceId: "email-sending|start_to_conversation", engine: "email_sent", startsFrom: null, counts: "conversation" },
  { sourceId: "feedback-request-cold-email-outreach|lead_found_to_conversation", engine: "conversation", startsFrom: "lead_found", counts: "conversation" },
  { sourceId: "cold-whatsapp-outreach|lead_found_to_conversation", engine: "conversation", startsFrom: "lead_found", counts: "conversation" },
];

const page = (key: string, spentUsd: number, outcomes: number, contacted: number) => ({
  key,
  label: key,
  sample: "Every workflow of the pipe",
  figures: { costPerOutcomeUsd: { value: outcomes ? spentUsd / outcomes : null, source: "pipe_pooled" }, spentUsd: { value: spentUsd }, outcomes, contacted },
  wroteWith: { model: { key: "opus", label: "Opus" }, template: { key: "blind-v4", label: "Blind" }, modelSource: "workflow_definition" },
  writesWithNow: null,
  runs: [{ when: "x", version: "v1" }],
});

describe("Engines and measures", () => {
  it("one Engine per outcome; two sources counting the same step from the same step are ONE measure", () => {
    const engines = enginesOf(SOURCES, name);
    expect(engines.map((e) => e.outcome)).toEqual(["email_sent", "conversation"]);
    expect(engines[0]!.measures.map((m) => m.id)).toEqual(["email_sent/lead_found/conversation", "email_sent/start/conversation"]);
    expect(engines[1]!.measures).toHaveLength(1);
    expect(engines[0]!.measures[1]!.startsFrom).toBeNull();
  });
});

describe("vocabulary", () => {
  it("re-words keys, enum words and sentences, never identifiers", () => {
    const body = inEngineWords({
      featureSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_conversation",
      workflow: { key: "sales-cold-email-outreach-hunor", label: "Hunor" },
      workflowDynastySlug: "x_pipe_y",
      topic: "workflow",
      reason: "no_outcome_on_pipe",
      source: "leg_default",
      note: "Every workflow of the pipe · a leg on flash figures, on any channel",
    });
    expect(body).toEqual({
      script: { key: "sales-cold-email-outreach-hunor", label: "Hunor" },
      scriptDynastySlug: "x_pipe_y",
      topic: "script",
      reason: "no_outcome_on_engine",
      source: "engine_default",
      note: "Every script of the Engine · a step on flash figures, on any medium",
    });
    expect(sourceWordsLeft(body)).toEqual([]);
    expect(enumInEngineWords("workflow_bars")).toBe("script_bars");
    expect(proseInEngineWords("drawn toward the pipe's rate")).toBe("drawn toward the Engine's rate");
  });
  it("the guard finds every source word left", () => {
    expect(sourceWordsLeft({ pipes: [], legKey: "a", x: "no_outcome_on_pipe", y: "the workflow" })).toEqual(["key:legKey", "key:pipes", "prose:workflow", "value:no_outcome_on_pipe"]);
  });
  it("a study id is re-keyed off its source", () => {
    const m = new Map([["cold-email-positive-reply", "email_sent/lead_found/conversation"]]);
    expect(studyIdInEngineWords("cold-email-positive-reply-workflow-roi", m)).toBe("email_sent/lead_found/conversation:script-roi");
    expect(studyIdInEngineWords("positive-reply-cost-every-path", m)).toBe("positive-reply-cost-every-path");
  });
});

describe("file", () => {
  it("each study names its Engine + measure, each outcome section its measures, no source left", () => {
    const file = {
      computedAt: "t",
      volume: { emails: 3, workflows: 2 },
      maturation: { note: "per workflow", legs: { reply: { durationDays: 21 } } },
      pipes: [
        { id: "cold-email-positive-reply", channel: "sales-cold-email-outreach", leg: "lead_found_to_conversation", outcome: "Positive reply", description: "Cold email" },
        { id: "orphan", channel: "x", leg: "y", outcome: "z", description: "" },
      ],
      outcomes: [{ id: "positive-reply", step: "lead_interested", pipes: ["cold-email-positive-reply", "orphan"], description: "d", population: "p" }],
      studies: [
        { id: "cold-email-positive-reply-workflow-roi", pipe: "cold-email-positive-reply", topic: "workflow", question: "Which workflow gets the cheapest positive reply?", charts: [{ points: [{ key: "sales-cold-email-outreach-hunor", label: "Hunor" }] }] },
        { id: "positive-reply-delay", pipe: null, outcome: "positive-reply", topic: "delay", question: "How long?" },
        { id: "orphan-x", pipe: "orphan", topic: "cost", question: "q" },
      ],
      unavailable: [{ id: "cold-email-positive-reply-naming", reason: "waits on the pipe" }],
    };
    const out = engineFileOf(file, SOURCES, name) as Record<string, any>;
    expect(sourceWordsLeft(out)).toEqual([]);
    expect(out.studies[0]).toMatchObject({ id: "email_sent/lead_found/conversation:script-roi", engine: "email_sent", measure: "email_sent/lead_found/conversation", topic: "script", question: "Which script gets the cheapest positive reply?" });
    expect(out.studies[0].charts[0].points[0].key).toBe("sales-cold-email-outreach-hunor");
    expect(out.studies[1]).toMatchObject({ id: "positive-reply-delay", engine: null, measure: null, outcome: "positive-reply" });
    expect(out.studies).toHaveLength(2);
    expect(out.outcomes[0].measures).toEqual(["email_sent/lead_found/conversation"]);
    expect(out.volume).toEqual({ emails: 3, scripts: 2 });
    expect(out.maturation).toEqual({ note: "per script", rules: { reply: { durationDays: 21 } } });
    expect(out.unavailable).toEqual([{ id: "email_sent/lead_found/conversation:naming", reason: "waits on the Engine" }]);
    expect(out.notCarried.map((n: { what: string }) => n.what)).toEqual(["study orphan-x", "source orphan"]);
  });
});

describe("catalogue", () => {
  const catalog = {
    "cold-email-positive-reply": { workflows: [page("hunor", 100, 4, 400), page("conversation/dy_x", 50, 1, 80)], templates: [{ key: "blind-v4", label: "Blind", workflows: [{ key: "hunor", label: "Hunor" }] }], models: [{ key: "opus", label: "Opus", runs: [{ workflow: { key: "hunor", label: "Hunor" } }] }] },
    "email-sending|start_to_conversation": { workflows: [page("bubup", 7, 0, 10)], templates: [], models: [] },
    "feedback-request-cold-email-outreach|lead_found_to_conversation": { workflows: [page("condor", 3, 1, 9), page("shared", 1, 0, 1)], templates: [], models: [] },
    "cold-whatsapp-outreach|lead_found_to_conversation": { workflows: [page("shared", 2, 0, 2)], templates: [], models: [] },
  };

  it("per Engine, per measure: scripts with their LLM and template as tactics; per-script totals = per-workflow totals (Email sent)", () => {
    const out = engineCatalogOf(catalog, SOURCES, name) as Record<string, any>;
    expect(sourceWordsLeft(out)).toEqual([]);
    const emailSent = out.engines.find((e: { outcome: string }) => e.outcome === "email_sent");
    const scripts = emailSent.measures.flatMap((m: { scripts: unknown[] }) => m.scripts);
    expect(scripts.map((s: { key: string }) => s.key)).toEqual(["hunor", "conversation/dy_x", "bubup"]);
    expect(scripts[0].tactics).toEqual({ llm: { key: "opus", label: "Opus" }, template: { key: "blind-v4", label: "Blind" } });
    const sum = (rows: Array<{ figures: { spentUsd: { value: number }; outcomes: number; contacted: number } }>) =>
      rows.reduce((a, r) => ({ spent: a.spent + r.figures.spentUsd.value, outcomes: a.outcomes + r.figures.outcomes, contacted: a.contacted + r.figures.contacted }), { spent: 0, outcomes: 0, contacted: 0 });
    const old = sum([...catalog["cold-email-positive-reply"].workflows, ...catalog["email-sending|start_to_conversation"].workflows]);
    expect(sum(scripts)).toEqual(old);
    expect(emailSent.measures[0].templates[0].scripts).toEqual([{ key: "hunor", label: "Hunor" }]);
    expect(emailSent.measures[0].llms[0].runs[0].script).toEqual({ key: "hunor", label: "Hunor" });
  });

  it("two sources of one measure holding the same script: the first page is served, the other named, never summed", () => {
    const out = engineCatalogOf(catalog, SOURCES, name) as Record<string, any>;
    const conv = out.engines.find((e: { outcome: string }) => e.outcome === "conversation").measures[0];
    expect(conv.scripts.map((s: { key: string }) => s.key)).toEqual(["condor", "shared"]);
    expect(conv.scripts[1].figures.spentUsd.value).toBe(1);
    expect(out.notCarried).toEqual([{ what: "script shared on conversation/lead_found/conversation", reason: expect.stringContaining("never summed") }]);
  });
});

describe("performance", () => {
  const perf = (rows: unknown[], totals: unknown) => ({ pipe: "x", featureSlug: "s", legKey: "l", figuresBasis: "workflow_bars", rows, totals, series: totals ? { points: [] } : null, unavailableReason: null, servedNow: { workflow: null, unavailableReason: "pipe_not_read" } });
  it("one source measured: its rows, totals and series as served; several: rows listed, totals not summed", () => {
    const out = enginePerformanceOf(
      {
        "cold-email-positive-reply": perf([{ key: "hunor|blind|opus", workflow: { key: "hunor" }, deprecatedParts: ["workflow"] }], { spentUsd: { value: 3 } }),
        "email-sending|start_to_conversation": perf([], null),
        "feedback-request-cold-email-outreach|lead_found_to_conversation": perf([{ key: "a" }], { spentUsd: { value: 1 } }),
        "cold-whatsapp-outreach|lead_found_to_conversation": perf([{ key: "b" }], { spentUsd: { value: 2 } }),
      },
      SOURCES,
      name,
    ) as Record<string, any>;
    expect(sourceWordsLeft(out)).toEqual([]);
    const m0 = out.engines[0].measures[0];
    expect(m0).toMatchObject({ figuresBasis: "script_bars", totals: { spentUsd: { value: 3 } }, totalsUnavailableReason: null, servedNow: { script: null, unavailableReason: "engine_not_read" } });
    expect(m0.rows[0]).toEqual({ key: "hunor|blind|opus", script: { key: "hunor" }, deprecatedParts: ["script"] });
    expect(out.engines[0].measures[1].rows).toEqual([]);
    const conv = out.engines[1].measures[0];
    expect(conv).toMatchObject({ totals: null, series: null, totalsUnavailableReason: "several_sources_not_summed" });
    expect(conv.rows.map((r: { key: string }) => r.key)).toEqual(["a", "b"]);
  });
});

describe("live scripts", () => {
  it("the source's ranking rows, in the framework's words", () => {
    const measure = enginesOf(SOURCES, name)[0]!.measures[0]!;
    const ranking = { featureSlug: "s", legKey: "l", computedAt: "t", rows: [{ rank: 1, workflowDynastySlug: "hunor", workflowDynastyName: "Hunor", figures: { costPerOutcomeUsd: { source: "pipe_pooled" } } }] };
    const out = engineLiveScriptsOf(measure, [ranking]) as Record<string, any>;
    expect(sourceWordsLeft(out)).toEqual([]);
    expect(out.rows[0]).toEqual({ rank: 1, scriptDynastySlug: "hunor", scriptDynastyName: "Hunor", figures: { costPerOutcomeUsd: { source: "engine_pooled" } } });
    expect(out.orderUnavailableReason).toBeNull();
    expect(engineLiveScriptsOf(measure, [null]).orderUnavailableReason).toBe("ranking_not_computed_yet");
  });
});
