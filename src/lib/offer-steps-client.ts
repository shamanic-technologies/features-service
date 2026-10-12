/**
 * THE STEPS AN OFFER'S BUSINESS HAS (owner 2026-10-12): brand-service
 * `GET /orgs/brands/:brandId/offers/:offerId/steps` (service key + `x-org-id`), shape as brand-service
 * DEPLOYS it (v0.83.26): `{ offerId, stated, steps, statedAt }`. `stated:false` + `steps:null` = the offer
 * never said (nothing known, nothing filtered); `stated:true` = `steps` is every step key its business has.
 *
 * Read FAIL-LOUD (`OfferStepsUnreadableError`, served 502 `offer_steps_unreadable`): a swallowed read would
 * propose funnels through a step the client said its business does not have (Doc Dinners 2026-10-12, two
 * Direct-purchase funnels created on an offer that has no purchase step).
 */

import { fetchWithRetry } from "./fetch-retry.js";

export interface OfferSteps {
  offerId: string;
  stated: boolean;
  /** Null exactly when `stated` is false. */
  steps: string[] | null;
  statedAt: string | null;
}

export class OfferStepsUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferStepsUnreadableError";
  }
}

/** brand-service answered 404: the offer is not on this (org, brand). */
export class OfferStepsOfferNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferStepsOfferNotFoundError";
  }
}

export async function fetchOfferSteps(
  brandId: string,
  offerId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<OfferSteps> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) throw new OfferStepsUnreadableError("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  if (!headers.orgId) throw new OfferStepsUnreadableError("an offer's steps are read for its org (x-org-id); features-service will not pick one");
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  let response: Response;
  try {
    response = await fetchWithRetry(`${url}/orgs/brands/${encodeURIComponent(brandId)}/offers/${encodeURIComponent(offerId)}/steps`, { headers: reqHeaders });
  } catch (err) {
    throw new OfferStepsUnreadableError(`brand-service offer steps read failed: ${(err as Error).message}`);
  }
  const text = await response.text();
  // 404: the offer is not on the brand; 403: the caller's org does not hold the brand. Both = not this org's offer.
  if (response.status === 404 || response.status === 403) {
    throw new OfferStepsOfferNotFoundError(`brand-service (${response.status}): offer ${offerId} of brand ${brandId} is not held by the caller's org (${text})`);
  }
  if (!response.ok) throw new OfferStepsUnreadableError(`brand-service offer steps read failed (${response.status}): ${text}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OfferStepsUnreadableError(`brand-service offer steps read answered non-JSON: ${text.slice(0, 200)}`);
  }
  const b = body as Partial<OfferSteps>;
  if (typeof b.stated !== "boolean") throw new OfferStepsUnreadableError(`brand-service offer steps read: no boolean "stated" in ${text.slice(0, 200)}`);
  if (b.stated && (!Array.isArray(b.steps) || b.steps.some((s) => typeof s !== "string"))) {
    throw new OfferStepsUnreadableError(`brand-service offer steps read: stated without a step list in ${text.slice(0, 200)}`);
  }
  return { offerId, stated: b.stated, steps: b.stated ? (b.steps as string[]) : null, statedAt: typeof b.statedAt === "string" ? b.statedAt : null };
}
