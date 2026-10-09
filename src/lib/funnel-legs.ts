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
import { isOutboundChannel } from "./channel-types.js";

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
 * Every pre-merge spelling of a leg that touched a FORM step, resolved to its canonical key.
 *
 * `form_filled` and `lead_form_submitted` were two steps until 2026-09-18 and are now the single
 * `form_submitted`, so the three legs they sat on were minted under other names. Stored rows elsewhere
 * in the fleet key budgets and campaigns on a leg key, and a campaign that named one of these does not
 * stop existing because the vocabulary merged — so these are accepted FOREVER on the way IN, and NEVER
 * emitted. `FUNNEL_LEG_KEYS` publishes the canonical names alone.
 */
const LEGACY_FUNNEL_LEG_KEYS: Record<string, string> = {
  website_visit_to_form_filled: "website_visit_to_form_submitted",
  // ⚠️ `website_visit_to_paid_client` IS DELIBERATELY ABSENT, AND ITS ABSENCE WAS MEASURED.
  //
  // `sales_from_website` shipped on 2026-09-17 as visit -> paid client, minting that leg; the purchase
  // rung (2026-09-18) splits it into `website_visit_to_purchase` + `purchase_to_paid_client`, so the
  // old key names no leg any more. It gets no alias because there is no honest single target — the
  // work it described is now two legs, and picking either would silently re-key a budget or a campaign
  // onto half of what it bought. That is only safe because nothing references it: checked against prod
  // 2026-09-18, `billing_service.brand_funnel_daily_budgets` and `campaign_service.campaigns` carry
  // ZERO rows on it (the only leg keys in either are `start_to_website_visit`, `start_to_conversation`
  // and `conversation_to_meeting_booked`). If that ever stops being true the answer is a migration by
  // the service that owns the row, never a guess here.
  form_filled_to_paid_client: "form_submitted_to_paid_client",
  start_to_lead_form_submitted: "start_to_form_submitted",
  lead_form_submitted_to_paid_client: "form_submitted_to_paid_client",
};

/**
 * Resolve a caller's spelling to a known leg, tolerating case and separator variance the same way
 * every other vocabulary here does. `null` for a word naming no leg — every caller FAILS LOUD on
 * that rather than guessing one, because guessing would price a leg the caller never asked for.
 *
 * It is a LOOKUP, never a parse: an unknown `a_to_b` that happens to be well-formed is still unknown.
 */
export function matchFunnelLegKey(raw: string): string | null {
  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const direct = LEGS_BY_KEY.get(normalised);
  if (direct) return direct.legKey;
  const legacy = LEGACY_FUNNEL_LEG_KEYS[normalised] ?? STORED_SPELLING_OF_OUTBOUND_LEG_KEY[normalised];
  return legacy != null && LEGS_BY_KEY.has(legacy) ? legacy : null;
}

// ── THE OUTBOUND LEG RENAME (LOCKED, owner 2026-10-09; one identity shared by six codebases) ─────────
//
// Once "Lead found" is a normal step, an OUTBOUND channel (cold email, cold call, LinkedIn...) no longer
// moves a lead from nothing: a sourcing channel does (Start -> Lead found), and the outbound leg starts
// on the found lead. So, for the OUTBOUND channels ONLY (`OUTBOUND_CHANNEL_SLUGS`, `lib/channel-types.ts`):
//     start_to_conversation   ->  lead_found_to_conversation
//     start_to_website_visit  ->  lead_found_to_website_visit
// The same legacy keys on a NON-outbound channel (ads, SEO, organic, PR) are NOT renamed; sourcing keeps
// `start_to_lead_found`; every other leg key is unchanged.
//
// WAVE 1 (now): the two spellings are ONE identity on every input (a campaign row, a ticked leg, a
// combination key, an assignment write, `?leg=`), resolved to the spelling this fleet STORES and SERVES
// today, the legacy one. Nothing stored moves, nothing served moves. WAVE 2 migrates the stored rows and
// flips the served spelling; it is a data migration plus flipping the direction of this map, never a
// rename of names or history (combination names are keyed on the combination key, re-keyed in place).

/** One pair of the correspondence, as published on `/public/channels` `legKeyCorrespondence`. */
export interface LegKeyCorrespondence {
  /** The channel type the rename applies to — `outbound`, and only it. */
  channelType: "outbound";
  /** The key stored and served today (wave 1). */
  legacyLegKey: string;
  /** The LOCKED key wave 2 stores and serves. */
  legKey: string;
  fromStep: ChannelStepDef;
  toStep: ChannelStepDef;
}

export const OUTBOUND_LEG_KEY_CORRESPONDENCE: readonly LegKeyCorrespondence[] = (["conversation", "website_visit"] as const).map(
  (to) => ({
    channelType: "outbound" as const,
    legacyLegKey: legKeyFor({ from: null, to }),
    legKey: legKeyFor({ from: "lead_found", to }),
    fromStep: { ...CHANNEL_STEPS.lead_found },
    toStep: { ...CHANNEL_STEPS[to] },
  }),
);

/** new outbound spelling -> the spelling stored today. */
const STORED_SPELLING_OF_OUTBOUND_LEG_KEY: Record<string, string> = Object.fromEntries(
  OUTBOUND_LEG_KEY_CORRESPONDENCE.map((c) => [c.legKey, c.legacyLegKey]),
);

/** True when `raw` is a new (wave 2) outbound spelling. */
export function isOutboundLegKeySpelling(raw: string): boolean {
  return Object.hasOwn(STORED_SPELLING_OF_OUTBOUND_LEG_KEY, normaliseLegKey(raw));
}

const normaliseLegKey = (raw: string): string => raw.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Resolve a leg key a caller sends FOR ONE CHANNEL. Same as `matchFunnelLegKey`, except that the new
 * outbound spelling names no leg of a channel that is not outbound (a Google Ads campaign never performs
 * Lead found -> Website visit): null there, so the caller refuses it as an unknown leg.
 */
export function matchChannelLegKey(featureSlug: string | null | undefined, raw: string): string | null {
  if (isOutboundLegKeySpelling(raw) && !isOutboundChannel(featureSlug)) return null;
  return matchFunnelLegKey(raw);
}

/** A leg key as STORED today: a new outbound spelling resolved to its legacy twin, every other key
 *  returned VERBATIM (so every read of a legacy-spelled input stays byte-identical). */
export function storedLegKeyOf(raw: string): string {
  return isOutboundLegKeySpelling(raw) ? STORED_SPELLING_OF_OUTBOUND_LEG_KEY[normaliseLegKey(raw)] : raw;
}

/**
 * A combination key (`lib/offer-sales-paths.ts` `combinationKeyOf`: legs `+`-joined, a platform leg
 * `@<slug>`) as STORED today: each leg's key resolved through `storedLegKeyOf`, so a combination a
 * caller spells with the new outbound keys names the same row, name and selection as the legacy one.
 * This service minted the format, so reading it back is not splitting somebody else's identifier.
 */
export function storedCombinationKeyOf(raw: string): string {
  return raw
    .split("+")
    .map((part) => {
      const at = part.indexOf("@");
      if (at < 0) return storedLegKeyOf(part);
      const slug = part.slice(at + 1);
      const leg = part.slice(0, at);
      return `${isOutboundLegKeySpelling(leg) && !isOutboundChannel(slug) ? leg : storedLegKeyOf(leg)}@${slug}`;
    })
    .join("+");
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
