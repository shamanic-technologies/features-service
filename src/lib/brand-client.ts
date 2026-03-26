const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL;
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY;

export interface ExtractFieldItem {
  key: string;
  description: string;
}

export interface ExtractedFieldResult {
  key: string;
  value: string | string[] | Record<string, unknown> | null;
  cached: boolean;
  extractedAt: string;
  expiresAt: string | null;
  sourceUrls: string[] | null;
}

/**
 * Call brand-service to extract fields for a brand via AI.
 * Results are cached per field for 30 days by brand-service.
 */
export async function extractBrandFields(
  brandId: string,
  fields: ExtractFieldItem[],
  headers: { orgId: string; userId: string; runId: string },
): Promise<ExtractedFieldResult[]> {
  if (!BRAND_SERVICE_URL || !BRAND_SERVICE_API_KEY) {
    throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  const response = await fetch(`${BRAND_SERVICE_URL}/brands/${brandId}/extract-fields`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": BRAND_SERVICE_API_KEY,
      "x-org-id": headers.orgId,
      "x-user-id": headers.userId,
      "x-run-id": headers.runId,
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`brand-service extract-fields failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { brandId: string; results: ExtractedFieldResult[] };
  return data.results;
}
