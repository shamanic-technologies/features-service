/**
 * WHEN DO THIS SCOPE'S FIGURES STOP BEING NOISE — the countdown, and the four ways it can fail to be one.
 *
 * A customer looking at a campaign whose figures are still too thin to price needs to know WHEN that
 * stops. Until this module the dashboard answered that itself, in the browser, out of ingredients it
 * assembled from three services — and it was wrong in both halves at once.
 *
 * It picked the expected price by taking the CHEAPEST figure across every workflow, which selects, by
 * construction, the workflow that has spent the least and produced NOTHING of the outcome: an EXPLORE
 * FLOOR, not a price. Measured in prod 2026-09-13 on brand `a179bbd9…` / campaign `3922c8e1…` / leg
 * `start_to_conversation`: the browser read `alioth` at **$21.22** with ZERO observed outcomes, where
 * the campaign's own measured price is **$77.6825** — `azalea`'s $310.73 of spend over the 4
 * conversations it actually produced. Ten outcomes at $21.22 is a $212 target a campaign that has
 * already spent $438 passed weeks ago, so the countdown reached zero while the outcomes did not. And
 * nothing in the browser could express that: its only states were "still learning, N days" and "done",
 * so an overrun rendered as a countdown that had finished.
 *
 * ── THE EXPECTED PRICE RESTS ON CELLS THAT OBSERVED AN OUTCOME, AND ONLY ON THOSE ────────────────
 *
 * Pool the (campaign × workflow) cells whose driver signal was actually seen: Σ their spend over Σ
 * their outcomes. Spend on a workflow that produced nothing is EXPLORATION spend — the price of
 * finding out — not the price of an outcome, and a ratio whose denominator is zero is a floor rather
 * than a price. **DO NOT "simplify" this to the campaign's whole spend over its whole outcome count**:
 * on the campaign above that reads $438 / 4 = $109.50 and prices in the barren workflows' exploration.
 * And do NOT reach for the cheapest workflow's figure, which is what produced the bug.
 *
 * ── THE OUTCOME IS THE CAMPAIGN'S OWN LEG'S STEP ─────────────────────────────────────────────────
 *
 * Never the first step of the funnel the leg belongs to. A campaign converting a reply into a meeting
 * is not measured on replies it does not produce, so the count is walked from the observed driver
 * through the funnel's own declared rates (`lib/leg-outcome.ts`) exactly as every other leg-keyed
 * figure is. `outcomeObserved` says which of the two a consumer is reading: an ENTRY leg's count is a
 * raw OBSERVATION, a deeper leg's is that observation walked forward.
 *
 * ── A SCOPE FINISHES WHEN ITS FIRST CAMPAIGN DOES ────────────────────────────────────────────────
 *
 * A campaign has finished gathering once it has {@link LEARNING_OUTCOMES_REQUIRED} outcomes of the
 * thing it is buying. A funnel, an offer or a brand has finished once at least ONE of its campaigns
 * has — so the scope's verdict is `priced` the moment any campaign crosses, whatever its siblings are
 * doing, and its COUNTDOWN is its LEADING campaign's: the live campaign with the most outcomes, which
 * is the one that will cross first. A scope with no campaigns at all has nothing to say — that is
 * `unmeasured`, never `learning`, because nothing is being gathered and nothing ever will be.
 *
 * A PAUSED campaign is never the subject of a countdown: its days-left would be priced against a daily
 * spend that is not happening. So the leading campaign is picked among the LIVE ones, and a scope whose
 * campaigns are all stopped reads `paused` with its counts intact and no countdown at all.
 *
 * ── AND FINISHING THE SPEND IS NOT FINISHING THE GATHERING ───────────────────────────────────────
 *
 * Cold email's outcomes keep arriving for about {@link OUTCOME_LAG_DAYS} after the spend is in, so a
 * scope that has reached its spend target with the outcomes still missing is its OWN state —
 * `learning_limited`, the same word the ad platforms use for an entity that is unlikely to leave
 * learning on the budget it has. It is NOT `priced` (the evidence did not arrive) and NOT `learning`
 * (there is no spend left to wait on). Collapsing the three into one is precisely what the browser did.
 */
import { funnelStepKeys, type ChannelStepDef, type ChannelStepKey } from "./acquisition-channels.js";
import { funnelLeg, funnelsContainingLeg, matchFunnelLegKey } from "./funnel-legs.js";
import { bookedToAttendedRate, legOutcomeTerms, FUNNEL_DRIVER, type LegDriver } from "./leg-outcome.js";
import { matchSalesFunnelKey, type SalesFunnelKey } from "./sales-funnels.js";
import type { SalesEconomics } from "./funnel-registry.js";

/** How many outcomes of its OWN leg a campaign must have before its figures stop being noise. */
export const LEARNING_OUTCOMES_REQUIRED = 10;

/**
 * How long a scope's outcomes keep landing after its spend is in. Stated on the wire rather than
 * folded into the countdown: it is why a `learning_limited` verdict is not a terminal one, and a
 * consumer has to be able to say that instead of rendering a finished bar.
 */
export const OUTCOME_LAG_DAYS = 14;

/** What raising the daily ceiling buys, stated at these multiples of what it is today. */
export const CEILING_MULTIPLES = [2, 3, 5] as const;

/**
 * WHAT THIS SCOPE'S FIGURES ARE WORTH, AND WHY.
 *
 *  - `priced`            — a campaign of this scope has its {@link LEARNING_OUTCOMES_REQUIRED}
 *                          outcomes. Nothing to say; the money above is the answer.
 *  - `learning`          — still gathering, and there is spend left to do it with. Carries the countdown.
 *  - `learning_limited`  — the spend needed has been reached and the outcomes have not arrived.
 *  - `paused`            — no campaign of this scope is running, so nothing is being gathered.
 *  - `unmeasured`        — we cannot say. `unmeasuredReason` names which ingredient is missing.
 */
export type LearningStatus = "priced" | "learning" | "learning_limited" | "paused" | "unmeasured";

/**
 * WHICH INGREDIENT IS MISSING. Each is a different sentence a consumer renders differently, and none
 * of them is a zero: "we could not say" and "it will take no time" are not the same statement.
 */
export type LearningUnmeasuredReason =
  /** This scope has no campaigns at all — nothing is gathering and nothing ever will. */
  | "no_campaigns"
  /** campaign-service could not be read, so we do not know which campaigns this scope has. */
  | "campaigns_unreadable"
  /** The leading campaign states no leg, so there is no outcome to count it in. */
  | "no_leg_stated"
  /** We could not count anybody's outcomes — the producer behind the counts degraded. */
  | "no_outcome_evidence"
  /** The leg needs a conversion rate the brand never declared, so its outcome is unpriceable. */
  | "leg_unpriceable"
  /** No cell has observed an outcome yet, so every figure we hold is a floor rather than a price. */
  | "no_expected_price"
  /** The leg carries no daily ceiling, so there is no rate to divide the remaining spend by. */
  | "no_daily_ceiling";

/** What raising the ceiling to this figure would leave. Same unit as `daysRemaining`. */
export interface LearningCeilingScenario {
  dailyCeilingUsd: number;
  daysRemaining: number;
}

/** ONE campaign of the scope, as this verdict sees it. Lean: the consumer renders, it does not derive. */
export interface LearningCampaign {
  /** The identity's representative id — the live member when there is one. */
  campaignId: string;
  /** Every member id of the identity this row totals over. */
  campaignIds: string[];
  /** campaign-service's identity key, or null for a row it could not place. */
  campaignIdentityKey: string | null;
  /** The leg this campaign is bought for, as campaign-service states it. Null = it states none. */
  legKey: string | null;
  /** The step the count below is denominated in — the leg's OWN `toStep`. */
  outcomeStep: ChannelStepDef | null;
  /**
   * How many of that step this campaign accounts for. NULL is "we could not count this" (no leg, an
   * unpriceable rate, or a degraded producer); `0` is a measurement.
   */
  outcomesObserved: number | null;
  /** TRUE ⟺ the count is a raw OBSERVATION (an entry leg) rather than walked from the driver. */
  outcomeObserved: boolean;
  /** TRUE ⟺ at least one member is `ongoing`. A stopped campaign gathers nothing. */
  live: boolean;
}

/** WHEN THIS SCOPE'S FIGURES STOP BEING NOISE — the whole answer, divided by nobody. */
export interface LearningPhase {
  status: LearningStatus;
  /** Present ⟺ `status === "unmeasured"`. Null otherwise. */
  unmeasuredReason: LearningUnmeasuredReason | null;

  /** The LEADING campaign — whose countdown this is. Null when there is none to lead. */
  campaignId: string | null;
  campaignIdentityKey: string | null;
  legKey: string | null;
  outcomeStep: ChannelStepDef | null;

  /** The leading campaign's own count, and the bar it is measured against. */
  outcomesObserved: number | null;
  outcomesRequired: number;
  /** `100 × observed / required`, clamped to 100. Null when the count is. */
  progressPct: number | null;
  /** TRUE ⟺ the count is a raw OBSERVATION rather than walked from the driver signal. */
  outcomeObserved: boolean;

  /**
   * What one outcome of this leg costs, pooled over the leading campaign's (campaign × workflow)
   * cells that OBSERVED one. NULL when no cell has — a floor is not a price and must never found a
   * spend target.
   */
  expectedCostPerOutcomeUsd: number | null;
  /** `expectedCostPerOutcomeUsd × outcomesRequired` — the spend the countdown is counting down. */
  spendTargetUsd: number | null;
  /** What the leading campaign has committed so far, on the SAME basis the money above rides. */
  committedSpentUsd: number | null;
  /** `max(0, target − committed)`. `0` says the target is reached. */
  spendRemainingUsd: number | null;

  /** What billing has this leg funded at, per day. NULL is "no ceiling", never a ceiling of 0. */
  dailyCeilingUsd: number | null;
  /** Whole days at the current ceiling. NULL on every status but `learning`. */
  daysRemaining: number | null;
  /** What raising the ceiling would buy. `[]` whenever `daysRemaining` is null. */
  ceilingScenarios: LearningCeilingScenario[];

  /** Why reaching the spend target is not reaching the outcomes. See {@link OUTCOME_LAG_DAYS}. */
  outcomeLagDays: number;

  /** Every campaign of the scope with its own count, so a consumer can SEE why the verdict reads so. */
  campaigns: LearningCampaign[];
}

/** The evidence one campaign identity contributes, before any of it is judged. */
export interface LearningCampaignInput {
  campaignId: string;
  campaignIds: string[];
  campaignIdentityKey: string | null;
  /** campaign-service's stated leg. */
  legKey: string | null;
  /** campaign-service's stated funnel — the basis the leg is priced through when it contains the leg. */
  funnelKey: string | null;
  live: boolean;
  /**
   * The campaign's raw counts of the two signals a grain observes. NULL for BOTH means the counts
   * could not be read at all, which is a different answer from a measured 0.
   */
  observed: { clicks: number; replies: number } | null;
}

/** One (campaign × workflow) cell of the LEADING campaign: its spend and its raw driver count. */
export interface LearningCell {
  spentUsd: number;
  clicks: number;
  replies: number;
}

/** The terms a campaign's leg is counted and priced on, or null when it states no usable leg. */
interface ResolvedLeg {
  legKey: string;
  funnelKey: SalesFunnelKey;
  outcomeStep: ChannelStepDef;
  driver: LegDriver;
  /** P(the leg's step | one driver signal). NULL = a rate the brand never declared. */
  rateFromDriver: number | null;
  outcomeObserved: boolean;
}

/**
 * Which funnel prices a campaign's leg: the funnel the CAMPAIGN ITSELF states, when that funnel
 * contains the leg, else the first funnel in the catalogue that does. The campaign states both, so
 * nothing here is guessed; the fallback only fires on a row whose two statements disagree.
 */
function resolveLeg(input: LearningCampaignInput, economics: SalesEconomics | null): ResolvedLeg | null {
  if (!input.legKey) return null;
  const legKey = matchFunnelLegKey(input.legKey);
  if (!legKey) return null;
  const leg = funnelLeg(legKey);
  if (!leg) return null;

  const containing = funnelsContainingLeg(legKey);
  if (containing.length === 0) return null;
  const stated = input.funnelKey ? matchSalesFunnelKey(input.funnelKey) : null;
  const funnelKey = stated && containing.includes(stated) ? stated : containing[0]!;

  const driver = FUNNEL_DRIVER[funnelKey];
  // AN ENTRY LEG NEEDS NO RATE — the driver signal IS its outcome, so it is counted and priced for a
  // brand that has declared nothing at all. Only a deeper leg needs the ladder, and without one it is
  // unpriceable rather than zero.
  const isEntry = funnelStepKeys(funnelKey)[0] === leg.toStep.key;
  if (!economics) {
    return {
      legKey,
      funnelKey,
      outcomeStep: leg.toStep,
      driver,
      rateFromDriver: isEntry ? 1 : null,
      outcomeObserved: isEntry,
    };
  }

  const terms = legOutcomeTerms(
    funnelKey,
    leg.toStep.key,
    {
      r2m: economics.replyToMeetingPct / 100,
      v2m: economics.visitToMeetingPct / 100,
      m2c: economics.meetingToClosePct / 100,
      v2c: economics.visitToClosePct / 100,
      v2s: economics.visitToSignupPct / 100,
      s2pc: economics.signupToPaidClientPct / 100,
      ...(economics.visitToFormSubmissionPct != null ? { v2fs: economics.visitToFormSubmissionPct / 100 } : {}),
      ...(economics.formSubmissionToPaidClientPct != null
        ? { fs2pc: economics.formSubmissionToPaidClientPct / 100 }
        : {}),
    },
    bookedToAttendedRate(economics),
  );
  if (!terms) return null;

  return {
    legKey,
    funnelKey,
    outcomeStep: leg.toStep,
    driver,
    rateFromDriver: terms.rateFromDriver,
    outcomeObserved: terms.outcomeObserved,
  };
}

const driverCount = (observed: { clicks: number; replies: number }, driver: LegDriver): number =>
  driver === "click" ? observed.clicks : observed.replies;

/**
 * Pool the leading campaign's (campaign × workflow) cells that OBSERVED an outcome.
 *
 * Σ spend over Σ outcomes, where a cell's outcome count is its driver count walked through the leg's
 * own rate. A cell whose driver count is 0 contributes NEITHER its spend nor its (zero) outcomes: its
 * spend is what exploration cost, and folding it in prices the finding-out into the found. Null when
 * no cell has observed one — that is a floor, and a floor may not found a spend target.
 */
export function expectedCostPerOutcome(cells: LearningCell[], leg: ResolvedLegLike): number | null {
  const rate = leg.rateFromDriver;
  if (rate == null || rate <= 0) return null;
  let spend = 0;
  let driver = 0;
  for (const cell of cells) {
    const count = leg.driver === "click" ? cell.clicks : cell.replies;
    if (count <= 0) continue;
    spend += cell.spentUsd;
    driver += count;
  }
  if (driver <= 0 || spend <= 0) return null;
  return spend / (driver * rate);
}

/** The slice of a resolved leg the pooling needs — exported so a caller can price without the rest. */
export interface ResolvedLegLike {
  driver: LegDriver;
  rateFromDriver: number | null;
}

/** Everything the verdict is built from. Each piece absent is its own stated answer, never a zero. */
export interface LearningPhaseInput {
  /** Every campaign identity of the scope. `null` ⟺ campaign-service could not be read. */
  campaigns: LearningCampaignInput[] | null;
  /** The brand's merged economics, which carry the rate ladder the leg is walked through. */
  economics: SalesEconomics | null;
  /**
   * The LEADING campaign's per-(campaign × workflow) cells, resolved by the caller AFTER this module
   * names the leader. `null` ⟺ not read (no leader to read for) or the read degraded.
   */
  leadingCells: LearningCell[] | null;
  /** The leading campaign's committed spend, in USD, on the SAME basis the money above rides. */
  leadingCommittedSpentUsd: number | null;
  /** What billing has the leading campaign's leg funded at, per day. NULL = no ceiling stated. */
  dailyCeilingUsd: number | null;
}

/**
 * WHICH campaign the countdown is about, resolved before its cells are read.
 *
 * Split out because the caller has to fetch that campaign's cells and its leg's ceiling, and cannot
 * do so until it knows which campaign it is — so this runs first, the caller fetches, and
 * {@link buildLearningPhase} then judges the whole thing. Both walk the SAME rules, so the leader
 * named here is the leader judged there.
 */
export function resolveLearningLeader(
  campaigns: LearningCampaignInput[],
  economics: SalesEconomics | null,
): { input: LearningCampaignInput; leg: ResolvedLeg | null; outcomes: number | null } | null {
  const live = campaigns.filter((c) => c.live);
  if (live.length === 0) return null;
  const scored = live.map((input) => {
    const leg = resolveLeg(input, economics);
    return { input, leg, outcomes: countOutcomes(input, leg) };
  });
  // Most outcomes leads — it is the campaign that crosses first. A campaign we could not count is
  // ranked below every one we could, and the id breaks a tie so the same scope always names the same
  // campaign rather than whichever order the producer happened to serve.
  scored.sort((a, b) => {
    const ao = a.outcomes ?? -1;
    const bo = b.outcomes ?? -1;
    if (ao !== bo) return bo - ao;
    return a.input.campaignId < b.input.campaignId ? -1 : 1;
  });
  return scored[0] ?? null;
}

/** A campaign's count of its OWN leg's step. Null is "we could not count this", never 0. */
function countOutcomes(input: LearningCampaignInput, leg: ResolvedLeg | null): number | null {
  if (!leg || !input.observed) return null;
  const rate = leg.rateFromDriver;
  if (rate == null) return null;
  return driverCount(input.observed, leg.driver) * rate;
}

const EMPTY_VERDICT = {
  campaignId: null,
  campaignIdentityKey: null,
  legKey: null,
  outcomeStep: null,
  outcomesObserved: null,
  progressPct: null,
  outcomeObserved: false,
  expectedCostPerOutcomeUsd: null,
  spendTargetUsd: null,
  committedSpentUsd: null,
  spendRemainingUsd: null,
  dailyCeilingUsd: null,
  daysRemaining: null,
  ceilingScenarios: [] as LearningCeilingScenario[],
};

function describe(input: LearningCampaignInput, leg: ResolvedLeg | null): LearningCampaign {
  return {
    campaignId: input.campaignId,
    campaignIds: input.campaignIds,
    campaignIdentityKey: input.campaignIdentityKey,
    legKey: leg?.legKey ?? input.legKey ?? null,
    outcomeStep: leg?.outcomeStep ?? null,
    outcomesObserved: countOutcomes(input, leg),
    outcomeObserved: leg?.outcomeObserved ?? false,
    live: input.live,
  };
}

/** PURE. Every figure the scope's verdict rests on, and the verdict. No IO, no defaults, no averages. */
export function buildLearningPhase(input: LearningPhaseInput): LearningPhase {
  const base = {
    ...EMPTY_VERDICT,
    outcomesRequired: LEARNING_OUTCOMES_REQUIRED,
    outcomeLagDays: OUTCOME_LAG_DAYS,
    campaigns: [] as LearningCampaign[],
  };

  if (input.campaigns === null) {
    return { ...base, status: "unmeasured", unmeasuredReason: "campaigns_unreadable" };
  }
  const rows = input.campaigns.map((c) => ({ input: c, leg: resolveLeg(c, input.economics) }));
  const campaigns = rows.map(({ input: c, leg }) => describe(c, leg));
  const withCampaigns = { ...base, campaigns };

  if (campaigns.length === 0) {
    return { ...withCampaigns, status: "unmeasured", unmeasuredReason: "no_campaigns" };
  }

  // A SCOPE IS PRICED THE MOMENT ANY OF ITS CAMPAIGNS IS — whatever the siblings are doing, and
  // whether or not that campaign is still running: evidence already gathered does not un-gather.
  const priced = campaigns.find(
    (c) => c.outcomesObserved != null && c.outcomesObserved >= LEARNING_OUTCOMES_REQUIRED,
  );
  if (priced) {
    return {
      ...withCampaigns,
      status: "priced",
      unmeasuredReason: null,
      campaignId: priced.campaignId,
      campaignIdentityKey: priced.campaignIdentityKey,
      legKey: priced.legKey,
      outcomeStep: priced.outcomeStep,
      outcomesObserved: priced.outcomesObserved,
      outcomeObserved: priced.outcomeObserved,
      progressPct: 100,
    };
  }

  const leader = resolveLearningLeader(input.campaigns, input.economics);
  // NOTHING IS RUNNING, so nothing is being gathered and a countdown would be priced against a daily
  // spend that is not happening. The counts stay: what was gathered is still true.
  if (!leader) return { ...withCampaigns, status: "paused", unmeasuredReason: null };

  const { input: lead, leg, outcomes } = leader;
  const named = {
    ...withCampaigns,
    campaignId: lead.campaignId,
    campaignIdentityKey: lead.campaignIdentityKey,
    legKey: leg?.legKey ?? lead.legKey ?? null,
    outcomeStep: leg?.outcomeStep ?? null,
    outcomesObserved: outcomes,
    outcomeObserved: leg?.outcomeObserved ?? false,
    progressPct:
      outcomes == null ? null : Math.min(100, (100 * outcomes) / LEARNING_OUTCOMES_REQUIRED),
    committedSpentUsd: input.leadingCommittedSpentUsd,
    dailyCeilingUsd: input.dailyCeilingUsd,
  };
  const unmeasured = (unmeasuredReason: LearningUnmeasuredReason): LearningPhase => ({
    ...named,
    status: "unmeasured",
    unmeasuredReason,
  });

  if (!leg) return unmeasured("no_leg_stated");
  if (leg.rateFromDriver == null) return unmeasured("leg_unpriceable");
  if (outcomes == null) return unmeasured("no_outcome_evidence");

  const price = input.leadingCells ? expectedCostPerOutcome(input.leadingCells, leg) : null;
  if (price == null) return unmeasured("no_expected_price");

  const spendTargetUsd = price * LEARNING_OUTCOMES_REQUIRED;
  const committed = input.leadingCommittedSpentUsd ?? 0;
  const spendRemainingUsd = Math.max(0, spendTargetUsd - committed);
  const priceFigures = { expectedCostPerOutcomeUsd: price, spendTargetUsd, spendRemainingUsd };

  // THE SPEND IS IN AND THE OUTCOMES ARE NOT. Its own state: not `priced` (the evidence did not
  // arrive) and not `learning` (there is no spend left to wait on). `outcomeLagDays` beside it is why
  // this is not terminal.
  if (spendRemainingUsd === 0) {
    return { ...named, ...priceFigures, status: "learning_limited", unmeasuredReason: null };
  }
  if (input.dailyCeilingUsd == null || input.dailyCeilingUsd <= 0) {
    return { ...named, ...priceFigures, status: "unmeasured", unmeasuredReason: "no_daily_ceiling" };
  }

  const daysAt = (ceiling: number): number => Math.ceil(spendRemainingUsd / ceiling);
  return {
    ...named,
    ...priceFigures,
    status: "learning",
    unmeasuredReason: null,
    daysRemaining: daysAt(input.dailyCeilingUsd),
    ceilingScenarios: CEILING_MULTIPLES.map((m) => ({
      dailyCeilingUsd: input.dailyCeilingUsd! * m,
      daysRemaining: daysAt(input.dailyCeilingUsd! * m),
    })),
  };
}

export type { ChannelStepKey };
