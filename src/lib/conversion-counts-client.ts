import { fetchWithRetry } from "./fetch-retry.js";

/**
 * REAL per-brand attributed conversion counts from lead-service — the conversion-tracker source of
 * truth. Deduped + attributed by lead-service; excludes "ping". All four keys are ALWAYS present
 * (0 when the brand has none). These are tracked events, NOT a projection.
 */
export interface ConversionCounts {
  signup: number;
  meeting_booked: number;
  form_submission: number;
  purchase: number;
}

/**
 * Fetch the brand's real attributed conversion counts from lead-service
 * `GET /internal/brands/{brandId}/conversion-counts` (service-auth: x-api-key + x-service-name).
 *
 * Org-less internal read — the brand is in the path, so no x-org-id / user identity is forwarded
 * (mirrors accounts-client's `/internal/...` platform reads). features-service consumes the counts
 * verbatim; it does NOT own or default them.
 *
 * Fails loud on missing config / transport / non-OK / malformed — a swallowed error would fake a
 * count → a false CPS/CPSM. The Overview caller (`fetchConversionCountsSoft`) decides whether to
 * degrade the display tile to "absent" vs propagate, exactly as it does for the sequences series.
 */
export async function fetchConversionCounts(brandId: string): Promise<ConversionCounts> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/conversion-counts`,
    { headers: { "x-api-key": apiKey, "x-service-name": "features-service" } },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`lead-service /internal/brands/:brandId/conversion-counts failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { counts?: Partial<ConversionCounts> };
  const c = data.counts;
  if (
    !c ||
    typeof c.signup !== "number" ||
    typeof c.meeting_booked !== "number" ||
    typeof c.form_submission !== "number" ||
    typeof c.purchase !== "number"
  ) {
    throw new Error("lead-service /internal/brands/:brandId/conversion-counts returned malformed counts");
  }
  return {
    signup: c.signup,
    meeting_booked: c.meeting_booked,
    form_submission: c.form_submission,
    purchase: c.purchase,
  };
}
