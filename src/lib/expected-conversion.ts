/**
 * THE EXPECTED % CONVERSION of every row of the offer's sliced ladder (`pipeline.exclusiveLadder`), never empty
 * (owner 2026-10-11: "les taux de conversion, ça doit jamais être vide nulle part, quitte à poser une hypothèse").
 *
 * ADDITIVE beside `conversionFromRowAbove` (untouched): `expectedConversionFromRowAbove` is
 *   1. MEASURED: the row's own `conversionFromRowAbove.ratePct` when it has one;
 *   2. else the HYPOTHESIS for the share of the row that goes one step further: the brand's effective rate of
 *      the leg out of the row's step on the offer's priced paths (`/brands/:id/conversion-rates`, measured >
 *      stated > fleet median > industry default; the next step is the SHALLOWEST one those paths reach, else any
 *      catalogue leg out of the step); for
 *      the contacted row, the entry leg's fleet conversion (the best workflow's on the leg, `/public/stats/
 *      outcome-prices`), else a seeded cold-email benchmark (`DEFAULT_ENTRY_RATE_PCT`).
 * `basis` says which, in the words of `lib/expected-return.ts`. Null ONLY on Paid client (the last step: nothing
 * converts past it) and when the brand's rates could not be read (`unavailableReason`).
 */
import type { ChannelStepKey } from "./acquisition-channels.js";
import type { BrandEffectiveRates, EffectiveRateSource } from "./effective-conversion-rates.js";
import type { ExpectedBasis } from "./expected-return.js";
import { FUNNEL_LEGS } from "./funnel-legs.js";
import { LADDER_STEPS, type ConversionFromRowAbove } from "./offer-pipeline-explained.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

/**
 * The last rung for the contacted row: share of contacted people reaching the entry step on a cold email, used
 * only when the fleet has measured none. Conservative cold-email benchmarks: ~1% of contacted people reply
 * positively, ~2% click through to the website.
 */
export const DEFAULT_ENTRY_RATE_PCT: Readonly<Partial<Record<ChannelStepKey, number>>> = {
  conversation: 1,
  website_visit: 2,
};

/** The channel the contacted row's fleet rate is read on (every contacted person was emailed). */
const COLD_EMAIL_SLUG = "sales-cold-email-outreach";

export type ExpectedConversionUnavailableReason = "final_step" | "rates_unavailable" | "no_next_step";

export interface ExpectedConversion {
  ratePct: number | null;
  basis: ExpectedBasis | null;
  /** `measured` (the row's own), an effective-rate source (`manual`, `median`, `default`), `fleet_measured` or `default_entry`. */
  source: string | null;
  /** The step the rate leads to (the row above when measured, else the next step on the priced paths). */
  toStep: ChannelStepKey | null;
  /** The leg the hypothesis is read off. Null when measured. */
  legKey: string | null;
  unavailableReason: ExpectedConversionUnavailableReason | null;
}

const RATE_BASIS: Record<EffectiveRateSource, ExpectedBasis> = { measured: "measured", manual: "stated", median: "fleet", default: "default" };

const none = (reason: ExpectedConversionUnavailableReason): ExpectedConversion => ({
  ratePct: null,
  basis: null,
  source: null,
  toStep: null,
  legKey: null,
  unavailableReason: reason,
});

const depth = (step: string): number => {
  const i = LADDER_STEPS.indexOf(step as ChannelStepKey);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

/**
 * PURE: the legs out of `from` (null = the entry legs), the priced funnels' first, then every other catalogue leg
 * (a person can stand on a step the offer's priced paths do not walk, e.g. a reply on a purchase offer), each
 * group shallowest target first.
 */
function nextLegs(from: ChannelStepKey | null, pricedFunnelKeys: readonly SalesFunnelKey[]) {
  const priced = new Set(pricedFunnelKeys);
  const out = FUNNEL_LEGS.filter((l) => (from === null ? l.fromStep === null || l.fromStep.key === "lead_found" : l.fromStep?.key === from));
  const onPriced = (l: (typeof out)[number]) => priced.size === 0 || l.funnelKeys.some((f) => priced.has(f));
  return out.sort(
    (a, b) => Number(onPriced(b)) - Number(onPriced(a)) || depth(a.toStep.key) - depth(b.toStep.key) || a.legKey.localeCompare(b.legKey),
  );
}

export interface ExpectedConversionInputs {
  rates: BrandEffectiveRates | null;
  pricedFunnelKeys: readonly SalesFunnelKey[];
  /** `${legKey}|${featureSlug}` → the fleet's conversion on the leg (`fleetLegConversionRatesFromOutcomePrices`). */
  fleetConversions: ReadonlyMap<string, number>;
}

/** PURE: one step row's expected conversion. */
export function expectedStepConversion(step: ChannelStepKey, measured: ConversionFromRowAbove | null, input: ExpectedConversionInputs): ExpectedConversion {
  if (measured?.ratePct != null) {
    return { ratePct: measured.ratePct, basis: "measured", source: "measured", toStep: measured.rowAbove.key, legKey: null, unavailableReason: null };
  }
  if (step === "paid_client") return none("final_step");
  if (!input.rates) return none("rates_unavailable");
  for (const leg of nextLegs(step, input.pricedFunnelKeys)) {
    const r = input.rates.legs.find((x) => x.legKey === leg.legKey);
    if (r && r.effectiveRatePct !== null && r.source !== null) {
      return { ratePct: r.effectiveRatePct, basis: RATE_BASIS[r.source], source: r.source, toStep: leg.toStep.key, legKey: leg.legKey, unavailableReason: null };
    }
  }
  return none("no_next_step");
}

/** PURE: the contacted row's expected conversion (into `firstStep`, the shallowest displayed row, when there is one). */
export function expectedContactedConversion(
  measured: ConversionFromRowAbove | null,
  firstStep: ChannelStepKey | null,
  input: ExpectedConversionInputs,
): ExpectedConversion {
  if (measured?.ratePct != null) {
    return { ratePct: measured.ratePct, basis: "measured", source: "measured", toStep: measured.rowAbove.key, legKey: null, unavailableReason: null };
  }
  const entries = nextLegs(null, input.pricedFunnelKeys);
  const ordered = firstStep ? [...entries.filter((l) => l.toStep.key === firstStep), ...entries.filter((l) => l.toStep.key !== firstStep)] : entries;
  for (const leg of ordered) {
    const fleet = input.fleetConversions.get(`${leg.legKey}|${COLD_EMAIL_SLUG}`);
    if (fleet !== undefined) return { ratePct: fleet, basis: "fleet", source: "fleet_measured", toStep: leg.toStep.key, legKey: leg.legKey, unavailableReason: null };
  }
  for (const leg of ordered) {
    const d = DEFAULT_ENTRY_RATE_PCT[leg.toStep.key as ChannelStepKey];
    if (d !== undefined) return { ratePct: d, basis: "default", source: "default_entry", toStep: leg.toStep.key, legKey: leg.legKey, unavailableReason: null };
  }
  return none("no_next_step");
}

/** PURE: the sliced ladder with `expectedConversionFromRowAbove` on every row and the contacted row. */
export function withExpectedConversions<
  L extends {
    rows: Array<{ step: { key: ChannelStepKey }; conversionFromRowAbove: ConversionFromRowAbove | null; pricedPeople: number | null; people: { notOurs: { count: number } } | null }>;
    contacted: { conversionFromRowAbove: ConversionFromRowAbove | null };
  },
>(ladder: L, input: ExpectedConversionInputs): L {
  const displayed = ladder.rows.find((r) => r.people !== null && r.pricedPeople !== null && (r.pricedPeople > 0 || r.people.notOurs.count > 0));
  return {
    ...ladder,
    rows: ladder.rows.map((r) => ({ ...r, expectedConversionFromRowAbove: expectedStepConversion(r.step.key, r.conversionFromRowAbove, input) })),
    contacted: {
      ...ladder.contacted,
      expectedConversionFromRowAbove: expectedContactedConversion(ladder.contacted.conversionFromRowAbove, displayed?.step.key ?? null, input),
    },
  };
}
