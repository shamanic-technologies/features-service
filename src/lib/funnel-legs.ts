/**
 * A LEG IS THE UNIT PERFORMANCE IS MEASURED IN, AND IT CARRIES ONE IDENTIFIER OF ITS OWN.
 *
 * A sales funnel is a chain of steps; the thing somebody actually BUYS is one of its LEGS — the leg
 * that takes a lead sitting at one step and moves it to the next. The fleet is removing the sales
 * funnel from a campaign's identity for exactly that reason: one leg belongs to SEVERAL funnels at
 * once (a booked meeting becomes an attended meeting in both meeting funnels), so forcing a campaign
 * to name one funnel produced either duplicate campaigns contacting the same people, or a ranking that
 * quietly ignored the funnel it was told to work.
 *
 * So a funnel stops being an exclusive partition of the work and becomes a WAY OF READING the legs.
 * Two consequences, and both are load-bearing here:
 *
 *  1. **A CALLER NAMES ONE LEG WITH ONE VALUE.** `legKey` is minted and owned by this service and
 *     is a PUBLISHED CONTRACT — the rest of the fleet keys campaigns and budgets on it. Nobody should
 *     ever have to carry a PAIR of steps to name a leg, and nobody should ever SPLIT the identifier
 *     back into its parts: the two steps ride BESIDE it as data (`fromStep` / `toStep`), so a consumer
 *     that wants them READS them. Parsing the string is how a second, drifting vocabulary starts.
 *  2. **AN ENTRY LEG IS AN ORDINARY LEG.** The leg that STARTS a funnel has no step before it
 *     (`fromStep: null` — the lead was not on the funnel at all until this leg produced it), and it
 *     still carries a plain identifier like every other. It is the special case in the DATA, never in
 *     the vocabulary: a caller that had to spell an entry leg differently is a caller with a branch.
 *
 * ── THE CATALOGUE IS DERIVED FROM THE FUNNELS, NEVER A SECOND LIST ────────────────────────────────
 *
 * Every leg here falls out of `funnelLegs` over the deployed funnel catalogue, so a leg cannot
 * exist that no funnel has, a funnel cannot gain a leg this module does not know, and the funnels an
 * leg belongs to are read off the same walk rather than maintained beside it. A hand-written leg
 * table would drift from the funnels the day brand-service changes one.
 *
 * ── FUNNEL FIGURES ARE COMPOSED FROM LEGS, AND LEGS DO NOT PARTITION ──────────────────────────
 *
 * Because a leg belongs to several funnels, two funnels' figures legitimately OVERLAP: the same
 * attended meeting is on both meeting funnels. Their figures therefore MUST NOT be summed — there is
 * no surface here that sums them, and adding one would double-count the shared legs. A funnel reads
 * its legs (`legKeysOfFunnel`, and the per-rung `legKey` on `funnelSteps`); it is never measured
 * as a thing beside them.
 */
import {
  CHANNEL_STEPS,
  funnelLegs,
  type ChannelStepDef,
  type ChannelStepKey,
  type ChannelStepTransition,
} from "./acquisition-channels.js";
import { SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";

/**
 * MINT the canonical identifier of one leg.
 *
 * The spelling is `<from>_to_<to>`, with `start` standing in for "from nothing" — `start_to_conversation`
 * is as ordinary an identifier as `meeting_booked_to_meeting_attended`. It is READABLE on purpose (a
 * staff member reads a campaign row without a lookup) and it is still an OPAQUE key: a consumer joins
 * it against this catalogue, never splits it. Nothing outside this module composes a leg key.
 */
export function legKeyFor(transition: ChannelStepTransition): string {
  return `${transition.from ?? "start"}_to_${transition.to}`;
}

/** One leg, with everything a consumer needs to render or reason about it without the catalogue. */
export interface FunnelLegDef {
  /** The single canonical identifier. Published contract; the fleet keys campaigns and budgets on it. */
  legKey: string;
  /** The step a lead is taken OUT of. `null` is "from nothing" — this leg starts a funnel. */
  fromStep: ChannelStepDef | null;
  /** The step a lead is moved TO. */
  toStep: ChannelStepDef;
  /**
   * EVERY declared sales funnel this leg is a leg of, in the catalogue's canonical order. Usually
   * several — which is the whole reason a campaign can no longer be identified by one of them.
   */
  funnelKeys: SalesFunnelKey[];
}

const buildCatalogue = (): FunnelLegDef[] => {
  const byKey = new Map<string, FunnelLegDef>();
  for (const funnelKey of SALES_FUNNEL_KEYS) {
    for (const leg of funnelLegs(funnelKey)) {
      const legKey = legKeyFor(leg);
      const existing = byKey.get(legKey);
      if (existing) {
        if (!existing.funnelKeys.includes(funnelKey)) existing.funnelKeys.push(funnelKey);
        continue;
      }
      byKey.set(legKey, {
        legKey,
        fromStep: leg.from == null ? null : { ...CHANNEL_STEPS[leg.from] },
        toStep: { ...CHANNEL_STEPS[leg.to] },
        funnelKeys: [funnelKey],
      });
    }
  }
  return [...byKey.values()];
};

/** Every leg of every declared funnel, deduped, derived from the funnels themselves. */
export const FUNNEL_LEGS: FunnelLegDef[] = buildCatalogue();

const LEGS_BY_KEY: Map<string, FunnelLegDef> = new Map(FUNNEL_LEGS.map((a) => [a.legKey, a]));

/** Every leg key, in catalogue order — the published vocabulary. */
export const FUNNEL_LEG_KEYS: string[] = FUNNEL_LEGS.map((a) => a.legKey);

/**
 * Resolve a caller's spelling to a known leg, tolerating case and separator variance the same way
 * every other vocabulary here does. `null` for a word naming no leg — every caller FAILS LOUD on
 * that rather than guessing one, because guessing would price a leg the caller never asked for.
 *
 * It is a LOOKUP, never a parse: an unknown `a_to_b` that happens to be well-formed is still unknown.
 */
export function matchFunnelLegKey(raw: string): string | null {
  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return LEGS_BY_KEY.get(normalised)?.legKey ?? null;
}

/** The leg itself, or null when nothing names it. */
export function funnelLeg(legKey: string): FunnelLegDef | null {
  return LEGS_BY_KEY.get(legKey) ?? null;
}

/**
 * The declared funnels this leg is a leg of. An ENTRY leg feeds every one of them AT ONCE —
 * nobody can buy traffic that only travels down one funnel — which is why a leg yields ONE answer
 * however many funnels contain it.
 */
export function funnelsContainingLeg(legKey: string): SalesFunnelKey[] {
  return [...(LEGS_BY_KEY.get(legKey)?.funnelKeys ?? [])];
}

/** One funnel, read as the ordered list of leg keys it is composed of. */
export function legKeysOfFunnel(funnelKey: SalesFunnelKey): string[] {
  return funnelLegs(funnelKey).map(legKeyFor);
}

/** The leg key of the leg between two steps — used where a caller already holds the pair. */
export function legKeyBetween(from: ChannelStepKey | null, to: ChannelStepKey): string {
  return legKeyFor({ from, to });
}
