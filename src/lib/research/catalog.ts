/**
 * THE RESEARCH CATALOGUE (LIVE-RESEARCH-1018): one page per workflow, per template and per model, per pipe, with its
 * figures, its month curves and its last runs. Byte-compatible with the `ResearchCatalog` the dashboard typed over the
 * nightly snapshot's `research-catalog.json`. Pure: every bar is the same bucket the studies draw (`lib/research/*`), so a
 * page and its study can never state two figures.
 */
import type { LegWorkflowFigures } from "../leg-workflow-figures.js";
import { rankWriters } from "../leg-writer-ranking.js";
import { MONTHS, modelKey, n, pctText, templateLabel, usd } from "./format.js";
import { monthsChart, type PipeTerms, type ResearchBucket } from "./studies.js";
import type { ResearchChart, ResearchPipeId } from "./types.js";
import { modelRowAliases, type DynastyWriter, type ModelAliasReason, type ModelIdRow, type WriterReason } from "./writers.js";
import type { VersionShare } from "./generations.js";
import { NO_LLM_DYNASTIES, type LlmDynastyIndex, type LlmDynastyReason } from "../llm-dynasties.js";
import { runCostOf, tokensText, unavailableRunCost, type CatalogRunCost, type GenerationCostInput, type RunCostUnavailableReason } from "./run-cost.js";
import { NO_TEMPLATE_DYNASTIES, type TemplateDynastyIndex, type TemplateDynastyReason, type TemplateDynastyStatusSource, type TemplateStatus } from "./template-dynasties.js";

export interface CatalogRef {
  key: string;
  label: string;
  linked: boolean;
  /** On a template ref that names a dynasty: the version actually meant (absent when the ref names the page itself). */
  version?: { key: string; label: string } | null;
}

export interface CatalogFigures {
  rank: number | null;
  /** What `rank` orders on: the cost per outcome (cheapest first), the study's order; the return is a separate figure. */
  rankBasis: "cost_per_outcome";
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

/**
 * A page's return (TPL-DYNASTY-ROWS-1021-FS), on the leg workflow ranking's basis: a workflow's `roiMultiple` (its fleet
 * pipeline on the leg ÷ what clients were billed for it, lifetime). A template's (dynasty or version) is its OWN
 * (TPL-ROI-OWN-1022): the pipeline its own outcomes carry (each workflow's pipeline shared on the outcomes it produced)
 * ÷ what its own people were billed (each workflow's billed spend shared on what they cost), `source: own_outcomes`. A
 * template that wrote all of a workflow reads that workflow's return exactly; within one workflow, a cheaper outcome
 * reads a higher return. MEASURED only once it has an outcome of its own: a template with none never borrows a measured
 * figure. Never blank: with nothing measured, the figure it is EXPECTED to read is served, `basis: expected`, its source
 * named, and an expected return is never 0 (a pipe whose returns are all 0 serves its 0 measured, never expected); null
 * only with `unavailableReason`.
 */
export interface CatalogRoi {
  /** The multiple (3.2 = $3.20 of pipeline per $1 billed). */
  value: number | null;
  /** "3.20x". */
  display: string | null;
  basis: "measured" | "expected" | null;
  /**
   * measured: `workflow` (the ranking row), `own_outcomes` (a template or a model: its own outcomes' pipeline ÷ its own
   * billed spend). expected: `pipe_templates` (a template: every template of the pipe pooled, own pipeline ÷ own billed),
   * `pipe_models` (a model: every model of the pipe pooled, the same way), `writes_with_now` (the workflows writing with it
   * now that produced an outcome), `dynasty` (a version reads its dynasty's),
   * `pipe_best_workflow` (the workflow the pipe puts its money on, else its best measured return), `pipe_workflows` (a
   * workflow with no outcome yet: every workflow of the pipe pooled, the ranking row's `figures.roi`).
   */
  source: "workflow" | "own_outcomes" | "pipe_templates" | "pipe_models" | "pipe_workflows" | "writes_with_now" | "dynasty" | "pipe_best_workflow" | null;
  /** On `own_outcomes`: the share of its spend whose workflow states its pipeline and billed spend (1 = all of it). */
  spendCovered: number | null;
  unavailableReason: "no_return_on_pipe" | null;
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
  /** Its own icon (Phosphor name) + colour (MARKS-1022), keyed on `key`, the same on every read; set at serve time. */
  icon?: string;
  color?: string;
  label: string;
  name: string | null;
  /** A run may still pick it on this pipe (assigned active AND executable). */
  runnable: boolean;
  /** The return printed (`3.20x`), null with none: `roiDetail.display`, kept a string for the readers typed on it. */
  roi: string | null;
  roiDetail: CatalogRoi;
  /**
   * The leg workflow ranking row's `figures` (RESEARCH-WF-FIGURES-1022), byte-same as the Workflows list prints: ROI,
   * $/outcome, % conversion and $ spent, each measured or expected, gross pricing. Copied from the CURRENT ranking at
   * every read, so the page and the list never print two returns. Null when the ranking lists no such row.
   */
  figures: LegWorkflowFigures | null;
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

/** A template page's dynasty, as content-generation-service states it (TPL-DYNASTY-1021-FS2). */
export interface CatalogTemplateDynasty {
  slug: string;
  name: string;
  /** The customer-facing one-sentence description. */
  description: string;
  /** Internal signature (staff). */
  signature: string | null;
  /** `blind` (the brand stays private) or `named`. */
  identity: string;
  /** The version workflows write with now. */
  head: { key: string; label: string } | null;
}

/** One version of a dynasty, its share of the dynasty's figures read on the dynasty's basis (the versions add up to it). */
export interface CatalogTemplateVersion extends CatalogFigures {
  key: string;
  label: string;
  head: boolean;
  hasText: boolean;
  /** content-generation-service's status of this version (null = not stated). */
  status: TemplateStatus | null;
  /** The return printed (`3.20x`), null with none: `roiDetail.display`, kept a string for the readers typed on it. */
  roi: string | null;
  roiDetail: CatalogRoi;
}

/** Why a template page is a version on its own. */
export type CatalogTemplateStandaloneReason = "no_dynasty_on_pipe" | TemplateDynastyReason;

export interface CatalogTemplate extends CatalogFigures {
  /** The dynasty's slug; a version on its own keeps its template id. */
  key: string;
  /** Its own icon (Phosphor name) + colour (MARKS-1022), keyed on `key`, the same on every read; set at serve time. */
  icon?: string;
  color?: string;
  /** The template tactics it follows (TPL-TACTICS-ROWS-1022), read live at serve time; null with `tacticsUnavailableReason`. */
  tactics?: Array<{ id: string; name: string }> | null;
  tacticsUnavailableReason?: "tactics_unreadable" | "not_judged_yet" | null;
  /** The dynasty's name; a version on its own reads its version label. */
  label: string;
  /** The text shown: the head's on a dynasty (`/internal/research/templates` serves it under this key). */
  hasText: boolean;
  dynasty: CatalogTemplateDynasty | null;
  /** Null on a dynasty; why this page is one version on its own otherwise. */
  standaloneReason: CatalogTemplateStandaloneReason | null;
  /**
   * The DYNASTY's status (Active / Deprecated tabs): content-generation-service's own, else deprecated exactly when every
   * version is (`statusSource`). Null on a version on its own, or when no status is stated (`statusUnavailableReason`).
   */
  status: TemplateStatus | null;
  statusSource: TemplateDynastyStatusSource | null;
  statusUnavailableReason: "no_dynasty" | "status_not_stated" | null;
  /** The return printed (`3.20x`), null with none: `roiDetail.display`, kept a string for the readers typed on it. */
  roi: string | null;
  roiDetail: CatalogRoi;
  /** Every version of the dynasty, oldest first (empty on a version on its own). */
  versions: CatalogTemplateVersion[];
  workflows: Array<{ key: string; label: string }>;
  runs: Array<{ when: string; model: CatalogRef | null; workflow: { key: string; label: string } | null; version: string | null; templateVersion: string | null; tokens: string | null }>;
}

/** A model page's LLM dynasty, as chat-service states it (LLM-DYNASTY-1022-FS). */
export interface CatalogLlmDynasty {
  slug: string;
  name: string;
  provider: string;
  capabilityTier: string;
  /** The version the dynasty slug runs now (what a run calling the slug gets). */
  headModelId: string;
  /** The slug answers chat-service `/complete` today. */
  servedToday: boolean;
  /** Names workflows wrote before dynasties; each runs the head. */
  legacyAliases: string[];
}

/** One MODEL of a dynasty page: its share of the dynasty's figures read on the dynasty's basis (the models add up to it). */
export interface CatalogModelVersion extends CatalogFigures {
  /** The model key (`modelKey` of its name), the key the per-model bars used before dynasties. */
  key: string;
  label: string;
  /** chat-service's concrete ids under this name. */
  modelIds: string[];
  /** The dynasty's head (what its slug runs now). */
  head: boolean;
  servedToday: boolean;
  /** Its OWN return (MODEL-ROI-1023, the template version rule): measured with an outcome of its own, else its dynasty's, expected. */
  roi: string | null;
  roiDetail: CatalogRoi;
  /** What one writing run of this model costs on the pipe (MODEL-RUN-COST-1024): its runs only; the versions' runs add up to the page's. */
  runCost: CatalogRunCost;
}

/** Why a model page is one model on its own (no dynasty). */
export type CatalogModelStandaloneReason = "no_dynasty_in_chat_service" | LlmDynastyReason;

export interface CatalogModel extends CatalogFigures {
  /** The LLM dynasty's slug (LLM-DYNASTY-1022-FS: one page per dynasty, its versions pooled); a model chat-service places in no dynasty keeps its model key. */
  key: string;
  /** The dynasty's name; a model on its own reads its model name. */
  label: string;
  dynasty: CatalogLlmDynasty | null;
  /** Null on a dynasty; why this page is one model on its own otherwise. */
  standaloneReason: CatalogModelStandaloneReason | null;
  /**
   * Its OWN return (MODEL-ROI-1023, TPL-ROI-OWN-1022's rule): the pipeline its own outcomes carry ÷ what its own people
   * were billed, measured once it has an outcome of its own; else expected (every model of the pipe pooled, then the
   * workflows writing with it now, then the pipe's money workflow); null only with `unavailableReason`.
   */
  roi: string | null;
  roiDetail: CatalogRoi;
  /** Every model of the dynasty, newest first, each with its share of the page's figures (zero until it writes); on a model on its own, that model. */
  models: CatalogModelVersion[];
  /** chat-service's concrete model ids this page names (every version of the dynasty; two ids with one display name are one model). */
  modelIds: string[];
  /** Every alias chat-service serves this model under NOW (the word a workflow writes in `model`); several when it truly serves it under several. */
  aliases: string[];
  /** Aliases that once named it and now name another model. */
  formerAliases: string[];
  aliasesUnavailableReason: ModelAliasReason | null;
  /**
   * What ONE writing run of the dynasty costs on this pipe (MODEL-RUN-COST-1024): every client, workflow and template of
   * the pipe pooled, every version; average, input/output split (cache folded into input), cumulative daily curve.
   */
  runCost: CatalogRunCost;
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
  /** The tokens content-generation-service recorded for it (MODEL-RUN-COST-1024); absent/null = not recorded. */
  tokensInput?: number | null;
  tokensOutput?: number | null;
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
/**
 * The Workflows tab's order (owner 2026-10-24, PERF-COST-ORDER-1024, the Performance tab's rule): cost per outcome ascending,
 * a workflow with no outcome standing on its $ spent instead, every row ranked. Before, a workflow with no outcome had no
 * rank and stood under every priced one: Keel, rank 1 on the leg ranking and the only workflow running in prod ($65, no
 * reply yet), read below Ballad ($151 per reply).
 */
function catalogOrder(rows: readonly ResearchBucket[]): ResearchBucket[] {
  const shown = (r: ResearchBucket) => costOf(r) ?? r.figures.spentUsd;
  return [...rows].sort((a, b) => shown(a) - shown(b) || b.figures.outcomes - a.figures.outcomes || b.figures.contacted - a.figures.contacted || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** The leg order of the pipe's templates or models (`rankWriters`), selectable ones first: every row ranked. */
function writerOrder(rows: readonly ResearchBucket[], selectable: (key: string) => boolean): ResearchBucket[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const ranked = rankWriters(rows.map((r) => ({ key: r.key, label: r.label, selectable: selectable(r.key), notSelectableReason: null, basis: r.basis, figures: r.figures })));
  return ranked.rows.map((x) => byKey.get(x.key)!);
}

function figures(t: PipeTerms, r: ResearchBucket, rank: number | null): CatalogFigures {
  const c = costOf(r);
  const o = Math.round(r.figures.outcomes);
  const e = Math.round(r.figures.contacted);
  return {
    rank,
    rankBasis: "cost_per_outcome",
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
  /** The pipe's template dynasties: `templates` are keyed on them (generationBuckets). Absent = every version on its own. */
  templateDynasties?: TemplateDynastyIndex;
  /** Per template version, its share of its bar on the bar's basis (generationBuckets `tplVersions`). */
  templateVersions?: readonly ResearchBucket[];
  generationRuns: readonly GenerationRun[];
  /**
   * Every generation a model wrote on the pipe with its completion's LLM cost (MODEL-RUN-COST-1024); a reason when the
   * run costs cannot be served (vendor basis, copy unreadable). Absent = `run_costs_unreadable`.
   */
  generationCosts?: readonly GenerationCostInput[] | RunCostUnavailableReason;
  templateTexts: ReadonlySet<string>;
  /**
   * Every workflow the leg ranking lists (TPL-TACTICS-ROWS-1022; was its selectable rows only, so a ranking row that
   * cannot run had no page and no icon): each has a page, an empty one until it sends; `runnable` false = a run may not
   * pick it (absent = runnable). Null when the ranking could not be read (only the bars are listed then).
   */
  runnableWorkflows: ReadonlyArray<{ key: string; label: string; name: string | null; runnable?: boolean }> | null;
  /** Dynasty → what its runnable version writes with now; a string when the definitions could not be read at all. */
  writerOf: ((dynasty: string) => DynastyWriter | null) | WriterReason;
  /** Dynasty → what its newest writing version (any status) writes with; a string when the definitions could not be read. */
  lastWriterOf?: ((dynasty: string) => DynastyWriter | null) | WriterReason;
  /** chat-service's served models (`/internal/model-ids`), for each model page's aliases; a reason when unreadable. */
  servedModels?: readonly ModelIdRow[] | ModelAliasReason;
  /** chat-service's LLM dynasties (LLM-DYNASTY-1022-FS): `models` are keyed on them (generationBuckets). Absent = every model on its own. */
  llmDynasties?: LlmDynastyIndex;
  /** Per model, its share of its dynasty bar on the bar's basis (generationBuckets `llmModels`). */
  modelVersions?: ReadonlyArray<ResearchBucket & { dynastyKey: string }>;
  /**
   * The leg workflow ranking's return per workflow dynasty (`roiMultiple`, null = unstated) and the dynasty the pipe puts
   * its money on. Absent = no ranking read: every return then reads `no_return_on_pipe`.
   */
  workflowReturns?: {
    roiOf: ReadonlyMap<string, number | null>;
    moneyGoesHere: string | null;
    /** The two terms of each dynasty's return (the ranking's `pipelineUsd` / `billedSpendUsd`); absent or null = unknown. */
    pipelineOf?: ReadonlyMap<string, number | null>;
    billedOf?: ReadonlyMap<string, number | null>;
  };
  /** Template bar key (dynasty, else version) → workflow VERSION slug → what its people cost and produced (generationBuckets). */
  templateFiguresByVersion?: ReadonlyMap<string, ReadonlyMap<string, VersionShare>>;
  /** Template version id → workflow VERSION slug → what its people cost and produced. */
  templateVersionFiguresByVersion?: ReadonlyMap<string, ReadonlyMap<string, VersionShare>>;
  /** Model bar key (LLM dynasty slug, else model key) → workflow VERSION slug → what its people cost and produced (generationBuckets). */
  modelFiguresByVersion?: ReadonlyMap<string, ReadonlyMap<string, VersionShare>>;
  /** Model key (a per-model bar's key) → workflow VERSION slug → what its people cost and produced. */
  modelVersionFiguresByVersion?: ReadonlyMap<string, ReadonlyMap<string, VersionShare>>;
  /** Workflow VERSION slug → everything it cost and produced (generationBuckets `workflowVersionTotals`). */
  workflowVersionTotals?: ReadonlyMap<string, VersionShare>;
}

const roiText = (v: number) => `${v.toFixed(2)}x`;
const roiFields = (r: CatalogRoi) => ({ roi: r.display, roiDetail: r });
const NO_ROI: CatalogRoi = { value: null, display: null, basis: null, source: null, spendCovered: null, unavailableReason: "no_return_on_pipe" };
const roiOfValue = (value: number, basis: "measured" | "expected", source: CatalogRoi["source"], spendCovered: number | null = null): CatalogRoi => ({
  value,
  display: roiText(value),
  basis,
  source,
  spendCovered,
  unavailableReason: null,
});

/**
 * PURE (TPL-ROI-OWN-1022). A template's OWN return: the pipeline its own outcomes carry ÷ what its own people were billed.
 * Per workflow dynasty it wrote for, its share of the dynasty's pipeline = its outcomes there ÷ the dynasty's outcomes, its
 * share of the dynasty's billed spend = its spend there ÷ the dynasty's spend (all to date, the ranking's lifetime basis).
 * Null (not earned) until it has an outcome of its own (printed count ≥ 1) on a workflow stating both terms.
 */
export function ownTemplateRoi(
  figuresByVersion: ReadonlyMap<string, VersionShare> | undefined,
  dynastyOf: (slug: string) => string,
  versionTotals: ReadonlyMap<string, VersionShare> | undefined,
  pipelineOf: ReadonlyMap<string, number | null> | undefined,
  billedOf: ReadonlyMap<string, number | null> | undefined,
): { value: number; spendCovered: number } | null {
  if (!figuresByVersion || !versionTotals || !pipelineOf || !billedOf) return null;
  const dynTotals = new Map<string, VersionShare>();
  for (const [slug, f] of versionTotals) {
    const d = dynastyOf(slug);
    const t = dynTotals.get(d) ?? { spentUsd: 0, outcomes: 0 };
    t.spentUsd += f.spentUsd;
    t.outcomes += f.outcomes;
    dynTotals.set(d, t);
  }
  const own = new Map<string, VersionShare>();
  for (const [slug, f] of figuresByVersion) {
    const d = dynastyOf(slug);
    const t = own.get(d) ?? { spentUsd: 0, outcomes: 0 };
    t.spentUsd += f.spentUsd;
    t.outcomes += f.outcomes;
    own.set(d, t);
  }
  let spend = 0;
  let covered = 0;
  let outcomes = 0;
  let pipeline = 0;
  let billed = 0;
  for (const [d, f] of own) {
    spend += Math.max(0, f.spentUsd);
    const total = dynTotals.get(d);
    const p = pipelineOf.get(d);
    const b = billedOf.get(d);
    if (!total || p == null || b == null) continue;
    covered += Math.max(0, f.spentUsd);
    outcomes += f.outcomes;
    if (total.outcomes > 0) pipeline += (p * f.outcomes) / total.outcomes;
    if (total.spentUsd > 0) billed += (b * f.spentUsd) / total.spentUsd;
  }
  if (Math.round(outcomes) < 1 || !(billed > 0)) return null;
  return { value: pipeline / billed, spendCovered: spend > 0 ? covered / spend : 1 };
}

/** PURE. The pipe's expected return when nothing narrower states one: the money workflow's, else its best measured. */
function pipeExpectedRoi(w: PipeCatalogInput["workflowReturns"]): CatalogRoi {
  if (!w) return NO_ROI;
  // An expected return of 0 reads "worthless" on a page that never earned one: only a positive return is expected.
  const money = w.moneyGoesHere ? w.roiOf.get(w.moneyGoesHere) : null;
  if (money != null && money > 0) return roiOfValue(money, "expected", "pipe_best_workflow");
  const best = [...w.roiOf.values()].filter((v): v is number => v != null && v > 0).sort((a, b) => b - a)[0];
  return best != null ? roiOfValue(best, "expected", "pipe_best_workflow") : NO_ROI;
}

/** PURE. One pipe's catalogue. */
export function pipeCatalog(p: PipeCatalogInput): { workflows: CatalogWorkflow[]; templates: CatalogTemplate[]; models: CatalogModel[] } {
  // Every runnable workflow has a page, and so do the template and model it writes with now (empty until used).
  const runnableKeys = new Set((p.runnableWorkflows ?? []).filter((w) => w.runnable !== false).map((w) => w.key));
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
  // A model page is its chat-service LLM DYNASTY (LLM-DYNASTY-1022-FS), keyed on the slug; a model it places in none keeps its model key.
  const llmDyn = p.llmDynasties ?? NO_LLM_DYNASTIES;
  const llmKeyOfId = (id: string) => llmDyn.dynastyOfName(id)?.slug ?? modelKey(p.modelLabel(id));
  const llmKeyOfModel = (m: { id: string; label: string }) => llmDyn.dynastyOfName(m.id)?.slug ?? modelKey(m.label);
  const llmLabelOf = (key: string, fallback: string) => llmDyn.bySlug(key)?.name ?? fallback;
  const nowTemplates = new Set<string>();
  const nowModels = new Map<string, string>();
  for (const w of writers.values()) {
    if (!w.ok) continue;
    if (w.template) nowTemplates.add(w.template);
    if (w.model) nowModels.set(llmKeyOfModel(w.model), llmLabelOf(llmKeyOfModel(w.model), w.model.label));
  }
  // A template or model that wrote a row's figures has its page too.
  for (const { main, last } of fallbacks.values()) {
    if (!last || typeof last === "string" || !last.ok) continue;
    if (!main.template && last.template) nowTemplates.add(last.template);
    if (!main.model && last.model) nowModels.set(llmKeyOfModel(last.model), llmLabelOf(llmKeyOfModel(last.model), last.model.label));
  }
  const dyn = p.templateDynasties ?? NO_TEMPLATE_DYNASTIES;
  // Every dynasty of the pipe has its page, empty until one of its versions writes.
  for (const d of dyn.dynasties) nowTemplates.add(d.slug);
  const tplHave = new Set(p.templates.map((r) => r.key));
  const mdHave = new Set(p.models.map((r) => r.key));
  const nowTemplateKeys = new Set([...nowTemplates].map((t) => dyn.keyOf(t)));
  const allTemplates = [...p.templates, ...[...nowTemplateKeys].filter((t) => !tplHave.has(t)).map((t) => emptyBucket(t, dyn.labelOf(t)))];
  const allModels = [...p.models, ...[...nowModels].filter(([k]) => !mdHave.has(k)).map(([k, label]) => emptyBucket(k, label))];
  const wfRows = catalogOrder(allWorkflows);
  // Templates and models stand in the ONE leg order the pipe picks them by (BEST-TPL-LLM-1022, `rankWriters`, the
  // workflows' rule on $/outcome): the page's rank is the ranking's, never a second order on the same figures.
  const tplRows = writerOrder(allTemplates, (key) => {
    const d = dyn.dynastyOf(key);
    return Boolean(d && d.status !== "deprecated" && d.head);
  });
  const pageKeyOfServed = (m: ModelIdRow) => llmDyn.dynastyOfName(m.modelId)?.slug ?? modelKey(m.displayName);
  const mdRows = writerOrder(allModels, (key) => (typeof p.servedModels === "object" ? modelRowAliases(key, p.servedModels, pageKeyOfServed).aliases.length > 0 : true));
  const writerRank = new Map([...tplRows, ...mdRows].map((r) => [r, (tplRows.includes(r) ? tplRows : mdRows).indexOf(r) + 1]));
  const wfKeys = new Set(wfRows.map((r) => r.key));
  const tplKeys = new Set(tplRows.map((r) => r.key));
  const mdKeys = new Set(mdRows.map((r) => r.key));
  const wfLabel = new Map(wfRows.map((r) => [r.key, r.label]));
  const rankOf = (_r: ResearchBucket, i: number) => i + 1;
  const modelRef = (id: string | null): CatalogRef | null => {
    if (!id) return null;
    const key = llmKeyOfId(id);
    return { key, label: llmLabelOf(key, p.modelLabel(id)), linked: mdKeys.has(key) };
  };
  const tplRef = (id: string | null): CatalogRef | null => {
    if (!id) return null;
    const key = dyn.keyOf(id);
    const ref: CatalogRef = { key, label: dyn.labelOf(key), linked: tplKeys.has(key) };
    const v = dyn.versionOf(id);
    return v === key ? ref : { ...ref, version: { key: v, label: templateLabel(v) } };
  };
  const versionBars = new Map((p.templateVersions ?? []).map((v) => [v.key, v]));
  const resolvedModelRef = (m: { id: string; label: string } | null): CatalogRef | null => {
    if (!m) return null;
    const key = llmKeyOfModel(m);
    return { key, label: llmLabelOf(key, m.label), linked: mdKeys.has(key) };
  };
  const wfRef = (slug: string | null) => {
    if (!slug) return null;
    const d = p.dynastyOf(slug);
    return wfKeys.has(d) ? { key: d, label: wfLabel.get(d)! } : null;
  };
  const roiOf = p.workflowReturns?.roiOf ?? new Map<string, number | null>();
  const pipeRoi = pipeExpectedRoi(p.workflowReturns);
  const workflowRoi = (dynasty: string): CatalogRoi => {
    const v = roiOf.get(dynasty);
    return v != null ? roiOfValue(v, "measured", "workflow") : pipeRoi;
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
      ...roiFields(workflowRoi(r.key)),
      figures: null,
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
  // What a template is expected to return before it earned one of its own: the workflows writing with it now, those
  // whose return rests on an outcome (a workflow with none states no evidence about a template), positive only.
  const outcomesOf = new Map(wfRows.map((r) => [r.key, r.figures.outcomes]));
  const nowRoiOf = (key: string, part: "template" | "model" = "template"): CatalogRoi | null => {
    const vs = workflows
      .filter((w) => w.writesWithNow?.[part]?.key === key && w.roiDetail.basis === "measured" && w.roiDetail.value != null && w.roiDetail.value > 0 && (outcomesOf.get(w.key) ?? 0) > 0)
      .map((w) => w.roiDetail.value!);
    return vs.length ? roiOfValue(vs.reduce((a, b) => a + b, 0) / vs.length, "expected", "writes_with_now") : null;
  };
  const ownRoi = (figs: ReadonlyMap<string, VersionShare> | undefined) =>
    ownTemplateRoi(figs, p.dynastyOf, p.workflowVersionTotals, p.workflowReturns?.pipelineOf, p.workflowReturns?.billedOf);
  // What a template (a model) on this pipe returns, every template (model) pooled (each one's own pipeline ÷ own billed
  // spend, the ones that earned nothing included): the honest expectation for one that has not earned one of its own. A
  // workflow's return carries its contacted people's value, which no writer without an outcome has shown it earns.
  const pooledRoi = (bars: ReadonlyMap<string, ReadonlyMap<string, VersionShare>> | undefined, source: "pipe_templates" | "pipe_models") => {
    const pooled = new Map<string, VersionShare>();
    for (const figs of bars?.values() ?? []) {
      for (const [slug, f] of figs) {
        const t = pooled.get(slug) ?? { spentUsd: 0, outcomes: 0 };
        t.spentUsd += f.spentUsd;
        t.outcomes += f.outcomes;
        pooled.set(slug, t);
      }
    }
    const m = ownRoi(pooled);
    return m && m.value > 0 ? roiOfValue(m.value, "expected", source) : null;
  };
  const pooledTemplateRoi = pooledRoi(p.templateFiguresByVersion, "pipe_templates");
  const templateRoi = (key: string): CatalogRoi => {
    const m = ownRoi(p.templateFiguresByVersion?.get(key));
    return m ? roiOfValue(m.value, "measured", "own_outcomes", m.spendCovered) : (pooledTemplateRoi ?? nowRoiOf(key) ?? pipeRoi);
  };
  const templates: CatalogTemplate[] = tplRows.map((r, i) => {
    const d = dyn.dynastyOf(r.key);
    const roi = templateRoi(r.key);
    const versionRoi = (v: string): CatalogRoi => {
      const m = ownRoi(p.templateVersionFiguresByVersion?.get(v));
      return m ? roiOfValue(m.value, "measured", "own_outcomes", m.spendCovered) : roi.value != null ? { ...roi, basis: "expected", source: "dynasty", spendCovered: null } : roi;
    };
    return {
    key: r.key,
    label: r.label,
    hasText: p.templateTexts.has(d?.head ?? r.key),
    dynasty: d
      ? { slug: d.slug, name: d.name, description: d.description, signature: d.signature, identity: d.identity, head: d.head ? { key: d.head, label: templateLabel(d.head) } : null }
      : null,
    standaloneReason: d ? null : (dyn.unavailableReason ?? "no_dynasty_on_pipe"),
    status: d?.status ?? null,
    statusSource: d?.statusSource ?? null,
    statusUnavailableReason: !d ? "no_dynasty" : d.status === null ? "status_not_stated" : null,
    ...roiFields(roi),
    versions: d
      ? d.versions.map((v) => ({
          key: v,
          label: templateLabel(v),
          head: v === d.head,
          hasText: p.templateTexts.has(v),
          status: d.versionStatuses?.[v] ?? null,
          ...roiFields(versionRoi(v)),
          ...figures(p.terms, versionBars.get(v) ?? emptyBucket(v, templateLabel(v)), null),
        }))
      : [],
    ...figures(p.terms, r, writerRank.get(r) ?? null),
    workflows: workflows.filter((w) => w.template?.key === r.key || w.writesWithNow?.template?.key === r.key || w.wroteWith?.template?.key === r.key).map((w) => ({ key: w.key, label: w.label })),
    runs: p.generationRuns
      .filter((x) => x.promptType !== null && dyn.keyOf(x.promptType) === r.key)
      .slice(0, RUNS_SHOWN)
      .map((x) => ({
        when: whenText(x.createdAt),
        model: modelRef(x.model),
        workflow: wfRef(x.workflowSlug),
        version: x.workflowSlug ? versionText(x.workflowSlug) : null,
        templateVersion: x.promptType && dyn.versionOf(x.promptType),
        tokens: tokensText(x.tokensInput ?? null, x.tokensOutput ?? null),
      })),
    };
  });
  const versionBarsOf = new Map<string, Array<ResearchBucket & { dynastyKey: string }>>();
  for (const v of p.modelVersions ?? []) versionBarsOf.set(v.dynastyKey, [...(versionBarsOf.get(v.dynastyKey) ?? []), v]);
  const servedList = typeof p.servedModels === "object" ? p.servedModels : [];
  // A model's return is its OWN (MODEL-ROI-1023): the template rule, on the model bars' per-workflow-version shares.
  const pooledModelRoi = pooledRoi(p.modelFiguresByVersion, "pipe_models");
  const modelRoi = (key: string): CatalogRoi => {
    const m = ownRoi(p.modelFiguresByVersion?.get(key));
    return m ? roiOfValue(m.value, "measured", "own_outcomes", m.spendCovered) : (pooledModelRoi ?? nowRoiOf(key, "model") ?? pipeRoi);
  };
  const costs = p.generationCosts ?? "run_costs_unreadable";
  const costsOfPage = (key: string) => (typeof costs === "string" ? null : costs.filter((x) => llmKeyOfId(x.model) === key));
  const pageRunCost = (key: string) => {
    const rows = costsOfPage(key);
    return rows ? runCostOf(rows) : unavailableRunCost(costs as RunCostUnavailableReason);
  };
  // A version's runs: the page's runs written by one of its model ids (or named like it); the versions' runs partition the page's.
  const withVersionRunCosts = (key: string, versions: Array<Omit<CatalogModelVersion, "runCost">>): CatalogModelVersion[] => {
    const rows = costsOfPage(key);
    if (!rows) return versions.map((v) => ({ ...v, runCost: unavailableRunCost(costs as RunCostUnavailableReason) }));
    const versionOfRun = (m: string) => versions.find((v) => v.modelIds.includes(m))?.key ?? versions.find((v) => v.key === modelKey(p.modelLabel(m)))?.key ?? null;
    const byVersion = new Map<string, GenerationCostInput[]>();
    for (const x of rows) {
      const k = versionOfRun(x.model);
      if (k !== null) byVersion.set(k, [...(byVersion.get(k) ?? []), x]);
    }
    return versions.map((v) => ({ ...v, runCost: runCostOf(byVersion.get(v.key) ?? []) }));
  };
  const modelVersionsOf = (key: string, label: string, pageRoi: CatalogRoi): Array<Omit<CatalogModelVersion, "runCost">> => {
    const d = llmDyn.bySlug(key);
    const bars = versionBarsOf.get(key) ?? [];
    // A version's own return once it has an outcome of its own, else its dynasty's, expected (the template version rule).
    const versionRoi = (barKey: string | null): CatalogRoi => {
      const m = barKey === null ? null : ownRoi(p.modelVersionFiguresByVersion?.get(barKey));
      if (m) return roiOfValue(m.value, "measured", "own_outcomes", m.spendCovered);
      return pageRoi.value != null ? { ...pageRoi, basis: "expected", source: "dynasty", spendCovered: null } : pageRoi;
    };
    const idsOf = (k: string) => servedList.filter((m) => modelKey(m.displayName) === k || modelKey(m.modelId) === k).map((m) => m.modelId);
    if (!d) {
      const bar = bars[0] ?? emptyBucket(key, label);
      // A model on its own IS its one version: same figures, same return.
      return [{ key, label, modelIds: idsOf(key), head: true, servedToday: idsOf(key).length > 0, ...roiFields(pageRoi), ...figures(p.terms, bar, null) }];
    }
    // Every version newest first (chat-service's order), its bar if it wrote; a bar naming no listed version is appended.
    const used = new Set<string>();
    const out: Array<Omit<CatalogModelVersion, "runCost">> = [];
    for (const m of d.models) {
      const k = modelKey(m.displayName);
      const existing = out.find((x) => x.key === k);
      if (existing) {
        if (!existing.modelIds.includes(m.modelId)) existing.modelIds.push(m.modelId);
        existing.head ||= m.modelId === d.headModelId;
        existing.servedToday ||= m.servedToday;
        continue;
      }
      const bar = bars.find((b) => b.key === k || b.key === modelKey(m.modelId));
      if (bar) used.add(bar.key);
      out.push({ key: k, label: m.displayName, modelIds: [m.modelId], head: m.modelId === d.headModelId, servedToday: m.servedToday, ...roiFields(versionRoi(bar?.key ?? null)), ...figures(p.terms, bar ?? emptyBucket(k, m.displayName), null) });
    }
    for (const b of bars) if (!used.has(b.key)) out.push({ key: b.key, label: b.label, modelIds: idsOf(b.key), head: false, servedToday: false, ...roiFields(versionRoi(b.key)), ...figures(p.terms, b, null) });
    return out;
  };
  const models: CatalogModel[] = mdRows.map((r) => {
    const d = llmDyn.bySlug(r.key);
    const roi = modelRoi(r.key);
    return {
    key: r.key,
    label: r.label,
    dynasty: d ? { slug: d.slug, name: d.name, provider: d.provider, capabilityTier: d.capabilityTier, headModelId: d.headModelId, servedToday: d.servedToday, legacyAliases: [...d.legacyAliases] } : null,
    standaloneReason: d ? null : (llmDyn.unavailableReason ?? "no_dynasty_in_chat_service"),
    ...roiFields(roi),
    models: withVersionRunCosts(r.key, modelVersionsOf(r.key, r.label, roi)),
    runCost: pageRunCost(r.key),
    ...modelRowAliases(r.key, p.servedModels ?? "model_ids_unreadable", pageKeyOfServed),
    ...figures(p.terms, r, writerRank.get(r) ?? null),
    workflows: workflows.filter((w) => w.model?.key === r.key || w.writesWithNow?.model?.key === r.key || w.wroteWith?.model?.key === r.key).map((w) => ({ key: w.key, label: w.label })),
    runs: p.generationRuns
      .filter((x) => llmKeyOfId(x.model) === r.key)
      .slice(0, RUNS_SHOWN)
      .map((x) => ({ when: whenText(x.createdAt), workflow: wfRef(x.workflowSlug), template: tplRef(x.promptType), version: x.workflowSlug ? versionText(x.workflowSlug) : null, tokens: tokensText(x.tokensInput ?? null, x.tokensOutput ?? null) })),
    };
  });
  return { workflows, templates, models };
}

/** PURE. A ranking row's ROI figure as a catalogue return. */
export function catalogRoiOfFigure(f: LegWorkflowFigures["roi"]): CatalogRoi {
  if (f.value == null) return { ...NO_ROI, unavailableReason: "no_return_on_pipe" };
  const source: CatalogRoi["source"] = f.basis === "measured" ? "workflow" : f.source === "pipe_best_workflow" ? "pipe_best_workflow" : "pipe_workflows";
  return roiOfValue(f.value, f.basis === "measured" ? "measured" : "expected", source);
}

/**
 * PURE (RESEARCH-WF-FIGURES-1022). Every workflow page takes its ranking row's `figures` and its return from them, so the
 * Workflows list and the workflow page print ONE figure (before: the page held the ranking of its own build, up to 15 min
 * older, and a measured 30x on a workflow with no outcome). A row without `figures` (a ranking persisted before them)
 * leaves the page as built.
 */
export function withWorkflowFigures<T extends { workflows: CatalogWorkflow[] }>(
  pipe: T,
  rows: ReadonlyArray<{ workflowDynastySlug: string; figures?: LegWorkflowFigures; figuresByView?: { mature: LegWorkflowFigures; flash: LegWorkflowFigures } }> | null,
  /** The page's view (MATURITY-VIEW-1023): the row's figures on that half; a ranking stored before held none (page as built). */
  view?: "mature" | "flash",
): T {
  if (!rows) return pipe;
  const figuresOf = (r: (typeof rows)[number]) => (view ? r.figuresByView?.[view] : r.figures);
  const bySlug = new Map(rows.filter((r) => figuresOf(r)).map((r) => [r.workflowDynastySlug, figuresOf(r)!]));
  return {
    ...pipe,
    workflows: pipe.workflows.map((w) => {
      const f = bySlug.get(w.key);
      return f ? { ...w, ...roiFields(catalogRoiOfFigure(f.roi)), figures: f } : w;
    }),
  };
}
