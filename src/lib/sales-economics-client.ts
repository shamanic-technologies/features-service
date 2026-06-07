import type { SalesEconomics } from "./funnel-registry.js";

/**
 * Fetch a brand's saved sales conversion economics from brand-service.
 * Returns null when the brand has no economics saved yet (revenue is then incomputable —
 * the caller surfaces a null pipeline). Fails loud on any transport / non-OK error.
 */
export async function fetchSalesEconomics(
  brandId: string,
  headers: {
    orgId: string;
    userId: string;
    runId: string;
    campaignId?: string;
    featureSlug?: string;
  },
): Promise<SalesEconomics | null> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-user-id": headers.userId,
    "x-run-id": headers.runId,
    "x-brand-id": brandId,
  };
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetch(`${url}/orgs/brands/${brandId}/sales-economics`, {
    headers: reqHeaders,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service sales-economics failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { salesEconomics: SalesEconomics | null };
  return data.salesEconomics;
}

/**
 * Fetch the CROSS-BRAND AVERAGE sales economics from brand-service — the average of every brand's
 * saved set, org-scoped. Used as a READ-TIME fallback when a brand never saved its own economics, so
 * revenue stays computable instead of a null pipeline. The caller tags any revenue computed on this
 * as "cross-brand-average" provenance (an ESTIMATE, never presented as a user-confirmed number).
 * Returns null when no brand has saved economics yet (cold start). Fails loud on any transport /
 * non-OK error (mirrors fetchSalesEconomics).
 */
export async function fetchCrossBrandAverage(
  headers: {
    orgId: string;
    userId: string;
    runId: string;
    campaignId?: string;
    featureSlug?: string;
  },
): Promise<SalesEconomics | null> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-user-id": headers.userId,
    "x-run-id": headers.runId,
  };
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetch(`${url}/orgs/sales-economics-average`, {
    headers: reqHeaders,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service sales-economics-average failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { averages: SalesEconomics | null };
  return data.averages;
}
