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
 * here is authored by features-service. A funnel is ONE chain from the first signal outreach can buy
 * (a positive reply, or a click onto the site) down to a paid client, and it carries the goal it
 * optimizes for plus the economics that chain is priced on.
 *
 * Three of brand-service's rules are load-bearing here and must not be softened:
 *  - **Nothing is defaulted.** A value the brand never declared reads `null`, which never means zero.
 *  - **READ `declared` BEFORE `funnels`.** `declared: true` with an EMPTY array is the brand STATING it
 *    sells through none — a real answer. `declared: false` is brand-service saying no set has ever been
 *    stated for this brand — a PRODUCER GAP, and reporting it as "the brand authorizes nothing" would
 *    put an answer in the brand's mouth it never gave. The two payloads are byte-identical on
 *    `funnels`, so the flag is the ONLY thing that separates them: never infer it from the list.
 *  - **Never substitute a plausible set** and do NOT derive one from the brand's stored economics —
 *    every rate on the brand-wide economics row is NOT NULL with a server default, so a brand that
 *    configured nothing still reads back plausible-looking numbers there and no absence signals
 *    anything.
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
 * Read the funnels a brand declared, FOR ONE ORG — `orgId` names whose configuration is wanted and is
 * required (see the org note at the top of this file). Fails loud
 * (`SalesFunnelsUnavailableError`) on any transport / non-OK response — including the 404 a
 * brand-service that predates the funnel model returns, which is exactly the dormant state the
 * arbitration must report rather than paper over — AND on `declared: false`, brand-service stating that
 * no set has ever been declared for this brand. Only `declared: true` is an answer, and `[]` under it
 * is a SUCCESS: the brand declared nothing.
 */
export async function fetchDeclaredSalesFunnels(brandId: string, orgId: string): Promise<DeclaredSalesFunnel[]> {
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
    response = await fetchWithRetry(`${url}/internal/brands/${brandId}/sales-funnels`, {
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

  const data = (await response.json()) as { declared?: unknown; funnels?: unknown };
  if (!Array.isArray(data.funnels)) {
    throw new SalesFunnelsUnavailableError(
      "brand-service declared sales-funnels response carried no `funnels` array",
    );
  }
  // The flag is REQUIRED on the producer's contract, and it is the only thing that distinguishes
  // "the brand stated it sells through none" from "no set has ever been stated". A payload without it
  // cannot answer that question at all, so it is unreadable — never assumed either way.
  if (typeof data.declared !== "boolean") {
    throw new SalesFunnelsUnavailableError(
      "brand-service declared sales-funnels response carried no `declared` flag, so whether this brand has ever stated a set cannot be read",
    );
  }
  if (!data.declared) {
    throw new SalesFunnelsUnavailableError(
      "brand-service reports no sales funnel has ever been declared for this brand (declared: false) — a producer gap, not the brand stating it sells through none",
    );
  }
  return data.funnels as DeclaredSalesFunnel[];
}
