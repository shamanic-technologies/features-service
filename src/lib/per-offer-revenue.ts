/**
 * PURE: price a population person by person on the offer of the campaign that reached them (the brand
 * read of a brand whose campaigns sell several offers; the IO half is `lib/per-offer-pricing.ts`).
 *
 * Each offer's paths come from its OWN terms through the same funnel resolution the single-offer read
 * uses (`resolvePaths` + `restrictPathsToDeclaredLegs`). A person whose campaign belongs to no priced
 * offer is worth 0 and still counted in every series.
 */

import { restrictPathsToDeclaredLegs, type FunnelDefinition } from "./funnel-registry.js";
import type { EnginePerson, ResolvedPath } from "./revenue-engine.js";
import { closedWonOf } from "./ratio-basis.js";
import type { SalesFunnelKey } from "./sales-funnels.js";
import type { OfferPricing } from "./per-offer-pricing.js";

interface OfferTerms {
  paths: ResolvedPath[];
  closeValueUsd: number;
  campaignIds: Set<string>;
}

export interface PerOfferPricer {
  /** Every offer's paths, deduped by tag — orders the stages only. */
  paths: ResolvedPath[];
  pricedFunnelKeys: SalesFunnelKey[];
  pricingOf: (person: EnginePerson) => { paths: ResolvedPath[]; closeValueUsd: number } | null;
  /**
   * The lifetime revenue that turns the total pipeline into the exact expected paying clients:
   * Σ pipeline ÷ Σ (offer pipeline ÷ offer lifetime revenue). Null when nothing is priced.
   */
  lifetimeRevenueOver: (
    persons: EnginePerson[],
    pipelineOf: (people: EnginePerson[], paths: ResolvedPath[], ltr: number) => number | null,
  ) => number | null;
  /** Deals closed won, each valued at its stated amount else its own offer's lifetime revenue. */
  closedWon: (persons: EnginePerson[]) => { closedWonCount: number; closedWonRevenueUsd: number } | null;
}

/** Null when no offer prices (every offer's economics null): the read stays unpriced. */
export function perOfferPricer(offers: readonly OfferPricing[], funnel: FunnelDefinition | null): PerOfferPricer | null {
  if (!funnel) return null;
  const terms: OfferTerms[] = [];
  const keys = new Set<SalesFunnelKey>();
  for (const offer of offers) {
    const economics = offer.priced.economics.economics;
    if (!economics) continue;
    const paths = restrictPathsToDeclaredLegs(
      funnel.resolvePaths({ economics, pricedFunnelKeys: offer.priced.pricedFunnelKeys }),
      offer.priced.pricedFunnelKeys,
    );
    terms.push({ paths, closeValueUsd: economics.lifetimeRevenueUsd, campaignIds: new Set(offer.campaignIds) });
    for (const k of offer.priced.pricedFunnelKeys) keys.add(k);
  }
  if (terms.length === 0) return null;
  const byCampaign = new Map<string, OfferTerms>();
  for (const t of terms) for (const id of t.campaignIds) byCampaign.set(id, t);
  const termsOf = (p: EnginePerson): OfferTerms | null => (p.campaignId ? (byCampaign.get(p.campaignId) ?? null) : null);
  const seen = new Set<string>();
  const paths = terms.flatMap((t) => t.paths).filter((p) => (seen.has(p.tag) ? false : (seen.add(p.tag), true)));
  return {
    paths,
    pricedFunnelKeys: [...keys],
    pricingOf: (p) => {
      const t = termsOf(p);
      return t ? { paths: t.paths, closeValueUsd: t.closeValueUsd } : null;
    },
    lifetimeRevenueOver: (persons, pipelineOf) => {
      let pipeline = 0;
      let clients = 0;
      for (const t of terms) {
        const own = persons.filter((p) => termsOf(p) === t);
        const value = own.length > 0 ? (pipelineOf(own, t.paths, t.closeValueUsd) ?? 0) : 0;
        pipeline += value;
        clients += value / t.closeValueUsd;
      }
      return clients > 0 ? pipeline / clients : null;
    },
    closedWon: (persons) => {
      let closedWonCount = 0;
      let closedWonRevenueUsd = 0;
      for (const t of terms) {
        const won = closedWonOf(persons.filter((p) => termsOf(p) === t), t.closeValueUsd);
        if (won === null) return null;
        closedWonCount += won.closedWonCount;
        closedWonRevenueUsd += won.closedWonRevenueUsd;
      }
      return { closedWonCount, closedWonRevenueUsd };
    },
  };
}
