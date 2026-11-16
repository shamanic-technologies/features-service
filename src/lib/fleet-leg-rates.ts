/**
 * THE FLEET'S MEASURED RATE IS A RUNG OF EVERY EXPECTED FIGURE (owner 2026-11-16, EXPECTED-FLEET-RATE-1116, « go with A »).
 *
 * Every expected figure (expected cost per outcome, expected ROI, expected % conversion, the catalogue funnel `expected`,
 * the sales paths) prices a leg on ONE order:
 *
 *   brand MEASURED  >  customer STATED  >  FLEET MEASURED  >  DEFAULT
 *
 * The fleet's measured rate is the conversion every client's runs measured on that (leg, channel), the one the outcome
 * prices build serves (`fleetLegConversionRatesFromOutcomePrices`, keyed `${stored legKey}|${channel slug}`). Before, it
 * was a rung of the contacted row and of a spend chart's entry leg only, so one page read two expected figures built on
 * two rates for the same step (prod 2026-11-16, campaign Wide Email: "% to Paid client" on the fleet's 0.10 % positive
 * reply rate beside "$ / Paid client" $1,140 and ROI 66x on the 1 % default).
 *
 * NOT the retired fleet MEDIAN of other clients' STATED rates (owner 2026-10-14): those were prefills nobody typed. This is
 * what our own runs measured. A brand's own measured or stated rate always wins over it.
 *
 * PURE.
 */
import { pipeLegKeyOf, storedLegKeyOf } from "./funnel-legs.js";
import { splitPlaySlug } from "./plays.js";

/** `${stored legKey}|${channel slug}` -> the fleet's measured conversion in percent (outcome prices). */
export type FleetLegRates = ReadonlyMap<string, number>;

export const NO_FLEET_LEG_RATES: FleetLegRates = new Map();

const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The fleet's measured conversion of `legKey` on `channelSlug` (a play suffix `~<strategy>` is the channel's own), or null.
 * With no channel named (a ladder row, a leg the customer's team works), the LOWEST rate any channel measured on the leg:
 * an assumption that never flatters.
 */
export function fleetLegRatePct(fleet: FleetLegRates, legKey: string, channelSlug: string | null): number | null {
  if (channelSlug) {
    const slug = splitPlaySlug(channelSlug).slug;
    const r = fleet.get(`${storedLegKeyOf(pipeLegKeyOf(slug, legKey))}|${slug}`);
    return usable(r) ? r : null;
  }
  const prefix = `${storedLegKeyOf(legKey)}|`;
  let lowest: number | null = null;
  for (const [k, r] of fleet) if (k.startsWith(prefix) && usable(r) && (lowest === null || r < lowest)) lowest = r;
  return lowest;
}

/** Which rung priced a leg, in the words of `lib/expected-return.ts` (`ExpectedBasis`). */
export type ExpectedRateRung = "measured" | "stated" | "fleet" | "default";

export interface ExpectedLegRate {
  ratePct: number;
  rung: ExpectedRateRung;
}

/**
 * PURE: THE ORDER. `own` = the brand's own rate when it is measured or stated (anything else, a default, is not its own);
 * then the fleet's measured rate; then the default. Null when no rung holds a usable rate.
 */
export function pickExpectedLegRate(
  own: { ratePct: number | null; rung: "measured" | "stated" } | null,
  fleetPct: number | null,
  defaultPct: number | null,
): ExpectedLegRate | null {
  // The brand's own conclusive 0 % stands (`zeroIsConclusive`): its caller reads it as a zero, never as "no rate".
  if (own && typeof own.ratePct === "number" && Number.isFinite(own.ratePct) && own.ratePct >= 0) return { ratePct: own.ratePct, rung: own.rung };
  if (usable(fleetPct)) return { ratePct: fleetPct, rung: "fleet" };
  if (usable(defaultPct)) return { ratePct: defaultPct, rung: "default" };
  return null;
}

/** The slice of a brand's resolved leg (`EffectiveArrowRate`) the order reads. */
export interface BrandLegRateLike {
  effectiveRatePct: number | null;
  source: "measured" | "manual" | "default" | null;
  defaultRatePct: number | null;
}

/**
 * PURE: one leg of a brand on THE ORDER: its own rate when measured or stated, else the fleet's measured rate of the leg
 * on `channelSlug` (null = no channel named, `fleetLegRatePct`), else its default. Null when the brand leg is unknown and
 * the fleet measured nothing.
 */
export function expectedBrandLegRate(
  brand: BrandLegRateLike | null,
  fleet: FleetLegRates,
  legKey: string,
  channelSlug: string | null,
): ExpectedLegRate | null {
  const own =
    brand && (brand.source === "measured" || brand.source === "manual")
      ? { ratePct: brand.effectiveRatePct, rung: brand.source === "measured" ? ("measured" as const) : ("stated" as const) }
      : null;
  // A leg resolved on its default keeps the very rate it resolved to; any other leg's seeded default is the last rung.
  const def = brand ? (brand.source === "default" ? brand.effectiveRatePct : brand.defaultRatePct) : null;
  return pickExpectedLegRate(own, fleetLegRatePct(fleet, legKey, channelSlug), def);
}
