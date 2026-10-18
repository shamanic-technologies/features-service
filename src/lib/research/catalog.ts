/**
 * THE RESEARCH CATALOGUE (LIVE-RESEARCH-1018): one page per workflow, per template and per model, per pipe, with its
 * figures, its month curves and its last runs. Byte-compatible with the `ResearchCatalog` the dashboard typed over the
 * nightly snapshot's `research-catalog.json`. Pure: every bar is the same bucket the studies draw (`lib/research/*`), so a
 * page and its study can never state two figures.
 */
import { MONTHS, modelKey, n, pctText, templateLabel, usd } from "./format.js";
import { monthsChart, type PipeTerms, type ResearchBucket } from "./studies.js";
import type { ResearchChart, ResearchPipeId } from "./types.js";

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

export interface CatalogWorkflow extends CatalogFigures {
  key: string;
  label: string;
  name: string | null;
  model: CatalogRef | null;
  template: CatalogRef | null;
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

const costOf = (b: ResearchBucket) => (b.figures.outcomes > 0 && b.figures.spentUsd > 0 ? b.figures.spentUsd / b.figures.outcomes : null);
/** Cheapest first (the study's ROI order), then the unpriced ones by people reached. */
function catalogOrder(rows: readonly ResearchBucket[]): ResearchBucket[] {
  const priced = rows.filter((r) => costOf(r) !== null).sort((a, b) => costOf(a)! - costOf(b)! || b.figures.outcomes - a.figures.outcomes);
  const rest = rows.filter((r) => costOf(r) === null && r.figures.contacted > 0).sort((a, b) => b.figures.contacted - a.figures.contacted);
  return [...priced, ...rest];
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
}

/** PURE. One pipe's catalogue. */
export function pipeCatalog(p: PipeCatalogInput): { workflows: CatalogWorkflow[]; templates: CatalogTemplate[]; models: CatalogModel[] } {
  const wfRows = catalogOrder(p.workflows);
  const tplRows = catalogOrder(p.templates);
  const mdRows = catalogOrder(p.models);
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
  const wfRef = (slug: string | null) => {
    if (!slug) return null;
    const d = p.dynastyOf(slug);
    return wfKeys.has(d) ? { key: d, label: wfLabel.get(d)! } : null;
  };
  const workflows: CatalogWorkflow[] = wfRows.map((r, i) => {
    const main = p.mainOf(r.key);
    return {
      key: r.key,
      label: r.label,
      name: p.nameOf(r.key),
      model: modelRef(main.model),
      template: tplRef(main.template),
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
    workflows: workflows.filter((w) => w.template?.key === r.key).map((w) => ({ key: w.key, label: w.label })),
    runs: p.generationRuns
      .filter((x) => x.promptType === r.key)
      .slice(0, RUNS_SHOWN)
      .map((x) => ({ when: whenText(x.createdAt), model: modelRef(x.model), workflow: wfRef(x.workflowSlug), version: x.workflowSlug ? versionText(x.workflowSlug) : null, tokens: null })),
  }));
  const models: CatalogModel[] = mdRows.map((r, i) => ({
    key: r.key,
    label: r.label,
    ...figures(p.terms, r, rankOf(r, i)),
    workflows: workflows.filter((w) => w.model?.key === r.key).map((w) => ({ key: w.key, label: w.label })),
    runs: p.generationRuns
      .filter((x) => modelKey(p.modelLabel(x.model)) === r.key)
      .slice(0, RUNS_SHOWN)
      .map((x) => ({ when: whenText(x.createdAt), workflow: wfRef(x.workflowSlug), template: tplRef(x.promptType), version: x.workflowSlug ? versionText(x.workflowSlug) : null, tokens: null })),
  }));
  return { workflows, templates, models };
}
