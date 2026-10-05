/**
 * THE ECONOMICS A READ IS PRICED ON — the offer's terms, and nothing else (owner 2026-10-05).
 *
 * Every figure is priced on the funnels the read walks (`fetchPricingFunnels`, `lib/reading-funnels.ts`):
 * each funnel carries the brand's EFFECTIVE leg rate per arrow (measured > stated > fleet median >
 * default) and the OFFER's stated lifetime revenue. This module folds those funnels into the one
 * `SalesEconomics` record the engines read.
 *
 * SUPERSEDES the brand-level sales economics as an input: brand-service's `brand_sales_economics` row
 * (and its cross-brand-average fallback) had no writer since 2026-08-03, yet every read merged the
 * funnels' terms OVER it, so a rate no priced funnel states silently came from a stale or averaged row.
 * Now a rate no priced funnel states is 0 (the route is not walked), and a read with no priced funnel
 * or an offer that states no lifetime revenue is NULL with a named reason — never an average, never a
 * default lifetime revenue.
 */

import { createHash } from "node:crypto";
import { declaredEconomicsForFunnel } from "./declared-funnels.js";
import type { SalesEconomics } from "./funnel-registry.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

/** Why a read has no economics to price on. */
export type EconomicsUnpricedReason =
  /** The scope walks no path: its campaigns perform no leg, or its funnels could not be read. */
  | "no_priced_funnel"
  /** The offer being priced states no lifetime revenue. */
  | "lifetime_revenue_not_stated";

/** Why a revenue body's pipeline is null: the economics' own reason, or the feature/scope has nothing to price. */
export type PipelineUnpricedReason = EconomicsUnpricedReason | "no_funnel_wired" | "no_channel";

/** Every `PipelineUnpricedReason`, for the OpenAPI enum. */
export const PIPELINE_UNPRICED_REASONS = ["no_priced_funnel", "lifetime_revenue_not_stated", "no_funnel_wired", "no_channel"] as const;

/** The economics a read is priced on, or null with the reason. `economics === null` ⟺ `unpricedReason !== null`. */
export interface PricedEconomics {
  economics: SalesEconomics | null;
  unpricedReason: EconomicsUnpricedReason | null;
}

/** A rate no priced funnel states: the route is not walked, so it is worth nothing (never an average). */
const UNWALKED_RATES = {
  replyToMeetingPct: 0,
  visitToMeetingPct: 0,
  meetingToClosePct: 0,
  visitToSignupPct: 0,
  signupToPaidClientPct: 0,
  visitToClosePct: 0,
  // The direct funnels' single-step rates: a 0 gates their cost to null (never a false $0), where an
  // absent one would fail a single-step lens loud for a route the customer simply does not walk.
  visitToPaidClientPct: 0,
  replyToPaidClientPct: 0,
  // The form-magnet rates stay ABSENT when unstated: their consumers read absent as "not a form brand"
  // (a null series), which is what an unwalked form route is.
} as const;

/**
 * PURE: the economics of the priced funnels — EVERY priced funnel's own terms merged in catalogue order
 * (each comes from the same per-leg effective rates, so two funnels never disagree on a field they
 * share). A rate no funnel states is 0 (the form-magnet rates and the attended-meeting rate stay absent,
 * which their consumers already read as "not walked").
 * A click route the priced paths do not walk is 0, so a path the customer never ticked cannot leak
 * into the click of the one they did.
 */
export function offerTermsEconomics(
  declared: readonly DeclaredSalesFunnel[],
  pricedFunnelKeys: readonly SalesFunnelKey[],
): PricedEconomics {
  const merged: Partial<SalesEconomics> = {};
  for (const key of pricedFunnelKeys) Object.assign(merged, declaredEconomicsForFunnel([...declared], key) ?? {});
  return economicsFromTerms(merged, pricedFunnelKeys);
}

/**
 * PURE: complete one set of already-merged funnel terms (`declaredEconomics` of the priced funnels) into
 * the record the engines read — the same rules as `offerTermsEconomics`, for a caller holding the terms.
 */
export function economicsFromTerms(
  terms: Partial<SalesEconomics> | null | undefined,
  pricedFunnelKeys: readonly SalesFunnelKey[],
): PricedEconomics {
  if (pricedFunnelKeys.length === 0) return { economics: null, unpricedReason: "no_priced_funnel" };
  const merged: Partial<SalesEconomics> = terms ?? {};
  const ltr = merged.lifetimeRevenueUsd;
  if (typeof ltr !== "number" || !Number.isFinite(ltr)) return { economics: null, unpricedReason: "lifetime_revenue_not_stated" };
  const economics: SalesEconomics = { ...UNWALKED_RATES, ...merged, lifetimeRevenueUsd: ltr };
  if (!pricedFunnelKeys.includes("website_purchases")) economics.visitToClosePct = 0;
  if (!pricedFunnelKeys.includes("sales_meetings_from_website")) economics.visitToMeetingPct = 0;
  return { economics, unpricedReason: null };
}

/** Bumped whenever what the fingerprint hashes changes meaning, so no cell keyed on the old one is served. */
const FINGERPRINT_BASIS = "offer-terms-v1";

/**
 * Stable cache fingerprint of the economics a read is ACTUALLY priced on (the Gold `scope_key` part
 * `econ`). Economics are not a query param, so without it a snapshot computed before a customer changed
 * an offer's lifetime revenue, a leg rate or the ticked paths would be served after. Different terms ⇒
 * different cell. Hashes the WHOLE object with sorted keys (a field added later is covered), and the
 * basis marker so a cell keyed on the retired brand-economics fingerprint can never match.
 */
export function economicsFingerprint(priced: PricedEconomics & { pricedFunnelKeys?: readonly SalesFunnelKey[] }): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = stable((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };
  const subject = {
    basis: FINGERPRINT_BASIS,
    economics: priced.economics,
    unpricedReason: priced.unpricedReason,
    pricedFunnelKeys: priced.pricedFunnelKeys ? [...priced.pricedFunnelKeys] : null,
  };
  return createHash("sha1").update(JSON.stringify(stable(subject))).digest("hex").slice(0, 12);
}
