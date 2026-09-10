/**
 * THE MEDIAN RETURN ON SPEND OUR CLIENTS GET THROUGH ONE SALES FUNNEL — per (acquisition channel ×
 * sales funnel), over the brands that actually spent on that channel selling that funnel.
 *
 * A customer looking at a funnel they have NOT declared yet asks one question: what has a dollar
 * through this funnel come back as for your other clients, and what did a paying client cost them.
 * Nothing answered it. The one per-pair figure that existed — `channel-funnel-economics.ts` — is a
 * FORWARD projection (a pooled fleet unit price × the MEAN declared rates × the MEAN declared lifetime
 * revenue), and every one of those means is dragged by whichever brand sits furthest from the rest: on
 * the conversation-to-meeting funnel it reads 0.7x while the per-brand medians sit near 2x, because one
 * brand at 0.02x carries the average. That projection stays where it is (other consumers read its
 * per-step prices); it is not the answer to this question and must never be relabelled as one.
 *
 * THE FIGURE IS THE ONE EVERY CLIENT ALREADY READS ON THEIR OWN DASHBOARD — `costEconomics.roiMultiple`
 * scoped to that funnel: expected pipeline over committed spend, where the pipeline starts each lead at
 * its most-advanced REALIZED step and projects the rest with the brand's OWN rates and LTR. It is the
 * byte-same statistic `GET /features/:slug/revenue?funnel=<key>` states for one brand, taken across
 * brands. So a fleet figure and any one client's own number are one statistic at two grains, and
 * neither is a pure projection. It is read on the **NET** pricing basis (what the brand actually paid
 * after its usage discount), which is what makes that identity hold: the client's own dashboard reads
 * net, so a gross figure here would be a statistic about money nobody was billed. A brand with no
 * discount is byte-unchanged. See `fleet-return-on-spend.ts`, whose header states the basis in full.
 *
 * THE UNIT IS THE BRAND AND THE STATISTIC IS THE MEDIAN, never a mean — the same doctrine as
 * `fleet-return-on-spend.ts`, whose header is the spec this module follows. An average over a
 * population with a few brands tens of multiples out describes nobody in it; the quartiles ride beside
 * the median so a consumer can show the bulk rather than one scalar.
 *
 * THE SPEND FLOOR IS THE POPULATION AND IT IS APPLIED HERE, over stored INGREDIENTS rather than frozen
 * at write time, so one snapshot answers at any floor a caller names without recomputing anything. A
 * brand three days into its first campaign has spent a few dollars and its ratio is whatever its first
 * reply happened to do — real arithmetic, no information.
 *
 * UNMEASURABLE IS ITS OWN ANSWER, per pair, and it is the common case here rather than the exception:
 * a pair is measured only when enough brands sell that funnel through that channel, and today most
 * pairs have one or two. Below the bar every figure is null with a stated reason — never a 0, never a
 * mean, and never the same median quietly taken over a wider population (a neighbouring funnel, the
 * whole channel) to make a number appear.
 */
import type { SalesFunnelKey } from "./sales-funnels.js";

/**
 * One brand's stored ingredients FOR ONE FUNNEL — what it was CHARGED on the channel, what the
 * outreach it bought is expected to return through THIS funnel, and how many paying clients that
 * pipeline is.
 *
 * The paying-client COUNT is stored rather than the finished cost per client, for the same reason the
 * spend and the pipeline are stored rather than the finished ratio: a count composes across the orgs
 * that claim one brand (spend ÷ Σ clients) where a ratio does not, and it keeps every served figure
 * derivable at read time from ingredients nobody has rounded.
 */
export interface BrandFunnelReturnRow {
  brandId: string;
  /** The funnel this row is scoped to — the brand DECLARED it; a funnel it does not sell has no row. */
  funnelKey: SalesFunnelKey;
  /**
   * The brand's COMMITTED spend on the channel (actual + provisioned holds), in USD — the single
   * spend basis every money figure in this service rides. It is the CHANNEL's spend, not a per-funnel
   * split, exactly as `/revenue?funnel=` states it: the funnel narrows which legs carry value, and a
   * dollar spent on the channel bought the outreach whichever funnel it later converted through.
   */
  committedSpendUsd: number;
  /**
   * Expected pipeline through THIS funnel, in USD, or null when the brand has no usable economics.
   * NULL is "we could not price this", never a 0 — a 0 would say the outreach is expected to return
   * nothing, which is a measurement nobody made, and it would drag the median toward it.
   */
  expectedPipelineUsd: number | null;
  /**
   * Expected PAYING CLIENTS that pipeline is (pipeline ÷ the brand's lifetime revenue per client), or
   * null when the brand states no lifetime revenue. Null again is "we could not price this".
   */
  expectedPaidClients: number | null;
}

/** Why a pair's median could not be stated. Both are real answers; neither is an error. */
export type FunnelReturnUnmeasuredReason =
  /** No warm has written a snapshot for this CHANNEL yet, so there is nothing to take a median over. */
  | "no_snapshot_yet"
  /** A snapshot exists; too few brands sell this funnel through this channel past the spend floor. */
  | "not_enough_brands";

export interface FunnelReturnOnSpend {
  /** True only when a median RETURN is stated. False ⇒ every return figure is null and `reason` says why. */
  measured: boolean;
  /** Present exactly when `measured` is false. */
  reason: FunnelReturnUnmeasuredReason | null;
  /** The spend floor the population was restricted to (USD), echoed so a consumer can state it. */
  minSpendUsd: number;
  /** How many brands the return median was taken over — ALWAYS present, including when it is too few. */
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
  /**
   * The middle brand's cost per PAYING CLIENT (its committed spend ÷ its expected paying clients).
   *
   * Stated on its OWN population and its OWN count, because it needs one ingredient the return does not
   * — the brand's lifetime revenue per client — so a brand can carry a return and no cost per client.
   * Folding those brands in as anything would be inventing a lifetime revenue nobody declared.
   */
  medianCostPerPaidClientUsd: number | null;
  /** How many brands the cost-per-paid-client median was taken over. Never inferred from `brandCount`. */
  costPerPaidClientBrandCount: number;
}

/**
 * Fewer than this many qualifying brands cannot carry a per-pair claim. The bar is lower than the
 * channel-wide one (`MIN_RETURN_BRANDS`, 5) because a pair is a strictly narrower population than the
 * channel it sits in — every brand is on exactly one or two of its channel's funnels — so holding the
 * pair to the channel's bar would answer "unmeasured" for every pair we have. Three is the smallest
 * population where the median is not simply one customer's own economics restated on a public page.
 */
export const MIN_FUNNEL_RETURN_BRANDS = 3;

/** Linear-interpolated quantile of a NON-EMPTY ascending-sorted array (q in [0,1]). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The middle value of a sorted array, linear-interpolated on an even length. */
function median(sorted: number[]): number {
  return quantile(sorted, 0.5);
}

/**
 * The median return on spend for ONE (channel × funnel) pair, over `rows` — the stored rows of that
 * CHANNEL's snapshot already narrowed to that funnel — restricted to brands past `minSpendUsd`.
 *
 * A brand qualifies for the RETURN when it spent at or above the floor and its pipeline is priced; it
 * qualifies for the COST PER PAID CLIENT when it additionally states a lifetime revenue. A brand
 * missing either contributes NO data point to that figure — it is not a 0, and folding it in as one
 * would drag a median toward a number nobody measured.
 *
 * `rows === null` is the channel having no snapshot at all, which is a DIFFERENT statement from a
 * snapshot whose qualifying population is too thin, and the two are told apart on the wire.
 */
export function buildFunnelReturnOnSpend(
  rows: readonly BrandFunnelReturnRow[] | null,
  minSpendUsd: number,
  minBrands: number = MIN_FUNNEL_RETURN_BRANDS,
): FunnelReturnOnSpend {
  const empty = (
    reason: FunnelReturnUnmeasuredReason,
    brandCount: number,
    costBrandCount: number,
  ): FunnelReturnOnSpend => ({
    measured: false,
    reason,
    minSpendUsd,
    brandCount,
    medianReturnPerDollar: null,
    p25ReturnPerDollar: null,
    p75ReturnPerDollar: null,
    minReturnPerDollar: null,
    maxReturnPerDollar: null,
    medianCostPerPaidClientUsd: null,
    costPerPaidClientBrandCount: costBrandCount,
  });

  if (rows === null) return empty("no_snapshot_yet", 0, 0);

  const returns: number[] = [];
  const costs: number[] = [];
  for (const row of rows) {
    if (!(row.committedSpendUsd >= minSpendUsd) || row.committedSpendUsd <= 0) continue;
    if (row.expectedPipelineUsd === null) continue;
    returns.push(row.expectedPipelineUsd / row.committedSpendUsd);
    if (row.expectedPaidClients !== null && row.expectedPaidClients > 0) {
      costs.push(row.committedSpendUsd / row.expectedPaidClients);
    }
  }

  if (returns.length < minBrands) return empty("not_enough_brands", returns.length, costs.length);

  const sorted = [...returns].sort((a, b) => a - b);
  const sortedCosts = [...costs].sort((a, b) => a - b);
  return {
    measured: true,
    reason: null,
    minSpendUsd,
    brandCount: sorted.length,
    medianReturnPerDollar: median(sorted),
    p25ReturnPerDollar: quantile(sorted, 0.25),
    p75ReturnPerDollar: quantile(sorted, 0.75),
    minReturnPerDollar: sorted[0],
    maxReturnPerDollar: sorted[sorted.length - 1],
    // Held to the SAME bar as the return: a median over two brands is one customer's economics on a
    // public page whichever figure it is. Null here beside a stated return is not a contradiction —
    // it says the brands that sell this funnel have not all told us what a client is worth to them.
    medianCostPerPaidClientUsd: sortedCosts.length >= minBrands ? median(sortedCosts) : null,
    costPerPaidClientBrandCount: sortedCosts.length,
  };
}
