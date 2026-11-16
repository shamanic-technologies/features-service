/**
 * RESEARCH NATIVE ENGINE (owner 2026-11-16, RESEARCH-NATIVE-ENGINE-1116-P2, « should we delete something? »): the Research
 * build is STORED keyed by Engine. The workflow era's history was measured per population of campaigns (the campaigns of
 * one (medium x step pair), the only grain that history holds); each population is resolved to its Engine measure ONCE,
 * when the build lands (`engineResearchBuildOf`), and the reads serve the stored Engine bodies with their live overlays.
 * Before: every read re-read the channel catalogue and re-worded the whole per-population build (`researchEngineSources`
 * + `inEngineWords` per request).
 *
 * PURE. The only population keys kept are in `historySources`, NEVER served: each names the producers' own keys
 * (feature slug + step pair) that three live readers ask with:
 * - the leg workflow ranking (`readLegWorkflowRanking`): each history script page's figures, read live (RESEARCH-WF-FIGURES-1022),
 *   and `/internal/research/engines/live-scripts`;
 * - content-generation's template dynasties (`readLiveTemplateDynasties`): each template page's status, read live (TPL-STATUS-LIVE-1023);
 * - the engine shadow's uplift (`lib/engine-shadow-io.ts` `subPicks`): each history script's rows (`workflowRows`).
 */

import { engineCatalogOf, engineFileOf, engineHistoryOf, type EngineHistoryEntry, type EngineSource, type NotCarried, type ResearchEngineEntry } from "./by-engine.js";
import { researchConclusions, researchMeasuredStudies, type ResearchConclusionsBody, type ResearchStudiesBody } from "./conclusions.js";
import type { ResearchFile, ResearchView } from "./types.js";

/** Bump when the stored Engine build changes structure: a stored build of another shape is rebuilt at once. */
export const ENGINE_BUILD_SHAPE = "engine-v1" as const;

/** A history population: the producers' keys a live overlay reads it with (never served). */
export interface HistorySource {
  measureId: string;
  featureSlug: string;
  legKey: string;
  /** Per workflow dynasty, its history rows (outcomes, $ spent) on this population: the engine shadow's uplift. */
  workflowRows: Record<string, Array<{ outcomes: number; spentUsd: number }>>;
}

export interface EngineCatalogMeasure extends Record<string, unknown> {
  id: string;
  scripts: Array<Record<string, unknown> & { key: string }>;
  templates: Array<Record<string, unknown> & { key: string }>;
  llms: Array<Record<string, unknown> & { key: string }>;
}

export interface EngineResearchBuild {
  shape: typeof ENGINE_BUILD_SHAPE;
  /** Set on a build re-keyed at read from a copy stored by the per-population build (served until the first Engine build lands). */
  convertedFromStoredCopy?: true;
  view: ResearchView | null;
  computedAt: string;
  costBasis: "user" | "actual";
  /** The file by Engine (`engineFileOf`), served with its freshness. */
  file: Record<string, unknown> & { engines: ResearchEngineEntry[] };
  /** The catalogue by Engine (`engineCatalogOf`), before its live overlays; null = the copy held none. */
  catalog: { engines: Array<Omit<ResearchEngineEntry, "measures"> & { measures: EngineCatalogMeasure[] }>; notCarried: NotCarried[] } | null;
  /** The Performance tab's history per Engine measure; the scripts are read live. Null = the copy held none. */
  performance: EngineHistoryEntry[] | null;
  /** Template text by template id (`/internal/research/templates`). */
  texts: Record<string, string> | null;
  /** The billed file's conclusion and measured studies (`/internal/research/conclusions`, `/studies`); null on the vendor basis. */
  conclusions: ResearchConclusionsBody | null;
  measuredStudies: ResearchStudiesBody | null;
  historySources: HistorySource[];
}

/** The per-population build `computeResearch` returns (its sources keyed `sourceId`). */
export interface PopulationBuild {
  file: ResearchFile;
  catalog: Readonly<Record<string, { workflows: ReadonlyArray<{ key: string }>; templates: ReadonlyArray<{ key: string }>; models: ReadonlyArray<{ key: string }> }>> | null;
  texts: Record<string, string> | null;
  performance?: Readonly<Record<string, { rows: ReadonlyArray<unknown>; totals: unknown; series: unknown }>> | null;
}

interface HistoryRowLike {
  workflow?: { key?: string };
  outcomes?: { value?: number };
  spentUsd?: { value?: number };
}

/** PURE. The stored Engine build of one per-population build, every population placed on its Engine measure once. */
export function engineResearchBuildOf(
  build: PopulationBuild,
  sources: ReadonlyArray<EngineSource & { channel: string; leg: string }>,
  stepName: (key: string) => string,
): EngineResearchBuild {
  const { file } = build;
  const billed = file.costBasis === "user";
  const perf = build.performance ?? null;
  const historySources: HistorySource[] = sources.map((s) => {
    const workflowRows: HistorySource["workflowRows"] = {};
    for (const r of (perf?.[s.sourceId]?.rows ?? []) as HistoryRowLike[]) {
      const key = r.workflow?.key;
      if (!key) continue;
      (workflowRows[key] ??= []).push({ outcomes: r.outcomes?.value ?? 0, spentUsd: r.spentUsd?.value ?? 0 });
    }
    return { measureId: `${s.engine}/${s.startsFrom ?? "start"}/${s.counts}`, featureSlug: s.channel, legKey: s.leg, workflowRows };
  });
  return {
    shape: ENGINE_BUILD_SHAPE,
    view: file.view ?? null,
    computedAt: file.computedAt,
    costBasis: file.costBasis,
    file: engineFileOf(file as never, sources, stepName) as EngineResearchBuild["file"],
    catalog: build.catalog ? (engineCatalogOf(build.catalog, sources, stepName) as EngineResearchBuild["catalog"]) : null,
    performance: perf ? engineHistoryOf(perf, sources, stepName) : null,
    texts: build.texts,
    conclusions: billed ? researchConclusions(file) : null,
    measuredStudies: billed ? researchMeasuredStudies(file) : null,
    historySources,
  };
}
