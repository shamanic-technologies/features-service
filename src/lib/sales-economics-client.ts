import { createHash } from "node:crypto";
import type { SalesEconomics } from "./funnel-registry.js";
import { fetchWithRetry } from "./fetch-retry.js";

export class BrandOwnershipError extends Error {
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
 * Fetch a brand's saved sales conversion economics from brand-service.
 * Returns null when the brand has no economics saved yet (revenue is then incomputable —
 * the caller surfaces a null pipeline). Fails loud on any transport / non-OK error.
 */
export async function fetchSalesEconomics(
  brandId: string,
  headers: {
    orgId: string;
    userId?: string;
    runId?: string;
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
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/orgs/brands/${brandId}/sales-economics`, {
    headers: reqHeaders,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 403) {
      throw new BrandOwnershipError(brandId, headers.orgId, `brand-service sales-economics failed (${response.status}): ${text}`);
    }
    throw new Error(`brand-service sales-economics failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { salesEconomics: SalesEconomics | null };
  return data.salesEconomics;
}

/** A brand's SAVED economics, from ONE internal read. */
export interface SavedEconomics {
  /** The brand's OWN saved metric set, or null when it has never saved economics. */
  economics: SalesEconomics | null;
}

/**
 * Read a brand's SAVED sales economics FOR ONE ORG, from brand-service's INTERNAL
 * `GET /internal/brands/:brandId/sales-economics` (api-key + `x-org-id`, brandId in path). Returns that
 * org's OWN saved set (NOT the cross-brand-average effective one). `{ economics: null }` when nothing has
 * ever been saved (unset is NOT a 404). Fails loud on any transport / non-OK error.
 *
 * **NO GOAL IS READ HERE, and none may be added back.** This used to also map the payload's
 * `optimizationGoal` into a canonical `Goal`, and that field is being dropped from brand-service — the
 * column carries a NOT NULL default, so a brand that never chose a goal read back as selling through
 * website purchases when nobody had said so. What a brand sells through is its DECLARED SALES FUNNEL SET
 * (`GET /internal/brands/:brandId/sales-funnels`, `sales-funnels-client.ts` → `brand-funnels.ts`), which
 * is a real declaration with no default behind it. Every caller that used to branch on the goal now
 * branches on that set.
 *
 * WHICH ORG'S ANSWER — a brand row is a SHARED GLOBAL IDENTITY (any org that claims the same domain
 * lands on the same brand id), so the economics are the data of an (org, brand) PAIR, not of the brand
 * alone. Two orgs claiming one domain legitimately sell different things at different rates, so
 * brand-service refuses to guess for a brand several orgs claim: `orgId` — the org whose configuration is
 * wanted — is REQUIRED and travels as `x-org-id`. It is never resolved to a stand-in; an org picked on
 * brand-service's behalf is exactly the cross-org leak this closes, so a caller with no org fails loud
 * instead of reading org-less.
 */
export async function fetchBrandSavedEconomics(
  brandId: string,
  orgId: string,
): Promise<SavedEconomics> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }
  // No org means no question to ask — which org's economics? Substituting one is the leak being closed,
  // so this fails loud rather than reading org-less.
  if (!orgId) {
    throw new Error(
      "brand-service internal sales-economics read requires the org whose configuration is wanted (x-org-id); features-service will not pick one",
    );
  }

  const response = await fetchWithRetry(`${url}/internal/brands/${brandId}/sales-economics`, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service internal sales-economics failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { salesEconomics: SalesEconomics | null };
  return { economics: data.salesEconomics ?? null };
}

/** A brand's EFFECTIVE economics + provenance, as served by brand-service in ONE call. */
export interface EffectiveEconomics {
  /** The 5 conversion metrics, or null at cold start (nothing saved by any brand yet). */
  economics: SalesEconomics | null;
  /**
   * Provenance of `economics`: "user" = the brand's own saved set; "cross-brand-average" = the
   * org-wide average fallback (an ESTIMATE, never a user-confirmed number); null at cold start
   * (economics is null). null ⟺ economics === null.
   */
  source: "user" | "cross-brand-average" | null;
}

/**
 * Fetch a brand's EFFECTIVE sales economics from brand-service — ONE call that returns either the
 * brand's own saved set ("user"), the org-wide cross-brand-average fallback ("cross-brand-average"),
 * or null at cold start. brand-service OWNS the null→average defaulting now; features no longer
 * reimplements it. Fails loud on any transport / non-OK error (mirrors fetchSalesEconomics).
 */
export async function fetchEffectiveEconomics(
  brandId: string,
  headers: {
    orgId: string;
    userId?: string;
    runId?: string;
    campaignId?: string;
    featureSlug?: string;
  },
): Promise<EffectiveEconomics> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/orgs/brands/${brandId}/sales-economics-effective`, {
    headers: reqHeaders,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 403) {
      throw new BrandOwnershipError(brandId, headers.orgId, `brand-service sales-economics-effective failed (${response.status}): ${text}`);
    }
    throw new Error(`brand-service sales-economics-effective failed (${response.status}): ${text}`);
  }

  return (await response.json()) as EffectiveEconomics;
}

/**
 * Stable cache fingerprint of a brand's effective economics.
 *
 * WHY THIS EXISTS — the Gold SWR cache (`view-cache.ts`) serves a snapshot whose freshness key is the
 * request's query params. Economics are NOT a query param, so a snapshot computed before an economics
 * write would keep being served after it (onboarding writes the brand's economics, the very next screen
 * reads a stats endpoint). At the old 60s hard-stale cap that window was small; once `maxStale` is raised
 * so no read ever blocks, the window becomes minutes — long enough to show a customer the pre-write ROI.
 *
 * Rather than a cross-service invalidation hook (a new endpoint + a brand-service caller + a new failure
 * mode), the economics are folded INTO the cache key: different economics ⇒ different `scope_key` ⇒
 * guaranteed miss ⇒ fresh compute. Correct by construction, no new state, no cross-repo coordination.
 * Snapshot rows keyed on a superseded fingerprint simply orphan — the Gold layer is derived and
 * rebuildable, so orphans are harmless (documented in CLAUDE.md).
 *
 * Hashes the WHOLE object with sorted keys, so a field added to `SalesEconomics` later is covered
 * automatically — there is no per-field list here to forget to update.
 *
 * `source` is part of the hash on purpose: the same numbers arriving as the brand's own saved set
 * ("user") vs the org-wide average ("cross-brand-average") are a different answer for the surfaces that
 * gate on provenance, so they must not share a cache cell.
 */
export function economicsFingerprint(effective: EffectiveEconomics): string {
  // Deterministic serialisation: JSON.stringify's key order follows insertion order, which is NOT
  // guaranteed stable across producers, so sort every level.
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = stable((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };
  return createHash("sha1").update(JSON.stringify(stable(effective))).digest("hex").slice(0, 12);
}
