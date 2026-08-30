/**
 * AN ARROW IS THE UNIT PERFORMANCE IS MEASURED IN, AND IT CARRIES ONE IDENTIFIER OF ITS OWN.
 *
 * A sales funnel is a chain of steps; the thing somebody actually BUYS is one of its ARROWS — the leg
 * that takes a lead sitting at one step and moves it to the next. The fleet is removing the sales
 * funnel from a campaign's identity for exactly that reason: one arrow belongs to SEVERAL funnels at
 * once (a booked meeting becomes an attended meeting in both meeting funnels), so forcing a campaign
 * to name one funnel produced either duplicate campaigns contacting the same people, or a ranking that
 * quietly ignored the funnel it was told to work.
 *
 * So a funnel stops being an exclusive partition of the work and becomes a WAY OF READING the arrows.
 * Two consequences, and both are load-bearing here:
 *
 *  1. **A CALLER NAMES ONE ARROW WITH ONE VALUE.** `arrowKey` is minted and owned by this service and
 *     is a PUBLISHED CONTRACT — the rest of the fleet keys campaigns and budgets on it. Nobody should
 *     ever have to carry a PAIR of steps to name an arrow, and nobody should ever SPLIT the identifier
 *     back into its parts: the two steps ride BESIDE it as data (`fromStep` / `toStep`), so a consumer
 *     that wants them READS them. Parsing the string is how a second, drifting vocabulary starts.
 *  2. **AN ENTRY ARROW IS AN ORDINARY ARROW.** The arrow that STARTS a funnel has no step before it
 *     (`fromStep: null` — the lead was not on the funnel at all until this arrow produced it), and it
 *     still carries a plain identifier like every other. It is the special case in the DATA, never in
 *     the vocabulary: a caller that had to spell an entry arrow differently is a caller with a branch.
 *
 * ── THE CATALOGUE IS DERIVED FROM THE FUNNELS, NEVER A SECOND LIST ────────────────────────────────
 *
 * Every arrow here falls out of `funnelLegs` over the deployed funnel catalogue, so an arrow cannot
 * exist that no funnel has, a funnel cannot gain a leg this module does not know, and the funnels an
 * arrow belongs to are read off the same walk rather than maintained beside it. A hand-written arrow
 * table would drift from the funnels the day brand-service changes one.
 *
 * ── FUNNEL FIGURES ARE COMPOSED FROM ARROWS, AND ARROWS DO NOT PARTITION ──────────────────────────
 *
 * Because an arrow belongs to several funnels, two funnels' figures legitimately OVERLAP: the same
 * attended meeting is on both meeting funnels. Their figures therefore MUST NOT be summed — there is
 * no surface here that sums them, and adding one would double-count the shared arrows. A funnel reads
 * its arrows (`arrowKeysOfFunnel`, and the per-rung `arrowKey` on `funnelSteps`); it is never measured
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
 * MINT the canonical identifier of one arrow.
 *
 * The spelling is `<from>_to_<to>`, with `start` standing in for "from nothing" — `start_to_conversation`
 * is as ordinary an identifier as `meeting_booked_to_meeting_attended`. It is READABLE on purpose (a
 * staff member reads a campaign row without a lookup) and it is still an OPAQUE key: a consumer joins
 * it against this catalogue, never splits it. Nothing outside this module composes an arrow key.
 */
export function arrowKeyFor(transition: ChannelStepTransition): string {
  return `${transition.from ?? "start"}_to_${transition.to}`;
}

/** One arrow, with everything a consumer needs to render or reason about it without the catalogue. */
export interface FunnelArrowDef {
  /** The single canonical identifier. Published contract; the fleet keys campaigns and budgets on it. */
  arrowKey: string;
  /** The step a lead is taken OUT of. `null` is "from nothing" — this arrow starts a funnel. */
  fromStep: ChannelStepDef | null;
  /** The step a lead is moved TO. */
  toStep: ChannelStepDef;
  /**
   * EVERY declared sales funnel this arrow is a leg of, in the catalogue's canonical order. Usually
   * several — which is the whole reason a campaign can no longer be identified by one of them.
   */
  funnelKeys: SalesFunnelKey[];
}

const buildCatalogue = (): FunnelArrowDef[] => {
  const byKey = new Map<string, FunnelArrowDef>();
  for (const funnelKey of SALES_FUNNEL_KEYS) {
    for (const leg of funnelLegs(funnelKey)) {
      const arrowKey = arrowKeyFor(leg);
      const existing = byKey.get(arrowKey);
      if (existing) {
        if (!existing.funnelKeys.includes(funnelKey)) existing.funnelKeys.push(funnelKey);
        continue;
      }
      byKey.set(arrowKey, {
        arrowKey,
        fromStep: leg.from == null ? null : { ...CHANNEL_STEPS[leg.from] },
        toStep: { ...CHANNEL_STEPS[leg.to] },
        funnelKeys: [funnelKey],
      });
    }
  }
  return [...byKey.values()];
};

/** Every arrow of every declared funnel, deduped, derived from the funnels themselves. */
export const FUNNEL_ARROWS: FunnelArrowDef[] = buildCatalogue();

const ARROWS_BY_KEY: Map<string, FunnelArrowDef> = new Map(FUNNEL_ARROWS.map((a) => [a.arrowKey, a]));

/** Every arrow key, in catalogue order — the published vocabulary. */
export const FUNNEL_ARROW_KEYS: string[] = FUNNEL_ARROWS.map((a) => a.arrowKey);

/**
 * Resolve a caller's spelling to a known arrow, tolerating case and separator variance the same way
 * every other vocabulary here does. `null` for a word naming no arrow — every caller FAILS LOUD on
 * that rather than guessing one, because guessing would price an arrow the caller never asked for.
 *
 * It is a LOOKUP, never a parse: an unknown `a_to_b` that happens to be well-formed is still unknown.
 */
export function matchFunnelArrowKey(raw: string): string | null {
  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ARROWS_BY_KEY.get(normalised)?.arrowKey ?? null;
}

/** The arrow itself, or null when nothing names it. */
export function funnelArrow(arrowKey: string): FunnelArrowDef | null {
  return ARROWS_BY_KEY.get(arrowKey) ?? null;
}

/**
 * The declared funnels this arrow is a leg of. An ENTRY arrow feeds every one of them AT ONCE —
 * nobody can buy traffic that only travels down one funnel — which is why an arrow yields ONE answer
 * however many funnels contain it.
 */
export function funnelsContainingArrow(arrowKey: string): SalesFunnelKey[] {
  return [...(ARROWS_BY_KEY.get(arrowKey)?.funnelKeys ?? [])];
}

/** One funnel, read as the ordered list of arrow keys it is composed of. */
export function arrowKeysOfFunnel(funnelKey: SalesFunnelKey): string[] {
  return funnelLegs(funnelKey).map(arrowKeyFor);
}

/** The arrow key of the leg between two steps — used where a caller already holds the pair. */
export function arrowKeyBetween(from: ChannelStepKey | null, to: ChannelStepKey): string {
  return arrowKeyFor({ from, to });
}
