import { createHash } from "node:crypto";
import type { SalesEconomics } from "./funnel-registry.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { matchBrandServiceGoal, type Goal } from "./goals.js";

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

/** A brand's SAVED economics + its declared optimization goal, from ONE internal read. */
export interface SavedEconomicsWithGoal {
  /** The brand's OWN saved metric set, or null when it has never saved economics. */
  economics: SalesEconomics | null;
  /** The brand's declared optimization goal (canonical camelCase), or null when unset/unrecognised. */
  goal: Goal | null;
}

/**
 * Read a brand's SAVED sales economics + its `optimizationGoal` from brand-service's INTERNAL
 * `GET /internal/brands/:brandId/sales-economics` (api-key only, brandId in path, NO org context —
 * built for service schedulers). Returns the brand's OWN saved set (NOT the cross-brand-average
 * effective one — a goal must be the brand's own, never an average), with `optimizationGoal` mapped to
 * the canonical Goal. `{ economics: null, goal: null }` when the brand has never saved economics
 * (unset is NOT a 404). Fails loud on any transport / non-OK error.
 *
 * Used by the cross-org goal-bucketed cost surfaces to partition the fleet's brands by the goal they
 * optimize for, so each cost-per-outcome card only sums the spend + outcomes of the relevant brands.
 */
export async function fetchBrandSavedEconomicsWithGoal(brandId: string): Promise<SavedEconomicsWithGoal> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(`${url}/internal/brands/${brandId}/sales-economics`, {
    headers: { "x-api-key": apiKey },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service internal sales-economics failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    salesEconomics: (SalesEconomics & { optimizationGoal?: string | null }) | null;
  };
  const saved = data.salesEconomics;
  if (!saved) return { economics: null, goal: null };

  const rawGoal = saved.optimizationGoal;
  const goal = typeof rawGoal === "string" ? matchBrandServiceGoal(rawGoal) : null;
  return { economics: saved, goal };
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
