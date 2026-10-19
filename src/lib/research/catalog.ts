/**
 * THE RESEARCH CATALOGUE (LIVE-RESEARCH-1018): one page per workflow, per template and per model, per pipe, with its
 * figures, its month curves and its last runs. Byte-compatible with the `ResearchCatalog` the dashboard typed over the
 * nightly snapshot's `research-catalog.json`. Pure: every bar is the same bucket the studies draw (`lib/research/*`), so a
 * page and its study can never state two figures.
 */
import { MONTHS, modelKey, n, pctText, templateLabel, usd } from "./format.js";
import { monthsChart, type PipeTerms, type ResearchBucket } from "./studies.js";
import type { ResearchChart, ResearchPipeId } from "./types.js";
import type { DynastyWriter, WriterReason } from "./writers.js";

export interface CatalogRef {
  key: string;
  label: string;
  linked: boolean;
}

export interface CatalogFigures {
  rank: number | null;
  emails: string;
  emailsNoun: string;
  outcomes: string;
  spend: string;
  cost: string | null;
  rate: string | null;
  thin: boolean;
  sample: string;
  charts: ResearchChart[];
}

/** What a workflow's runnable version writes with NOW (its DAG), whether or not it sent anything yet. */
export interface CatalogWriter {
  version: string;
  template: CatalogRef | null;
  model: CatalogRef | null;
  /** The alias the DAG names (`pro`); `model` is the real model it resolves to (null when chat-service names none). */
  modelAlias: string | null;
}

/** Where one part of `wroteWith` comes from: the generated sequences (the real model), else the workflow's own DAG. */
export type WroteWithSource = "sequences" | "workflow_definition";
export type WroteWithReason = "workflow_definitions_unreadable" | "no_writing_step" | "no_workflow_definition";

/**
 * What wrote its figures, on EVERY row, deprecated workflows included (RESEARCH-DEPRECATED-LLM-TEMPLATE-1019): each part
 * is what most of its people's sequences were written with, else what its newest writing version's DAG names.
 */
export interface CatalogWroteWith {
  model: CatalogRef | null;
  modelSource: WroteWithSource | null;
  template: CatalogRef | null;
  templateSource: WroteWithSource | null;
  /** The DAG version a part was read off (`v5`); null when every part comes from the sequences. */
  version: string | null;
  /** The alias that DAG names (`pro`), when the model part was read off it. */
  modelAlias: string | null;
}

export interface CatalogWorkflow extends CatalogFigures {
  key: string;
  label: string;
  name: string | null;
  /** A run may still pick it on this pipe (assigned active AND executable). */
  runnable: boolean;
  /** What most of its people's sequences were written with (= `wroteWithMost`, kept for the readers typed on it). */
  model: CatalogRef | null;
  template: CatalogRef | null;
  wroteWithMost: { model: CatalogRef | null; template: CatalogRef | null };
  writesWithNow: CatalogWriter | null;
  writesWithNowUnavailableReason: WriterReason | null;
  wroteWith: CatalogWroteWith | null;
  wroteWithUnavailableReason: WroteWithReason | null;
  runs: Array<{ when: string; version: string; status: string; duration: string | null; cost: string | null }>;
}

export interface CatalogTemplate extends CatalogFigures {
  key: string;
  label: string;
  hasText: boolean;
  workflows: Array<{ key: string; label: string }>;
  runs: Array<{ when: string; model: CatalogRef | null; workflow: { key: string; label: string } | null; version: string | null; tokens: string | null }>;
}

export interface CatalogModel extends CatalogFigures {
  key: string;
  label: string;
  workflows: Array<{ key: string; label: string }>;
  runs: Array<{ when: string; workflow: { key: string; label: string } | null; template: CatalogRef | null; version: string | null; tokens: string | null }>;
}

export type ResearchCatalog = Record<ResearchPipeId, { workflows: CatalogWorkflow[]; templates: CatalogTemplate[]; models: CatalogModel[] }>;

/** One execute-workflow run of a workflow version on a leg. */
export interface WorkflowRun {
  workflowSlug: string;
  dynasty: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  /** What the run's whole subtree cost on the read's basis; null when not priced on it. */
  costUsd: number | null;
}

/** One generated sequence, newest first. */
export interface GenerationRun {
  createdAt: string;
  model: string;
  promptType: string | null;
  workflowSlug: string | null;
}

const RUNS_SHOWN = 10;
const pad = (x: number) => String(x).padStart(2, "0");
export function whenText(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
function durationText(a: string, b: string | null): string | null {
  if (!b) return null;
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
}
const versionText = (slug: string) => `v${/-v(\d+)$/.exec(slug)?.[1] ?? "1"}`;

/** A page with nothing sent yet: every figure zero, stated as such (never a borrowed figure). */
export function emptyBucket(key: string, label: string): ResearchBucket {
  return { key, label, basis: "flash", figures: { spentUsd: 0, contacted: 0, outcomes: 0 }, learning: true, months: null, strata: null };
}

const costOf = (b: ResearchBucket) => (b.figures.outcomes > 0 && b.figures.spentUsd > 0 ? b.figures.spentUsd / b.figures.outcomes : null);
/** Cheapest first (the study's ROI order), then the unpriced ones by people reached, then the pages nobody was reached on. */
function catalogOrder(rows: readonly ResearchBucket[]): ResearchBucket[] {
  const priced = rows.filter((r) => costOf(r) !== null).sort((a, b) => costOf(a)! - costOf(b)! || b.figures.outcomes - a.figures.outcomes);
  const rest = rows.filter((r) => costOf(r) === null && r.figures.contacted > 0).sort((a, b) => b.figures.contacted - a.figures.contacted);
  const unreached = rows.filter((r) => costOf(r) === null && !(r.figures.contacted > 0)).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return [...priced, ...rest, ...unreached];
}

function figures(t: PipeTerms, r: ResearchBucket, rank: number | null): CatalogFigures {
  const c = costOf(r);
  const o = Math.round(r.figures.outcomes);
  const e = Math.round(r.figures.contacted);
  return {
    rank,
    emails: n(e),
    emailsNoun: t.exposureNoun,
    outcomes: n(o),
    spend: usd(r.figures.spentUsd),
    cost: c === null ? null : usd(c),
    rate: r.figures.contacted > 0 ? pctText((100 * r.figures.outcomes) / r.figures.contacted) : null,
    thin: r.learning,
    sample: `${n(o)} ${o === 1 ? t.noun : t.nounPlural} · ${n(e)} ${e === 1 ? t.exposureNounOne : t.exposureNoun}`,
    charts: r.months && r.months.length ? [monthsChart(t, r.months, "cost", r.label), monthsChart(t, r.months, "rate", r.label)] : [],
  };
}

export interface PipeCatalogInput {
  terms: PipeTerms;
  workflows: ResearchBucket[];
  templates: ResearchBucket[];
  models: ResearchBucket[];
  /** Dynasty → workflow-service's own name. */
  nameOf: (dynasty: string) => string | null;
  /** Dynasty → the model id and template id most of its people's sequences were written with. */
  mainOf: (dynasty: string) => { model: string | null; template: string | null };
  /** Model id → the label its bar reads (chat-service's display name). */
  modelLabel: (id: string) => string;
  /** Version slug → its dynasty. */
  dynastyOf: (slug: string) => string;
  workflowRuns: readonly WorkflowRun[];
  generationRuns: readonly GenerationRun[];
  templateTexts: ReadonlySet<string>;
  /**
   * Every workflow a run may still pick on the pipe (the leg ranking's selectable rows): each has a page, an empty one
   * until it sends. Null when the ranking could not be read (only the bars are listed then).
   */
  runnableWorkflows: ReadonlyArray<{ key: string; label: string; name: string | null }> | null;
  /** Dynasty → what its runnable version writes with now; a string when the definitions could not be read at all. */
  writerOf: ((dynasty: string) => DynastyWriter | null) | WriterReason;
  /** Dynasty → what its newest writing version (any status) writes with; a string when the definitions could not be read. */
  lastWriterOf?: ((dynasty: string) => DynastyWriter | null) | WriterReason;
}

/** PURE. One pipe's catalogue. */
export function pipeCatalog(p: PipeCatalogInput): { workflows: CatalogWorkflow[]; templates: CatalogTemplate[]; models: CatalogModel[] } {
  // Every runnable workflow has a page, and so do the template and model it writes with now (empty until used).
  const runnableKeys = new Set((p.runnableWorkflows ?? []).map((w) => w.key));
  const barKeys = new Set(p.workflows.map((r) => r.key));
  const pageNames = new Map((p.runnableWorkflows ?? []).map((w) => [w.key, w.name]));
  const allWorkflows = [...p.workflows, ...(p.runnableWorkflows ?? []).filter((w) => !barKeys.has(w.key)).map((w) => emptyBucket(w.key, w.label))];
  const writer = (dynasty: string): DynastyWriter =>
    typeof p.writerOf === "string" ? { ok: false, reason: p.writerOf } : (p.writerOf(dynasty) ?? { ok: false, reason: "no_runnable_version" });
  const writers = new Map(allWorkflows.map((r) => [r.key, writer(r.key)]));
  const lastWriter = (dynasty: string): DynastyWriter | WroteWithReason => {
    if (p.lastWriterOf === undefined) return "workflow_definitions_unreadable";
    if (typeof p.lastWriterOf === "string") return "workflow_definitions_unreadable";
    return p.lastWriterOf(dynasty) ?? "no_workflow_definition";
  };
  // Per row, the DAG writer a part of `wroteWith` falls back on (only where the sequences name nothing).
  const fallbacks = new Map(
    allWorkflows.map((r) => {
      const main = p.mainOf(r.key);
      const last = main.model && main.template ? null : lastWriter(r.key);
      return [r.key, { main, last }] as const;
    }),
  );
  const nowTemplates = new Set<string>();
  const nowModels = new Map<string, string>();
  for (const w of writers.values()) {
    if (!w.ok) continue;
    if (w.template) nowTemplates.add(w.template);
    if (w.model) nowModels.set(modelKey(w.model.label), w.model.label);
  }
  // A template or model that wrote a row's figures has its page too.
  for (const { main, last } of fallbacks.values()) {
    if (!last || typeof last === "string" || !last.ok) continue;
    if (!main.template && last.template) nowTemplates.add(last.template);
    if (!main.model && last.model) nowModels.set(modelKey(last.model.label), last.model.label);
  }
  const tplHave = new Set(p.templates.map((r) => r.key));
  const mdHave = new Set(p.models.map((r) => r.key));
  const allTemplates = [...p.templates, ...[...nowTemplates].filter((t) => !tplHave.has(t)).map((t) => emptyBucket(t, templateLabel(t)))];
  const allModels = [...p.models, ...[...nowModels].filter(([k]) => !mdHave.has(k)).map(([k, label]) => emptyBucket(k, label))];
  const wfRows = catalogOrder(allWorkflows);
  const tplRows = catalogOrder(allTemplates);
  const mdRows = catalogOrder(allModels);
  const wfKeys = new Set(wfRows.map((r) => r.key));
  const tplKeys = new Set(tplRows.map((r) => r.key));
  const mdKeys = new Set(mdRows.map((r) => r.key));
  const wfLabel = new Map(wfRows.map((r) => [r.key, r.label]));
  const rankOf = (r: ResearchBucket, i: number) => (costOf(r) === null ? null : i + 1);
  const modelRef = (id: string | null): CatalogRef | null => {
    if (!id) return null;
    const label = p.modelLabel(id);
    const key = modelKey(label);
    return { key, label, linked: mdKeys.has(key) };
  };
  const tplRef = (id: string | null): CatalogRef | null => (id ? { key: id, label: templateLabel(id), linked: tplKeys.has(id) } : null);
  const resolvedModelRef = (m: { label: string } | null): CatalogRef | null => (m ? { key: modelKey(m.label), label: m.label, linked: mdKeys.has(modelKey(m.label)) } : null);
  const wfRef = (slug: string | null) => {
    if (!slug) return null;
    const d = p.dynastyOf(slug);
    return wfKeys.has(d) ? { key: d, label: wfLabel.get(d)! } : null;
  };
  const workflows: CatalogWorkflow[] = wfRows.map((r, i) => {
    const { main, last } = fallbacks.get(r.key)!;
    const most = { model: modelRef(main.model), template: tplRef(main.template) };
    const w = writers.get(r.key)!;
    const dag = last && typeof last !== "string" && last.ok ? last : null;
    const dagModel = !most.model && dag ? resolvedModelRef(dag.model) : null;
    const dagTemplate = !most.template && dag ? tplRef(dag.template) : null;
    const model = most.model ?? dagModel;
    const template = most.template ?? dagTemplate;
    const fromDag = Boolean(dagModel || dagTemplate);
    const wroteWith: CatalogWroteWith | null =
      model || template
        ? {
            model,
            modelSource: most.model ? "sequences" : dagModel ? "workflow_definition" : null,
            template,
            templateSource: most.template ? "sequences" : dagTemplate ? "workflow_definition" : null,
            version: fromDag && dag ? `v${dag.version}` : null,
            modelAlias: dagModel && dag ? dag.modelAlias : null,
          }
        : null;
    const wroteWithUnavailableReason: WroteWithReason | null = wroteWith
      ? null
      : typeof last === "string"
        ? last
        : last && !last.ok
          ? last.reason === "no_writing_step"
            ? "no_writing_step"
            : "workflow_definitions_unreadable"
          : "no_writing_step";
    return {
      key: r.key,
      label: r.label,
      name: p.nameOf(r.key) ?? pageNames.get(r.key) ?? null,
      runnable: runnableKeys.has(r.key),
      model: most.model,
      template: most.template,
      wroteWithMost: most,
      writesWithNow: w.ok ? { version: `v${w.version}`, template: tplRef(w.template), model: resolvedModelRef(w.model), modelAlias: w.modelAlias } : null,
      writesWithNowUnavailableReason: w.ok ? null : w.reason,
      wroteWith,
      wroteWithUnavailableReason,
      ...figures(p.terms, r, rankOf(r, i)),
      runs: p.workflowRuns
        .filter((x) => x.dynasty === r.key)
        .slice(0, RUNS_SHOWN)
        .map((x) => ({ when: whenText(x.startedAt), version: versionText(x.workflowSlug), status: x.status, duration: durationText(x.startedAt, x.completedAt), cost: x.costUsd && x.costUsd > 0 ? usd(x.costUsd) : null })),
    };
  });
  const templates: CatalogTemplate[] = tplRows.map((r, i) => ({
    key: r.key,
    label: r.label,
    hasText: p.templateTexts.has(r.key),
    ...figures(p.terms, r, rankOf(r, i)),
    workflows: workflows.filter((w) => w.template?.key === r.key || w.writesWithNow?.template?.key === r.key || w.wroteWith?.template?.key === r.key).map((w) => ({ key: w.key, label: w.label })),
    runs: p.generationRuns
      .filter((x) => x.promptType === r.key)
      .slice(0, RUNS_SHOWN)
      .map((x) => ({ when: whenText(x.createdAt), model: modelRef(x.model), workflow: wfRef(x.workflowSlug), version: x.workflowSlug ? versionText(x.workflowSlug) : null, tokens: null })),
  }));
  const models: CatalogModel[] = mdRows.map((r, i) => ({
    key: r.key,
    label: r.label,
    ...figures(p.terms, r, rankOf(r, i)),
    workflows: workflows.filter((w) => w.model?.key === r.key || w.writesWithNow?.model?.key === r.key || w.wroteWith?.model?.key === r.key).map((w) => ({ key: w.key, label: w.label })),
    runs: p.generationRuns
      .filter((x) => modelKey(p.modelLabel(x.model)) === r.key)
      .slice(0, RUNS_SHOWN)
      .map((x) => ({ when: whenText(x.createdAt), workflow: wfRef(x.workflowSlug), template: tplRef(x.promptType), version: x.workflowSlug ? versionText(x.workflowSlug) : null, tokens: null })),
  }));
  return { workflows, templates, models };
}
