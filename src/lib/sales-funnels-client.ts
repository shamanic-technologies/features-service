/**
 * The sales funnels a brand DECLARES it sells through — brand-service's
 * `GET /internal/brands/:brandId/sales-funnels` (api-key, brandId in path, NO org context; built for
 * the schedulers). This is the AUTHORIZED SET the goal arbitration ranks over.
 *
 * SHAPE IS THE PRODUCER'S. Everything below conforms to what brand-service actually deploys; nothing
 * here is authored by features-service. A funnel is ONE chain from the first signal outreach can buy
 * (a positive reply, or a click onto the site) down to a paid client, and it carries the goal it
 * optimizes for plus the economics that chain is priced on.
 *
 * Two of brand-service's rules are load-bearing here and must not be softened:
 *  - **Nothing is defaulted.** A value the brand never declared reads `null`, which never means zero.
 *  - **An EMPTY array means the brand declared nothing.** Do NOT substitute a plausible set and do NOT
 *    derive one from the brand's stored economics — every rate on the brand-wide economics row is
 *    NOT NULL with a server default, so a brand that configured nothing still reads back
 *    plausible-looking numbers there and no absence signals anything.
 */

import { fetchWithRetry } from "./fetch-retry.js";

/** Raised when the declared-funnel read cannot be answered — the caller surfaces it as its own 502
 * reason rather than a generic downstream failure, so "we could not read the authorized set" stays
 * distinguishable from "the brand authorizes nothing". */
export class SalesFunnelsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesFunnelsUnavailableError";
  }
}

/** One declared funnel, exactly as brand-service serves it. Absent values are `null`, never invented. */
export interface DeclaredSalesFunnel {
  funnelKey: string;
  name: string;
  steps: string[];
  /** brand-service's OWN wire goal for the funnel (`booked_meetings`, `form_submissions`, …). */
  goal: string;
  /** The runtime token. NOTE it is LOSSY for our purposes — brand-service deliberately collapses
   * `form_submissions` onto `signup` here — so the arbitration reads `goal` first (see
   * authorized-goals.ts) and only falls back to this. */
  currentGoal: string;
  /** Exactly the rates THIS funnel's chain prices, in chain order. Values may be null (undeclared). */
  rates: Record<string, number | null>;
  lifetimeRevenueUsd: number | null;
  destinationUrl: string | null;
  bookingUrl: string | null;
  updatedAt: string;
}

/**
 * Read the funnels a brand declared. Fails loud (`SalesFunnelsUnavailableError`) on any transport /
 * non-OK response — including the 404 a brand-service that predates the funnel model returns, which is
 * exactly the dormant state the arbitration must report rather than paper over. `[]` is a SUCCESS: the
 * brand declared nothing.
 */
export async function fetchDeclaredSalesFunnels(brandId: string): Promise<DeclaredSalesFunnel[]> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new SalesFunnelsUnavailableError("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }

  let response: Response;
  try {
    response = await fetchWithRetry(`${url}/internal/brands/${brandId}/sales-funnels`, {
      headers: { "x-api-key": apiKey },
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
      "brand-service declared sales-funnels response carried no `funnels` array",
    );
  }
  return data.funnels as DeclaredSalesFunnel[];
}
