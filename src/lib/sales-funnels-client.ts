/**
 * THE SHAPE EVERY PRICING MODULE READS A FUNNEL IN — and the errors a pricing read raises.
 *
 * WAVE C1 (2026-09-25): the read of the funnels a brand DECLARED (brand-service
 * `GET /internal/brands/:brandId/sales-funnels`) is GONE from this service. A pricing read now builds
 * the funnels it walks from the scope's campaign LEGS, the brand's per-leg rates and the offer's lifetime
 * revenue (`reading-funnels.ts`), and hands them on in this same shape, so the pricing math downstream
 * did not move. The error types stay: "we could not read what this scope sells" and "the brand sells
 * several offers and this read named none" are still the two answers a pricing caller acts on.
 */

import type { DeclaredFunnelLeg } from "./funnel-leg-rates.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

/** Raised when the declared-funnel read cannot be answered — the caller surfaces it as its own 502
 * reason rather than a generic downstream failure, so "we could not read the authorized set" stays
 * distinguishable from "the brand authorizes nothing". */
export class SalesFunnelsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesFunnelsUnavailableError";
  }
}

/** One offer of a brand, as brand-service names it when it refuses to pick between them. */
export interface DeclaredOffer {
  offerId: string;
  name: string | null;
}

/**
 * The brand sells SEVERAL offers and this read named none, so brand-service refused (409
 * `SEVERAL_OFFERS`) rather than serve one proposition's rates under another's name.
 *
 * This is NOT an outage and it is NOT a producer gap — it is a QUESTION WITH SEVERAL ANSWERS, and
 * telling it apart from the other two is the whole point of the subclass. A caller that can name the
 * offer (a campaign sells exactly one, so `?campaignId=` names it transitively) retries with it and
 * gets a real answer; a caller that genuinely cannot must DEGRADE and say so, never 502 and never
 * substitute one offer's economics.
 *
 * It EXTENDS `SalesFunnelsUnavailableError` on purpose: every existing `instanceof` catch — the
 * fail-soft `/revenue` path above all — keeps behaving exactly as it did, so a brand selling one
 * offer and a brand whose read merely failed are both byte-unchanged.
 */
export class SeveralOffersDeclaredError extends SalesFunnelsUnavailableError {
  constructor(
    message: string,
    readonly offers: DeclaredOffer[],
  ) {
    super(message);
    this.name = "SeveralOffersDeclaredError";
  }
}

/** What a consumer is told when the declaration could not be resolved to ONE offer's terms. */
export interface DeclaredFunnelsUnresolved {
  /** Machine-readable; the only value today. Never prose a consumer has to match on. */
  reason: "several_offers";
  /** brand-service's own sentence, rendered verbatim so the two services say one thing. */
  message: string;
  /** The offers it refused to choose between — what a consumer needs to let someone pick one. */
  offers: DeclaredOffer[];
}

/** The wire block for a read that had to degrade, or `null` for any other failure. */
export function describeSeveralOffers(error: unknown): DeclaredFunnelsUnresolved | null {
  if (!(error instanceof SeveralOffersDeclaredError)) return null;
  return { reason: "several_offers", message: error.message, offers: error.offers };
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

/** Re-exported so callers name the funnel type from one place. */
export type { SalesFunnelKey };
