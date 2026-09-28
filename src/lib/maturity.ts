/**
 * WHEN A FIGURE STOPS BEING NOISE — the ONE maturity rule, per leg (owner decision 2026-09-28,
 * features-service#1196). Every surface that asks "has this spend had time to produce its outcomes"
 * reads its parameters, its cutoff, its lead cohort and its verdict HERE; nothing restates them.
 *
 * WHY. A cold email's replies and visits keep arriving for weeks after it is sent. A figure that divides
 * everything spent to date by everything observed to date therefore reads the newest spend as money that
 * produced nothing. For the workflow picker that was a LADDER (prod 2026-09-28, campaign `3922c8e1…`):
 * a new workflow reads cheap, takes the budget, its own spend floor passes the leader before its outcomes
 * land, the next one takes over — $357 of $1,022 went to 33 workflows with zero positive replies. The
 * leader's own recent spend inflated its price too.
 *
 * ── EVERY STAT EXISTS IN TWO VERSIONS ─────────────────────────────────────────────────────────────
 *
 *  - FLASH  — everything to date: all spend, every lead, every outcome. What every figure was before.
 *  - MATURE — the spend of runs STARTED before the cutoff, over the outcomes (whenever they arrive) of
 *             the leads those same runs SERVED. ONE clock for spend and leads alike: the run start, i.e.
 *             the serve. A lead's outcome that lands today still counts if the lead was served before the
 *             cutoff — maturity bounds when the money went out, never when the result came back.
 *  - IS_MATURE — the scope holds at least `outcomesRequired` MATURE outcomes of its leg's own step.
 *
 * ── THE PARAMETERS, PER LEG ───────────────────────────────────────────────────────────────────────
 *
 *  | leg                      | duration | outcomes required     | measured (prod 2026-09-28)          |
 *  | start_to_conversation    | 21 days  | 1 positive reply      | 21 d from run start captures 92-95% |
 *  | start_to_website_visit   | 21 days  | 10 website visits     | of positive replies, 93-94% of visits|
 *  | every other leg          | 0 days   | 10 (the pre-existing  | nothing measured: a 0-day leg is    |
 *  |                          |          | learning bar)         | mature the day it is bought         |
 *
 * 14 days (the lag this replaced) caught 90% of visits and only 72-77% of positive replies. A leg with a
 * 0-day duration has MATURE ≡ FLASH by construction (every run started more than 0 days ago), so the rule
 * changes nothing for it — which is exactly "as today".
 *
 * ── THE CUTOFF IS DAY-GRANULAR ─────────────────────────────────────────────────────────────────────
 *
 * UTC midnight of `today − duration`, so it moves once a day, a cached figure is never stale by more than
 * its cache's own window, and runs-service's day-bucketed cost series splits on the same boundary.
 *
 * ── THE LEAD COHORT IS READ ON THE SERVE ───────────────────────────────────────────────────────────
 *
 * A lead is in the mature cohort when lead-service states it was served (on the clock of the run that
 * contacted it) before the cutoff. A lead with NO serve date stated is IN the cohort — never lose
 * information: a row predating the serve stamp is old by construction. `leads_campaigns.sent_at` is NOT
 * a serve date and is never read (89% of the rows it marks unsent were sent, per instantly).
 */

/** The counted signal a leg's outcome IS, when the leg is entered through one. */
export type MaturityOutcomeSignal = "clicked" | "positiveReply";

/** The maturity rule of ONE leg. */
export interface LegMaturity {
  /** The leg these parameters are for; null when the scope states no leg. */
  legKey: string | null;
  /** Days a run must have started before, for its spend and the leads it served to count as mature. */
  durationDays: number;
  /** MATURE outcomes of the leg's own step a scope must hold to be judged on them. */
  outcomesRequired: number;
  /**
   * The counted signal that IS the leg's outcome — `positiveReply` for the conversation leg, `clicked`
   * for the website-visit leg. Null on every other leg, whose outcome is walked from a driver signal.
   */
  outcomeSignal: MaturityOutcomeSignal | null;
  /**
   * `measured` — the owner set these from prod evidence (the two cold-email entry legs). `default` — no
   * leg-specific rule was measured: 0 days (mature the day it is bought) and the pre-existing bar of 10.
   */
  source: "measured" | "default";
}

const MEASURED_LEGS: Readonly<Record<string, Omit<LegMaturity, "legKey" | "source">>> = {
  start_to_conversation: { durationDays: 21, outcomesRequired: 1, outcomeSignal: "positiveReply" },
  start_to_website_visit: { durationDays: 21, outcomesRequired: 10, outcomeSignal: "clicked" },
};

/** Every leg the owner has not measured: mature the day it is bought, judged on the pre-existing bar. */
const DEFAULT_MATURITY: Omit<LegMaturity, "legKey" | "source"> = {
  durationDays: 0,
  outcomesRequired: 10,
  outcomeSignal: null,
};

/** PURE. The maturity rule of `legKey` (a canonical leg key, as `lib/funnel-legs.ts` mints it). */
export function legMaturity(legKey: string | null | undefined): LegMaturity {
  const key = legKey ?? null;
  const measured = key ? MEASURED_LEGS[key] : undefined;
  if (measured) return { legKey: key, ...measured, source: "measured" };
  return { legKey: key, ...DEFAULT_MATURITY, source: "default" };
}

/** PURE. The rule of every leg in `legKeys`, in the order given — what a catalogue publishes. */
export function legMaturityCatalogue(legKeys: readonly string[]): LegMaturity[] {
  return legKeys.map((k) => legMaturity(k));
}

/** PURE. UTC midnight of `now − days`, as an ISO string. Runs started before it (and the leads they
 *  served) are mature. */
export function maturityCutoffIso(days: number, now: Date = new Date()): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString();
}

/** PURE. The cutoff of `legKey`'s rule, or NULL for a leg that matures the day it is bought (mature ≡ flash). */
export function legCutoffIso(legKey: string | null | undefined, now: Date = new Date()): string | null {
  const { durationDays } = legMaturity(legKey);
  return durationDays > 0 ? maturityCutoffIso(durationDays, now) : null;
}

/**
 * THE LEAD COHORT PREDICATE — on the run-start (serve) clock. `cutoffIso` null (a 0-day leg) keeps every
 * lead. A lead whose serve date is not stated is IN the cohort (never lose information).
 */
export function servedInMatureCohort(servedAt: string | null | undefined, cutoffIso: string | null): boolean {
  if (!cutoffIso) return true;
  if (!servedAt) return true;
  return servedAt < cutoffIso;
}

/**
 * `startedBefore` for runs-service: the instant just before the cutoff, at MICROSECOND precision. runs-service
 * compares `started_at <= startedBefore` inclusively, so this partitions the ledger exactly on the cutoff —
 * the same bound `fetchMatureSpendCents` and `lib/runs-cost-split.ts` use.
 */
export function startedBeforeParam(cutoffIso: string): string {
  return `${new Date(new Date(cutoffIso).getTime() - 1).toISOString().slice(0, 23)}999Z`;
}

/**
 * IS THIS SCOPE MATURE ON ONE LEG — its MATURE outcomes of the leg's own step against the leg's bar.
 * NULL is "we could not count the mature outcomes", never a verdict.
 */
export function isMatureCount(matureOutcomes: number | null | undefined, legKey: string | null | undefined): boolean | null {
  if (matureOutcomes == null) return null;
  return matureOutcomes >= legMaturity(legKey).outcomesRequired;
}

/**
 * A SCOPE THAT SPANS SEVERAL LEGS (a brand, an offer, the fleet) is mature when EVERY leg present in its
 * mature figures is. One leg that is not mature makes the whole scope not mature: part of the figure
 * still rests on too little data. A leg that could not be counted (null) makes the verdict null unless
 * another leg already answered `false`. An empty list is null — nothing to judge.
 */
export function scopeIsMature(
  legs: ReadonlyArray<{ legKey: string | null; matureOutcomes: number | null }>,
): boolean | null {
  if (legs.length === 0) return null;
  let unknown = false;
  for (const leg of legs) {
    const verdict = isMatureCount(leg.matureOutcomes, leg.legKey);
    if (verdict === false) return false;
    if (verdict === null) unknown = true;
  }
  return unknown ? null : true;
}

/** THE SHARED SHAPE every surface serves a figure in: both versions and the verdict, side by side. */
export interface MaturityPair<T> {
  /** Everything to date. Null when there is no flash figure at all. */
  flash: T | null;
  /** The mature cohort's figure. Null when the mature cohort holds nothing (or could not be read). */
  mature: T | null;
  /** The scope's verdict — see {@link isMatureCount} / {@link scopeIsMature}. */
  isMature: boolean | null;
}

/** PURE. Build the shared shape. */
export function maturityPair<T>(flash: T | null, mature: T | null, isMature: boolean | null): MaturityPair<T> {
  return { flash, mature, isMature };
}

/**
 * THE FIGURES OF ONE SCOPE ON ONE BASIS — observed accounting, shared by every surface (workflow grains,
 * /revenue, audience rows, offer outcomes, /stats, the learning verdict, the fleet reads).
 *
 *  - `spentUsd`          committed spend on the request's pricing, summed EXACTLY and never rounded here, so a
 *                        scope's rows (workflow cells, audience rows) add up to the scope (`lib/decimal.ts`).
 *  - `contacted`         leads reached.
 *  - `outcomes`          the leg's own outcome (distinct leads at its outcome signal on an entry leg).
 *  - `costPerOutcomeUsd` `spentUsd / outcomes`; NULL at 0 outcomes or 0 spend — an observed figure, never a floor.
 *  - `conversionRatePct` `100 × outcomes / contacted`; NULL at 0 contacted — a measured 0 stays 0.
 */
export interface OutcomeFigures {
  spentUsd: number;
  contacted: number;
  outcomes: number;
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
}

/** PURE. The observed figures of one scope on one basis. `spentUsd` is taken as given (exact, unrounded). */
export function outcomeFigures(spentUsd: number, contacted: number, outcomes: number): OutcomeFigures {
  return {
    spentUsd,
    contacted,
    outcomes,
    costPerOutcomeUsd: outcomes > 0 && spentUsd > 0 ? spentUsd / outcomes : null,
    conversionRatePct: contacted > 0 ? (100 * outcomes) / contacted : null,
  };
}

/** One leg of a scope, on both bases, with the leg's own rule beside its figures. */
export type LegMaturityFigures = LegMaturity & MaturityPair<OutcomeFigures>;

/** PURE. Build one leg's wrapper: the leg's rule, both bases, and the verdict on the MATURE outcomes. */
export function legMaturityFigures(
  legKey: string | null,
  flash: OutcomeFigures | null,
  mature: OutcomeFigures | null,
): LegMaturityFigures {
  return {
    ...legMaturity(legKey),
    ...maturityPair(flash, mature, isMatureCount(mature ? mature.outcomes : null, legKey)),
  };
}
