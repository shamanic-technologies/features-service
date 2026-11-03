/**
 * THE FUNNEL COUNTS OF THE CLIENTS WE NAME ON OUR OWN HOMEPAGE — public, org-less, and the brands are
 * decided HERE.
 *
 * The apex page names real clients in TWO places — a row of live cards in the hero and a proof section
 * under it — and states, for each, how many people we contacted and how many of them reached each
 * subsequent step of that client's funnel. Those numbers were read out of production by hand on
 * 2026-09-06 and pasted into the page as literals. Nothing refreshes them, the page renders perfectly
 * either way, and the page nudges the counters in-session for a live feel — so a reader watching a
 * number climb is watching an invented increment climb from a frozen base. This is the read that makes
 * them true.
 *
 * ── THE BRANDS ARE THE SERVICE'S DECISION, NEVER THE CALLER'S ───────────────────────────────────
 *
 * There is deliberately NO request parameter naming a brand anywhere on this surface. This is an
 * unauthenticated read of NAMED CLIENTS' funnel figures; a caller-supplied identifier would turn the
 * same route into a way to read any brand's funnel with no session at all. That property is unchanged.
 *
 * WHAT CHANGED IS WHO DECIDES THE LIST. It used to be a frozen constant of three brand ids, curated by
 * hand and therefore ageing in public exactly as the numbers did. It is now A RANKING this service
 * computes — the most recently begun clients that have produced an outcome — in
 * `lib/showcase-clients.ts`, off the persisted fleet snapshot, and not reachable by a caller (the
 * best-return group is deleted, ROI-CONSISTENCY-1103: a return exists only where a value lands). The page refreshes on its own and nobody
 * adds a client by hand.
 *
 * ── THE PAGE DIVIDES NOTHING, AND "WE HAVE NO FIGURE" IS SAID OUT LOUD ──────────────────────────
 *
 * The page renders what is served and computes nothing — no rate, no division, no cents-to-dollars.
 * A step's `peopleReached` is DISTINCT people, `0` is MEASURED ("nobody got there"), and `null` is
 * "we could not measure this": the producer behind that rung degraded, exactly as {@link FunnelStep}
 * states it. A zero standing in for an unknown is the one answer this must never give, because on a
 * marketing page it reads as a fact about the client rather than as a gap in our own reading. The
 * same rule governs every money figure below: `null` is the gap, `0` is a measurement.
 *
 * ── THE MONEY HALF IS THE SAME PASS ─────────────────────────────────────────────────────────────
 *
 * The page also states what one outcome of the client's funnel cost: `costPerReachUsd`, that rung's
 * COMMITTED spend over the people who reached it — OBSERVED accounting, never floored to a benchmark,
 * which is what `FunnelStep.costPerReachCents` already means. It rides EVERY rung including the
 * outreach base, on the identical formula. No return is served here (ROI-CONSISTENCY-1103).
 *
 * Read at real VENDOR cost, before our markup (PUBLIC-VENDOR-COST-1031); the counts are untouched.
 *
 * Served in DOLLARS, not cents, because the consumer divides nothing: a figure it has to scale is a
 * figure it can scale wrongly, and the two surfaces would then state one number two ways.
 *
 * What is deliberately NOT published is the client's total spend. It is not asked for by the page,
 * and the narrower answer is the safer one on an unauthenticated read of named clients.
 *
 * ── A STEP NOBODY REACHED IS STILL A STEP ───────────────────────────────────────────────────────
 *
 * The chain is served IN THE FUNNEL'S OWN ORDER under the funnel's OWN names, first to last, with the
 * outreach base as its first entry — the page draws the funnel in order and hides zero-valued cells
 * itself, so dropping an empty rung here would silently change the shape of somebody's funnel. The
 * base is a rung of no funnel and the one every funnel converts FROM (see `funnel-steps.ts`), so it
 * carries the same shape as the rest rather than a special-cased field a consumer must branch on.
 *
 * ── ONE CHAIN PER FUNNEL THE BRAND'S CAMPAIGNS SELL, NEVER A PICK ───────────────────────────────
 *
 * A brand's campaigns state which funnel they sell, and a brand can sell several. Two funnels share
 * legs, so their figures overlap and must never be summed — and picking one of them would state a
 * funnel nobody asked about. So the answer is one chain PER funnel the brand's own campaigns state,
 * in catalogue order. Every showcase brand sells exactly one today.
 */
import { salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";
import type { FunnelStepBreakdown } from "./funnel-steps.js";
import type { ShowcaseGroupUnmeasuredReason } from "./showcase-clients.js";

/** The key + label of the outreach base — a step of no funnel, and the base every funnel converts from. */
export const SHOWCASE_CONTACTED_KEY = "contacted";
export const SHOWCASE_CONTACTED_LABEL = "Contacted";

/** One rung of a showcase funnel: what it is called, and how many people reached it. */
export interface ShowcaseFunnelStep {
  /**
   * The stable machine key of the rung — the canonical LEG key (`lib/funnel-legs.ts`) for a funnel
   * step, and `contacted` for the outreach base. A consumer keys its own copy off this rather than
   * off the label, which is buyer-facing wording and may be reworded.
   */
  key: string;
  /** The funnel's OWN name for this step, in the words the customer's own screen uses. */
  label: string;
  /**
   * DISTINCT people who reached this step. `0` is MEASURED — nobody got here. `null` is "we have no
   * figure": the producer behind this rung was unreadable on this read. Never a 0 standing in for an
   * unknown.
   */
  peopleReached: number | null;
  /**
   * WHAT REACHING THIS RUNG COST THE CLIENT — the funnel's COMMITTED spend divided by the people who
   * reached it, in DOLLARS, on the **NET** pricing basis. OBSERVED accounting, never floored to a
   * benchmark: it is what they PAID over what they got, which is the only honest answer to "what did a
   * booked meeting cost me" — and "what they paid" means after their usage discount, not our list
   * price, exactly as their own dashboard states it.
   *
   * `null` is "we have no figure" — nobody reached the rung (no denominator), nothing was spent, or
   * the count itself is unmeasured. NEVER 0, which on a marketing page would read as a client's
   * outcome having been free. It is served in dollars because the page divides nothing.
   */
  costPerReachUsd: number | null;
}

/** One funnel of one showcase brand, walked in the funnel's own order. */
export interface ShowcaseFunnel {
  funnelKey: SalesFunnelKey;
  /** The funnel's own name, so a consumer renders the chain without holding the catalogue. */
  funnelName: string;
  /** The rungs, first to last, the outreach base first. Never pruned — an empty rung is still a rung. */
  steps: ShowcaseFunnelStep[];
}

/** Why a showcase brand has no chain to serve. Never conflated with "the chain is all zeros". */
export type ShowcaseUnmeasuredReason =
  /** campaign-service lists no campaign for the brand, so it runs no channel and there is nothing to walk. */
  | "brand_has_no_channels"
  /** It runs channels, but none of its campaigns states a sales funnel — so there is no chain to name. */
  | "no_funnel_sold"
  /** lead-service holds no lead membership for the brand, so we cannot resolve whose org to read it under. */
  | "no_lead_membership"
  /** A downstream read failed for this brand alone. The other showcase brands still answer. */
  | "read_failed";

/** One showcase brand's answer. `funnels: []` always carries a reason — an empty list is never a shrug. */
export interface ShowcaseBrandFunnels {
  brand: { id: string; name: string | null; domain: string | null };
  funnels: ShowcaseFunnel[];
  /** True iff at least one chain was walked. False always names its reason. */
  measured: boolean;
  unmeasuredReason: ShowcaseUnmeasuredReason | null;
  /**
   * What the brand's money figures rest on (PUBLIC-VENDOR-COST-1031): every one is at real VENDOR cost. Absent on a brand
   * nothing was walked for.
   */
  vendorCost?: ShowcaseVendorCost;
}

/** A showcase brand's vendor cost coverage (`lib/public-vendor-cost.ts`). */
export interface ShowcaseVendorCost {
  /** Share of the brand's billed spend with no known vendor cost, %. */
  unpricedSharePct: number;
  /** `vendor_cost_unknown` when that share is past the tolerance: every money figure of the brand is then null. */
  moneyUnavailableReason: "vendor_cost_unknown" | null;
}

/**
 * One PICKED group of clients, already ordered by this service, each carrying the identical entry the
 * flat list below carries — who they are and their funnel figures, and nothing beyond it.
 */
export interface ShowcaseGroup {
  /** The clients, in the order the page states them. Empty exactly when `measured` is false. */
  brands: ShowcaseBrandFunnels[];
  /** True iff this group named at least one client. False always carries a reason. */
  measured: boolean;
  unmeasuredReason: ShowcaseGroupUnmeasuredReason | null;
  /** How many clients the group set out to name. */
  requestedCount: number;
  /**
   * How many clients passed the gate before the cut to `requestedCount`. A SHORT group is therefore a
   * stated fact (`qualifyingCount < requestedCount`) rather than a list a reader has to count — an
   * empty or short group is never served silently.
   */
  qualifyingCount: number;
}

/**
 * The payload.
 *
 * `brands` is the clients the group names — the field the existing consumer already reads, in an
 * unchanged shape.
 */
export interface ShowcaseFunnelsPayload {
  /** Every money figure is at real VENDOR cost, before our markup (PUBLIC-VENDOR-COST-1031). */
  costBasis: "vendor";
  brands: ShowcaseBrandFunnels[];
  groups: {
    /** Most recently begun clients that have produced at least one outcome, newest first. */
    recentlyStarted: ShowcaseGroup;
  };
}

/**
 * PURE: the paths a brand sells through — the reading paths of the legs its campaigns perform, every
 * offer — deduped, in catalogue order. A brand whose campaigns perform no leg reads none.
 */
export function brandReadingFunnels(reading: ReadonlyArray<{ funnelKey: SalesFunnelKey }>): SalesFunnelKey[] {
  return [...new Set(reading.map((f) => f.funnelKey))].sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b));
}

/**
 * PURE: one funnel's step breakdown → the ordered counts a page renders.
 *
 * The outreach base leads, because that is the base the first rung converts from and the number the
 * page states first ("12,307 contacted"). It is REACH — bounced and unsubscribed people included —
 * which is what `contactedRecipients` already means: they were emailed and they were paid for.
 */
export function showcaseFunnelOf(breakdown: FunnelStepBreakdown): ShowcaseFunnel {
  return {
    funnelKey: breakdown.funnelKey,
    funnelName: breakdown.name,
    steps: [
      {
        key: SHOWCASE_CONTACTED_KEY,
        label: SHOWCASE_CONTACTED_LABEL,
        peopleReached: breakdown.contactedRecipients,
        // The base is priced on the IDENTICAL formula every rung above it is — this scope's committed
        // spend over the people who reached it — so the chain carries one statement of cost from top
        // to bottom and the consumer needs no branch for its first entry.
        costPerReachUsd: costPerReachUsd(breakdown.committedSpentCents, breakdown.contactedRecipients),
      },
      ...breakdown.steps.map((step) => ({
        key: step.legKey,
        label: step.step,
        peopleReached: step.recipientsReached,
        costPerReachUsd: step.costPerReachCents === null ? null : step.costPerReachCents / 100,
      })),
    ],
  };
}

/**
 * PURE: committed cents over people reached, in dollars — `null` on every shape with no answer.
 *
 * A 0 count is no denominator and a 0 spend is nothing to divide; both are "we have no figure", not
 * "it was free". Mirrors `observedCostPerOutcome` (`lib/cost-engine.ts`), which is what every rung
 * above the base is already built with.
 */
function costPerReachUsd(committedSpentCents: number, peopleReached: number | null): number | null {
  if (peopleReached === null || peopleReached <= 0 || committedSpentCents <= 0) return null;
  return committedSpentCents / 100 / peopleReached;
}
