import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Per-audience conversion attribution primitive.
 *
 * lead-service is the conversion tracker's source of truth: it records conversion events and
 * attributes each attributed one to a lead we emailed for the brand. It exposes, per brand + event
 * type, the set of MATCHED-LEAD canonical emails (the emails-we-served identity) that produced an
 * attributed conversion — the exact key features-service already joins audiences on (human-service
 * audience membership is by email). So the per-audience conversion count = |audience member emails ∩
 * this set|, the SAME membership-intersection features-service uses for per-audience clicks / replies
 * (real producer-side attribution — NOT a split of the brand total, NOT hashing).
 *
 * Contract ownership: lead-service OWNS the endpoint path, query param, and response shape. This
 * reader conforms to the deployed shape (verified via the API registry — live > source). It reads a
 * `{ emails: string[] }` body and normalises (lowercase + trim) so the membership intersection is
 * case-insensitive regardless of how either side stores addresses. If lead-service ships a different
 * field name, conform HERE (the caller degrades to absent until then — see the soft wrapper).
 *
 * Fail-loud: a swallowed error would fabricate "zero form submissions" for an audience → a false
 * cost-per-form-submission. Any missing config / transport / non-OK / malformed response throws; the
 * audience-stats caller decides whether to degrade the per-audience form-submission column to ABSENT
 * (display enrichment, like the /revenue conversion-counts tiles) vs propagate.
 */

/** A lead-service conversion event type (byte-equal the conversion tracker's `event` vocabulary). */
export type ConversionEvent = "signup" | "meeting_booked" | "form_submission" | "purchase";

/**
 * Fetch the distinct matched-lead canonical emails (lowercased) that have >=1 attributed conversion
 * of `event` for the brand. Returns a Set for O(1) membership intersection. Empty set when the brand
 * has none (never a 404/500 from the producer for an unknown-but-valid brand).
 */
export async function fetchConversionEmails(brandId: string, event: ConversionEvent): Promise<Set<string>> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({ event });
  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/conversion-emails?${params}`,
    { headers: { "x-api-key": apiKey, "x-service-name": "features-service" } },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`lead-service /internal/brands/:brandId/conversion-emails failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { emails?: unknown };
  if (!Array.isArray(data.emails)) {
    throw new Error("lead-service /internal/brands/:brandId/conversion-emails returned no emails array");
  }
  const result = new Set<string>();
  for (const raw of data.emails) {
    if (typeof raw !== "string") {
      throw new Error("lead-service /internal/brands/:brandId/conversion-emails returned a non-string email");
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized) result.add(normalized);
  }
  return result;
}
