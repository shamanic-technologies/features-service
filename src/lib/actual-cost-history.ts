/**
 * WHAT A SCOPE REALLY COST US — the return-on-spend curve with its spend leg read at VENDOR cost,
 * before our markup, instead of at the price the client is billed.
 *
 * STAFF ONLY, AND THAT IS THE WHOLE DESIGN CONSTRAINT. The vendor cost is our margin in disguise:
 * billed ÷ vendor IS the markup. So this basis is never a parameter of a customer read. It is served
 * on its own path (`GET /internal/features/:slug/revenue/actual-cost`), and the api-service gateway
 * mounts that path behind its staff gate — the customer `/features/:slug/revenue` read cannot be
 * made to answer on this basis whatever it is sent (its gateway forward is transparent, so a query
 * parameter there would have been one typed URL away from any org user). Guarded in
 * `routes/actual-cost-history.test.ts`.
 *
 * ONE CURVE, TWO BASES, ONE COMPUTE. The value leg (pipeline) is the engine's, byte for byte the one
 * `/revenue`'s `roiHistory` draws; only the spend leg changes source. It is produced by the SAME
 * `computeFeatureRevenue` pass, with the dated-spend READER swapped (`DatedSpendReader`), so the
 * mature-cohort subtraction, the workflow narrowing and the campaign family all apply to the vendor
 * spend exactly as they apply to the billed one. Nothing is re-derived a second way.
 *
 * THE VENDOR COST COMES FROM THE SERVICES THAT RECORD IT, NEVER FROM A DIVISION HERE. costs-service
 * states what each price version really cost us (the markup changed over time, some vendors add VAT,
 * pass-through lines carry no markup at all) and runs-service applies that to its own cost rows. A
 * `billed / 5` in this service would be wrong on every row written under a different markup.
 *
 * AN UNPRICED ROW IS STATED, NEVER BORROWED. When part of a day's billed spend has no known vendor
 * cost, the cumulative vendor spend from that day on is unknown — so every point from that day on
 * carries `cumulativeSpendUsd: null` and `roiMultiple: null`, and the body names the billed amount it
 * could not price and the day it starts. The billed figure is never substituted: a curve reading
 * "actual" over billed money would show a margin of zero where we simply do not know.
 */

import type { RoiHistory } from "./roi-history.js";
import type { CampaignFilter } from "./campaign-scope.js";
import type { FeatureScope } from "./feature-scope.js";
import type { Pricing } from "./pricing.js";

/**
 * The dated-spend source `computeFeatureRevenue` draws the return curve's spend leg from. Default:
 * the billed committed spend (`fetchBrandCommittedSpendByDay`). Same signature, so a vendor-basis
 * reader drops in without the compute knowing which basis it is drawing.
 *
 * @returns Map<YYYY-MM-DD, spend in USD that day>. An absent day is zero spend.
 */
export type DatedSpendReader = (
  brandId: string,
  campaignScope: CampaignFilter,
  featureScope: FeatureScope,
  headers: { orgId: string },
  pricing: Pricing,
  workflowDynastySlug?: string,
  startedAfter?: string,
) => Promise<Map<string, number>>;

/** One day of a scope's dated spend on the VENDOR basis. */
export interface VendorSpendDay {
  /** Vendor cost of the rows whose vendor cost is known, in USD. */
  vendorUsd: number;
  /** BILLED spend of the rows whose vendor cost is NOT known, in USD. 0 when every row is priced. */
  unpricedBilledUsd: number;
}

/** What a vendor-basis read collected across every dated-spend read of one compute. */
export interface VendorSpendLedger {
  /** The reader to hand `computeFeatureRevenue`. */
  reader: DatedSpendReader;
  /** Billed USD with no known vendor cost, per UTC day, summed over every read the compute made. */
  unpricedByDay(): Map<string, number>;
}

/**
 * Wrap a vendor-basis fetcher into a {@link DatedSpendReader} that also remembers, per day, how much
 * billed spend it could not price — so the curve can say where it stops being measurable.
 */
export function vendorSpendLedger(
  fetchVendor: (...args: Parameters<DatedSpendReader>) => Promise<Map<string, VendorSpendDay>>,
): VendorSpendLedger {
  // The compute reads the scope's WHOLE dated spend once, and — when some campaigns are still
  // maturing — those campaigns' spend from the cutoff on (`startedAfter`), which it SUBTRACTS from the
  // curve's spend leg. The unpriced share follows the same arithmetic: what is unknown on the curve is
  // the whole read's unpriced spend less the maturing read's on the days it covers. Summing the two
  // would count a maturing row twice; ignoring the subtraction would null a curve over spend it
  // does not even contain.
  const whole = new Map<string, number>();
  const subtracted = new Map<string, number>();
  return {
    reader: async (...args) => {
      const startedAfter = args[6];
      const days = await fetchVendor(...args);
      const out = new Map<string, number>();
      const into = startedAfter ? subtracted : whole;
      for (const [day, { vendorUsd, unpricedBilledUsd }] of days) {
        out.set(day, vendorUsd);
        if (unpricedBilledUsd > 0) into.set(day, (into.get(day) ?? 0) + unpricedBilledUsd);
      }
      return out;
    },
    unpricedByDay: () => {
      const out = new Map<string, number>();
      for (const [day, usd] of whole) {
        const rest = usd - (subtracted.get(day) ?? 0);
        if (rest > 1e-9) out.set(day, rest);
      }
      return out;
    },
  };
}

/** One UTC day on the actual-cost curve. Both legs cumulative since inception, like `roiHistory`. */
export interface ActualCostHistoryPoint {
  date: string;
  /**
   * Every dollar the scope REALLY cost us (vendor cost, before our markup) up to and including this
   * day. NULL from the first day part of the spend has no known vendor cost — never the billed figure.
   */
  cumulativeSpendUsd: number | null;
  /** The same dated pipeline `/revenue`'s `roiHistory` carries for this day. */
  cumulativePipelineUsd: number;
  /** cumulativePipelineUsd / cumulativeSpendUsd. NULL when nothing was spent yet or the spend is unknown. */
  roiMultiple: number | null;
}

export interface ActualCostHistory {
  daily: ActualCostHistoryPoint[];
  datedPipelineUsd: number;
  undatedPipelineUsd: number;
  /** Billed USD the curve could not price at vendor cost. 0 when every row was priced. */
  unpricedBilledCostUsd: number;
  /** First UTC day with unpriced spend — every point from it on reads a null spend. Null when none. */
  unpricedFromDate: string | null;
}

/**
 * Turn the curve `computeFeatureRevenue` built from the vendor reader into the actual-cost curve:
 * identical points, except that the spend and the return go NULL from the first day with spend we
 * could not price. PURE.
 */
export function buildActualCostHistory(
  vendorCurve: RoiHistory,
  unpricedByDay: Map<string, number>,
): ActualCostHistory {
  const unpricedDays = [...unpricedByDay.entries()].filter(([, usd]) => usd > 0).map(([d]) => d).sort();
  const unpricedFromDate = unpricedDays[0] ?? null;
  let unpricedBilledCostUsd = 0;
  for (const day of unpricedDays) unpricedBilledCostUsd += unpricedByDay.get(day) ?? 0;

  const daily = vendorCurve.daily.map((p) => {
    const unknown = unpricedFromDate != null && p.date >= unpricedFromDate;
    return {
      date: p.date,
      cumulativeSpendUsd: unknown ? null : p.cumulativeSpendUsd,
      cumulativePipelineUsd: p.cumulativePipelineUsd,
      roiMultiple: unknown ? null : p.roiMultiple,
    };
  });

  return {
    daily,
    datedPipelineUsd: vendorCurve.datedPipelineUsd,
    undatedPipelineUsd: vendorCurve.undatedPipelineUsd,
    unpricedBilledCostUsd,
    unpricedFromDate,
  };
}
