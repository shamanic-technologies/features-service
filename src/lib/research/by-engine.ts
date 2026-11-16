/**
 * RESEARCH BY ENGINE AND SCRIPT (owner 2026-11-13, RESEARCH-BY-ENGINE-1113, go « A »: the staff Research page carries no
 * pipe anywhere). The framework v10 objects are an ENGINE (one per outcome) and its SCRIPTS (dynasties); an LLM and a
 * template are TACTICS of a script. PURE: every figure here is the byte-same figure the per-source Research reads serve
 * (`/internal/research*`), regrouped and re-worded, never recomputed, so a moved figure keeps its population and basis.
 *
 * - Engine of a Research source = the catalogue's Engine outcome of that (channel x step pair): `outcome`, else its `to`
 *   step (the rule campaign-service runs: `lib/engine-favourites.ts` `pipeEngineOutcome`).
 * - Inside an Engine, a MEASURE = what the figures count (`counts`, the step reached) and among whom (`startsFrom`, the
 *   step people stood at; null = from nothing). Two sources of one Engine counting the same step from the same step are
 *   ONE measure (their scripts listed together); figures are never summed across sources (a list keeps each source's
 *   page; two sources holding the same script keep the first and name the other in `notCarried`).
 * - Vocabulary: no field, key or enum value names a pipe, leg, channel, play or workflow (`inEngineWords`); prose says
 *   script / Engine / step. Guard `lib/research/by-engine.test.ts`.
 */

import { monthText, type MeasureScripts, type ScriptPoint } from "./engine-script-performance.js";
import { n, pctText, usd } from "./format.js";

/** One Research source (the per-source reads key on `sourceId`) placed on its Engine. */
export interface EngineSource {
  sourceId: string;
  engine: string;
  /** The step its people stood at; null = from nothing. */
  startsFrom: string | null;
  /** The step its figures count. */
  counts: string;
}

export interface StepRef {
  key: string;
  name: string;
}

export interface ResearchMeasure {
  /** `<engine>/<startsFrom or start>/<counts>`: stable, names no channel. */
  id: string;
  engine: string;
  startsFrom: StepRef | null;
  counts: StepRef;
  /** "Leads found who reached a Conversation", "Conversations from nothing" style. */
  description: string;
}

export interface ResearchEngineEntry {
  /** The Engine's outcome key (`email_sent`). */
  outcome: string;
  name: string;
  measures: ResearchMeasure[];
}

export interface NotCarried {
  what: string;
  reason: string;
}

export const measureIdOf = (engine: string, startsFrom: string | null, counts: string): string => `${engine}/${startsFrom ?? "start"}/${counts}`;

/** PURE. The Engines and their measures, in the order the sources come (the page's order). */
export function enginesOf(sources: readonly EngineSource[], stepName: (key: string) => string): ResearchEngineEntry[] {
  const engines = new Map<string, ResearchEngineEntry>();
  for (const s of sources) {
    let e = engines.get(s.engine);
    if (!e) {
      e = { outcome: s.engine, name: stepName(s.engine), measures: [] };
      engines.set(s.engine, e);
    }
    const id = measureIdOf(s.engine, s.startsFrom, s.counts);
    if (e.measures.some((m) => m.id === id)) continue;
    const startsFrom = s.startsFrom ? { key: s.startsFrom, name: stepName(s.startsFrom) } : null;
    const counts = { key: s.counts, name: stepName(s.counts) };
    const description = startsFrom ? `Of people at ${startsFrom.name}, those who reached ${counts.name}` : `${counts.name}, from nothing`;
    e.measures.push({ id, engine: s.engine, startsFrom, counts, description });
  }
  return [...engines.values()];
}

/** PURE. sourceId -> measure id. */
export const measureOfSource = (sources: readonly EngineSource[]): Map<string, string> =>
  new Map(sources.map((s) => [s.sourceId, measureIdOf(s.engine, s.startsFrom, s.counts)]));

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────────────────────────

const KEY_RENAMES: Record<string, string> = {
  workflow: "script",
  workflows: "scripts",
  workflowDynastySlug: "scriptDynastySlug",
  workflowDynastyName: "scriptDynastyName",
};
/** Fields naming the source a figure came from: the Engine / measure carry it instead. */
const KEY_DROPS = new Set(["featureSlug", "legKey", "channel", "leg", "pipe", "pipes"]);
/** Fields holding an identifier: never re-worded (a slug that happens to read like a word stays the slug). */
const ID_KEYS = new Set(["key", "slug", "id", "scriptDynastySlug", "workflowDynastySlug", "headModelId", "templateVersion", "version"]);

const TOKEN_RENAMES: Record<string, string> = { pipe: "engine", pipes: "engines", workflow: "script", workflows: "scripts", leg: "engine", legs: "engines", channel: "medium", play: "strategy" };
const SNAKE = /^[a-z]+(_[a-z0-9]+)+$/;

/** PURE. An enum word in the framework's vocabulary (`no_outcome_on_pipe` -> `no_outcome_on_engine`, `workflow` -> `script`). */
export function enumInEngineWords(value: string): string {
  if (value in TOKEN_RENAMES) return TOKEN_RENAMES[value]!;
  if (!SNAKE.test(value)) return value;
  return value
    .split("_")
    .map((t) => TOKEN_RENAMES[t] ?? t)
    .join("_");
}

const PROSE_WORDS: Array<[RegExp, string]> = [
  [/\bWorkflows\b/g, "Scripts"],
  [/\bworkflows\b/g, "scripts"],
  [/\bWorkflow\b/g, "Script"],
  [/\bworkflow\b/g, "script"],
  [/\b[Pp]ipes\b/g, "Engines"],
  [/\b[Pp]ipe's\b/g, "Engine's"],
  [/\b[Pp]ipe\b/g, "Engine"],
  [/\bLegs\b/g, "Steps"],
  [/\blegs\b/g, "steps"],
  [/\bLeg\b/g, "Step"],
  [/\bleg\b/g, "step"],
  [/\bChannels\b/g, "Media"],
  [/\bchannels\b/g, "media"],
  [/\bChannel\b/g, "Medium"],
  [/\bchannel\b/g, "medium"],
  [/\bPlays\b/g, "Strategies"],
  [/\bplays\b/g, "strategies"],
];

/** PURE. A sentence in the framework's words. */
export function proseInEngineWords(text: string): string {
  let out = text;
  for (const [re, to] of PROSE_WORDS) out = out.replace(re, to);
  return out;
}

/**
 * PURE, deep. A body in the framework's vocabulary: field names renamed (`workflow` -> `script`), source fields dropped,
 * enum words re-worded, every sentence (a string holding a space) re-worded; identifiers untouched. Never mutates.
 */
export function inEngineWords<T>(value: T, parentKey: string | null = null): T {
  if (typeof value === "string") {
    if (parentKey && ID_KEYS.has(parentKey)) return value;
    return (/\s/.test(value) ? proseInEngineWords(value) : enumInEngineWords(value)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => inEngineWords(v, parentKey)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (KEY_DROPS.has(k)) continue;
      const key = KEY_RENAMES[k] ?? k;
      out[key] = inEngineWords(v, key);
    }
    return out as T;
  }
  return value;
}

/** PURE. The source words a body must no longer carry (the guard the tests and the route's self-check read). */
export function sourceWordsLeft(body: unknown): string[] {
  const found = new Set<string>();
  const banned = /(pipe|workflow|channel)/i;
  const walk = (v: unknown, key: string | null) => {
    if (typeof v === "string") {
      if (key && ID_KEYS.has(key)) return;
      if (/\s/.test(v)) {
        for (const m of v.matchAll(/\b(pipes?|workflows?|legs?|channels?|plays?)\b/gi)) found.add(`prose:${m[0].toLowerCase()}`);
      } else if (SNAKE.test(v) || v in TOKEN_RENAMES) {
        for (const t of v.split("_")) if (t in TOKEN_RENAMES) found.add(`value:${v}`);
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (banned.test(k) || /^legs?$|Leg[A-Z]?|^leg[A-Z]/.test(k) || /^plays?$/.test(k)) found.add(`key:${k}`);
        walk(x, k);
      }
    }
  };
  walk(body, null);
  return [...found].sort();
}

// ── Studies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE. A study / unavailable id re-keyed off its source: `<source>-workflow-roi` -> `<measure>:script-roi`. */
export function studyIdInEngineWords(id: string, measureOf: ReadonlyMap<string, string>): string {
  let best: string | null = null;
  for (const src of measureOf.keys()) if (id.startsWith(`${src}-`) && (!best || src.length > best.length)) best = src;
  const rest = best ? id.slice(best.length + 1) : id;
  const worded = rest
    .split("-")
    .map((t) => TOKEN_RENAMES[t] ?? t)
    .join("-");
  return best ? `${measureOf.get(best)}:${worded}` : worded;
}

interface StudyLike {
  id: string;
  pipe?: string | null;
}

interface OutcomeLike {
  id: string;
  pipes?: string[];
}

interface FileLike {
  pipes: ReadonlyArray<{ id: string }>;
  outcomes: ReadonlyArray<OutcomeLike>;
  studies: ReadonlyArray<StudyLike>;
  unavailable: ReadonlyArray<{ id: string; reason: string }>;
  volume?: { workflows?: number };
  maturation?: { legs?: unknown };
}

/** PURE. The Research file by Engine: each study on its Engine + measure (or its outcome section), no source named. */
export function engineFileOf(file: FileLike, sources: readonly EngineSource[], stepName: (key: string) => string): Record<string, unknown> {
  const measureOf = measureOfSource(sources);
  const engineOfMeasure = new Map(sources.map((s) => [measureIdOf(s.engine, s.startsFrom, s.counts), s.engine]));
  const notCarried: NotCarried[] = [];
  const studies = file.studies.flatMap((s) => {
    const measure = s.pipe ? measureOf.get(s.pipe) ?? null : null;
    if (s.pipe && !measure) {
      notCarried.push({ what: `study ${studyIdInEngineWords(s.id, measureOf)}`, reason: "its source names no Engine in the catalogue" });
      return [];
    }
    const { pipe: _pipe, ...rest } = s;
    return [{ ...inEngineWords(rest), id: studyIdInEngineWords(s.id, measureOf), engine: measure ? engineOfMeasure.get(measure)! : null, measure }];
  });
  const outcomes = file.outcomes.map((o) => {
    const { pipes, ...rest } = o;
    const measures = pipes ? [...new Set(pipes.map((p) => measureOf.get(p)).filter((m): m is string => !!m))] : undefined;
    return { ...inEngineWords(rest), ...(measures ? { measures } : {}) };
  });
  for (const p of file.pipes) if (!measureOf.has(p.id)) notCarried.push({ what: `source ${p.id}`, reason: "the catalogue names no Engine for it" });
  const { pipes: _p, outcomes: _o, studies: _s, unavailable, volume, maturation, ...head } = file;
  const vol = volume ? (({ workflows, ...v }) => ({ ...v, ...(workflows !== undefined ? { scripts: workflows } : {}) }))(volume) : undefined;
  const mat = maturation ? (({ legs, ...m }) => ({ ...inEngineWords(m), ...(legs !== undefined ? { rules: legs } : {}) }))(maturation) : undefined;
  return {
    ...inEngineWords(head),
    ...(vol ? { volume: vol } : {}),
    ...(mat ? { maturation: mat } : {}),
    engines: enginesOf(sources, stepName),
    outcomes,
    studies,
    unavailable: unavailable.map((u) => ({ id: studyIdInEngineWords(u.id, measureOf), reason: proseInEngineWords(u.reason) })),
    notCarried,
  };
}

// ── Catalogue ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface PageLike {
  key: string;
}
interface CatalogEntryLike {
  workflows: ReadonlyArray<PageLike>;
  templates: ReadonlyArray<PageLike>;
  models: ReadonlyArray<PageLike>;
}

interface RefLike {
  key: string;
  label: string;
  [k: string]: unknown;
}

/** PURE. A script page's LLM and template as its TACTICS: what wrote it (`wroteWith`), else what it writes with now. */
export function scriptTacticsOf(page: object): { llm: RefLike | null; template: RefLike | null } {
  const wrote = (page as { wroteWith?: unknown }).wroteWith as { model?: RefLike | null; template?: RefLike | null } | null | undefined;
  const now = (page as { writesWithNow?: unknown }).writesWithNow as { model?: RefLike | null; template?: RefLike | null } | null | undefined;
  return { llm: wrote?.model ?? now?.model ?? null, template: wrote?.template ?? now?.template ?? null };
}

/** PURE. Pages of several sources of one measure, listed together; a key two sources hold keeps the first (named). */
function mergePages(lists: ReadonlyArray<ReadonlyArray<PageLike>>, measure: string, kind: string, notCarried: NotCarried[]): PageLike[] {
  const seen = new Set<string>();
  const out: PageLike[] = [];
  for (const list of lists)
    for (const p of list) {
      if (seen.has(p.key)) {
        notCarried.push({ what: `${kind} ${p.key} on ${measure}`, reason: "two sources of this measure hold it: the first one's page is served, figures are never summed" });
        continue;
      }
      seen.add(p.key);
      out.push(p);
    }
  return out;
}

/** PURE. The catalogue by Engine: per Engine, per measure, its script / template / LLM pages. */
export function engineCatalogOf(catalog: Readonly<Record<string, CatalogEntryLike>>, sources: readonly EngineSource[], stepName: (key: string) => string): Record<string, unknown> {
  const notCarried: NotCarried[] = [];
  const engines = enginesOf(sources, stepName).map((e) => ({
    ...e,
    measures: e.measures.map((m) => {
      const entries = sources.filter((s) => measureIdOf(s.engine, s.startsFrom, s.counts) === m.id).flatMap((s) => (catalog[s.sourceId] ? [catalog[s.sourceId]!] : []));
      const scripts = mergePages(entries.map((x) => x.workflows), m.id, "script", notCarried).map((p) => ({ ...inEngineWords(p), tactics: inEngineWords(scriptTacticsOf(p)) }));
      const templates = mergePages(entries.map((x) => x.templates), m.id, "template", notCarried).map((p) => inEngineWords(p));
      const llms = mergePages(entries.map((x) => x.models), m.id, "llm", notCarried).map((p) => inEngineWords(p));
      return { ...m, scripts, templates, llms };
    }),
  }));
  return { engines, notCarried };
}

// ── Performance ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface PerfLike {
  rows: ReadonlyArray<unknown>;
  totals: unknown;
  series: unknown;
}

/** The scripts of one measure on the ledger (`lib/research/engine-script-performance.ts`), or why they are not read. */
export interface MeasureScriptsRead {
  scripts: MeasureScripts | null;
  unavailableReason: "ledger_book_unreadable" | "ledger_book_missing_days" | null;
}

/** The Rating's favourite script of an Engine today and the LLM / template it states (`lib/engine-favourites.ts`). */
export interface EngineFavouriteLike {
  script: string | null;
  llm: { key: string; name: string } | null;
  template: { key: string; name: string } | null;
}

export interface EngineScriptsInput {
  of: (m: ResearchMeasure) => MeasureScriptsRead;
  /** undefined = not read (the board is not built). */
  favourite: (engine: string) => EngineFavouriteLike | null | undefined;
}

interface FigureLike {
  value: number | null;
}
interface CountLike {
  value: number;
}
interface TotalsLike {
  spentUsd: CountLike;
  outcomes: CountLike;
  contacted: CountLike;
  conversionRatePct: FigureLike;
}
interface PointLike {
  month: string;
  outcomes: number;
  spentUsd: number;
  conversionRatePct: number | null;
}
interface RowLike {
  key: string;
  rank?: number;
  written?: boolean;
  deprecatedParts?: string[];
}

const measured = (value: number, display: (v: number) => string) => ({ value, display: display(value), basis: "measured" as const, source: "own" as const, unavailableReason: null });
const notMeasured = (reason: string) => ({ value: null, display: null, basis: null, source: null, unavailableReason: reason });

/** PURE. Totals of spend / outcomes / contacted, their cost per outcome and conversion measured on the sums. */
function totalsOf(a: { spentUsd: number; outcomes: number; contacted: number }) {
  return {
    costPerOutcomeUsd: Math.round(a.outcomes) >= 1 && a.spentUsd > 0 ? measured(a.spentUsd / a.outcomes, usd) : notMeasured("no_outcome_on_engine"),
    conversionRatePct: a.contacted > 0 ? measured((100 * a.outcomes) / a.contacted, pctText) : notMeasured("nobody_emailed_on_engine"),
    outcomes: { value: a.outcomes, display: n(Math.round(a.outcomes)) },
    spentUsd: { value: a.spentUsd, display: usd(a.spentUsd) },
    contacted: { value: a.contacted, display: n(Math.round(a.contacted)) },
  };
}

/**
 * PURE. The cumulative month series of the history (the workflow era's points) and of the scripts, added month by month;
 * its last point = the totals. A history point states no base, so its conversion's base is read back off its rate (none
 * when the rate is 0 and scripts add to that month: the point's conversion is then null, never guessed).
 */
export function mergedSeries(history: readonly PointLike[], scripts: readonly ScriptPoint[], historyContacted: number, now: Date) {
  const months = [...history.map((p) => p.month), ...scripts.map((p) => p.month)].sort();
  const thisMonth = now.toISOString().slice(0, 7);
  if (months.length === 0) return null;
  const h = new Map(history.map((p) => [p.month, p] as const));
  const sc = new Map(scripts.map((p) => [p.month, p] as const));
  const lastHistory = history[history.length - 1] ?? null;
  const points: Array<{ month: string; label: string; costPerOutcomeUsd: number | null; conversionRatePct: number | null; outcomes: number; spentUsd: number }> = [];
  let carryS: ScriptPoint | null = null;
  for (let ym = months[0]!; ym <= thisMonth; ym = nextMonthOf(ym)) {
    const hp = h.get(ym) ?? (lastHistory && ym > lastHistory.month ? lastHistory : null);
    const sp = sc.get(ym) ?? (carryS && ym > carryS.month ? carryS : null);
    if (sc.has(ym)) carryS = sc.get(ym)!;
    const isLast = ym === thisMonth;
    const hContacted = !hp ? 0 : isLast && hp === lastHistory ? historyContacted : hp.conversionRatePct === null ? 0 : hp.conversionRatePct > 0 ? (100 * hp.outcomes) / hp.conversionRatePct : null;
    const spentUsd = (hp?.spentUsd ?? 0) + (sp?.spentUsd ?? 0);
    const outcomes = (hp?.outcomes ?? 0) + (sp?.outcomes ?? 0);
    const contacted = hContacted === null ? (sp && sp.contacted > 0 ? null : 0) : hContacted + (sp?.contacted ?? 0);
    points.push({
      month: ym,
      label: monthText(ym),
      costPerOutcomeUsd: Math.round(outcomes) >= 1 && spentUsd > 0 ? spentUsd / outcomes : null,
      conversionRatePct: contacted === null ? null : hContacted === null ? hp!.conversionRatePct : contacted > 0 ? (100 * outcomes) / contacted : null,
      outcomes,
      spentUsd,
    });
  }
  return { grain: "month" as const, points };
}

const nextMonthOf = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * PURE. One measure's Performance on scripts (RESEARCH-PERF-SCRIPTS-1116): the scripts of its Engine first (what produces
 * the outcome today, measured on the ledger, `era: scripts`), then the workflow era's rows that wrote (`era: history`, all
 * deprecated: no campaign runs a workflow since MIGRATE-1105). The combinations of the workflow era that never wrote are
 * not listed (`combinationsNeverRunNotListed`): nothing can run them. Totals and series = scripts + history, so
 * Σ rows' spend = the totals.
 */
export function withMeasureScripts(
  m: ResearchMeasure,
  body: Record<string, unknown>,
  read: MeasureScriptsRead,
  fav: EngineFavouriteLike | null | undefined,
  now: Date,
): Record<string, unknown> {
  const all = (body.rows as RowLike[] | undefined) ?? [];
  const history = all
    .filter((r) => r.written !== false)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((r) => ({ ...r, era: "history" as const, status: "deprecated" as const, deprecatedParts: [...new Set([...(r.deprecatedParts ?? []), "script"])] }));
  const scriptRows = read.scripts?.rows ?? [];
  const rows = [...scriptRows, ...history].map((r, i) => ({ ...r, rank: i + 1 }));
  const reason = body.totalsUnavailableReason as string | null | undefined;
  const ht = body.totals as TotalsLike | null | undefined;
  const sum = { spentUsd: 0, outcomes: 0, contacted: 0 };
  for (const r of scriptRows) {
    sum.spentUsd += r.spentUsd.value;
    sum.outcomes += r.outcomes.value;
    sum.contacted += r.contacted.value;
  }
  const several = reason === "several_sources_not_summed";
  const hasHistory = !!ht;
  let totals: unknown = several ? null : body.totals ?? null;
  let series: unknown = several ? null : body.series ?? null;
  let totalsUnavailableReason: string | null = reason ?? null;
  if (!several && scriptRows.length > 0) {
    totals = totalsOf({ spentUsd: (ht?.spentUsd.value ?? 0) + sum.spentUsd, outcomes: (ht?.outcomes.value ?? 0) + sum.outcomes, contacted: (ht?.contacted.value ?? 0) + sum.contacted });
    const hs = ((body.series as { points?: PointLike[] } | null | undefined)?.points ?? []) as PointLike[];
    series = mergedSeries(hasHistory ? hs : [], read.scripts?.points ?? [], ht?.contacted.value ?? 0, now);
    totalsUnavailableReason = null;
  }
  const favRow = fav?.script ? scriptRows.find((r) => r.key === fav.script) ?? null : null;
  const servedNow =
    fav === undefined
      ? { script: null, template: null, llm: null, row: null, unavailableReason: "served_pick_unreadable" }
      : !fav || !fav.script
        ? { script: null, template: null, llm: null, row: null, unavailableReason: "no_runnable_script" }
        : {
            script: { key: fav.script, label: favRow?.script.label ?? fav.script.slice(fav.script.indexOf("/") + 1) },
            template: fav.template ? { key: fav.template.key, label: fav.template.name } : null,
            llm: fav.llm ? { key: fav.llm.key, label: fav.llm.name } : null,
            row: favRow,
            unavailableReason: favRow ? null : "combination_not_listed",
          };
  return {
    ...m,
    ...body,
    rowsCover: "scripts_that_ran_and_history",
    figuresBasis: "scripts_on_ledger_history_on_bars",
    rows,
    totals,
    series,
    totalsUnavailableReason,
    scriptsUnavailableReason: read.unavailableReason,
    unplacedScriptOutcomes: read.scripts?.unplacedOutcomes ?? null,
    combinationsNeverRunNotListed: all.length - history.length,
    servedNow,
  };
}

/** PURE. The Performance tab by Engine: per measure, its rows (scripts, then the history), totals, series, served now. */
export function enginePerformanceOf(
  pipes: Readonly<Record<string, PerfLike>>,
  sources: readonly EngineSource[],
  stepName: (key: string) => string,
  scripts?: EngineScriptsInput,
  now: Date = new Date(),
): Record<string, unknown> {
  const engines = enginesOf(sources, stepName).map((e) => ({
    ...e,
    measures: e.measures.map((m) => {
      const perfs = sources.filter((s) => measureIdOf(s.engine, s.startsFrom, s.counts) === m.id).flatMap((s) => (pipes[s.sourceId] ? [pipes[s.sourceId]!] : []));
      const filled = perfs.filter((p) => p.rows.length > 0 || p.totals !== null);
      const base = filled[0] ?? perfs[0] ?? null;
      const body: Record<string, unknown> = !base
        ? { rows: [], totals: null, series: null, totalsUnavailableReason: "no_source_measured" }
        : filled.length <= 1
          ? { ...(inEngineWords(base) as unknown as Record<string, unknown>), totalsUnavailableReason: null }
          : // Several sources measured the same thing on different campaigns: their rows are listed, never summed.
            { ...(inEngineWords(base) as unknown as Record<string, unknown>), rows: filled.flatMap((p) => inEngineWords(p.rows)), totals: null, series: null, totalsUnavailableReason: "several_sources_not_summed" };
      if (!scripts) return { ...m, ...body };
      return withMeasureScripts(m, body, scripts.of(m), scripts.favourite(m.engine), now);
    }),
  }));
  return { engines };
}

// ── Live script ranking ─────────────────────────────────────────────────────────────────────────────────────────────

interface RankingLike {
  rows: ReadonlyArray<unknown>;
}

/** PURE. One measure's live script ranking: the ranking rows of its source (several = listed, order stated as not shared). */
export function engineLiveScriptsOf(measure: ResearchMeasure, rankings: ReadonlyArray<RankingLike | null>): Record<string, unknown> {
  const present = rankings.filter((r): r is RankingLike => !!r);
  const filled = present.filter((r) => r.rows.length > 0);
  const base = filled[0] ?? present[0] ?? null;
  const body = base ? (inEngineWords(base) as unknown as Record<string, unknown>) : { computedAt: null, rows: [] };
  if (filled.length <= 1) return { ...body, engine: measure.engine, measure, orderUnavailableReason: base ? null : "ranking_not_computed_yet" };
  return { ...body, engine: measure.engine, measure, rows: filled.flatMap((r) => inEngineWords(r.rows)), orderUnavailableReason: "several_sources_ranked_apart" };
}
