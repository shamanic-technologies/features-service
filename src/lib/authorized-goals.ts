/**
 * The set of optimization goals a brand AUTHORIZES — the candidate set the goal arbitration ranks.
 *
 * OWNERSHIP: the authorized set is BRAND-SERVICE's. A brand states every funnel it sells through;
 * features-service reads that statement and ranks it. It is NEVER supplied by the caller
 * (campaign-service must not be in a position to influence which goals compete) and it is NEVER
 * inferred here (a brand's single `optimizationGoal` is one goal, not an authorization set — reading it
 * as the set would silently answer a different question).
 *
 * `funnelStages` is explicitly NOT the authorized set. It is a different concept with a different
 * vocabulary (`website_purchase` | `sales_meeting` = stages a brand's funnel contains), and reading it
 * as a goal list would produce a plausible-looking but wrong set.
 *
 * TRANSITIONAL SHAPE TOLERANCE — brand-service is adding the field in parallel with this endpoint, so
 * the parser accepts the handful of container names / item shapes the producer could reasonably ship
 * (`authorizedGoals` | `optimizationGoals` | `funnels` | `salesFunnels`, at the top level of the
 * sales-economics payload or nested under `salesEconomics` / `economics`; items either a plain goal
 * string or an object carrying the goal plus optional per-funnel economics). This is INPUT TOLERANCE
 * over an unshipped producer, not a fallback: when NO recognised container is present the parser
 * returns `null` and the arbitration endpoint FAILS LOUD (502) naming what is missing — it never
 * substitutes a default set. Narrow this to the single deployed name once brand-service ships.
 */

import type { SalesEconomics } from "./funnel-registry.js";
import { matchOptimizationGoal, type Goal } from "./goals.js";

/** Raised when the producer serves a goal value features-service cannot map. Fails loud — a goal the
 * brand authorized must never be silently dropped from the competition. */
export class UnknownAuthorizedGoalError extends Error {
  constructor(readonly raw: string) {
    super(`brand-service authorized goal "${raw}" is not a recognised optimization goal`);
    this.name = "UnknownAuthorizedGoalError";
  }
}

/** One authorized funnel: the goal, plus the per-funnel economics the brand states for it (when any). */
export interface AuthorizedGoalEntry {
  goal: Goal;
  /**
   * PER-FUNNEL economics overrides, as stated by the brand for THIS funnel. Merged OVER the brand's
   * effective economics when projecting this goal, so a brand that sells a $200 self-serve plan and a
   * $20k enterprise contract is arbitrated on each funnel's own revenue instead of one blended number.
   * `null` when the producer states none — the brand's effective economics then apply unchanged, which
   * is today's semantics, not a fabricated value.
   */
  economics: Partial<SalesEconomics> | null;
}

const CONTAINER_KEYS = ["authorizedGoals", "optimizationGoals", "funnels", "salesFunnels"] as const;
const NESTED_KEYS = ["salesEconomics", "economics"] as const;
const GOAL_KEYS = ["goal", "optimizationGoal", "currentGoal", "slug", "name"] as const;
const ECONOMICS_KEYS = ["economics", "salesEconomics"] as const;

/** The numeric SalesEconomics fields a per-funnel override may restate. Anything else is ignored. */
const ECONOMICS_FIELDS = [
  "lifetimeRevenueUsd",
  "replyToMeetingPct",
  "visitToMeetingPct",
  "meetingToClosePct",
  "visitToSignupPct",
  "signupToPaidClientPct",
  "visitToClosePct",
  "visitToPaidClientPct",
  "replyToPaidClientPct",
  "visitToFormSubmissionPct",
  "formSubmissionToPaidClientPct",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readEconomicsOverride(raw: unknown): Partial<SalesEconomics> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const field of ECONOMICS_FIELDS) {
    const value = raw[field];
    if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
  }
  return Object.keys(out).length > 0 ? (out as Partial<SalesEconomics>) : null;
}

function readEntry(item: unknown): AuthorizedGoalEntry {
  if (typeof item === "string") {
    const goal = matchOptimizationGoal(item);
    if (!goal) throw new UnknownAuthorizedGoalError(item);
    return { goal, economics: null };
  }
  if (isRecord(item)) {
    for (const key of GOAL_KEYS) {
      const raw = item[key];
      if (typeof raw !== "string" || raw === "") continue;
      const goal = matchOptimizationGoal(raw);
      if (!goal) throw new UnknownAuthorizedGoalError(raw);
      let economics: Partial<SalesEconomics> | null = null;
      for (const econKey of ECONOMICS_KEYS) {
        economics = readEconomicsOverride(item[econKey]);
        if (economics) break;
      }
      // A funnel object may also carry its rates FLAT (no nested economics object).
      if (!economics) economics = readEconomicsOverride(item);
      return { goal, economics };
    }
  }
  throw new UnknownAuthorizedGoalError(JSON.stringify(item));
}

/**
 * Extract the authorized goal set from a brand-service sales-economics payload.
 *
 * Returns `null` when the payload carries NO recognised authorized-set container — i.e. the producer
 * does not (yet) state one. The caller must fail loud on `null`; it must NOT default to the brand's
 * single `optimizationGoal` or to the full `GOALS` vocabulary.
 *
 * Returns `[]` when the producer states an EMPTY set — a real, distinguishable answer ("this brand
 * authorizes nothing"), which the arbitration reports as unrankable rather than as an error.
 *
 * Throws `UnknownAuthorizedGoalError` on a goal value that maps to no known goal.
 */
export function parseAuthorizedGoals(payload: unknown): AuthorizedGoalEntry[] | null {
  if (!isRecord(payload)) return null;
  const containers: unknown[] = [];
  for (const key of CONTAINER_KEYS) {
    if (key in payload) containers.push(payload[key]);
  }
  for (const nested of NESTED_KEYS) {
    const inner = payload[nested];
    if (!isRecord(inner)) continue;
    for (const key of CONTAINER_KEYS) {
      if (key in inner) containers.push(inner[key]);
    }
  }
  const list = containers.find((c) => Array.isArray(c));
  if (list === undefined) return null;

  const seen = new Set<Goal>();
  const entries: AuthorizedGoalEntry[] = [];
  for (const item of list as unknown[]) {
    const entry = readEntry(item);
    if (seen.has(entry.goal)) continue;
    seen.add(entry.goal);
    entries.push(entry);
  }
  return entries;
}
