/**
 * Org USAGE DISCOUNT percentage, from billing-service (the owner of the discount).
 *
 * The platform can grant an org a per-org usage discount (a percentage, e.g. 50%, applied to what a
 * discounted org actually pays). features-service reads it — user-less, api-key only, org in the path —
 * to render the customer dashboard's cost metrics at their NET (discounted) price (see lib/pricing.ts).
 *
 * Producer contract (billing-service): `GET /internal/accounts/by-org/:orgId/usage-discount` →
 * `{ discount_percent: number }` in [0, 100]. A KNOWN org with no discount returns 0 (NOT 404) — so a
 * non-discounted org resolves to a 0% discount = no change. billing OWNS this endpoint + the value;
 * features-service does NOT default, guess, or fabricate it.
 *
 * Fail-loud (No silent fallback): any transport / non-OK / malformed / out-of-range / 404 response
 * THROWS → the NET request 502s. A swallowed error would silently serve GROSS numbers under a NET
 * request (the dashboard would show undiscounted prices next to a "you have X% off" banner) — worse
 * than an error. GROSS requests never call this (no billing dependency on the default path).
 *
 * NOTE (conform-on-ship): this endpoint does not exist in billing-service yet (billing-service GAP —
 * flagged + spawned). The path/field above are the features-service-side NEED; if billing ships a
 * different path/shape, CONFORM this client to the deployed contract (producer owns its shape). Until
 * billing ships it, NET requests fail loud here — GROSS (the default) is unaffected.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export async function fetchOrgUsageDiscountPct(orgId: string): Promise<number> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(`${url}/internal/accounts/by-org/${orgId}/usage-discount`, {
    headers: { "x-api-key": apiKey },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[features-service] billing-service /internal/accounts/by-org/:orgId/usage-discount failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as { discount_percent?: unknown };
  const pct = Number(data.discount_percent);
  if (!Number.isFinite(pct)) {
    throw new Error(
      `[features-service] billing-service usage-discount returned non-numeric discount_percent: ${JSON.stringify(data.discount_percent)}`,
    );
  }
  if (pct < 0 || pct > 100) {
    throw new Error(
      `[features-service] billing-service usage-discount out of range [0,100]: ${pct} (org ${orgId})`,
    );
  }
  return pct;
}
