/**
 * WHAT A BRAND STATED, ON THE MODEL THAT REPLACES THE SALES FUNNEL — one conversion rate per LEG of the
 * brand, and one lifetime revenue per OFFER.
 *
 * brand-service `GET /internal/brands/:brandId/offer-economics` (service auth, `x-org-id` optional —
 * sent, because a brand id is shared by every org claiming the same domain and each states its own).
 * Shape conforms to what brand-service DEPLOYS (v0.81.8); nothing here is authored by features-service.
 *
 *  - `legRates`: every leg the catalogue knows, each once. An unstated leg reads `stated: false` with a
 *    null rate — never a number, never a default. No sales funnel is part of the key: a leg reads the
 *    most recent value stated for it, whichever brand-service route stated it.
 *  - `offers`: every offer of the brand with its own `lifetimeRevenueUsd` (null = never stated).
 *
 * This is the ONLY read of a brand's configuration any pricing surface makes (wave C1): the funnel a
 * brand "declared" is no longer read by anything here.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { SalesFunnelsUnavailableError } from "./sales-funnels-client.js";

export interface BrandLegRate {
  fromStep: string;
  toStep: string;
  /** 0..100. Null exactly when `stated` is false. */
  ratePct: number | null;
  stated: boolean;
}

export interface BrandOfferEconomics {
  offerId: string;
  name: string;
  /** Null when the offer never stated one — never a 0. */
  lifetimeRevenueUsd: number | null;
}

export interface BrandLegEconomics {
  legRates: BrandLegRate[];
  offers: BrandOfferEconomics[];
}

/**
 * Read a brand's leg rates and offers FOR ONE ORG. Fails loud with `SalesFunnelsUnavailableError` (the
 * type every pricing caller already catches as "we could not read what this brand sells") on any
 * transport / non-OK / malformed response. A missing org is a missing question, never a stand-in.
 */
export async function fetchBrandLegEconomics(brandId: string, orgId: string): Promise<BrandLegEconomics> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new SalesFunnelsUnavailableError("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }
  if (!orgId) {
    throw new SalesFunnelsUnavailableError(
      "brand offer-economics read requires the org whose statements are wanted (x-org-id); features-service will not pick one",
    );
  }

  let response: Response;
  try {
    // A leg rate or a lifetime revenue is what a person just typed: shared across the reads of ONE
    // refresh only (3s), never across refreshes.
    response = await fetchWithRetry(`${url}/internal/brands/${brandId}/offer-economics`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId },
    });
  } catch (error) {
    throw new SalesFunnelsUnavailableError(`brand-service offer-economics read failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new SalesFunnelsUnavailableError(`brand-service offer-economics read failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { legRates?: unknown; offers?: unknown };
  if (!Array.isArray(data.legRates) || !Array.isArray(data.offers)) {
    throw new SalesFunnelsUnavailableError("brand-service offer-economics response carried no `legRates` / `offers` array");
  }

  const legRates: BrandLegRate[] = [];
  for (const raw of data.legRates as Array<Record<string, unknown>>) {
    if (typeof raw?.fromStep !== "string" || typeof raw?.toStep !== "string") continue;
    const ratePct = typeof raw.ratePct === "number" && Number.isFinite(raw.ratePct) ? raw.ratePct : null;
    // A statement is a stated flag AND a number; either missing is "not stated".
    const stated = raw.stated === true && ratePct !== null;
    legRates.push({ fromStep: raw.fromStep, toStep: raw.toStep, ratePct: stated ? ratePct : null, stated });
  }
  const offers: BrandOfferEconomics[] = [];
  for (const raw of data.offers as Array<Record<string, unknown>>) {
    if (typeof raw?.offerId !== "string" || raw.offerId === "") continue;
    const ltr = raw.lifetimeRevenueUsd;
    offers.push({
      offerId: raw.offerId,
      name: typeof raw.name === "string" ? raw.name : "",
      lifetimeRevenueUsd: typeof ltr === "number" && Number.isFinite(ltr) ? ltr : null,
    });
  }
  return { legRates, offers };
}
