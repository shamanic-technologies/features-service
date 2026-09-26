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
 * hand and therefore ageing in public exactly as the numbers did. It is now TWO RANKINGS this service
 * computes — the most recently begun clients that have produced an outcome, and the best measured
 * return on spend past a floor — both of them in `lib/showcase-clients.ts`, both off the persisted
 * fleet snapshot, and neither of them reachable by a caller. The page refreshes on its own and nobody
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
 * ── THE MONEY HALF IS THE SAME PASS, AND IT IS THE CLIENT'S OWN NUMBER ──────────────────────────
 *
 * The page also states, under each client, what they got back on the budget they paid and what one
 * outcome of their funnel cost them. Those two were read out of production by hand and pasted in as
 * literals exactly as the counts were, so they age in public the same way.
 *
 * Both fall out of the engine pass the counts already cost, with no extra read of anything:
 *
 *   - `returnPerDollar` is `costEconomics.roiMultiple` for the funnel-narrowed read — expected
 *     pipeline over COMMITTED spend, the byte-same statistic the client's own revenue
 *     read states when priced on that funnel. So a showcase figure and the customer's own screen can
 *     never disagree, and it is emphatically NOT the forward `returnPerDollar` projection the
 *     channel-funnel economics publishes (an order apart in production — see `fleet-funnel-return.ts`).
 *   - `costPerReachUsd` is that rung's COMMITTED spend over the people who reached it — OBSERVED
 *     accounting, never floored to a benchmark, which is what `FunnelStep.costPerReachCents` already
 *     means. It rides EVERY rung including the outreach base, on the identical formula, so a consumer
 *     renders "cost per meeting booked" for one client and "cost per website visit" for another
 *     without knowing which rung to ask for and without a branch for the base.
 *
 * BOTH ARE READ ON THE **NET** PRICING BASIS — what the client ACTUALLY PAID after whatever per-org
 * usage discount they carry — and that is what makes the "byte-same as their own dashboard" claim
 * above TRUE rather than aspirational. Every consumer-facing dashboard surface in the fleet reads
 * `pricing=net`, so a GROSS figure here would publish a number no client has ever seen on a screen
 * they own: measured in prod 2026-09-10, one showcase client read 9.386x gross against 18.324x net
 * and another 1.828x against 3.481x, with the same factor on every `costPerReachUsd` rung. A client
 * carrying no discount has a frozen net equal to its gross per cost row, so it is byte-unchanged —
 * which is also the regression check that nothing else moved. NET is read off runs-service's FROZEN
 * net twin on the same cost read (zero extra IO, no discount fetch, no multiply here) and FAILS LOUD
 * when the twin is absent: there is deliberately no fall back to gross, because a silent basis swap
 * is exactly the two-numbers-under-one-word bug this basis exists to close.
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
import { matchSalesFunnelKey, salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";
import type { FunnelStepBreakdown } from "./funnel-steps.js";
import type { CostEconomics } from "./cost-economics.js";
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
  /**
   * WHAT A DOLLAR THROUGH THIS FUNNEL CAME BACK AS FOR THIS CLIENT — expected pipeline over COMMITTED
   * spend, i.e. `costEconomics.roiMultiple` for the funnel-narrowed read, on the **NET** pricing basis
   * (what the client actually paid after their usage discount). The byte-same statistic the client
   * reads as ROI on their own dashboard — which reads net too — so the two surfaces cannot state two
   * numbers.
   *
   * `null` is "we could not measure this": nothing was spent on the funnel, or the brand states no
   * economics to price its pipeline with. A measured `0` — real spend, no pipeline yet — is a
   * different answer and stays a `0`, so a consumer can leave the unmeasurable one blank rather than
   * print a number nobody stands behind.
   */
  returnPerDollar: number | null;
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
 * `brands` is the DEDUPED UNION of both groups — the field the existing consumer already reads, in an
 * unchanged shape, so it keeps rendering while it moves onto the groups. A client picked by both
 * questions appears ONCE here and in BOTH groups: a group is an answer to its own question, not a
 * slice of one list.
 */
export interface ShowcaseFunnelsPayload {
  brands: ShowcaseBrandFunnels[];
  groups: {
    /** Most recently begun clients that have produced at least one outcome, newest first. */
    recentlyStarted: ShowcaseGroup;
    /** Best measured return on spend past `minSpendUsd`, best first. */
    highestReturn: ShowcaseGroup;
  };
  /**
   * The spend floor the `highestReturn` ranking was taken over, in USD — stated because a ranking
   * whose population a reader cannot see is a ranking they cannot check. Below it a return is whatever
   * that client's first outcome happened to do (measured in prod: 21.5x on $4.12 of spend).
   */
  minSpendUsd: number;
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
export function showcaseFunnelOf(
  breakdown: FunnelStepBreakdown,
  /**
   * The funnel-narrowed read's OWN economics block, whose `roiMultiple` is the return. Absent on a
   * path that produced none — the return is then `null`, never a substituted figure.
   */
  costEconomics?: Pick<CostEconomics, "roiMultiple"> | null,
): ShowcaseFunnel {
  return {
    funnelKey: breakdown.funnelKey,
    funnelName: breakdown.name,
    returnPerDollar: costEconomics?.roiMultiple ?? null,
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
