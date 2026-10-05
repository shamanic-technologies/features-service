import { fetchWithRetry } from "./fetch-retry.js";
import { SalesFunnelsUnavailableError } from "./sales-funnels-client.js";

/**
 * The org does not hold this brand: brand-service answered 403 (the brand belongs to another
 * org) OR 404 (the brand no longer exists at all). Both mean a feature membership this service holds
 * is STALE, and every fleet-wide fan-out skips the brand rather than failing the whole read on it. A
 * deleted brand's membership row outlives the brand, so a 404 here is the ordinary case after a
 * teardown, not an outage: measured 2026-09-18, one deleted brand's `Brand not found` inside a
 * `Promise.all` took `workflow-cost-per-outcome` down for every caller.
 *
 * It EXTENDS `SalesFunnelsUnavailableError` because it is also "we could not read what this brand
 * sells": a soft pricing caller degrades on it like on any unreadable statement, while a fleet sweep
 * (or the soft pricing read, which rethrows it) still tells the stale membership apart.
 */
export class BrandOwnershipError extends SalesFunnelsUnavailableError {
  constructor(
    readonly brandId: string,
    readonly orgId: string,
    message: string,
  ) {
    super(message);
    this.name = "BrandOwnershipError";
  }
}

/**
 * Does this org HOLD this brand? brand-service owns the org → brand edge and refuses a foreign (403) or
 * gone (404) brand on its org-scoped reads; the internal `offer-economics` read every price comes from
 * does NOT (it answers any org with that org's — empty — statements). So the check is its own call:
 * the org-scoped `GET /orgs/brands/:brandId/leg-rates`, the cheapest org-scoped read of the same
 * statements. It used to ride the retired brand-level economics read for free (owner 2026-10-05).
 *
 * Resolves when held; throws `BrandOwnershipError` on 403/404; fails loud on anything else.
 */
export async function assertBrandHeld(
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<void> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  if (!headers.orgId) throw new Error("brand ownership check requires the org (x-org-id); features-service will not pick one");
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  const response = await fetchWithRetry(`${url}/orgs/brands/${encodeURIComponent(brandId)}/leg-rates`, { headers: reqHeaders });
  if (response.ok) return;
  const text = await response.text();
  if (response.status === 403 || response.status === 404) {
    throw new BrandOwnershipError(brandId, headers.orgId, `brand-service leg-rates ownership check failed (${response.status}): ${text}`);
  }
  throw new Error(`brand-service leg-rates ownership check failed (${response.status}): ${text}`);
}
