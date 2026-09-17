import { fetchWithRetry } from "./fetch-retry.js";

const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL;
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY;

export interface ExtractFieldItem {
  key: string;
  description: string;
}

type FieldValue = string | string[] | Record<string, unknown> | null;

export interface BrandFieldDetail {
  value: FieldValue;
  cached: boolean;
  extractedAt: string;
  expiresAt: string | null;
  sourceUrls: string[] | null;
}

export interface ExtractedFieldResult {
  value: FieldValue;
  byBrand: Record<string, BrandFieldDetail>;
}

/** One offer of a brand, as brand-service names it when it refuses to pick between them. */
export interface BrandOffer {
  offerId: string;
  name: string | null;
}

/**
 * brand-service REFUSED or REJECTED the extraction, and the refusal is the answer rather than an
 * outage — so it carries brand-service's own status, its machine-readable code and, for the
 * several-offers case, the offers it declined to choose between.
 *
 * The two refusals that matter to a caller:
 *  - **409 `SEVERAL_OFFERS`** — the brand sells more than one thing, so the seven user-facing fields
 *    have several right answers and brand-service will not guess. NOT a fault: a caller that knows
 *    which proposition it is starting a channel for names it and gets a real answer.
 *  - **404** — the named offer is not an offer of this brand. Also not a fault of ours to hide.
 *
 * Every other status stays an ordinary downstream failure and surfaces as a 502, exactly as before.
 */
export class BrandFieldExtractionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** brand-service's own machine-readable code when it sent one (e.g. `SEVERAL_OFFERS`). */
    readonly code: string | null,
    /** The offers brand-service refused to choose between; empty for every other refusal. */
    readonly offers: BrandOffer[],
  ) {
    super(message);
    this.name = "BrandFieldExtractionError";
  }
}

/**
 * Parse brand-service's error body WITHOUT inventing anything. A body that is not JSON, or carries no
 * `code`, yields nulls and the caller falls back to the raw text — the same generic failure it always
 * reported.
 */
function parseBrandError(text: string): { message: string | null; code: string | null; offers: BrandOffer[] } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { message: null, code: null, offers: [] };
  }
  const record = body as { code?: unknown; error?: unknown; offers?: unknown };
  const offers = Array.isArray(record.offers)
    ? (record.offers as Array<Record<string, unknown>>)
        .filter((o) => typeof o.offerId === "string" && o.offerId !== "")
        .map((o) => ({ offerId: o.offerId as string, name: typeof o.name === "string" ? o.name : null }))
    : [];
  return {
    message: typeof record.error === "string" && record.error !== "" ? record.error : null,
    code: typeof record.code === "string" && record.code !== "" ? record.code : null,
    offers,
  };
}

/**
 * Call brand-service to extract fields for brands via AI.
 * brand-service reads the brand IDs from the x-brand-id header (CSV format).
 * Results are cached per field for 30 days by brand-service.
 */
export async function extractBrandFields(
  fields: ExtractFieldItem[],
  headers: {
    orgId: string;
    userId: string;
    runId: string;
    brandId?: string;
    campaignId?: string;
    featureSlug?: string;
  },
  /**
   * WHICH offer's confirmed fields ground the extraction. The user-facing fields describe ONE value
   * proposition, so a brand selling two things has two right answers and only the caller knows which
   * it means.
   *
   * OMITTED IS THE UNCHANGED PATH and must stay so: brand-service resolves a brand's sole offer
   * exactly as it always did, and refuses (409 `SEVERAL_OFFERS`) for a brand holding several rather
   * than guessing. Never default it, and never pick the first offer — a substituted proposition is
   * the fabricated answer this whole mechanism exists to refuse.
   */
  offerId?: string | null,
): Promise<Record<string, ExtractedFieldResult>> {
  if (!BRAND_SERVICE_URL || !BRAND_SERVICE_API_KEY) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  if (!headers.brandId) {
    throw new Error("x-brand-id header is required for brand extraction");
  }

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": BRAND_SERVICE_API_KEY,
    "x-org-id": headers.orgId,
    "x-user-id": headers.userId,
    "x-run-id": headers.runId,
    "x-brand-id": headers.brandId,
  };
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  // The offer travels in the BODY, under brand-service's own field name, and is OMITTED when the
  // caller named none — so the request a single-offer brand produces is byte-identical to before.
  const payload: { fields: ExtractFieldItem[]; offerId?: string } = { fields };
  if (offerId) payload.offerId = offerId;

  const response = await fetchWithRetry(`${BRAND_SERVICE_URL}/orgs/brands/extract-fields`, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    const parsed = parseBrandError(text);
    throw new BrandFieldExtractionError(
      parsed.message ?? `brand-service extract-fields failed (${response.status}): ${text}`,
      response.status,
      parsed.code,
      parsed.offers,
    );
  }

  const data = await response.json() as {
    brands: Array<{ brandId: string; domain: string; name: string }>;
    fields: Record<string, ExtractedFieldResult>;
  };
  const map: Record<string, ExtractedFieldResult> = {};
  for (const [key, field] of Object.entries(data.fields)) {
    map[key] = field;
  }
  return map;
}
