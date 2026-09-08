/**
 * THE MEDIAN RETURN ON SPEND OUR CLIENTS GET — the fleet figure, over the brands that actually spent.
 *
 * A public competitor-comparison page closes on a band of live figures. Two of them were already
 * answerable (how many people we reached for how many companies, and the median cost of a hot lead);
 * the third — what a dollar our clients put through the channel comes back as — was not answerable
 * anywhere. The read designed to carry it (`/public/stats/revenue?groupBy=brand`) is a full engine pass
 * per (org, brand) and took minutes; this module is the arithmetic half of moving that answer onto a
 * read a landing can actually make.
 *
 * THE FIGURE IS A BRAND'S OWN REALIZED RETURN, NOT A PROJECTION, and the difference is not cosmetic.
 * `returnPerDollar` (`channel-funnel-economics.ts`, `/funnel-ranking`, `/audience-stats`) is a FORWARD
 * unit-economics projection: a brand's lifetime revenue divided by what a paying client is modelled to
 * cost through one funnel. It answers "what should a dollar buy here". This module answers a different
 * question — "what has a dollar ALREADY come back as" — and it is the ratio every client reads on their
 * own dashboard: `costEconomics.roiMultiple`, expected pipeline over committed spend. On the cold-email
 * channel in production the two are an order apart (the fleet projection sits under 1x while the
 * measured medians sit well above it), so they are NOT interchangeable and neither may be relabelled as
 * the other.
 *
 * THE UNIT IS THE BRAND, AND THE STATISTIC IS THE MEDIAN — never a mean. A handful of brands sit tens of
 * multiples above the rest, so an average describes nobody in the population; the median is the brand in
 * the middle. The quartiles ride beside it so a consumer can show the bulk rather than one scalar.
 *
 * THE SPEND FLOOR IS THE POPULATION, AND IT IS A PARAMETER OF THE QUESTION. A brand three days into its
 * first campaign has spent a few dollars and its ratio is whatever its first reply happened to do — real
 * arithmetic, no information. So the median is taken over brands past a floor of spend, and because the
 * floor is applied HERE (over stored ingredients) rather than frozen at write time, one snapshot answers
 * at any floor a caller names.
 *
 * UNMEASURABLE IS ITS OWN ANSWER. Below the minimum number of qualifying brands every figure is null
 * with a stated reason — never a 0, never a mean, and never the same median quietly taken over a wider
 * population to make a number appear. The consumer drops the stat and the figures beside it survive.
 */

/** One brand's stored ingredients — what it was CHARGED, and what that outreach is expected to return. */
export interface BrandReturnRow {
  brandId: string;
  /**
   * The brand's COMMITTED spend on this channel (actual + provisioned holds), in USD — the single
   * spend basis every money figure in this service rides (`costEconomics.committedCostUsd`).
   */
  committedSpendUsd: number;
  /**
   * The brand's expected pipeline in USD, or null when it has no usable economics. NULL IS "we could
   * not price this", never a 0: a 0 would say the brand's outreach is expected to return nothing, which
   * is a measurement nobody made.
   */
  expectedPipelineUsd: number | null;
}

/** Why a median could not be stated. Both are real answers; neither is an error. */
export type FleetReturnUnmeasuredReason =
  /** No warm has written a snapshot for this channel yet, so there is nothing to take a median over. */
  | "no_snapshot_yet"
  /** A snapshot exists, but too few brands are past the spend floor to state a median honestly. */
  | "not_enough_brands";

export interface FleetReturnOnSpend {
  /** True only when a median is stated. False ⇒ every figure below is null and `reason` says why. */
  measured: boolean;
  /** Present exactly when `measured` is false. */
  reason: FleetReturnUnmeasuredReason | null;
  /** The spend floor the population was restricted to (USD), echoed so a consumer can state it. */
  minSpendUsd: number;
  /** How many brands the median was taken over — ALWAYS present, including when it is too few. */
  brandCount: number;
  /** The middle brand's return per dollar of spend (expected pipeline ÷ committed spend). */
  medianReturnPerDollar: number | null;
  /** 25th percentile — the lower edge of the bulk. */
  p25ReturnPerDollar: number | null;
  /** 75th percentile — the upper edge of the bulk. */
  p75ReturnPerDollar: number | null;
  /** The weakest qualifying brand's return. */
  minReturnPerDollar: number | null;
  /** The strongest qualifying brand's return. */
  maxReturnPerDollar: number | null;
}

/**
 * Fewer than this many qualifying brands cannot carry a fleet claim: the "median" would be one or two
 * customers, and on a public page it would also come close to naming an individual brand's economics.
 * The consumer states its own bar too — `brandCount` is on the wire for exactly that — but a read that
 * would have to answer with two brands answers `not_enough_brands` instead.
 */
export const MIN_RETURN_BRANDS = 5;

/** The floor a caller gets when it names none: below $100 of spend a brand's ratio carries no signal. */
export const DEFAULT_MIN_SPEND_USD = 100;

/** Linear-interpolated quantile of a NON-EMPTY ascending-sorted array (q in [0,1]). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The fleet median return on spend over `rows`, restricted to brands that spent at least
 * `minSpendUsd`.
 *
 * A brand qualifies when it has spent at or above the floor AND its pipeline is priced. A brand whose
 * pipeline is null contributes NO data point — it is not a 0, and folding it in as one would drag the
 * median toward a number nobody measured.
 *
 * `snapshotMissing` distinguishes the two ways an empty answer happens: no warm has run yet (nothing
 * to say) versus a real snapshot whose qualifying population is too thin (something to say, and a
 * different thing).
 */
export function buildFleetReturnOnSpend(
  rows: readonly BrandReturnRow[] | null,
  minSpendUsd: number,
  minBrands: number = MIN_RETURN_BRANDS,
): FleetReturnOnSpend {
  const empty = (reason: FleetReturnUnmeasuredReason, brandCount: number): FleetReturnOnSpend => ({
    measured: false,
    reason,
    minSpendUsd,
    brandCount,
    medianReturnPerDollar: null,
    p25ReturnPerDollar: null,
    p75ReturnPerDollar: null,
    minReturnPerDollar: null,
    maxReturnPerDollar: null,
  });

  if (rows === null) return empty("no_snapshot_yet", 0);

  const values: number[] = [];
  for (const row of rows) {
    if (!(row.committedSpendUsd >= minSpendUsd) || row.committedSpendUsd <= 0) continue;
    if (row.expectedPipelineUsd === null) continue;
    values.push(row.expectedPipelineUsd / row.committedSpendUsd);
  }

  if (values.length < minBrands) return empty("not_enough_brands", values.length);

  const sorted = [...values].sort((a, b) => a - b);
  return {
    measured: true,
    reason: null,
    minSpendUsd,
    brandCount: sorted.length,
    medianReturnPerDollar: quantile(sorted, 0.5),
    p25ReturnPerDollar: quantile(sorted, 0.25),
    p75ReturnPerDollar: quantile(sorted, 0.75),
    minReturnPerDollar: sorted[0],
    maxReturnPerDollar: sorted[sorted.length - 1],
  };
}

/**
 * Parse the `?minSpendUsd=` query parameter. Absent / empty → the default floor. Returns null for
 * anything that is not a finite number ≥ 0, so the caller can 400 — NO silent coercion, and no
 * quiet fall back to the default on a value the caller clearly meant.
 */
export function parseMinSpendUsd(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MIN_SPEND_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
