/**
 * WHAT A READ IS PRICED ON, WITHOUT A DECLARED SALES FUNNEL (wave C1).
 *
 * The fleet retired the sales funnel as an identity: org > brand > offer > outcome > leg. A campaign is
 * (offer × LEG × channel), a brand states ONE conversion rate per leg, and an offer states its own
 * lifetime revenue (brand-service v0.81.8, `offer-economics`). Nothing here reads the funnels a brand
 * "declared" any more.
 *
 * Every pricing surface still walks the catalogue's funnels, because a funnel is simply a PATH through
 * legs — from a step, onward to a paid client — and the revenue engine prices each path with the
 * best-path (MAX) rule it has always used. What changed is which paths a read walks, and where their
 * numbers come from:
 *
 *  - WHICH PATHS — the READING FUNNELS. For each leg the scope's campaigns perform (the offer's
 *    campaigns, or a leg the caller names), the catalogue funnels containing that leg are the
 *    candidates — narrowed, for a leg acting on leads already at a step, to the funnels whose leg INTO
 *    that step the brand states or the scope performs (how its leads actually got there). At the step
 *    the leg lands on, a brand's leads go where the brand says they go: the
 *    candidates whose NEXT leg out of that step the brand STATED a rate for are kept. When the brand
 *    stated no leg out of that step, the ONE candidate whose onward path is worth most on the brand's
 *    effective rates is kept (best path, max) — never every candidate, because a path the brand never
 *    walks, priced on fleet medians, would otherwise out-bid the path it does walk. Only when no onward
 *    path can be priced at all is every candidate read (nothing to choose on, nothing guessed).
 *  - WHOSE NUMBERS — each leg of each reading funnel carries the brand's EFFECTIVE leg rate (measured >
 *    stated > fleet median, `effective-conversion-rates.ts`), and the funnel carries the OFFER's
 *    lifetime revenue.
 *
 * The result is shaped as the `DeclaredSalesFunnel[]` every pricing module already consumes, so the
 * downstream math (`declaredEconomics`, `statedLegRates`, the funnel ladders, the max across funnels)
 * is untouched. For an offer whose campaigns sit on one funnel the brand states its legs for — every
 * live offer in prod on 2026-09-25 — the reading set IS the funnel it used to declare, priced on the
 * same leg values (brand-service carried every funnel arrow onto its leg; 0 differ) and the same
 * lifetime revenue (the offer's; identical for every live offer but one, whose second declared funnel
 * no campaign ran).
 */

import { funnelLegs, type ChannelStepKey } from "./acquisition-channels.js";
import { fetchBrandLegEconomics, type BrandLegEconomics, type BrandOfferEconomics } from "./brand-leg-economics-client.js";
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";
import { parseAcquisitionChannel } from "./channel-catalogue.js";
import type { AcquisitionChannel } from "./acquisition-channels.js";
import {
  effectiveLegRatePct,
  funnelArrows,
  getBrandEffectiveRates,
  legPairKey,
  type BrandEffectiveRates,
} from "./effective-conversion-rates.js";
import { funnelLeg, funnelsContainingLeg, legKeyFor, matchFunnelLegKey } from "./funnel-legs.js";
import type { DeclaredFunnelLeg } from "./funnel-leg-rates.js";
import { buildOfferLegPartition } from "./offer-outcomes.js";
import {
  SalesFunnelsUnavailableError,
  SeveralOffersDeclaredError,
  type DeclaredSalesFunnel,
} from "./sales-funnels-client.js";
import { SALES_FUNNELS, salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";
import { CHANNEL_STEPS } from "./acquisition-channels.js";
import { SEED_FEATURES } from "../seed/features.js";

const byCatalogue = (a: SalesFunnelKey, b: SalesFunnelKey): number => salesFunnelIndex(a) - salesFunnelIndex(b);

/**
 * PURE: the reading funnels of a set of legs.
 *
 * `statedLeg(from, to)` — did the brand STATE a rate for this leg. `pathScore(funnel, step)` — the
 * probability of a paid client from `step` along `funnel`'s onward legs on the brand's rates (null when
 * some leg has none). An unknown leg key contributes nothing.
 */
export function readingFunnelsForLegs(
  legKeys: readonly string[],
  statedLeg: (from: ChannelStepKey, to: ChannelStepKey) => boolean,
  pathScore: (funnelKey: SalesFunnelKey, fromStep: ChannelStepKey) => number | null,
): SalesFunnelKey[] {
  const out = new Set<SalesFunnelKey>();
  const performed = new Set(legKeys.map((k) => matchFunnelLegKey(k)).filter((k): k is string => k !== null));
  for (const raw of legKeys) {
    const legKey = matchFunnelLegKey(raw);
    const leg = legKey ? funnelLeg(legKey) : null;
    if (!legKey || !leg) continue;
    const step = leg.toStep.key as ChannelStepKey;
    const from = (leg.fromStep?.key as ChannelStepKey | undefined) ?? null;
    // UPSTREAM: an internal leg acts on leads that reached its FROM step some way. The funnels whose
    // leg INTO that step the brand states, or the scope performs, are how its leads got there; a funnel
    // reached some other way (an ad delivering the meeting) is not this brand's path. Nobody said →
    // every candidate stays, and the onward rule below decides.
    let candidates = funnelsContainingLeg(legKey).sort(byCatalogue);
    if (from !== null) {
      const prevOf = (f: SalesFunnelKey) => funnelLegs(f).find((t) => t.to === from) ?? null;
      const walked = candidates.filter((f) => {
        const prev = prevOf(f);
        if (!prev) return false;
        return prev.from === null ? performed.has(legKeyFor(prev)) : statedLeg(prev.from, prev.to) || performed.has(legKeyFor(prev));
      });
      if (walked.length > 0) candidates = walked;
    }
    const nextOf = (f: SalesFunnelKey) => funnelLegs(f).find((t) => t.from === step) ?? null;
    // A leg landing on a funnel's LAST step has nowhere onward to branch: every candidate is read.
    const terminal = candidates.filter((f) => nextOf(f) === null);
    const branching = candidates.filter((f) => nextOf(f) !== null);
    for (const f of terminal) out.add(f);
    if (branching.length === 0) continue;
    const stated = branching.filter((f) => {
      const next = nextOf(f)!;
      return statedLeg(step, next.to);
    });
    if (stated.length > 0) {
      for (const f of stated) out.add(f);
      continue;
    }
    // The brand said nothing about where its leads go from here: the single best onward path. When no
    // onward path can be priced at all there is nothing to choose on, so every candidate is read and the
    // engine's own max (and a ranking's catalogue-order tie-break) decides — never a guessed one.
    const scored = branching.map((f) => ({ f, score: pathScore(f, step) }));
    const priced = scored.filter((x) => x.score !== null) as Array<{ f: SalesFunnelKey; score: number }>;
    if (priced.length === 0) {
      for (const f of branching) out.add(f);
      continue;
    }
    let best = priced[0];
    for (const x of priced.slice(1)) if (x.score > best.score) best = x;
    out.add(best.f);
  }
  return [...out].sort(byCatalogue);
}

/** PURE: P(paid client | at `fromStep`) along `funnelKey`'s onward legs, or null when a leg has no rate. */
export function onwardPathScore(
  funnelKey: SalesFunnelKey,
  fromStep: ChannelStepKey,
  rateOf: (from: ChannelStepKey, to: ChannelStepKey) => number | null,
): number | null {
  const legs = funnelLegs(funnelKey);
  const start = legs.findIndex((t) => t.from === fromStep);
  if (start < 0) return null;
  let p = 1;
  for (const t of legs.slice(start)) {
    const rate = rateOf(t.from!, t.to);
    if (rate === null) return null;
    p *= rate / 100;
  }
  return p;
}

/** The acquisition channel of a feature slug, off the in-process catalogue. */
let channelCatalogue: Map<string, AcquisitionChannel | null> | null = null;
function channelOf(slug: string): AcquisitionChannel | null {
  channelCatalogue ??= new Map(SEED_FEATURES.map((f) => [f.slug, parseAcquisitionChannel(f.slug, f.acquisitionChannel)]));
  return channelCatalogue.get(slug) ?? null;
}

/**
 * PURE: every leg ONE offer's campaigns perform — every status (a stopped campaign's leads are still
 * the offer's history), every channel including the customer-operated ones (they perform a leg of the
 * offer too). Same leg resolution as the offer's outcome read.
 */
export function offerLegKeys(
  rows: readonly CampaignIdentityRow[],
  offerId: string,
  /** The brand sells exactly this one offer: a row predating the offer (null `offerId`) is its. */
  soleOffer = false,
): string[] {
  const scoped = soleOffer ? rows.map((r) => (r.offerId ? r : { ...r, offerId })) : rows;
  const partition = buildOfferLegPartition(scoped, offerId, (slug) => {
    const channel = channelOf(slug);
    // Read customer-operated channels as ours HERE: the outcome read hides them from its rows, but
    // their leg is still a leg this offer runs.
    return channel && channel.operatedBy === "customer" ? { ...channel, operatedBy: "platform" } : channel;
  });
  return [...new Set(partition.groups.map((g) => g.legKey))].sort();
}

/** Resolve the offer a read prices on. */
export function resolvePricedOffer(offers: readonly BrandOfferEconomics[], offerId: string | null | undefined, brandId: string): BrandOfferEconomics {
  if (offerId) {
    const offer = offers.find((o) => o.offerId === offerId);
    if (!offer) throw new SalesFunnelsUnavailableError(`offer ${offerId} is not an offer of brand ${brandId}`);
    return offer;
  }
  if (offers.length === 0) {
    throw new SalesFunnelsUnavailableError(`brand ${brandId} states no offer — nothing to price a lifetime revenue on`);
  }
  if (offers.length > 1) {
    // A brand-scoped read of a brand selling several offers: each offer carries its own lifetime
    // revenue, so pricing one under the brand's name would be a guess. Same refusal as before.
    throw new SeveralOffersDeclaredError(
      `brand ${brandId} sells several offers and this read named none`,
      offers.map((o) => ({ offerId: o.offerId, name: o.name || null })),
    );
  }
  return offers[0];
}

export interface PricingFunnelsOptions {
  /** `effective` (default): measured > stated > fleet median. `stated`: only what the brand stated. */
  rates?: "effective" | "stated";
  /** Price these legs instead of the offer's campaigns' legs (a leg-keyed read names its own). */
  legKeys?: readonly string[];
  /** Funnels a caller NAMED (`?funnel=`): always priced, whatever the reading set holds. */
  include?: readonly SalesFunnelKey[];
  /** Already-read statements, to spare the brand-service read. */
  legEconomics?: BrandLegEconomics;
}

/** PURE: the funnels, shaped as the pricing modules read them. */
export function buildPricingFunnels(input: {
  funnelKeys: readonly SalesFunnelKey[];
  lifetimeRevenueUsd: number | null;
  rateOf: (fromStep: string, toStep: string) => { ratePct: number | null; provenance: string };
}): DeclaredSalesFunnel[] {
  return [...input.funnelKeys].sort(byCatalogue).map((funnelKey) => {
    const arrows: DeclaredFunnelLeg[] = funnelArrows(funnelKey).map(({ fromStep, toStep }) => ({
      fromStep,
      toStep,
      ...input.rateOf(fromStep, toStep),
      rateKey: null,
    }));
    return {
      funnelKey,
      active: true,
      name: SALES_FUNNELS[funnelKey].name,
      steps: [...SALES_FUNNELS[funnelKey].steps],
      rates: {},
      arrows,
      lifetimeRevenueUsd: input.lifetimeRevenueUsd,
      destinationUrl: null,
      bookingUrl: null,
      updatedAt: "",
    };
  });
}

/**
 * The funnels a read is priced on — the replacement for the declared-funnel read. Throws
 * `SalesFunnelsUnavailableError` (and its `SeveralOffersDeclaredError` subclass) exactly where the
 * declared read did, so every caller's existing degrade keeps working: statements unreadable, an offer
 * that is not the brand's, or a brand-scoped read of a several-offer brand. A scope whose campaigns
 * perform no leg answers `[]`.
 */
export async function fetchPricingFunnels(
  brandId: string,
  orgId: string,
  offerId?: string | null,
  opts: PricingFunnelsOptions = {},
): Promise<DeclaredSalesFunnel[]> {
  const legEconomics = opts.legEconomics ?? (await fetchBrandLegEconomics(brandId, orgId));
  const offer = resolvePricedOffer(legEconomics.offers, offerId, brandId);

  let legKeys: readonly string[];
  if (opts.legKeys) {
    legKeys = opts.legKeys;
  } else {
    let rows: CampaignIdentityRow[];
    try {
      rows = await fetchBrandCampaignRows(brandId, undefined, { orgId });
    } catch (error) {
      throw new SalesFunnelsUnavailableError(`the campaigns of brand ${brandId} could not be read: ${(error as Error).message}`);
    }
    legKeys = offerLegKeys(rows, offer.offerId, legEconomics.offers.length === 1);
  }

  let effective: BrandEffectiveRates | null = null;
  if ((opts.rates ?? "effective") === "effective") {
    try {
      effective = await getBrandEffectiveRates(brandId, orgId, legEconomics);
    } catch (error) {
      console.error(
        `[features-service] effective conversion rates unavailable for brand ${brandId} (org ${orgId}); pricing on its stated leg rates: ${(error as Error).message}`,
      );
    }
  }

  const statedByLeg = new Map<string, number>();
  for (const leg of legEconomics.legRates) {
    const key = legPairKey(leg.fromStep, leg.toStep);
    if (leg.stated && leg.ratePct !== null && !statedByLeg.has(key)) statedByLeg.set(key, leg.ratePct);
  }
  const label = (step: ChannelStepKey): string => CHANNEL_STEPS[step].label;
  const rateByKeys = (from: ChannelStepKey, to: ChannelStepKey): number | null =>
    effective ? effectiveLegRatePct(effective, label(from), label(to)) : statedByLeg.get(`${from}>${to}`) ?? null;

  const keys = new Set(
    readingFunnelsForLegs(
      legKeys,
      (from, to) => statedByLeg.has(`${from}>${to}`),
      (funnelKey, step) => onwardPathScore(funnelKey, step, rateByKeys),
    ),
  );
  for (const k of opts.include ?? []) keys.add(k);
  // A scope whose campaigns perform no leg (a brand before its first campaign) walks no path: an EMPTY
  // set, which every caller already reads as "nothing to price on" — never a substituted funnel.
  if (keys.size === 0) return [];

  return buildPricingFunnels({
    funnelKeys: [...keys],
    lifetimeRevenueUsd: offer.lifetimeRevenueUsd,
    rateOf: (fromStep, toStep) => {
      if (effective) {
        const key = legPairKey(fromStep, toStep);
        const leg = effective.legs.find((l) => legPairKey(l.fromStep, l.toStep) === key);
        return leg?.effectiveRatePct != null
          ? { ratePct: leg.effectiveRatePct, provenance: `stated_${leg.source}` }
          : { ratePct: null, provenance: "unstated" };
      }
      const stated = statedByLeg.get(legPairKey(fromStep, toStep));
      return stated !== undefined ? { ratePct: stated, provenance: "stated_manual" } : { ratePct: null, provenance: "unstated" };
    },
  });
}

/** The reading funnel keys of a scope, in catalogue order (stated rates only — no lead walk). */
export async function fetchReadingFunnelKeys(
  brandId: string,
  orgId: string,
  offerId?: string | null,
): Promise<SalesFunnelKey[]> {
  return (await fetchPricingFunnels(brandId, orgId, offerId, { rates: "stated" })).map((f) => f.funnelKey);
}

/**
 * A brand's statements for the FLEET reads: `reading` — every offer's pricing funnels (stated leg rates,
 * the offer's own lifetime revenue); `stated` — those PLUS every other catalogue funnel on which the
 * brand stated at least one leg (no lifetime revenue), because a rate a brand stated is a fact about the
 * brand whichever funnel reads it, and the fleet medians are taken over what brands stated. An offer
 * whose campaigns perform no leg contributes no reading funnel.
 */
export async function fetchBrandStatedFunnels(
  brandId: string,
  orgId: string,
): Promise<{ reading: DeclaredSalesFunnel[]; stated: DeclaredSalesFunnel[] }> {
  const legEconomics = await fetchBrandLegEconomics(brandId, orgId);
  let rows: CampaignIdentityRow[];
  try {
    rows = await fetchBrandCampaignRows(brandId, undefined, { orgId });
  } catch (error) {
    throw new SalesFunnelsUnavailableError(`the campaigns of brand ${brandId} could not be read: ${(error as Error).message}`);
  }
  const reading: DeclaredSalesFunnel[] = [];
  for (const offer of legEconomics.offers) {
    const legKeys = offerLegKeys(rows, offer.offerId, legEconomics.offers.length === 1);
    if (legKeys.length === 0) continue;
    reading.push(...(await fetchPricingFunnels(brandId, orgId, offer.offerId, { rates: "stated", legKeys, legEconomics })));
  }
  const statedByLeg = new Map<string, number>();
  for (const leg of legEconomics.legRates) {
    const key = legPairKey(leg.fromStep, leg.toStep);
    if (leg.stated && leg.ratePct !== null && !statedByLeg.has(key)) statedByLeg.set(key, leg.ratePct);
  }
  const covered = new Set(reading.map((f) => f.funnelKey));
  const others = (Object.keys(SALES_FUNNELS) as SalesFunnelKey[]).filter(
    (k) => !covered.has(k) && funnelArrows(k).some((a) => statedByLeg.has(legPairKey(a.fromStep, a.toStep))),
  );
  const extra = buildPricingFunnels({
    funnelKeys: others,
    lifetimeRevenueUsd: null,
    rateOf: (fromStep, toStep) => {
      const stated = statedByLeg.get(legPairKey(fromStep, toStep));
      return stated !== undefined ? { ratePct: stated, provenance: "stated_manual" } : { ratePct: null, provenance: "unstated" };
    },
  });
  return { reading, stated: [...reading, ...extra] };
}

/** Every offer's pricing funnels (stated rates) — the reading half of `fetchBrandStatedFunnels`. */
export async function fetchPricingFunnelsAllOffers(brandId: string, orgId: string): Promise<DeclaredSalesFunnel[]> {
  return (await fetchBrandStatedFunnels(brandId, orgId)).reading;
}
