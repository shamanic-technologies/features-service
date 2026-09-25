/**
 * THE CONVERSION RATES A BRAND STATED BY HAND — brand-service's brand-grain store, one rate per
 * (org, brand, sales funnel, arrow), shared by every offer of the brand.
 *
 * Shape conforms to what brand-service DEPLOYS (`GET /internal/brands/:brandId/funnel-rates`,
 * service-auth, `x-org-id` optional): every funnel of the catalogue, each arrow stated or not.
 * `stated: false` carries `ratePct: null` and is "the brand has not stated this arrow" — never a 0,
 * never a default. Nothing here is authored by features-service.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { matchSalesFunnelKey, type SalesFunnelKey } from "./sales-funnels.js";

export interface BrandArrowRate {
  fromStep: string;
  toStep: string;
  /** The stated rate, 0..100. Null exactly when `stated` is false. */
  ratePct: number | null;
  stated: boolean;
}

export interface BrandFunnelRates {
  funnelKey: SalesFunnelKey;
  arrows: BrandArrowRate[];
}

export class BrandFunnelRatesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandFunnelRatesUnavailableError";
  }
}

/**
 * Read what a brand stated, FOR ONE ORG (the org is part of the question: a brand id is shared by every
 * org claiming the same domain, and each states its own rates). Fails loud on any transport / non-OK
 * response. A funnel key this service cannot model is skipped with a loud log — a rate for a funnel we
 * do not price has nowhere to go, and it must not take the brand's other funnels down with it.
 */
export async function fetchBrandFunnelRates(brandId: string, orgId: string): Promise<BrandFunnelRates[]> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new BrandFunnelRatesUnavailableError("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }
  if (!orgId) {
    throw new BrandFunnelRatesUnavailableError(
      "brand funnel-rates read requires the org whose statements are wanted (x-org-id); features-service will not pick one",
    );
  }

  let response: Response;
  try {
    response = await fetchWithRetry(`${url}/internal/brands/${brandId}/funnel-rates`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId },
    });
  } catch (error) {
    throw new BrandFunnelRatesUnavailableError(`brand-service funnel-rates read failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new BrandFunnelRatesUnavailableError(`brand-service funnel-rates read failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { funnels?: unknown };
  if (!Array.isArray(data.funnels)) {
    throw new BrandFunnelRatesUnavailableError("brand-service funnel-rates response carried no `funnels` array");
  }

  const out: BrandFunnelRates[] = [];
  for (const raw of data.funnels as Array<Record<string, unknown>>) {
    const rawKey = typeof raw.funnelKey === "string" ? raw.funnelKey : "";
    const funnelKey = matchSalesFunnelKey(rawKey);
    if (!funnelKey) {
      console.warn(`[features-service] brand-service funnel-rates: brand ${brandId} carries funnel "${rawKey}" this service cannot model — skipped`);
      continue;
    }
    const arrows: BrandArrowRate[] = [];
    for (const entry of (Array.isArray(raw.arrows) ? raw.arrows : []) as Array<Record<string, unknown>>) {
      if (typeof entry?.fromStep !== "string" || typeof entry?.toStep !== "string") continue;
      const ratePct = typeof entry.ratePct === "number" && Number.isFinite(entry.ratePct) ? entry.ratePct : null;
      // A statement is a stated flag AND a number; either one missing is "not stated".
      const stated = entry.stated === true && ratePct !== null;
      arrows.push({ fromStep: entry.fromStep, toStep: entry.toStep, ratePct: stated ? ratePct : null, stated });
    }
    out.push({ funnelKey, arrows });
  }
  return out;
}
