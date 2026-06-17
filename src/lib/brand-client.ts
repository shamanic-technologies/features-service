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

export interface BrandPersona {
  id: string;
  brandId: string;
  name: string;
  filters: Record<string, string[]>;
  status: "active" | "paused" | "archived";
  createdAt: string;
}

export interface BrandProfileVersion {
  id: string;
  brandId: string;
  version: number;
  fields: Record<string, string | string[]>;
  createdAt: string;
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

  const response = await fetchWithRetry(`${BRAND_SERVICE_URL}/orgs/brands/extract-fields`, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service extract-fields failed (${response.status}): ${text}`);
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

function buildBrandHeaders(headers: {
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
}): Record<string, string> {
  if (!BRAND_SERVICE_API_KEY) {
    throw new Error("BRAND_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "x-api-key": BRAND_SERVICE_API_KEY,
    "x-org-id": headers.orgId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.brandId) reqHeaders["x-brand-id"] = headers.brandId;
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;
  return reqHeaders;
}

export async function fetchBrandPersonas(
  brandId: string,
  headers: {
    orgId: string;
    userId?: string;
    runId?: string;
    campaignId?: string;
    featureSlug?: string;
  },
): Promise<BrandPersona[]> {
  if (!BRAND_SERVICE_URL || !BRAND_SERVICE_API_KEY) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(`${BRAND_SERVICE_URL}/orgs/brands/${brandId}/personas`, {
    headers: buildBrandHeaders({ ...headers, brandId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service personas failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { personas: BrandPersona[] };
  return data.personas;
}

export async function fetchCurrentBrandProfile(
  brandId: string,
  headers: {
    orgId: string;
    userId?: string;
    runId?: string;
    campaignId?: string;
    featureSlug?: string;
  },
): Promise<BrandProfileVersion | null> {
  if (!BRAND_SERVICE_URL || !BRAND_SERVICE_API_KEY) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(`${BRAND_SERVICE_URL}/orgs/brands/${brandId}/brand-profile`, {
    headers: buildBrandHeaders({ ...headers, brandId }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service brand-profile failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { current: BrandProfileVersion | null };
  return data.current;
}
