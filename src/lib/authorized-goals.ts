/**
 * The set of optimization goals a brand AUTHORIZES — the candidate set the goal arbitration ranks.
 *
 * OWNERSHIP: the authorized set is BRAND-SERVICE's. A brand DECLARES the sales funnels it sells
 * through (`GET /internal/brands/:brandId/sales-funnels`), each funnel carrying the goal it optimizes
 * for and the economics that funnel is priced on. features-service reads that declaration and ranks
 * it. It is NEVER supplied by the caller (campaign-service must not be in a position to influence
 * which goals compete) and it is NEVER inferred here — in particular a brand's single
 * `optimizationGoal` is ONE goal, not an authorization set, and brand-service is explicit that the
 * brand-wide economics row cannot stand in for a declaration (every rate on it is NOT NULL with a
 * server default, so a brand that configured nothing still reads back plausible-looking numbers and
 * no absence signals anything).
 *
 * "No funnel declared" is `[]`, a real answer — the arbitration reports the brand unrankable. There is
 * no separate "unset" wire state in the producer's model; a read that cannot be answered throws
 * (`SalesFunnelsUnavailableError`) and the route reports THAT distinctly.
 *
 * TWO FUNNELS CAN SHARE ONE GOAL. `reply_meeting` and `visit_meeting` both optimize for a booked
 * meeting via different first signals, and features-service's meeting funnel spans BOTH channels
 * (clicks·visitToMeeting + replies·replyToMeeting). So funnels are MERGED per goal rather than
 * deduped-by-first: their rate sets are complementary legs of the same projection, and dropping one
 * would arbitrate the goal on half its economics.
 */

import type { SalesEconomics } from "./funnel-registry.js";
import { matchOptimizationGoal, type Goal } from "./goals.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";

/** Raised when a declared funnel names a goal features-service cannot map. Fails loud — a goal the
 * brand authorized must never be silently dropped from the competition. */
export class UnknownAuthorizedGoalError extends Error {
  constructor(readonly raw: string) {
    super(`brand-service authorized goal "${raw}" is not a recognised optimization goal`);
    this.name = "UnknownAuthorizedGoalError";
  }
}

/** One authorized goal: the goal, plus the economics the brand declared for the funnel(s) behind it. */
export interface AuthorizedGoalEntry {
  goal: Goal;
  /**
   * PER-FUNNEL economics as DECLARED, merged over the brand's effective economics when projecting this
   * goal — so a brand selling a $200 self-serve plan and a $20k contract is arbitrated on each funnel's
   * own revenue instead of one blended number. `null` when the brand declared no usable number for the
   * funnel; the brand's effective economics then apply unchanged (today's semantics, not a fabricated
   * value). A rate the brand never declared reads `null` upstream and is DROPPED here — never coerced
   * to 0, which would silently zero-collapse a funnel.
   */
  economics: Partial<SalesEconomics> | null;
}

/**
 * The rates a declared funnel can carry that features-service's projection actually consumes. Named
 * identically on both sides. `meetingBookedToAttendedPct` (the meeting show-up rate) is deliberately
 * ABSENT: it exists only on brand-service's funnel rows and features-service's funnel does not model a
 * separate show-up step, so importing it would silently rename a rate the projection never reads.
 */
const CONSUMED_RATE_KEYS = [
  "replyToMeetingPct",
  "visitToMeetingPct",
  "meetingToClosePct",
  "visitToSignupPct",
  "signupToPaidClientPct",
  "visitToFormSubmissionPct",
  "formSubmissionToPaidClientPct",
  "visitToClosePct",
  "visitToPaidClientPct",
  "replyToPaidClientPct",
] as const;

/**
 * Map ONE declared funnel to its canonical goal.
 *
 * Reads brand-service's WIRE `goal` first and only then `currentGoal`, because `currentGoal` is LOSSY
 * for this purpose: brand-service deliberately collapses `form_submissions` onto the `signup` runtime
 * token ("consumers never see a new value"), while features-service models form submissions as their
 * OWN goal with their own funnel (visit→form→paid). Reading the runtime token would arbitrate a Form
 * Magnet funnel on signup economics — a wrong answer that looks right.
 */
function goalOfFunnel(funnel: DeclaredSalesFunnel): Goal {
  const wire = typeof funnel.goal === "string" ? matchOptimizationGoal(funnel.goal) : null;
  if (wire) return wire;
  const runtime = typeof funnel.currentGoal === "string" ? matchOptimizationGoal(funnel.currentGoal) : null;
  if (runtime) return runtime;
  throw new UnknownAuthorizedGoalError(funnel.goal ?? funnel.currentGoal ?? JSON.stringify(funnel));
}

/** The declared numbers on one funnel, dropping every rate the brand never gave us. */
function declaredEconomics(funnel: DeclaredSalesFunnel): Partial<SalesEconomics> | null {
  const out: Record<string, number> = {};
  const rates = funnel.rates;
  if (rates && typeof rates === "object") {
    for (const key of CONSUMED_RATE_KEYS) {
      const value = rates[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
  }
  if (typeof funnel.lifetimeRevenueUsd === "number" && Number.isFinite(funnel.lifetimeRevenueUsd)) {
    out.lifetimeRevenueUsd = funnel.lifetimeRevenueUsd;
  }
  return Object.keys(out).length > 0 ? (out as Partial<SalesEconomics>) : null;
}

/**
 * Turn the funnels a brand declared into the authorized goal set the arbitration ranks.
 *
 * `[]` in ⇒ `[]` out: the brand declared nothing, which the arbitration reports as unrankable. Order
 * follows the producer's, so the answer is stable. Throws `UnknownAuthorizedGoalError` on a goal value
 * that maps to nothing — dropping it would silently arbitrate a smaller set than the brand authorized.
 *
 * Funnels sharing a goal are MERGED (see the module doc): their declared rates union, first declaration
 * winning a collision in the producer's order. A lifetime revenue stated by several funnels of one goal
 * resolves to the LOWEST — deterministic, and it can only ever understate the goal's return, never
 * inflate it into winning the arbitration.
 */
export function authorizedGoalsFromFunnels(funnels: DeclaredSalesFunnel[]): AuthorizedGoalEntry[] {
  const byGoal = new Map<Goal, Partial<SalesEconomics> | null>();
  const order: Goal[] = [];

  for (const funnel of funnels) {
    const goal = goalOfFunnel(funnel);
    const declared = declaredEconomics(funnel);
    if (!byGoal.has(goal)) {
      byGoal.set(goal, declared);
      order.push(goal);
      continue;
    }
    const existing = byGoal.get(goal) ?? null;
    if (!declared) continue;
    if (!existing) {
      byGoal.set(goal, declared);
      continue;
    }
    const merged: Record<string, number> = { ...(existing as Record<string, number>) };
    for (const [key, value] of Object.entries(declared as Record<string, number>)) {
      if (key === "lifetimeRevenueUsd") {
        merged.lifetimeRevenueUsd =
          merged.lifetimeRevenueUsd == null ? value : Math.min(merged.lifetimeRevenueUsd, value);
        continue;
      }
      if (!(key in merged)) merged[key] = value;
    }
    byGoal.set(goal, merged as Partial<SalesEconomics>);
  }

  return order.map((goal) => ({ goal, economics: byGoal.get(goal) ?? null }));
}
