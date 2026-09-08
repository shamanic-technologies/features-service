/**
 * THE FUNNEL COUNTS OF THE CLIENTS WE NAME ON OUR OWN HOMEPAGE — public, org-less, and the brands are
 * decided HERE.
 *
 * The apex page states three named clients and, under each, how many people we contacted and how many
 * of them reached each subsequent step of that client's funnel. Those numbers were read out of
 * production by hand on 2026-09-06 and pasted into the page as literals. Nothing refreshes them, the
 * page renders perfectly either way, and the page nudges the counters in-session for a live feel — so
 * a reader watching a number climb is watching an invented increment climb from a frozen base. This is
 * the read that makes them true.
 *
 * ── THE BRANDS ARE THE SERVICE'S DECISION, NEVER THE CALLER'S ───────────────────────────────────
 *
 * There is deliberately NO request parameter naming a brand anywhere on this surface. This is an
 * unauthenticated read of NAMED CLIENTS' funnel figures, published because we agreed to publish those
 * three; a caller-supplied identifier would turn the same route into a way to read any brand's funnel
 * with no session at all. The allowlist below is the whole access-control story, which is why it is a
 * frozen constant in code rather than a row somebody can add to from outside.
 *
 * ── COUNTS ONLY, AND "WE HAVE NO FIGURE" IS SAID OUT LOUD ───────────────────────────────────────
 *
 * The page renders what is served and computes nothing — no rate, no division, no money. A step's
 * `peopleReached` is DISTINCT people, `0` is MEASURED ("nobody got there"), and `null` is "we could
 * not measure this": the producer behind that rung degraded, exactly as {@link FunnelStep} states it.
 * A zero standing in for an unknown is the one answer this must never give, because on a marketing
 * page it reads as a fact about the client rather than as a gap in our own reading.
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
import { matchSalesFunnelKey, salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";
import type { FunnelStepBreakdown } from "./funnel-steps.js";

/**
 * THE ALLOWLIST — the clients whose funnel figures we publish, in the order the page states them.
 *
 * Adding a brand here PUBLISHES that brand's funnel counts to anyone on the internet, with no auth
 * and no session. That is the point of the surface and it is also its only risk, so the list lives in
 * code, is reviewed like code, and is never widened by a request.
 */
export const SHOWCASE_BRAND_IDS: readonly string[] = [
  // docdinners.com
  "75d7e3e8-6926-4f85-a557-976895400666",
  // opsfolio.com
  "6e21bb6c-67bc-45f3-8a6d-52230338d7e4",
  // shockwavecenters.com
  "a179bbd9-8eed-4dba-9338-78125922b0c6",
];

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
}

/** The payload. One entry per allowlisted brand, in the allowlist's own order — always all of them. */
export interface ShowcaseFunnelsPayload {
  brands: ShowcaseBrandFunnels[];
}

/**
 * PURE: the SALES FUNNELS a brand's own campaigns state they sell, in catalogue order, deduped.
 *
 * A campaign stating no funnel (or a word this catalogue does not know) contributes NOTHING — it is
 * never parked on a default, which would print a funnel the campaign never stated.
 */
export function brandSoldFunnels(rows: CampaignIdentityRow[]): SalesFunnelKey[] {
  const keys = new Set<SalesFunnelKey>();
  for (const row of rows) {
    if (!row.funnelKey) continue;
    const matched = matchSalesFunnelKey(row.funnelKey);
    if (matched) keys.add(matched);
  }
  return [...keys].sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b));
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
      },
      ...breakdown.steps.map((step) => ({
        key: step.legKey,
        label: step.step,
        peopleReached: step.recipientsReached,
      })),
    ],
  };
}
