/**
 * THE ONE DOOR every pricing read goes through: the funnels a scope walks (`fetchPricingFunnels`) priced
 * on the OFFER's terms (`offerTermsEconomics`). Lives in lib so lib modules (pipeline-activity's
 * forecast, customer-health) can price without importing a route.
 */
import { economicsFingerprint, offerTermsEconomics, type PricedEconomics } from "./offer-priced-economics.js";
import { fetchPricingFunnels } from "./reading-funnels.js";
import { SalesFunnelsUnavailableError, type DeclaredSalesFunnel } from "./sales-funnels-client.js";
import { salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";

/**
 * WHAT THE PIPELINE IS PRICED ON — the offer's terms on the funnels the read walks: which LEGS carry
 * expected value at all, and whose TERMS those legs are priced on.
 *
 * THE LEGS. The paths that carry value are exactly the legs of the funnels being priced — a signal
 * that is not a step of one contributes nothing (`restrictPathsToDeclaredLegs`). A read NARROWED to one
 * funnel (a requested funnel the brand reads, or a campaign's own legs) is priced on that funnel alone.
 *
 * THE TERMS. EVERY priced funnel's own effective leg rates and the offer's stated lifetime revenue
 * (`offerTermsEconomics`), and nothing else (owner 2026-10-05, supersedes the brand-wide record these
 * terms used to be merged over: brand-service's brand sales economics had no writer since 2026-08-03).
 * A rate no priced funnel states is 0; no priced funnel, or an offer stating no lifetime revenue, is
 * NULL economics with a named reason — the null-pipeline path, never an average.
 */
export interface FunnelPricedEconomics {
  /** The offer-terms economics, or null with its reason. */
  economics: PricedEconomics;
  /** The funnels whose LEGS carry expected value on this read; `[]` ⇒ economics null (`no_priced_funnel`). */
  pricedFunnelKeys: SalesFunnelKey[];
}

/**
 * Read the funnels this scope is priced on (its campaigns' legs, the brand's effective leg rates, the
 * offer's lifetime revenue — `lib/reading-funnels.ts`), SOFT: `[]` when there is none or it cannot be
 * read, which prices the read on NULL economics (`no_priced_funnel`) rather than 502-ing the customer's
 * Overview. Ownership is NOT checked here (brand-service's offer-economics answers any org): a caller
 * that must refuse a foreign brand pairs it with `assertBrandHeld` (`lib/brand-ownership.ts`).
 */
export async function fetchDeclaredFunnelsSoft(
  brandId: string,
  orgId: string,
  /** The offer being priced, when the read knows one. See `fetchPricingFunnels`. */
  offerId?: string | null,
): Promise<DeclaredSalesFunnel[]> {
  try {
    // The caller's own org names whose configuration we want: a brand id alone is shared across every
    // org claiming the same domain, so what it sells through is the (org, brand) pair's data.
    return await fetchPricingFunnels(brandId, orgId, offerId);
  } catch (err) {
    const what =
      err instanceof SalesFunnelsUnavailableError
        ? `this brand's offer terms could not be read (${(err as Error).message})`
        : (err as Error).message;
    console.warn(`[features-service] pricing funnels unavailable for brand ${brandId} (economics null, no_priced_funnel): ${what}`);
    return [];
  }
}

/**
 * PURE: pick the funnels this read is priced on, and price them on their own (offer) terms. No IO — the
 * funnels are read ONCE per request and every campaign group reuses them.
 */
export function priceOnDeclaredFunnel(
  declared: DeclaredSalesFunnel[],
  requestedFunnel?: SalesFunnelKey,
): FunnelPricedEconomics {
  const declaredKeys = declared.map((f) => f.funnelKey).sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b));
  // A funnel the brand never reads is ignored rather than honoured: pricing a brand on a funnel it
  // never said it sells through would be the same fiction the defaulted goal produced.
  const named = requestedFunnel && declaredKeys.includes(requestedFunnel) ? requestedFunnel : null;
  const pricedFunnelKeys = named ? [named] : declaredKeys;
  return { economics: offerTermsEconomics(declared, pricedFunnelKeys), pricedFunnelKeys };
}

/** The request-path composition of the two above, for callers that hold no funnels of their own. */
export async function fetchFunnelPricedEconomics(
  brandId: string,
  orgId: string,
  requestedFunnel: SalesFunnelKey | undefined,
  offerId?: string | null,
): Promise<FunnelPricedEconomics> {
  return priceOnDeclaredFunnel(await fetchDeclaredFunnelsSoft(brandId, orgId, offerId), requestedFunnel);
}

/** The Gold-cache fingerprint of a priced read (`lib/offer-priced-economics.ts`). */
export function pricedFingerprint(priced: FunnelPricedEconomics): string {
  return economicsFingerprint({ ...priced.economics, pricedFunnelKeys: priced.pricedFunnelKeys });
}
