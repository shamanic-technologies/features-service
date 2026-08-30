/**
 * The sales funnels a brand DECLARES it sells through — brand-service's
 * `GET /internal/brands/:brandId/sales-funnels` (api-key + `x-org-id`, brandId in path). This is the
 * AUTHORIZED SET the goal arbitration ranks over.
 *
 * WHICH ORG'S ANSWER — a brand row is a SHARED GLOBAL IDENTITY (any org that claims the same domain
 * lands on the same brand id), so what a brand sells through is the data of an (org, brand) PAIR, not
 * of the brand alone. Two orgs claiming one domain legitimately sell different things at different
 * rates, and there is no single answer to give: brand-service refuses to guess for a brand several
 * orgs claim, so the ORG WHOSE ANSWER WE WANT is a REQUIRED argument here and travels as `x-org-id`.
 * Never resolve it to a stand-in — an org picked on brand-service's behalf is exactly the cross-org
 * leak this closes. A caller with no org has no question to ask, so `orgId` is fail-loud.
 *
 * SHAPE IS THE PRODUCER'S. Everything below conforms to what brand-service actually deploys; nothing
 * here is authored by features-service. A funnel is ONE funnel from the first signal outreach can buy
 * (a positive reply, or a click onto the site) down to a paid client, and it carries the goal it
 * optimizes for plus the economics that funnel is priced on.
 *
 * Three of brand-service's rules are load-bearing here and must not be softened:
 *  - **Nothing is defaulted.** A value the brand never declared reads `null`, which never means zero.
 *  - **An EMPTY list is a PRODUCER GAP, not an answer.** It means this org has never stated what it
 *    sells through. Reporting it as "the brand authorizes nothing" would put an answer in the org's
 *    mouth it never gave. "Answered, but sells through nothing" does not exist: brand-service refuses
 *    to switch off an org's last active funnel, so having answered always leaves at least one.
 *  - **Never substitute a plausible set** and do NOT derive one from the brand's stored economics —
 *    every rate on the brand-wide economics row is NOT NULL with a server default, so a brand that
 *    configured nothing still reads back plausible-looking numbers there and no absence signals
 *    anything.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import type { DeclaredFunnelLeg } from "./funnel-leg-rates.js";
import { matchSalesFunnelKey, SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";

/** Raised when the declared-funnel read cannot be answered — the caller surfaces it as its own 502
 * reason rather than a generic downstream failure, so "we could not read the authorized set" stays
 * distinguishable from "the brand authorizes nothing". */
export class SalesFunnelsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesFunnelsUnavailableError";
  }
}

/**
 * One declared funnel, exactly as brand-service serves it. Absent values are `null`, never invented.
 *
 * NO `goal` / `currentGoal`: brand-service retired the goal from every funnel read (#434). It was the
 * poorer word — `sales_meetings_from_conversation` and `sales_meetings_from_website` both collapsed onto
 * one `meetingBooked`, so a meeting won from a reply could not be priced apart from one won on the
 * website. `funnelKey` is the whole answer, and it is what this service prices on.
 */
export interface DeclaredSalesFunnel {
  funnelKey: SalesFunnelKey;
  /** Whether the org currently sells through this funnel. The INTERNAL read serves only active ones. */
  active?: boolean;
  name: string;
  steps: string[];
  /** Exactly the rates THIS funnel's funnel prices, in funnel order. Values may be null (undeclared). */
  rates: Record<string, number | null>;
  /**
   * The funnel read LEG BY LEG — one entry per arrow, identified by the two steps it connects, each
   * carrying the rate that arrow converts at and where that rate came from (`stated_arrow` /
   * `named_rate` / `unstated`). This is what lets a funnel gain a step without every service in the
   * chain growing a field for it: a leg no named rate can express still states its own rate.
   *
   * OPTIONAL, and its absence is the no-change path rather than a gap: a payload without it is priced
   * on the named `rates` exactly as before. See `funnel-leg-rates.ts` for the precedence.
   */
  arrows?: DeclaredFunnelLeg[];
  lifetimeRevenueUsd: number | null;
  destinationUrl: string | null;
  bookingUrl: string | null;
  updatedAt: string;
}

/** Raised when brand-service serves a funnel key this service has no funnel for. Fails loud: pricing a
 * funnel we cannot model would put a number under a name we do not understand, and dropping it would
 * silently rank a smaller set than the brand declared. */
export class UnknownSalesFunnelError extends Error {
  constructor(readonly raw: string) {
    super(`brand-service declared sales funnel "${raw}" is not in the known catalogue`);
    this.name = "UnknownSalesFunnelError";
  }
}

/**
 * Read the funnels a brand declared, FOR ONE ORG — `orgId` names whose configuration is wanted and is
 * required (see the org note at the top of this file). Fails loud
 * (`SalesFunnelsUnavailableError`) on any transport / non-OK response — including the 404 a
 * brand-service that predates the funnel model returns, which is exactly the dormant state the
 * arbitration must report rather than paper over — AND on an EMPTY list, which says this org has
 * never stated a set.
 */
export async function fetchDeclaredSalesFunnels(
  brandId: string,
  orgId: string,
  /**
   * WHICH offer's funnels — and therefore whose lifetime revenue and whose rates. A declared funnel
   * hangs off an OFFER, because a brand selling a $200 self-serve plan and a $20k contract converts
   * and is worth completely different numbers on the same funnel (brand-service#473).
   *
   * Omitted keeps today's answer for every brand selling one thing, which is 100% of live traffic:
   * brand-service resolves the sole offer, and refuses (409) for a brand selling several rather than
   * guessing. Only a caller that genuinely knows which proposition it is pricing names one.
   */
  offerId?: string | null,
): Promise<DeclaredSalesFunnel[]> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new SalesFunnelsUnavailableError("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }
  // A missing org is a missing QUESTION, not a value to substitute: brand-service cannot answer "what
  // does this brand sell through" without knowing whose claim we mean, and picking one here is the
  // cross-org leak. Fail loud rather than send the read org-less.
  if (!orgId) {
    throw new SalesFunnelsUnavailableError(
      "declared sales-funnels read requires the org whose configuration is wanted (x-org-id); features-service will not pick one",
    );
  }

  let response: Response;
  try {
    const query = offerId ? `?offerId=${encodeURIComponent(offerId)}` : "";
    response = await fetchWithRetry(`${url}/internal/brands/${brandId}/sales-funnels${query}`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId },
    });
  } catch (error) {
    throw new SalesFunnelsUnavailableError(
      `brand-service declared sales-funnels read failed: ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new SalesFunnelsUnavailableError(
      `brand-service declared sales-funnels read failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as { funnels?: unknown };
  if (!Array.isArray(data.funnels)) {
    throw new SalesFunnelsUnavailableError(
      "brand-service sales-funnels response carried no `funnels` array",
    );
  }
  // The LIST answers it on its own. An org that has told us what it sells through always keeps at
  // least one funnel active — brand-service refuses to switch off the last one — so "answered but
  // sells through nothing" cannot occur, and an empty list means only that this org has never
  // answered. That is a producer gap to surface, never a brand stating it sells through none.
  //
  // This used to read a separate `declared` boolean. It said exactly what the list says, and it is
  // being retired: brand-service still serves it only because this refused a payload without it.
  if (data.funnels.length === 0) {
    throw new SalesFunnelsUnavailableError(
      "brand-service reports no sales funnel for this brand — the org has never stated what it sells through, a producer gap",
    );
  }
  // Canonicalise the key. brand-service emits only the canonical four, but it accepts the
  // pre-retirement spellings forever on write, so resolving them here costs nothing and means a stored
  // row that predates its rename can never read back as an unknown funnel. An unrecognised key FAILS
  // LOUD — see UnknownSalesFunnelError.
  return (data.funnels as Array<Record<string, unknown>>).map((raw) => {
    const rawKey = typeof raw.funnelKey === "string" ? raw.funnelKey : "";
    const funnelKey = matchSalesFunnelKey(rawKey);
    if (!funnelKey) throw new UnknownSalesFunnelError(rawKey || JSON.stringify(raw));
    return {
      ...(raw as unknown as DeclaredSalesFunnel),
      funnelKey,
      // brand-service always names the funnel; fall back to the catalogue's own label rather than
      // leaving the ranking with a blank row if it ever does not.
      name: typeof raw.name === "string" && raw.name !== "" ? raw.name : SALES_FUNNELS[funnelKey].name,
    } satisfies DeclaredSalesFunnel;
  });
}

/** Re-exported so callers name the funnel type from one place. */
export type { SalesFunnelKey };
