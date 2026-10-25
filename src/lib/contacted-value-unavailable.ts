import { BrandOwnershipError } from "./brand-ownership.js";

/**
 * A CONTACTED lead's value needs two reads: the send dates (email-gateway `/orgs/status`, the 30-day expiry runs off
 * the last send) and the brand's contacted pricing cell (entry rates per campaign × workflow). Until 2026-10-21 both
 * were fail-soft: unreadable send dates left every contacted lead UNDATED, which reads as EXPIRED, so the Contacted
 * column (~$125 of the distribute.you offer's $236.60) silently became $0 and the pipeline dropped by that much with
 * no warning. A $0 that reads as real is a fail-loud violation (owner rule): each read is retried once, then the
 * compute throws `ContactedValueUnavailableError`. Behind the Gold cache that keeps the LAST GOOD figure served (a
 * failed refresh serves stale); a cold read answers 503 with the reason (`contactedValueUnavailableBody`).
 */
export type ContactedValueUnavailableReason =
  /** email-gateway's send dates could not be read: no contacted lead can be told live from expired. */
  | "send_dates_unreadable"
  /** The brand's contacted pricing cell (entry rates) could not be read or computed. */
  | "contacted_pricing_unreadable";

export class ContactedValueUnavailableError extends Error {
  constructor(
    readonly reason: ContactedValueUnavailableReason,
    readonly brandId: string,
    cause: string,
  ) {
    super(`contacted value unavailable for brand ${brandId} (${reason}): ${cause}`);
    this.name = "ContactedValueUnavailableError";
  }
}

/** The 503 body a route serves for it: the reason a dashboard can show, never a $0. */
export function contactedValueUnavailableBody(err: ContactedValueUnavailableError) {
  return {
    error: "The contacted leads' value cannot be computed right now; no figure is served rather than a wrong one.",
    reason: "contacted_value_unavailable" as const,
    detail: err.reason,
    brandId: err.brandId,
  };
}

/**
 * One retry, then loud. `what` names the read in the log.
 *
 * A `BrandOwnershipError` is NOT an unreadable read: brand-service ANSWERED that the caller's org does not hold
 * the brand (403) or that the brand is gone (404). That verdict is rethrown at once, as itself — never retried
 * (it cannot change in a second), never relabelled `ContactedValueUnavailableError` — so every caller keeps its
 * own ownership handling: a dashboard route refuses the foreign brand, a fleet sweep over feature memberships
 * skips the stale (org, brand) pair. Measured 2026-10-25 (CONTACTED-PRICING-403-1025): the public revenue sweep
 * walks lead-service memberships whose org no longer holds the brand (7 of the 10 brands have no owner at all),
 * and each such pair logged a retry + "contacted value UNAVAILABLE" for a cell no org could ever compute under
 * that identity, while the owners' own cells were computed fine.
 */
export async function readOrUnavailable<T>(
  brandId: string,
  reason: ContactedValueUnavailableReason,
  what: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (first) {
    if (first instanceof BrandOwnershipError) throw first;
    console.warn(`[features-service] ${what} failed for brand ${brandId}, retrying once: ${(first as Error).message}`);
    try {
      return await read();
    } catch (second) {
      if (second instanceof BrandOwnershipError) throw second;
      console.error(`[features-service] ${what} failed twice for brand ${brandId}: contacted value UNAVAILABLE (${reason})`);
      throw new ContactedValueUnavailableError(reason, brandId, (second as Error).message);
    }
  }
}
