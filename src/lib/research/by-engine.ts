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

/** PURE. The Performance tab by Engine: per measure, its rows (script x template x LLM), totals, series, served now. */
export function enginePerformanceOf(pipes: Readonly<Record<string, PerfLike>>, sources: readonly EngineSource[], stepName: (key: string) => string): Record<string, unknown> {
  const engines = enginesOf(sources, stepName).map((e) => ({
    ...e,
    measures: e.measures.map((m) => {
      const perfs = sources.filter((s) => measureIdOf(s.engine, s.startsFrom, s.counts) === m.id).flatMap((s) => (pipes[s.sourceId] ? [pipes[s.sourceId]!] : []));
      const filled = perfs.filter((p) => p.rows.length > 0 || p.totals !== null);
      const base = filled[0] ?? perfs[0] ?? null;
      if (!base) return { ...m, rows: [], totals: null, series: null, totalsUnavailableReason: "no_source_measured" };
      const body = inEngineWords(base) as unknown as Record<string, unknown>;
      if (filled.length <= 1) return { ...m, ...body, totalsUnavailableReason: null };
      // Several sources measured the same thing on different campaigns: their rows are listed, never summed.
      const rows = filled.flatMap((p) => inEngineWords(p.rows));
      return { ...m, ...body, rows, totals: null, series: null, totalsUnavailableReason: "several_sources_not_summed" };
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
