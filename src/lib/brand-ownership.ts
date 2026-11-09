import { fetchWithRetry } from "./fetch-retry.js";
import { SalesFunnelsUnavailableError } from "./sales-funnels-client.js";

/**
 * The org does not hold this brand: brand-service answered 403 (the brand belongs to another
 * org) OR 404 (the brand no longer exists at all). Both mean a feature membership this service holds
 * is STALE, and every fleet-wide fan-out skips the brand rather than failing the whole read on it. A
 * deleted brand's membership row outlives the brand, so a 404 here is the ordinary case after a
 * teardown, not an outage: measured 2026-09-18, one deleted brand's `Brand not found` inside a
 * `Promise.all` took `workflow-cost-per-outcome` down for every caller.
 *
 * It EXTENDS `SalesFunnelsUnavailableError` because it is also "we could not read what this brand
 * sells": a soft pricing caller degrades on it like on any unreadable statement, while a fleet sweep
 * (or the soft pricing read, which rethrows it) still tells the stale membership apart.
 */
export class BrandOwnershipError extends SalesFunnelsUnavailableError {
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
 * Does this org HOLD this brand? brand-service owns the org → brand edge and refuses a foreign (403) or
 * gone (404) brand on its org-scoped reads; the internal `offer-economics` read every price comes from
 * does NOT (it answers any org with that org's — empty — statements). So the check is its own call:
 * the org-scoped `GET /orgs/brands/:brandId/leg-rates`, the cheapest org-scoped read of the same
 * statements. It used to ride the retired brand-level economics read for free (owner 2026-10-05).
 *
 * Resolves when held; throws `BrandOwnershipError` on 403/404; fails loud on anything else.
 */
export async function assertBrandHeld(
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<void> {
  if (!headers.orgId) throw new Error("brand ownership check requires the org (x-org-id); features-service will not pick one");
  const holdMs = ownershipHoldMs();
  if (holdMs <= 0) return checkBrandHeld(brandId, headers);
  const key = `${headers.orgId}|${brandId}`;
  const now = Date.now();
  const held = heldOwnership.get(key);
  if (held && now - held.at < OWNERSHIP_SERVE_STALE_MS) {
    // Held: answered now; past the hold it is re-checked BEHIND the answer, once.
    if (now - held.at >= holdMs && !held.rechecking) {
      held.rechecking = true;
      checkBrandHeld(brandId, headers).then(
        () => heldOwnership.set(key, { at: Date.now(), rechecking: false }),
        (err: unknown) => {
          // A refusal ends the hold at once (the next read answers 404); an outage keeps it and retries next read.
          if (err instanceof BrandOwnershipError) heldOwnership.delete(key);
          else held.rechecking = false;
          console.error(`[features-service] brand ownership re-check failed for ${key}: ${(err as Error).message}`);
        },
      );
    }
    return;
  }
  const pending = inFlightOwnership.get(key);
  if (pending) return pending;
  const check = checkBrandHeld(brandId, headers)
    .then(() => {
      heldOwnership.set(key, { at: Date.now(), rechecking: false });
      if (heldOwnership.size > 10_000) for (const [k, v] of heldOwnership) if (Date.now() - v.at >= OWNERSHIP_SERVE_STALE_MS) heldOwnership.delete(k);
    })
    .finally(() => inFlightOwnership.delete(key));
  inFlightOwnership.set(key, check);
  return check;
}

/**
 * A HELD "yes" (DASH-SPEED-1110). Every brand and offer read the dashboard polls (revenue every 5 s, Deals,
 * Companies, campaign money) asked brand-service this same question on the request path before its O(1)
 * cell lookup, so each poll waited on a sibling round trip that, on a loaded box, is the slow part of the
 * answer. Who holds a brand moves only on a brand transfer (`dropBrandOwnershipHolds`, called by it) or a
 * teardown, so a "yes" is held `BRAND_OWNERSHIP_HOLD_MS` (60 s) and re-checked behind the answer up to
 * 10 min; a refusal (403/404) or an error is never held. `BRAND_OWNERSHIP_HOLD_MS=0` = ask every read.
 */
const OWNERSHIP_SERVE_STALE_MS = 10 * 60_000;
const heldOwnership = new Map<string, { at: number; rechecking: boolean }>();
const inFlightOwnership = new Map<string, Promise<void>>();

function ownershipHoldMs(): number {
  const raw = process.env.BRAND_OWNERSHIP_HOLD_MS;
  if (raw === undefined || raw === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/** Forget every held "yes" of these orgs (a brand transfer moved a brand between them). */
export function dropBrandOwnershipHolds(orgIds: readonly string[]): number {
  let dropped = 0;
  for (const key of heldOwnership.keys()) {
    if (orgIds.some((org) => key.startsWith(`${org}|`))) {
      heldOwnership.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/** Test seam. */
export function __resetBrandOwnershipHolds(): void {
  heldOwnership.clear();
  inFlightOwnership.clear();
}

async function checkBrandHeld(
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<void> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  if (!headers.orgId) throw new Error("brand ownership check requires the org (x-org-id); features-service will not pick one");
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  const response = await fetchWithRetry(`${url}/orgs/brands/${encodeURIComponent(brandId)}/leg-rates`, { headers: reqHeaders });
  if (response.ok) {
    await response.arrayBuffer(); // release the connection: an unread body holds its socket until GC
    return;
  }
  const text = await response.text();
  if (response.status === 403 || response.status === 404) {
    throw new BrandOwnershipError(brandId, headers.orgId, `brand-service leg-rates ownership check failed (${response.status}): ${text}`);
  }
  throw new Error(`brand-service leg-rates ownership check failed (${response.status}): ${text}`);
}
