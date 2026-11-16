/**
 * RESEARCH BY ENGINE AND SCRIPT (owner 2026-11-13, RESEARCH-BY-ENGINE-1113): the staff Research reads keyed by Engine
 * (outcome) and script dynasty, never by pipe. Since RESEARCH-NATIVE-ENGINE-1116-P2 the build is STORED by Engine
 * (`lib/research/engine-build.ts`: every history population placed on its Engine measure once per build); these reads
 * serve it with the overlays read live: the freshness, the history script pages' figures (leg workflow ranking,
 * RESEARCH-WF-FIGURES-1022), the template pages' status and tactics (TPL-STATUS-LIVE-1023, TPL-TACTICS-ROWS-1022), the
 * marks, and the Engine's scripts on the ledger (RESEARCH-PERF-SCRIPTS-1116). No catalogue read and no re-wording per request.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { enginePerformanceOf, inEngineWords, type EngineHistoryEntry } from "../lib/research/by-engine.js";
import { measureScripts, scriptKeyOf, type ScriptFacts } from "../lib/research/engine-script-performance.js";
import { SCRIPTS_FIRST_DAY, dailyBookSinceDay, loadDailyLedgerBook, runStartUntilOf, type LedgerBookRead } from "../lib/ledger-book.js";
import { legCutoffIso } from "../lib/maturity.js";
import { readRunnableScriptsForCatalogue, scriptDynastyKey, type RunnableScript } from "../lib/script-catalogue-client.js";
import { loadFleetCell } from "../lib/fleet-cell-store.js";
import { SCRIPT_ENGINES_CELL, favouritesOfBoard, writingTactic } from "../lib/engine-favourites.js";
import { llmTacticsOf, templateTacticsOf, type BoardEngine, type ScriptLlmTactic, type ScriptTemplateTactic } from "../lib/script-engine-board.js";
import { llmDynastyIndex, readLlmDynastiesSoft, type LlmDynastyIndex } from "../lib/llm-dynasties.js";
import type { EngineScriptsInput, MeasureScriptsRead, ResearchMeasure } from "../lib/research/by-engine.js";
import { readResearchBuild, researchFreshnessOf, type Basis } from "./research.js";
import { readLegWorkflowRanking } from "./public.js";
import type { ResearchView } from "../lib/research/types.js";
import type { EngineResearchBuild, HistorySource } from "../lib/research/engine-build.js";
import { readLiveTemplateDynasties } from "../lib/writer-catalogue-client.js";
import { withLiveTemplateStatus } from "../lib/research/live-template-status.js";
import { readTemplateTactics, withTemplateTactics } from "../lib/template-tactics.js";
import { marksFor } from "../lib/catalogue-marks-store.js";
import { withMark } from "../lib/catalogue-mark-serving.js";
import type { CatalogTemplate } from "../lib/research/catalog.js";
import type { LegWorkflowFigures } from "../lib/leg-workflow-figures.js";

const router = Router();

const viewOf = (raw: unknown): ResearchView | null => (raw === undefined || raw === "" || raw === "mature" ? "mature" : raw === "flash" ? "flash" : null);
const basisOf = (raw: unknown): Basis | null => (raw === undefined || raw === "" || raw === "user" || raw === "billed" ? "user" : raw === "actual" ? "actual" : null);

function readParams(req: import("express").Request, res: import("express").Response): { basis: Basis; view: ResearchView } | null {
  const basis = basisOf(req.query.basis);
  if (!basis) {
    res.status(400).json({ error: "basis must be user (billed, default) or actual", reason: "basis_unrecognised" });
    return null;
  }
  const view = viewOf(req.query.view);
  if (!view) {
    res.status(400).json({ error: "view must be mature (default) or flash", reason: "view_unrecognised" });
    return null;
  }
  return { basis, view };
}

const notYet = (res: import("express").Response) =>
  res.status(503).json({ error: "The research studies have not been computed yet: the first build after this deploy is running.", reason: "research_not_computed_yet" });

router.get("/internal/research/engines", apiKeyOnly, async (req, res) => {
  const p = readParams(req, res);
  if (!p) return;
  try {
    const build = await readResearchBuild(p.basis, p.view);
    if (!build) return notYet(res);
    res.json({ ...build.file, freshness: researchFreshnessOf(build, p.basis, p.view) });
  } catch (error) {
    console.error("[features-service] research by Engine (file) failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/engines/catalog", apiKeyOnly, async (req, res) => {
  const p = readParams(req, res);
  if (!p) return;
  try {
    const build = await readResearchBuild(p.basis, p.view);
    if (!build?.catalog) return notYet(res);
    res.json({ computedAt: build.computedAt, costBasis: build.costBasis, view: p.view, ...(await servedEngineCatalog(build, p.view)) });
  } catch (error) {
    console.error("[features-service] research by Engine (catalogue) failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * The scripts of every Research measure, read LIVE at each Performance read (RESEARCH-PERF-SCRIPTS-1116): the general
 * ledger's daily book (the shared read the Engine prices hold, `loadDailyLedgerBook`; billed = gross, vendor = actual),
 * workflow-service's runnable scripts (names, re-homing), Monitoring's stored script board (runnable, runs of the last 30
 * days, the LLM / template each script states, the favourite = served now) and chat-service's LLM dynasties (labels). A
 * book that misses a past day of the scripts' era (not merely stale) or cannot be read leaves every measure's scripts
 * unread, said on `scriptsUnavailableReason` (the history rows still serve); never a 5xx for it.
 */
export async function readEngineScripts(basis: Basis, view: ResearchView, now: Date = new Date()): Promise<EngineScriptsInput> {
  const [bookRead, runnable, board, dynasties] = await Promise.all([
    loadDailyLedgerBook(basis === "actual" ? "vendor" : "gross", dailyBookSinceDay(now.getTime())).catch((error: unknown): null => {
      console.error("[features-service] research by Engine (performance): the daily ledger book is unreadable, no script is measured this read:", error);
      return null;
    }),
    readRunnableScriptsForCatalogue().catch((error: unknown): RunnableScript[] => {
      console.error("[features-service] research by Engine (performance): runnable scripts unreadable, scripts read without names:", (error as Error).message);
      return [];
    }),
    loadFleetCell(SCRIPT_ENGINES_CELL)
      .then((c) => (c ? (JSON.parse(c.text) as { engines: BoardEngine[] }).engines : null))
      .catch((error: unknown): null => {
        console.error("[features-service] research by Engine (performance): the script board is unreadable:", (error as Error).message);
        return null;
      }),
    readLlmDynastiesSoft("research by Engine (performance)"),
  ]);
  return engineScriptsOf({ bookRead, runnable, board, index: llmDynastyIndex(dynasties), view, now });
}

/** PURE (given its reads). See `readEngineScripts`. */
export function engineScriptsOf(input: { bookRead: LedgerBookRead | null; runnable: readonly RunnableScript[]; board: readonly BoardEngine[] | null; index: LlmDynastyIndex; view: ResearchView; now: Date }): EngineScriptsInput {
  const { bookRead, runnable, board, index, view, now } = input;
  const today = now.toISOString().slice(0, 10);
  const stale = new Set(bookRead?.staleDays ?? []);
  const late = (bookRead?.missingDays ?? []).filter((d) => d >= SCRIPTS_FIRST_DAY && d < today && !stale.has(d));
  if (late.length > 0) console.error(`[features-service] research by Engine (performance): the daily ledger book misses ${late.length} day(s) of the scripts' era (${late.slice(0, 5).join(",")}), no script is measured this read`);
  const unavailableReason: MeasureScriptsRead["unavailableReason"] = !bookRead ? "ledger_book_unreadable" : late.length > 0 ? "ledger_book_missing_days" : null;
  const keyOf = scriptKeyOf(runnable.map(scriptDynastyKey));
  const llmOf = (t: ScriptLlmTactic | null): ScriptFacts["llm"] => {
    if (!t?.model) return null;
    const d = index.dynastyOfName(t.model);
    return d ? { key: d.slug, label: d.name, provider: d.provider || t.provider } : { key: t.model, label: t.model, provider: t.provider };
  };
  const tplOf = (t: ScriptTemplateTactic | null): ScriptFacts["template"] => (t ? { key: t.templateDynastySlug, label: t.templateDynastySlug } : null);
  const facts = new Map<string, ScriptFacts>();
  for (const s of runnable) {
    const key = scriptDynastyKey(s);
    facts.set(key, { key, name: s.name ?? null, runnable: true, recentRuns: 0, llm: llmOf(writingTactic(llmTacticsOf(s.tactics))), template: tplOf(writingTactic(templateTacticsOf(s.tactics))) });
  }
  for (const e of board ?? [])
    for (const r of e.scripts) {
      const was = facts.get(r.scriptDynasty);
      facts.set(r.scriptDynasty, {
        key: r.scriptDynasty,
        name: was?.name ?? null,
        // the catalogue read now wins over the stored board's (≤ 15 min old)
        runnable: runnable.length > 0 ? !!was : r.runnable,
        recentRuns: r.runsByDay.reduce((a, d) => a + d.runs, 0),
        llm: was?.llm ?? llmOf(writingTactic(r.llms)),
        template: was?.template ?? tplOf(writingTactic(r.templates)),
      });
    }
  const held = new Map<string, MeasureScriptsRead>();
  return {
    of: (m: ResearchMeasure) => {
      if (unavailableReason || !bookRead) return { scripts: null, unavailableReason };
      let v = held.get(m.id);
      if (!v) {
        const cutoff = legCutoffIso(`${m.startsFrom?.key ?? "start"}_to_${m.counts.key}`, now);
        const measure = { engine: m.engine, startsFrom: m.startsFrom?.key ?? null, counts: m.counts.key };
        held.set(m.id, (v = { scripts: measureScripts({ measure, book: bookRead.book, view, matureCutDay: cutoff ? runStartUntilOf(cutoff) : null, keyOf, facts, now }), unavailableReason: null }));
      }
      return v;
    },
    favourite: (engine: string) => {
      if (!board) return undefined;
      const e = board.find((x) => x.outcome === engine);
      return e ? favouritesOfBoard(e, index.dynastyOfName) : null;
    },
  };
}

router.get("/internal/research/engines/performance", apiKeyOnly, async (req, res) => {
  const p = readParams(req, res);
  if (!p) return;
  try {
    const build = await readResearchBuild(p.basis, p.view);
    // A copy stored before the Performance tab existed holds none: not computed yet until the next build.
    if (!build?.performance) return notYet(res);
    const now = new Date();
    const [history, scripts] = await Promise.all([withHistoryMarks(build.performance), readEngineScripts(p.basis, p.view, now)]);
    res.json({ computedAt: build.computedAt, freshness: researchFreshnessOf(build, p.basis, p.view), costBasis: build.costBasis, view: p.view, ...enginePerformanceOf(history, scripts, now) });
  } catch (error) {
    console.error("[features-service] research by Engine (performance) failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── live overlays ──────────────────────────────────────────────────────────────────────────────────────────────────

type Page = Record<string, unknown> & { key: string };
type RankingRow = { workflowDynastySlug: string; figures?: LegWorkflowFigures; figuresByView?: { mature: LegWorkflowFigures; flash: LegWorkflowFigures } };

/** The history populations of each measure, in build order (the first one's page is the one a measure serves). */
const sourcesByMeasure = (build: EngineResearchBuild): Map<string, HistorySource[]> => {
  const out = new Map<string, HistorySource[]>();
  for (const s of build.historySources) out.set(s.measureId, [...(out.get(s.measureId) ?? []), s]);
  return out;
};

/**
 * The stored catalogue with what moves between builds, read now: each history script page takes its CURRENT leg workflow
 * ranking row's figures on the view (RESEARCH-WF-FIGURES-1022: one figure per workflow), each template page
 * content-generation's current status (TPL-STATUS-LIVE-1023) and its tactics (TPL-TACTICS-ROWS-1022), then the marks.
 * A ranking or a template list that cannot be read leaves the build's page (logged by its reader).
 */
async function servedEngineCatalog(build: EngineResearchBuild, view: ResearchView): Promise<Record<string, unknown>> {
  const catalog = build.catalog!;
  const sources = sourcesByMeasure(build);
  const all = build.historySources;
  const [rankings, lives, tacticsOf] = await Promise.all([
    Promise.all(all.map((s) => readLegWorkflowRanking(s.featureSlug, s.legKey, 0).catch((): null => null))),
    Promise.all(all.map((s) => readLiveTemplateDynasties(s.featureSlug, s.legKey))),
    readTemplateTactics(),
  ]);
  const rankingOf = new Map(all.map((s, i) => [s, rankings[i]?.rows as RankingRow[] | undefined]));
  const liveOf = new Map(all.map((s, i) => [s, lives[i]!]));
  const engines = catalog.engines.map((e) => ({
    ...e,
    measures: e.measures.map((m) => {
      const mine = sources.get(m.id) ?? [];
      const figures = new Map<string, LegWorkflowFigures>();
      for (const s of mine)
        for (const r of rankingOf.get(s) ?? []) {
          const f = r.figuresByView?.[view];
          if (f && !figures.has(r.workflowDynastySlug)) figures.set(r.workflowDynastySlug, f);
        }
      const scripts = m.scripts.map((p) => (figures.has(p.key) ? { ...p, figures: inEngineWords(figures.get(p.key)!) } : p));
      // the first population listing a dynasty states its status (applied last)
      let templates = m.templates as unknown as CatalogTemplate[];
      for (const s of [...mine].reverse()) templates = withLiveTemplateStatus(templates, liveOf.get(s) ?? null);
      return { ...m, scripts, templates: inEngineWords(withTemplateTactics(templates, tacticsOf)) as unknown as Page[] };
    }),
  }));
  const pages = engines.flatMap((e) => e.measures);
  const [wf, tpl] = await Promise.all([marksFor("workflow", pages.flatMap((m) => m.scripts.map((p) => p.key))), marksFor("template", pages.flatMap((m) => m.templates.map((p) => p.key)))]);
  return {
    engines: engines.map((e) => ({
      ...e,
      measures: e.measures.map((m) => ({ ...m, scripts: m.scripts.map((p) => withMark(p, wf.get(p.key))), templates: m.templates.map((p) => withMark(p, tpl.get(p.key))) })),
    })),
    notCarried: catalog.notCarried,
  };
}

interface HistoryRowLike {
  script: { key: string };
  template: { key: string; dynasty: { key: string } | null } | null;
}

/** Each history row's script mark and its template page's mark (also on its dynasty ref); LLM rows carry none. */
async function withHistoryMarks(history: readonly EngineHistoryEntry[]): Promise<EngineHistoryEntry[]> {
  const rows = history.flatMap((e) => e.measures.flatMap((m) => (m.rows as HistoryRowLike[] | undefined) ?? []));
  const [wf, tpl] = await Promise.all([marksFor("workflow", rows.map((r) => r.script.key)), marksFor("template", rows.flatMap((r) => (r.template ? [r.template.key] : [])))]);
  return history.map((e) => ({
    ...e,
    measures: e.measures.map((m) => ({
      ...m,
      rows: ((m.rows as HistoryRowLike[] | undefined) ?? []).map((r) => ({
        ...r,
        script: withMark(r.script, wf.get(r.script.key)),
        template: r.template ? { ...withMark(r.template, tpl.get(r.template.key)), dynasty: r.template.dynasty ? withMark(r.template.dynasty, tpl.get(r.template.dynasty.key)) : null } : null,
      })),
    })),
  }));
}

export default router;
