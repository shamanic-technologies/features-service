/**
 * GROSS vs NET pricing selector for the customer-facing cost-metric stat endpoints
 * (`/revenue`, `/stats`, `/audience-stats`, `/workflow-projection`, `/pipeline-activity`).
 *
 * The platform can grant an org a per-org USAGE DISCOUNT (a percentage, owned by billing-service). A
 * discounted org's dashboard must be able to see its cost metrics at the NET (discounted) price it
 * actually pays, so the numbers stay coherent with the "you have X% off" banner. Staff / internal
 * reporting want the GROSS (real, undiscounted) numbers — so GROSS is the DEFAULT and every existing
 * caller (which sends no selector) is byte-identical to today.
 *
 * HOW the discount is applied — at the COST INPUT, never the output. Every money metric on these
 * endpoints (total spent, CPC, cost-per-outcome / -close, CAC, ROI, revenue spend, projected budget)
 * is DERIVED from the run/cost cents read from runs-service. So multiplying that cents input by the
 * discount factor once, at the point cost enters each compute, makes EVERY derived money figure come
 * out net AND coherent by construction: CPC and total-spent scale down by the factor, CAC scales down,
 * ROI scales UP (cost in the denominator), all from one multiplication — no field-by-field post-hoc
 * classification, no risk of getting ROI's direction wrong. Counts, conversion rates, and
 * probabilities never touch cost, so they are unchanged.
 *
 * The default factor is 1.0 (gross): every cost producer takes `discountFactor = 1`, so omitting the
 * selector changes nothing.
 */
import { fetchOrgUsageDiscountPct } from "./billing-discount-client.js";

export type Pricing = "gross" | "net";

/**
 * Parse the `?pricing=` query param. Absent / empty → "gross" (the default — backward-compatible).
 * Returns null for any other value so the caller can 400 (NO Zod `.default()`, NO silent coercion).
 */
export function parsePricing(raw: unknown): Pricing | null {
  if (raw === undefined || raw === null || raw === "") return "gross";
  if (raw === "gross" || raw === "net") return raw;
  return null;
}

/**
 * Resolve the multiplicative cost factor for a request.
 *   - GROSS → 1 (no billing call — the default path has ZERO billing dependency).
 *   - NET   → 1 − discountPct/100, discountPct read from billing-service (fail-loud).
 *
 * Fail-loud (No silent fallback): if NET is requested but billing can't resolve the org's discount,
 * this THROWS → the request 502s. It never falls back to gross under a net request. A non-discounted
 * org resolves to discountPct 0 → factor 1 → NET == GROSS (per the AC), because billing returns 0
 * (not an error) for a known org with no discount.
 */
export async function resolveDiscountFactor(pricing: Pricing, orgId: string): Promise<number> {
  if (pricing === "gross") return 1;
  const pct = await fetchOrgUsageDiscountPct(orgId);
  return 1 - pct / 100;
}

/** Apply a discount factor to a USD-cents amount, rounding to whole cents (mirrors the runs-cost reads). */
export function discountCents(cents: number, factor: number): number {
  return Math.round(cents * factor);
}
