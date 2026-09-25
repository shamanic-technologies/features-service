/**
 * THE RETURN ON OUR OUTREACH IS MEASURED ON THE MATURE COHORT — runs old enough to have produced
 * their outcomes, and the leads those runs reached.
 *
 * WHY. A cold email's replies and visits keep arriving for about two weeks after it was sent
 * ({@link OUTCOME_LAG_DAYS}). A campaign that spent heavily in the last fortnight therefore reads a
 * terrible ROI: its spend is counted today while the outcomes that spend bought have not landed yet.
 * The number is arithmetically right and says nothing about how the campaign performs — it says how
 * YOUNG it is.
 *
 * THE RULE (owner decision, 2026-09-25):
 *   - Each campaign's LEG carries a MATURITY DELAY: {@link OUTCOME_LAG_DAYS} for the two cold-email
 *     entry legs (`start_to_website_visit`, `start_to_conversation`), 0 for every other leg — and 0
 *     for a campaign stating no leg (every such row in prod is a stopped pre-leg ancestor).
 *   - ROI, %CAC, $CAC and the pipeline they divide are computed on the MATURE COHORT only: the cost
 *     of runs STARTED before the cutoff, and the value of the leads FIRST CONTACTED before it. Their
 *     outcomes count whenever they happened, the last fortnight included — maturity bounds when the
 *     money went out, never when the result came back.
 *   - A lead with NO contact date is IN the cohort (owner: never lose information for ROI).
 *   - Runs and leads of a zero-delay campaign are always in the cohort.
 *   - Everything else keeps full history: the invested / spent figures, the headline pipeline, the
 *     outcome counts, `funnelSteps`, `leads[]`, the measured conversion rates. Only the ratios move.
 *   - A scope whose cohort holds no spend yet (every dollar is younger than the delay) answers the
 *     ratios `null` with `unmeasuredReason: "maturing"` — never 0, never a default.
 *
 * THE CUTOFF IS DAY-GRANULAR — UTC midnight of `today − delay` — so it moves once a day, a cached
 * body is never stale by more than the cache's own window, and runs-service's day-bucketed cost
 * series and this cutoff split the ledger on the same boundary.
 *
 * A read spanning campaigns on different legs applies EACH CAMPAIGN'S OWN delay: a zero-delay
 * campaign's recent spend and leads stay in, a fourteen-day campaign's leave. With the two delays in
 * force today that is at most one real cutoff.
 */
import { OUTCOME_LAG_DAYS } from "./learning-phase.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";
import type { EnginePerson } from "./revenue-engine.js";

/** The legs whose outcomes lag their spend. Every other leg matures on the day it is bought. */
const DELAYED_LEGS: ReadonlySet<string> = new Set(["start_to_website_visit", "start_to_conversation"]);

/** Days a campaign bought for `legKey` must age before its spend and its leads count toward ROI. */
export function maturityDaysForLeg(legKey: string | null | undefined): number {
  return legKey && DELAYED_LEGS.has(legKey) ? OUTCOME_LAG_DAYS : 0;
}

/** UTC midnight of `now − days`, as an ISO string. Runs started before it are mature. */
export function maturityCutoffIso(days: number, now: Date = new Date()): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString();
}

/**
 * Which of a scope's campaigns are still maturing, and from when.
 *
 * `days` is the delay STATED on the wire — the largest delay of any campaign in the scope, so a
 * tooltip reads "14 days" whenever any part of the figure waited that long. `cutoffIso` is null when
 * nothing in the scope waits (every campaign is on a zero-delay leg), which is the byte-unchanged path.
 */
export interface MaturityPlan {
  /**
   * True when campaign-service could not tell us the scope's legs. We then cannot separate young spend
   * from mature spend, so the ratios read null with `unmeasuredReason: "maturity_unknown"` — never the
   * whole-history ratio this rule exists to stop printing, and never a 502 on a page whose every other
   * figure is right (the same degrade the campaign-identity read takes on the same outage).
   */
  unknown?: boolean;
  days: number;
  cutoffIso: string | null;
  /** The campaigns whose runs after the cutoff, and leads first contacted after it, are excluded. */
  delayedCampaignIds: ReadonlySet<string>;
}

export const NO_MATURITY: MaturityPlan = { days: 0, cutoffIso: null, delayedCampaignIds: new Set() };
export const UNKNOWN_MATURITY: MaturityPlan = { unknown: true, days: 0, cutoffIso: null, delayedCampaignIds: new Set() };

/**
 * PURE. The plan for the campaigns in scope. `inScope` decides which rows count: a read narrowed to a
 * campaign family or to a channel set passes the predicate matching its own scope, so a brand whose
 * OTHER channel runs a fourteen-day leg does not make this one's figure wait.
 */
export function buildMaturityPlan(
  rows: readonly CampaignIdentityRow[],
  inScope: (row: CampaignIdentityRow) => boolean,
  now: Date = new Date(),
): MaturityPlan {
  let days = 0;
  const delayed = new Set<string>();
  for (const row of rows) {
    if (!inScope(row)) continue;
    const d = maturityDaysForLeg(row.legKey);
    if (d <= 0) continue;
    delayed.add(row.id);
    if (d > days) days = d;
  }
  if (days === 0) return NO_MATURITY;
  return { days, cutoffIso: maturityCutoffIso(days, now), delayedCampaignIds: delayed };
}

/**
 * PURE. The rows of the mature cohort: every row EXCEPT a maturing campaign's row whose lead was first
 * contacted on or after the cutoff. A row with no contact date stays in (never lose information), and
 * a row of a zero-delay campaign always stays in.
 */
export function matureCohortPersons(persons: readonly EnginePerson[], plan: MaturityPlan): EnginePerson[] {
  if (!plan.cutoffIso) return [...persons];
  const cutoff = plan.cutoffIso;
  return persons.filter((p) => {
    if (!p.campaignId || !plan.delayedCampaignIds.has(p.campaignId)) return true;
    const contacted = p.signalDates?.contacted ?? null;
    if (!contacted) return true;
    return contacted < cutoff;
  });
}

/** The scope pieces the in-scope predicate is built from. */
export function scopePredicate(input: {
  /** The channel(s) the read spans. */
  featureSlugs: readonly string[];
  /** The campaign ids the read is narrowed to, `[]` = every campaign of the channel set. */
  campaignIds: readonly string[];
}): (row: CampaignIdentityRow) => boolean {
  const slugs = new Set(input.featureSlugs);
  const ids = input.campaignIds.length > 0 ? new Set(input.campaignIds) : null;
  return (row) => (ids ? ids.has(row.id) : row.featureSlug != null && slugs.has(row.featureSlug));
}
