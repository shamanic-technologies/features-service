/**
 * RESEARCH BY ENGINE AND SCRIPT (owner 2026-11-13, RESEARCH-BY-ENGINE-1113): the staff Research reads keyed by Engine
 * (outcome) and script dynasty, never by pipe. Additive twins of `/internal/research`, `/catalog`, `/performance` and the
 * live ranking (`/public/stats/leg-workflow-ranking`), built off the SAME served bodies (`lib/research/by-engine.ts`, pure),
 * so every figure keeps its population and basis. The per-source reads stay until the dashboard stops reading them.
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

router.get("/internal/research/engines/performance", apiKeyOnly, async (req, res) => {
  const p = readParams(req, res);
  if (!p) return;
  try {
    const [file, perf] = await Promise.all([readResearch(p.basis, p.view), servedResearchPerformance(p.basis, p.view)]);
    if (!file || !perf) return notYet(res);
    const { pipes, ...head } = perf;
    res.json({ ...head, ...enginePerformanceOf(pipes, await researchEngineSources(file.pipes), stepNameOf) });
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
