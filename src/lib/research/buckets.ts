/**
 * PER-SLUG EVIDENCE → THE BARS OF A STUDY (LIVE-RESEARCH-1018). Pure.
 *
 * The IO half reads, per workflow VERSION (slug) on one leg, the byte-same evidence the leg workflow ranking rolls up to
 * dynasties (`fetchFleetLegSlugEvidence` in `routes/public.ts`): flash (everything to date) and mature (runs started
 * before the leg's cutoff, every outcome their leads produced since), plus that evidence dated by month and split by
 * client (org) x month. A bucket (a dynasty, a model, a template, a side of a split) POOLS its slugs, then takes the
 * ranking's rule: read MATURE once its pooled mature outcomes reach the leg's bar, else FLASH and Learning.
 *
 * The dated halves come from finer reads than the totals (spend per run month, persons per serve month), so each is
 * SCALED to its total: the month bars and the strata then add up to the bar exactly, and their proportions are the
 * finer read's. A total with no dated evidence behind it serves no month curve and no strata (never invented).
 */
import { isMatureCount } from "../maturity.js";
import type { StratumCounts } from "./verdict.js";
import type { BucketFigures, BucketMonth, ResearchBucket } from "./studies.js";
import type { ResearchView } from "./types.js";

/** One half (flash or mature) of a slug's evidence. */
export interface SlugHalf {
  figures: BucketFigures;
  /** `YYYY-MM` → figures; unscaled (the finer read). */
  months: Record<string, BucketFigures>;
  /** `<org>|YYYY-MM` → figures; unscaled. */
  strata: Record<string, BucketFigures>;
}

export interface SlugCell {
  slug: string;
  flash: SlugHalf;
  /** Null when the mature cut could not be made. */
  mature: SlugHalf | null;
}

const ZERO = (): BucketFigures => ({ spentUsd: 0, contacted: 0, outcomes: 0 });

function addInto(into: BucketFigures, f: BucketFigures): void {
  into.spentUsd += f.spentUsd;
  into.contacted += f.contacted;
  into.outcomes += f.outcomes;
}

/** PURE. Pool several halves (several slugs of one bucket). */
export function poolHalves(halves: readonly SlugHalf[]): SlugHalf {
  const figures = ZERO();
  const months: Record<string, BucketFigures> = {};
  const strata: Record<string, BucketFigures> = {};
  for (const h of halves) {
    addInto(figures, h.figures);
    for (const [k, f] of Object.entries(h.months)) addInto((months[k] ??= ZERO()), f);
    for (const [k, f] of Object.entries(h.strata)) addInto((strata[k] ??= ZERO()), f);
  }
  return { figures, months, strata };
}

/** Scale each component of the dated parts so they sum to `total` (a part with no dated evidence stays zero). */
function scaled(parts: Record<string, BucketFigures>, total: BucketFigures): Record<string, BucketFigures> {
  const sum = ZERO();
  for (const f of Object.values(parts)) addInto(sum, f);
  const k = {
    spentUsd: sum.spentUsd > 0 ? total.spentUsd / sum.spentUsd : 0,
    contacted: sum.contacted > 0 ? total.contacted / sum.contacted : 0,
    outcomes: sum.outcomes > 0 ? total.outcomes / sum.outcomes : 0,
  };
  const out: Record<string, BucketFigures> = {};
  for (const [key, f] of Object.entries(parts)) {
    out[key] = { spentUsd: f.spentUsd * k.spentUsd, contacted: f.contacted * k.contacted, outcomes: f.outcomes * k.outcomes };
  }
  return out;
}

/** The dated parts carry the total exactly (no scaling needed and no part invented)? Counts may be scaled; we check the outcomes. */
function datedCovers(parts: Record<string, BucketFigures>, total: BucketFigures): boolean {
  const sum = ZERO();
  for (const f of Object.values(parts)) addInto(sum, f);
  // Every non-zero total component needs some dated evidence to be spread on.
  return (total.spentUsd <= 0 || sum.spentUsd > 0) && (total.contacted <= 0 || sum.contacted > 0) && (total.outcomes <= 0 || sum.outcomes > 0);
}

/**
 * PURE. One bucket from its slugs. `override` = the figures another surface already serves for this bucket (the leg
 * workflow ranking's row for a dynasty): the bar states THEM, the dated parts are scaled onto them.
 */
export function bucketOf(input: {
  key: string;
  label: string;
  legKey: string;
  cells: readonly SlugCell[];
  override?: { basis: "mature" | "flash"; figures: BucketFigures; learning: boolean };
  /**
   * Read on this half whatever its own count says (a template VERSION is read on its dynasty's basis, so the versions'
   * figures add up to the dynasty's exactly). `mature` falls to flash when the mature cut could not be made.
   */
  forceBasis?: "mature" | "flash";
  /**
   * The page's view (MATURITY-VIEW-1023): every figure on ONE half, whatever the bucket's own count says (`mature` falls
   * to flash only when the mature cut could not be made). Wins over `forceBasis` and over the override's basis; the
   * override's figures are then those of the view's half (the caller passes them). `learning` keeps the maturity rule.
   */
  view?: ResearchView;
}): ResearchBucket {
  const flash = poolHalves(input.cells.map((c) => c.flash));
  const matureCut = input.cells.every((c) => c.mature !== null);
  const mature = matureCut ? poolHalves(input.cells.map((c) => c.mature!)) : null;
  const ruleMature = isMatureCount(mature ? mature.figures.outcomes : null, input.legKey) === true;
  const isMature = input.view
    ? input.view === "mature" && mature !== null
    : input.override
      ? input.override.basis === "mature"
      : input.forceBasis
        ? input.forceBasis === "mature" && mature !== null
        : ruleMature;
  const half = isMature && mature ? mature : flash;
  const figures = input.override ? input.override.figures : half.figures;
  const months = datedCovers(half.months, figures) ? scaled(half.months, figures) : null;
  const strata = datedCovers(half.strata, figures) ? scaled(half.strata, figures) : null;
  return {
    key: input.key,
    label: input.label,
    basis: isMature ? "mature" : "flash",
    figures,
    learning: input.override ? input.override.learning : input.view ? !ruleMature : !isMature,
    months: months
      ? Object.entries(months)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([month, f]): BucketMonth => ({ month, ...f }))
      : null,
    strata: strata
      ? Object.fromEntries(Object.entries(strata).map(([k, f]): [string, StratumCounts] => [k, { exposure: f.contacted, outcomes: f.outcomes, spend: f.spentUsd }]))
      : null,
  };
}

/** PURE. Group slug cells by a key function; a slug the function maps to null is left out (returned apart). */
export function groupCells(cells: readonly SlugCell[], keyOf: (slug: string) => string | null): { groups: Map<string, SlugCell[]>; leftOut: SlugCell[] } {
  const groups = new Map<string, SlugCell[]>();
  const leftOut: SlugCell[] = [];
  for (const c of cells) {
    const k = keyOf(c.slug);
    if (k === null) {
      leftOut.push(c);
      continue;
    }
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  return { groups, leftOut };
}
