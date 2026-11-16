/**
 * RESEARCH BY ENGINE AND SCRIPT (owner 2026-11-13, RESEARCH-BY-ENGINE-1113): the staff Research reads keyed by Engine
 * (outcome) and script dynasty, never by pipe. Additive twins of `/internal/research`, `/catalog`, `/performance` and the
 * live ranking (the stored fleet leg workflow ranking), built off the SAME served bodies (`lib/research/by-engine.ts`, pure),
 * so every figure keeps its population and basis. The pipe-keyed catalogue / performance / ranking routes are deleted
 * (RESEARCH-BY-ENGINE-1113-RETIRE, 2026-11-16): these are the only Research reads by source.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { loadChannelCatalogue } from "../lib/channel-declarations-store.js";
import { pipeLegKeyOf } from "../lib/funnel-legs.js";
import { CHANNEL_STEPS } from "../lib/acquisition-channels.js";
import {
  engineCatalogOf,
  engineFileOf,
  engineLiveScriptsOf,
  enginePerformanceOf,
  enginesOf,
  measureIdOf,
  type EngineSource,
} from "../lib/research/by-engine.js";
import { measureScripts, scriptKeyOf, type ScriptFacts } from "../lib/research/engine-script-performance.js";
import { SCRIPTS_FIRST_DAY, dailyBookSinceDay, loadDailyLedgerBook, runStartUntilOf, type LedgerBookRead } from "../lib/ledger-book.js";
import { legCutoffIso } from "../lib/maturity.js";
import { readRunnableScriptsForCatalogue, scriptDynastyKey, type RunnableScript } from "../lib/script-catalogue-client.js";
import { loadFleetCell } from "../lib/fleet-cell-store.js";
import { SCRIPT_ENGINES_CELL, favouritesOfBoard, writingTactic } from "../lib/engine-favourites.js";
import { llmTacticsOf, templateTacticsOf, type BoardEngine, type ScriptLlmTactic, type ScriptTemplateTactic } from "../lib/script-engine-board.js";
import { llmDynastyIndex, readLlmDynastiesSoft, type LlmDynastyIndex } from "../lib/llm-dynasties.js";
import type { EngineScriptsInput, MeasureScriptsRead, ResearchMeasure } from "../lib/research/by-engine.js";
import { readResearch, servedResearchCatalog, servedResearchFile, servedResearchPerformance, type Basis } from "./research.js";
import { servedLegWorkflowRanking } from "./public.js";
import type { ResearchView } from "../lib/research/types.js";

const router = Router();

/** An outcome's name: its catalogue step's label, else the key spelled out (`email_sent` -> "Email sent"). */
export function stepNameOf(key: string): string {
  const label = (CHANNEL_STEPS as Record<string, { label?: string } | undefined>)[key]?.label;
  return label ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

/** Each Research source on its Engine, from the catalogue (`outcome ?? to`, the rule campaign-service runs). */
export async function researchEngineSources(pipes: ReadonlyArray<{ id: string; channel: string; leg: string }>): Promise<Array<EngineSource & { channel: string; leg: string }>> {
  const catalogue = await loadChannelCatalogue({ publishedOnly: false });
  return pipes.flatMap((p) => {
    const t = catalogue.channels.find((c) => c.slug === p.channel)?.stepTransitions.find((x) => pipeLegKeyOf(p.channel, x.legKey) === pipeLegKeyOf(p.channel, p.leg));
    if (!t) {
      console.error(`[features-service] research by Engine: source ${p.id} is in no catalogue entry, left out (named in notCarried)`);
      return [];
    }
    return [{ sourceId: p.id, engine: t.outcome ?? t.to.key, startsFrom: t.from?.key ?? null, counts: t.to.key, channel: p.channel, leg: p.leg }];
  });
}

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
    const file = await servedResearchFile(p.basis, p.view);
    if (!file) return notYet(res);
    res.json(engineFileOf(file, await researchEngineSources(file.pipes), stepNameOf));
  } catch (error) {
    console.error("[features-service] research by Engine (file) failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/engines/catalog", apiKeyOnly, async (req, res) => {
  const p = readParams(req, res);
  if (!p) return;
  try {
    const [file, catalog] = await Promise.all([readResearch(p.basis, p.view), servedResearchCatalog(p.basis, p.view)]);
    if (!file || !catalog) return notYet(res);
    res.json({ computedAt: file.computedAt, costBasis: file.costBasis, view: p.view, ...engineCatalogOf(catalog, await researchEngineSources(file.pipes), stepNameOf) });
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
    const [file, perf] = await Promise.all([readResearch(p.basis, p.view), servedResearchPerformance(p.basis, p.view)]);
    if (!file || !perf) return notYet(res);
    const { pipes, ...head } = perf;
    const now = new Date();
    res.json({ ...head, ...enginePerformanceOf(pipes, await researchEngineSources(file.pipes), stepNameOf, await readEngineScripts(p.basis, p.view, now), now) });
  } catch (error) {
    console.error("[features-service] research by Engine (performance) failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/engines/live-scripts", apiKeyOnly, async (req, res) => {
  const measureId = String(req.query.measure ?? "");
  const rawPricing = req.query.pricing;
  if (rawPricing !== undefined && rawPricing !== "gross" && rawPricing !== "net") {
    res.status(400).json({ error: "pricing must be gross or net", reason: "pricing_unrecognised" });
    return;
  }
  const pricing: "gross" | "net" = rawPricing === "net" ? "net" : "gross";
  try {
    const file = await readResearch("user", "mature");
    if (!file) return notYet(res);
    const sources = await researchEngineSources(file.pipes);
    const measure = enginesOf(sources, stepNameOf)
      .flatMap((e) => e.measures)
      .find((m) => m.id === measureId);
    if (!measure) {
      res.status(404).json({ error: "No Research measure has this id (the `measures[].id` of /internal/research/engines).", reason: "measure_not_found" });
      return;
    }
    const mine = sources.filter((s) => measureIdOf(s.engine, s.startsFrom, s.counts) === measure.id);
    const rankings = await Promise.all(mine.map((s) => servedLegWorkflowRanking(s.channel, pipeLegKeyOf(s.channel, s.leg), pricing)));
    res.json({ pricing, ...engineLiveScriptsOf(measure, rankings) });
  } catch (error) {
    console.error("[features-service] research by Engine (live scripts) failed:", error);
    res.status(502).json({ error: "The live script ranking could not be read", reason: "live_scripts_unreadable" });
  }
});

export default router;
