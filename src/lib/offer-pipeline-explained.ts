/**
 * WHAT WORKING WITH US EARNED AN OFFER, STEP BY STEP — AND WHY EACH NUMBER IS WHAT IT IS.
 *
 * The offer outcome read (`lib/offer-outcomes.ts`) answers "how many people at each step, what they cost
 * and what they are worth". A customer reading that page then asks WHY: why is a booked meeting worth
 * $273? how many of my replies went cold? who is about to buy? how many did you actually win me? This
 * module answers those questions from the SAME inputs the outcome rows are built from, so an
 * explanation can never disagree with the figure it explains. Every figure is served; the browser
 * divides, multiplies and sums nothing.
 *
 * ── THE VALUE OF A STEP, EXPLAINED (`explainStepValue`) ─────────────────────────────────────────
 *
 *   valuePerOutcomeUsd = lifetimeRevenueUsd × P(paid client | reached the step)
 *   P(paid client | step) = Π the leg rates of the BASIS funnel from the step onward to Paid client
 *
 * The basis funnel is the one `stepValues` already picked (best path, max), and each leg rate is the
 * one that funnel was priced on, with its source (`measured` on the CRM or on our leads, `manual` =
 * the customer stated it, `median` = fleet median, `default` = industry benchmark) and, when measured,
 * the counts it was measured on. The product is RECONCILED against the served value before it is
 * served: a set of legs that does not multiply back to the value to the cent is withheld (null + loud log),
 * never served beside a value it does not explain.
 *
 * ── CONVERSION FROM THE PREVIOUS STEP (`stepConversion`) ────────────────────────────────────────
 *
 * The previous step of a step is the step before it on the funnels the offer is priced on (any
 * catalogue funnel when none of those contains it); a funnel's FIRST step is preceded by "contacted".
 * Several previous steps (a meeting booked off a reply OR a visit) are unioned. Distinct leads, both
 * sides: `reachedFromPrevious` = leads at the step that also stood on a previous step,
 * `previousReached` = leads that stood on one; rate = their ratio.
 *
 * ── COLD, HOT, WON, CONTACTED (`buildOfferPipeline`) ────────────────────────────────────────────
 *
 *   - COLD: lead-service's went-cold rule, exactly as served (CRM brands only; nothing re-derived), narrowed
 *     to interest WE caused (the stalled step priced on this read and after our first delivered email;
 *     the rest is counted in `otherCausesCount`, never listed). A
 *     cold lead is worth what the pipeline prices it at TODAY (`expectedValueOfPerson`, the dead-step
 *     overlay already applied), i.e. back to whatever path the cold step does not kill.
 *   - HOT: live engaged leads (any step reached, not won, not cold) the pipeline still prices above 0,
 *     ranked by that value; the top `HOT_LEADS_LIMIT` are listed, the whole set is counted and summed.
 *   - WON: paying clients on the priced causes (default: our outreach only). One organisation is one
 *     client, worth the amount stated on its sale, else the offer's lifetime revenue (the Deals board's
 *     Won rule, narrowed to the priced causes).
 *   - CONTACTED: distinct people and distinct companies contacted.
 *
 * ── WHO STANDS ON EACH STEP (`ladder[].people`) ──────────────────────────────────────────────────
 *
 * The people at a ladder step (the same distinct leads `recipientsReached` counts), in three disjoint
 * groups, each COUNTED whole and LISTED up to `STEP_PEOPLE_LIMIT`:
 *   - `ours`: the step is priced for them (the `pricedRecipientsReached` rule) and they are not lost.
 *   - `lost`: priced for them, but lost — lead-service says they went cold (`went_cold`, since `coldSince`;
 *     the same verdict that keeps a person out of hot leads), or
 *     ruled out by a human at a step and now priced at 0 (`ruled_out`, the deals board's verdict; no date).
 *     A paying client is never lost.
 *   - `notOurs`: reached, but the step is not priced for them (another cause, or unstated).
 * `ours.count + lost.count === pricedRecipientsReached`; `+ notOurs.count === recipientsReached`.
 * `pricedConversionFromPrevious` is `conversionFromPrevious` measured on the priced sets only
 * (`contacted` stays everyone contacted), so it reads beside the priced People count.
 *
 * Every person listed anywhere in this block carries `campaignLeadIds` (the `leads_campaigns` rows of
 * the person within the offer's campaigns; the id lead-service's per-lead step-statement write takes)
 * and `campaignLeadId` (the first of them), so a panel can write a status without a lookup.
 *
 * ── THE PIPELINE, SLICED: ONE ROW PER PERSON (`exclusiveLadder`, owner 2026-10-08) ──────────────
 *
 * `ladder[]` is CUMULATIVE (a paying client is also on Meeting attended, Meeting booked, Positive
 * reply), so its rows overlap and never add. `exclusiveLadder` is the second reading: every person
 * stands on ONE row, and the rows add up to the offer's pipeline.
 *   - A person's row = the furthest step we brought them to (the furthest step PRICED for them); a
 *     person no step is priced for stands, as `notOurs`, on the furthest step they reached; a contacted
 *     person who reached no step stands on the `contacted` row. Never contacted and no step = no row.
 *   - What a person adds = the engine's own per-person value (`computeRevenue`, contacted pricing
 *     included: the byte-same run as the offer's revenue read), under the pipeline's company rule: one
 *     company is counted once, at its most valuable member (ties: smallest lead id). A colleague of that
 *     member adds 0 (`countedWithColleague`); what they would have added rides `countedWithColleagueUsd`.
 *   - So Σ rows' `pipelineUsd` + `contacted.pipelineUsd` = `total.pipelineUsd` = the engine's
 *     `totalPipelineUsd` over this population, and `total.headlinePipelineUsd` is what the offer's
 *     revenue read serves; a gap between the two is served with its reason, never silent.
 *   - The contacted row's value is explained like a step's: per entry route, the chance of reaching
 *     its step from contact (the brand's per-(campaign × workflow) entry rate, averaged over the valued
 *     people) times that step's value, the routes combined as independent shots at one close, expiring
 *     30 days after the last email sent.
 *   - `rows[].hot`: the row's people who are hot leads (the `hotLeads` set, not a re-derived one), so
 *     Σ rows' hot counts = `hotLeads.totalCount` minus the few on the contacted row / no row (an engaged
 *     step not counted), all served in `total.hot`. A hot person is in `ours` or `notOurs`, never `lost`.
 * The conversion column stays the cumulative `pricedConversionFromPrevious` (step to step is a
 * cumulative notion: of those who stood on the previous step, how many reached this one).
 */
import { CHANNEL_STEPS, funnelStepKeys, type ChannelStepKey } from "./acquisition-channels.js";
import { getFunnel, restrictPathsToDeclaredLegs } from "./funnel-registry.js";
import { LEAD_FIELD_TO_SIGNAL, stepMeasured, type StepEvidence } from "./funnel-steps.js";
import { legKeyFor } from "./funnel-legs.js";
import { STEP_LEAD_FIELD, type StepValue } from "./offer-outcomes.js";
import { priceOnDeclaredFunnel } from "./offer-pricing.js";
import {
  computeRevenue,
  contactedExpired,
  contactedGroupKey,
  CONTACTED_VALUE_EXPIRY_DAYS,
  dedupPersonsByLead,
  expectedValueOfPerson,
  type ContactedPricing,
  type EnginePerson,
  type ResolvedPath,
} from "./revenue-engine.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";
import { DISPLAY_ONLY_SALES_FUNNELS, SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";
import type { ColdLeadsRead } from "./step-outcomes-client.js";
import type { MeasurementBasis, RateCandidate } from "./effective-conversion-rates.js";
import { DEFAULT_PRICED_CAUSES, causeByDeliveryRule, type OutcomeCause } from "./outcome-cause.js";

/** Where a leg rate comes from — the effective-rate vocabulary (`lib/effective-conversion-rates.ts`). */
export type ExplainedRateSource = "measured" | "manual" | "median" | "default";

export interface ExplainedLeg {
  fromStep: { key: ChannelStepKey; label: string };
  toStep: { key: ChannelStepKey; label: string };
  legKey: string;
  ratePct: number;
  source: ExplainedRateSource | null;
  /** The counts a MEASURED rate was read on (`toReached` of `fromReached`); null for any other source. */
  measured: { basis: MeasurementBasis; fromReached: number | null; toReached: number | null } | null;
  /**
   * Every rate the precedence weighed for the leg, in precedence order, exactly one `kept` (its `ratePct`
   * = `ratePct` above). A leg priced off a funnel carrying no candidates states its one rate as the kept one.
   */
  candidates: RateCandidate[];
}

export interface StepValueExplanation {
  lifetimeRevenueUsd: number;
  /** P(paid client | reached the step) × 100 = Π legs[].ratePct / 100 × 100. */
  probabilityPct: number;
  basisFunnelKey: SalesFunnelKey;
  /** The legs multiplied, from the step to Paid client. Empty on Paid client itself (100%). */
  legs: ExplainedLeg[];
}

const SOURCES: Record<string, ExplainedRateSource> = {
  stated_measured: "measured",
  stated_manual: "manual",
  stated_median: "median",
  stated_default: "default",
};

/**
 * The leg's candidates as served: the arrow's own when they agree with the rate it is priced on (one kept,
 * at that rate), else the one rate the arrow carries, kept. Never two kept, never a kept rate the value
 * was not priced on.
 */
function legCandidates(
  ratePct: number,
  source: ExplainedRateSource | null,
  measured: ExplainedLeg["measured"],
  candidates: readonly RateCandidate[] | undefined,
): RateCandidate[] {
  const kept = candidates?.filter((c) => c.kept) ?? [];
  if (candidates && kept.length === 1 && kept[0]!.ratePct === ratePct) return candidates.map((c) => ({ ...c }));
  if (candidates) {
    console.error(`[features-service] offer value explanation: a leg's rate candidates do not keep its rate ${ratePct}; serving the rate alone`);
  }
  if (source === null) return [];
  return [
    {
      basis: source === "measured" ? (measured?.basis ?? "our_leads") : source,
      ratePct,
      fromReached: measured?.fromReached ?? null,
      toReached: measured?.toReached ?? null,
      outcomesCounted: null,
      brandCount: null,
      kept: true,
      notKeptReason: null,
    },
  ];
}

/** Tolerance of the reconciliation: half a cent, or a relative 1e-9 on a very large value. */
const reconciles = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 1e-9);

/**
 * PURE: the explanation of one step's value, or null when there is no value, the basis funnel states
 * no lifetime revenue, a leg on the way has no rate, or the legs do not multiply back to the value.
 */
export function explainStepValue(
  declared: readonly DeclaredSalesFunnel[],
  step: ChannelStepKey,
  value: StepValue | undefined,
): StepValueExplanation | null {
  if (!value) return null;
  const funnel = declared.find((f) => f.funnelKey === value.basisFunnelKey);
  const ltr = funnel?.lifetimeRevenueUsd;
  if (!funnel || typeof ltr !== "number" || !Number.isFinite(ltr)) return null;
  const steps = funnelStepKeys(funnel.funnelKey);
  const index = steps.indexOf(step);
  if (index < 0) return null;
  const legs: ExplainedLeg[] = [];
  let probability = 1;
  for (let i = index; i + 1 < steps.length; i++) {
    const arrow = funnel.arrows?.[i];
    if (!arrow || arrow.ratePct === null || !Number.isFinite(arrow.ratePct)) return null;
    probability *= arrow.ratePct / 100;
    const source = SOURCES[arrow.provenance] ?? null;
    const from = steps[i];
    const to = steps[i + 1];
    const measured =
      source === "measured" && arrow.measured
        ? { basis: arrow.measured.basis, fromReached: arrow.measured.fromReached, toReached: arrow.measured.toReached }
        : null;
    legs.push({
      fromStep: { key: from, label: CHANNEL_STEPS[from].label },
      toStep: { key: to, label: CHANNEL_STEPS[to].label },
      legKey: legKeyFor({ from, to }),
      ratePct: arrow.ratePct,
      source,
      measured,
      candidates: legCandidates(arrow.ratePct, source, measured, arrow.candidates),
    });
  }
  if (!reconciles(ltr * probability, value.valuePerOutcomeUsd)) {
    console.error(
      `[features-service] offer value explanation withheld: ${step} on ${funnel.funnelKey} — LTR ${ltr} × legs ` +
        `${probability} = ${ltr * probability} ≠ served value ${value.valuePerOutcomeUsd}`,
    );
    return null;
  }
  return { lifetimeRevenueUsd: ltr, probabilityPct: probability * 100, basisFunnelKey: funnel.funnelKey, legs };
}

/** A previous step: a channel step, or `contacted` before a funnel's first step. */
export type PreviousStep = ChannelStepKey | "contacted";

/** PURE: the steps right before `step` on the priced funnels (any catalogue funnel when none holds it). */
export function previousStepsOf(step: ChannelStepKey, pricedFunnelKeys: readonly SalesFunnelKey[]): PreviousStep[] {
  const holds = (k: SalesFunnelKey) => funnelStepKeys(k).includes(step);
  let funnels = pricedFunnelKeys.filter(holds);
  if (funnels.length === 0) {
    funnels = (Object.keys(SALES_FUNNELS) as SalesFunnelKey[]).filter((k) => !DISPLAY_ONLY_SALES_FUNNELS.has(k) && holds(k));
  }
  const out = new Set<PreviousStep>();
  for (const k of funnels) {
    const steps = funnelStepKeys(k);
    const i = steps.indexOf(step);
    out.add(i === 0 ? "contacted" : steps[i - 1]);
  }
  const order = (s: PreviousStep) => (s === "contacted" ? -1 : Object.keys(CHANNEL_STEPS).indexOf(s));
  return [...out].sort((a, b) => order(a) - order(b));
}

export interface StepConversion {
  previousSteps: PreviousStep[];
  /** Distinct leads that stood on at least one previous step. */
  previousReached: number;
  /** Of those, the distinct leads that ALSO reached this step. */
  reachedFromPrevious: number;
  /** reachedFromPrevious ÷ previousReached × 100; null when nobody stood on a previous step. */
  ratePct: number | null;
}

/** Distinct lead ids per step (null = the step is not counted, or its producer was unreadable), plus contacted. */
export interface OfferStepSets {
  contacted: Set<string>;
  byStep: Map<ChannelStepKey, Set<string> | null>;
}

/** PURE: per step, the offer's distinct leads standing on it. */
export function offerStepSets(persons: readonly EnginePerson[], evidence: StepEvidence): OfferStepSets {
  const deduped = dedupPersonsByLead([...persons]);
  const contacted = new Set(deduped.filter((p) => p.signals.contacted).map((p) => p.leadId));
  const byStep = new Map<ChannelStepKey, Set<string> | null>();
  for (const step of Object.keys(CHANNEL_STEPS) as ChannelStepKey[]) {
    const field = STEP_LEAD_FIELD[step];
    if (!field || !stepMeasured(field, evidence)) {
      byStep.set(step, null);
      continue;
    }
    const signal = LEAD_FIELD_TO_SIGNAL[field];
    byStep.set(step, new Set(deduped.filter((p) => p.signals[signal]).map((p) => p.leadId)));
  }
  return { contacted, byStep };
}

/** PURE: conversion into the leads `reached` from the previous steps' leads. Null when a previous step is uncounted. */
export function stepConversion(
  step: ChannelStepKey,
  reached: ReadonlySet<string>,
  sets: OfferStepSets,
  pricedFunnelKeys: readonly SalesFunnelKey[],
): StepConversion | null {
  const previousSteps = previousStepsOf(step, pricedFunnelKeys);
  const union = new Set<string>();
  for (const prev of previousSteps) {
    const set = prev === "contacted" ? sets.contacted : sets.byStep.get(prev);
    if (!set) return null;
    for (const id of set) union.add(id);
  }
  let reachedFromPrevious = 0;
  for (const id of reached) if (union.has(id)) reachedFromPrevious++;
  return {
    previousSteps,
    previousReached: union.size,
    reachedFromPrevious,
    ratePct: union.size > 0 ? (reachedFromPrevious / union.size) * 100 : null,
  };
}

// ── The pipeline ─────────────────────────────────────────────────────────────────────────────────

/** The ladder's steps, in the order a lead climbs them. */
export const LADDER_STEPS: readonly ChannelStepKey[] = [
  "website_visit",
  "conversation",
  "signup",
  "form_submitted",
  "meeting_booked",
  "meeting_attended",
  "paid_client",
];

/** The step a cold lead REACHED before the silence. */
const COLD_REACHED_STEP: Record<"positive_reply" | "meeting_booked", ChannelStepKey> = {
  positive_reply: "conversation",
  meeting_booked: "meeting_booked",
};
const COLD_REACHED_SIGNAL: Record<"positive_reply" | "meeting_booked", string> = {
  positive_reply: "positiveReply",
  meeting_booked: "meeting",
};

/** How many hot leads are listed (all are counted and summed). */
export const HOT_LEADS_LIMIT = 25;

const ENGAGED_SIGNALS = ["clicked", "positiveReply", "signup", "formSubmission", "meeting", "meetingAttended"] as const;

export interface PipelineLeadIdentity {
  leadId: string;
  /** One `leads_campaigns` row id of the person (the first of `campaignLeadIds`); null when none stated. */
  campaignLeadId: string | null;
  /** Every `leads_campaigns` row id of the person within the offer's campaigns. */
  campaignLeadIds: string[];
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  orgName: string | null;
  orgDomain: string | null;
  orgLogoUrl: string | null;
}

export interface PricedPipelineLead extends PipelineLeadIdentity {
  /** The furthest step the lead reached. */
  step: { key: ChannelStepKey; label: string };
  /** What the pipeline prices the lead at now. Null only on a cold lead of an offer with no priced economics. */
  valueUsd: number | null;
  /** valueUsd ÷ (the lead's stated value, else the offer's lifetime revenue) × 100. */
  probabilityPct: number | null;
}

export interface ColdPipelineLead extends PricedPipelineLead {
  /** The step that never came. */
  coldAtStep: { key: ChannelStepKey; label: string };
  coldSince: string;
  stalledSince: string;
}

export interface LostPipelineLead extends PricedPipelineLead {
  lostReason: "went_cold" | "ruled_out";
  /** went_cold: coldSince. ruled_out: null (undated here). */
  lostSince: string | null;
  /** went_cold only (null when ruled out). */
  coldAtStep: { key: ChannelStepKey; label: string } | null;
  coldSince: string | null;
  stalledSince: string | null;
}

export interface LadderStep {
  step: { key: ChannelStepKey; label: string };
  /** Distinct leads of the offer that reached the step, every cause counted. Null = not counted / unreadable. */
  recipientsReached: number | null;
  /** Of those, the ones whose step is priced (`?cause=`, default our outreach). */
  pricedRecipientsReached: number | null;
  valuePerOutcomeUsd: number | null;
  /** pricedRecipientsReached × valuePerOutcomeUsd — the outcome row's `valueUsd` rule. Null when either is. */
  pricedValueUsd: number | null;
  valueExplanation: StepValueExplanation | null;
  conversionFromPrevious: StepConversion | null;
  /** The same conversion over the PRICED leads of each step (the People column's basis). */
  pricedConversionFromPrevious: StepConversion | null;
  /** Who stands on the step, in three groups (see the module doc). Null when the step is not counted. */
  people: StepPeople | null;
  /** Leads that reached this step and then went cold; null when who went cold could not be read. */
  wentCold: { count: number; valueUsd: number | null } | null;
}

/** How many people each group of a step lists (every group is counted whole). */
export const STEP_PEOPLE_LIMIT = 25;

export interface StepPerson extends PipelineLeadIdentity {
  /** When the person first reached the step; null when the producer dated it nowhere. */
  reachedAt: string | null;
  /** What the pipeline prices the person at now; null when the offer has no priced economics. */
  valueUsd: number | null;
  probabilityPct: number | null;
}

export interface LostStepPerson extends StepPerson {
  lostReason: "went_cold" | "ruled_out";
  /** Since when (the cold verdict's `coldSince`); null for a ruled-out person (the statement is undated here). */
  lostSince: string | null;
  /** The step that never came (went cold only). */
  coldAtStep: { key: ChannelStepKey; label: string } | null;
}

export interface StepPeopleGroup<T> {
  count: number;
  leads: T[];
}

export interface StepPeople {
  limit: number;
  ours: StepPeopleGroup<StepPerson>;
  lost: StepPeopleGroup<LostStepPerson>;
  notOurs: StepPeopleGroup<StepPerson>;
}

/** A person on the exclusive ladder: the card, plus what they add to the pipeline under the company rule. */
export interface ExclusiveStepPerson extends StepPerson {
  /** What this person adds to the pipeline: their value when they carry their company's, else 0. Null = unpriced offer. */
  pipelineUsd: number | null;
  /** A colleague at the same company carries the company's value (one company is counted once). */
  countedWithColleague: boolean;
}
export type ExclusiveLostStepPerson = LostStepPerson & Pick<ExclusiveStepPerson, "pipelineUsd" | "countedWithColleague">;

export interface ExclusiveStepPeople {
  limit: number;
  ours: StepPeopleGroup<ExclusiveStepPerson>;
  lost: StepPeopleGroup<ExclusiveLostStepPerson>;
  notOurs: StepPeopleGroup<ExclusiveStepPerson>;
}

export interface ExclusiveLadderRow {
  step: { key: ChannelStepKey; label: string };
  /** People whose furthest step WE brought them to is this one (ours + lost). Null when the step is not counted. */
  pricedPeople: number | null;
  /** What one person reaching the step is worth (the cumulative ladder's own value). */
  valuePerOutcomeUsd: number | null;
  /** Σ what the row's people add to the pipeline (company rule applied). Null when the offer is unpriced. */
  pipelineUsd: number | null;
  /** Σ the values of the row's people whose company a colleague already carries (NOT in pipelineUsd). */
  countedWithColleagueUsd: number | null;
  people: ExclusiveStepPeople | null;
  /**
   * The row's people who are hot leads (the `hotLeads` verdict, byte-same set), highest value first, capped
   * at `STEP_PEOPLE_LIMIT`, counted whole. Null when `hotLeads` is null (the offer is unpriced).
   */
  hot: ({ limit: number } & StepPeopleGroup<ExclusiveStepPerson>) | null;
  /** The row's "% Conversion" (owner 2026-10-08), see `ConversionFromRowAbove`. */
  conversionFromRowAbove: ConversionFromRowAbove | null;
  /** The same figure, one point per day since the offer's first delivery (see `ConversionHistory`). Null unless asked, or the step is not counted. */
  conversionHistory: ConversionHistory | null;
}

/** One day of a sliced row's % Conversion: the rule of `ConversionFromRowAbove` on where each person stood that day. */
export interface ConversionHistoryPoint {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /** Null when the row had no row above that day, or was not displayed (no priced, no notOurs people), or both rows were 0. */
  ratePct: number | null;
  /** The row's people that day (pricedPeople; the contacted row: count). */
  rowPeople: number;
  rowAbove: { key: ChannelStepKey; label: string } | null;
  rowAbovePeople: number | null;
}

/**
 * THE SLICED % CONVERSION, DATED (owner 2026-10-08, the step side panel's chart). Per UTC day from the offer's
 * first delivered email to today, every person stands where they stood THAT day: the furthest step priced
 * for them reached by then, else the furthest reached (notOurs), else the contacted row once contacted;
 * then the SAME rule (`conversionsFromRowAbove`) as today's column. Same population and sets, so the last
 * point IS today's `conversionFromRowAbove`. A step a person reached with NO date is placed on the last
 * point only (never back-dated); `undatedPeople` counts the row's people whose arrival on it is undated.
 */
export interface ConversionHistory {
  startsOn: string;
  endsOn: string;
  undatedPeople: number;
  points: ConversionHistoryPoint[];
}

/**
 * THE SLICED LADDER'S CONVERSION COLUMN (owner 2026-10-08, verbatim: "the conversion colonne is recalculated as
 * the total of the row above / (total of that row + totla above)"). A row's total = its people (`pricedPeople`;
 * the contacted row: `count`); "the row above" = the next DEEPER row as displayed (a row with no priced and no
 * notOurs people is not displayed, so it is skipped). Rate = above / (row + above) × 100, null when both are 0.
 * The deepest displayed row has no row above: null. Not ladder[].pricedConversionFromPrevious (cumulative).
 */
export interface ConversionFromRowAbove {
  rowAbove: { key: ChannelStepKey; label: string };
  rowAbovePeople: number;
  rowPeople: number;
  ratePct: number | null;
}

export interface ContactedEntryRouteExplained {
  signal: string;
  step: { key: ChannelStepKey; label: string };
  legKey: string;
  /** Average over the valued people of P(this step | contacted), their (campaign × workflow) group's rate. */
  entryRatePct: number;
  /** What a person standing on the step is worth (the engine's path value). */
  valueAtStepUsd: number;
}

export interface ExclusiveContactedRow {
  /** Contacted people who reached no step (openers included; bounced and unsubscribed included, at 0). */
  count: number;
  /** Of those, the ones the pipeline values above 0 (priced entry rate, not expired, can convert). */
  valuedCount: number;
  /** Last email sent more than `expiryDays` ago: worth 0. */
  expiredCount: number;
  /** Bounced or unsubscribed: worth 0. */
  cannotConvertCount: number;
  /** No priced entry rate for their (campaign × workflow) group, or no campaign/workflow: worth 0. */
  unpricedCount: number;
  /** Mean value over the valued people. Null when nobody is valued or the offer is unpriced. */
  valuePerPersonUsd: number | null;
  pipelineUsd: number | null;
  countedWithColleagueUsd: number | null;
  /** How one is priced. Null when nobody is valued (no rate, all expired) or the offer is unpriced. */
  explanation: { routes: ContactedEntryRouteExplained[]; combine: "independent"; expiryDays: number; lastSentOnOrAfter: string } | null;
  /** Listed highest value first, capped at `limit`; counted whole in `count`. */
  people: { limit: number; leads: ExclusiveStepPerson[] };
  /** The row's "% Conversion": the shallowest displayed step row over (count + it). Null when no step row is displayed. */
  conversionFromRowAbove: ConversionFromRowAbove | null;
  /** Its dated series (see `ConversionHistory`). Null unless asked. */
  conversionHistory: ConversionHistory | null;
}

export interface ExclusiveLadder {
  contacted: ExclusiveContactedRow;
  /** The ladder's steps in climbing order; every person on exactly one row (or the contacted row). */
  rows: ExclusiveLadderRow[];
  total: {
    /** Distinct people on a row (contacted row included). */
    people: number;
    /** Served people on no row: never contacted, reached no step (worth 0). */
    peopleOnNoRow: number;
    /** What the people on no row add (0 by construction; served so the sum below is whole). */
    noRowPipelineUsd: number | null;
    /** Σ rows' pipelineUsd + contacted.pipelineUsd (+ noRowPipelineUsd, 0) = the engine's totalPipelineUsd over this population. */
    pipelineUsd: number | null;
    /** The offer revenue read's `headline.totalPipelineUsd` (the page's Pipeline figure). Null when unread. */
    headlinePipelineUsd: number | null;
    /** headlinePipelineUsd − pipelineUsd; 0 when they agree to the cent. Null when either is null. */
    gapUsd: number | null;
    /** Why there is a gap (or why it could not be checked); null when they agree. */
    gapReason: "population_differs" | "headline_unreadable" | "unpriced" | null;
    /**
     * Where `hotLeads.totalCount` stands on this ladder: Σ rows[].hot.count + onContactedRow + onNoRow = count.
     * A hot person sits on the contacted row / no row only when the step they engaged on is not counted
     * (its producer unreadable). Null when `hotLeads` is null.
     */
    hot: { count: number; onRows: number; onContactedRow: number; onNoRow: number } | null;
  };
}

export interface OfferPipeline {
  peopleContacted: number;
  companiesContacted: number;
  /** Contacted people whose company is unknown (counted in no company). */
  contactedWithoutCompanyCount: number;
  ladder: LadderStep[];
  customersWon: {
    /** Organisations won on the priced causes (one organisation = one client). */
    count: number;
    leadCount: number;
    /** Stated amount, else lifetime revenue, per client; null when a client has neither. */
    valueUsd: number | null;
    /** Paying clients the read counted but did not price (another cause, or unstated). */
    otherCausesLeadCount: number;
  } | null;
  /** Null when lead-service did not say who went cold. `applies: false` = not a CRM brand: nothing goes cold. */
  coldRule: { applies: boolean; afterDays: number | null } | null;
  coldLeads: { count: number; valueUsd: number | null; leads: ColdPipelineLead[]; otherCausesCount: number } | null;
  /**
   * TODAY'S LOST LEADS (owner 2026-10-08, option (a)): went cold on interest we caused (`coldLeads`,
   * reason `went_cold`) + engaged, ruled out by a human and now priced at 0 (`ruled_out`). The same
   * verdict as the `lost` family of `/brands/:id/lead-families`. Null when who went cold could not be read.
   */
  lostLeads: { count: number; valueUsd: number | null; wentColdCount: number; ruledOutCount: number; leads: LostPipelineLead[] } | null;
  hotLeads: { limit: number; totalCount: number; totalValueUsd: number; leads: PricedPipelineLead[] } | null;
  /** Why lead values (hot, cold values) are null: the offer has no priced economics. */
  leadValuesUnpricedReason: string | null;
  /** The pipeline sliced: each person on one row, rows adding to the total (see the module doc). */
  exclusiveLadder: ExclusiveLadder;
}

const SIGNAL_STEP: ReadonlyArray<[string, ChannelStepKey]> = [
  ["closeWin", "paid_client"],
  ["meetingAttended", "meeting_attended"],
  ["meeting", "meeting_booked"],
  ["formSubmission", "form_submitted"],
  ["signup", "signup"],
  ["positiveReply", "conversation"],
  ["clicked", "website_visit"],
];

function furthestStep(p: EnginePerson): ChannelStepKey | null {
  for (const [signal, step] of SIGNAL_STEP) if (p.signals[signal]) return step;
  return null;
}

const stepWire = (key: ChannelStepKey) => ({ key, label: CHANNEL_STEPS[key].label });

const identity = (p: EnginePerson): PipelineLeadIdentity => ({
  leadId: p.leadId,
  campaignLeadId: p.campaignLeadIds?.[0] ?? null,
  campaignLeadIds: [...(p.campaignLeadIds ?? [])],
  firstName: p.firstName ?? null,
  lastName: p.lastName ?? null,
  title: p.title ?? null,
  orgName: p.orgName ?? null,
  orgDomain: p.orgDomain ?? null,
  orgLogoUrl: p.orgLogoUrl ?? null,
});

const statedValue = (p: EnginePerson): number | null =>
  typeof p.valueUsd === "number" && Number.isFinite(p.valueUsd) && p.valueUsd >= 0 ? p.valueUsd : null;

/**
 * WHICH FAMILY A PERSON IS IN (the Unibox filters, owner 2026-10-08), from the SAME verdicts the pipeline
 * block serves, so a filter count can never disagree with Today's:
 *   - `won`: a paying client on the priced causes (the people `customersWon` counts).
 *   - `hot`: a hot lead (every one `hotLeads.totalCount` counts, not only the listed top).
 *   - `lost`: interested thanks to us then went cold (`coldLeads`, reason `went_cold`), or engaged, ruled
 *     out by a human and now priced at 0 (`ruled_out`).
 *   - `cold`: contacted by us, never engaged.
 * Precedence won > hot > lost > cold; anyone else (engaged on another cause, cold on another cause) has
 * no family and is absent.
 */
export type LeadFamily = "won" | "hot" | "lost" | "cold";
export const LEAD_FAMILY_RANK: Record<LeadFamily, number> = { won: 0, hot: 1, lost: 2, cold: 3 };

export interface LeadFamilyRow {
  leadId: string;
  /** Canonical (trimmed, lower-cased) email; null when the producer states none. */
  email: string | null;
  campaignLeadIds: string[];
  family: LeadFamily;
  lostReason: "went_cold" | "ruled_out" | null;
}

/** PURE: the whole pipeline block. `values`/`explanations` are the outcome rows' own (one source). */
export function buildOfferPipeline(input: Parameters<typeof buildOfferPipelineAndFamilies>[0]): OfferPipeline {
  return buildOfferPipelineAndFamilies(input).pipeline;
}

/** PURE: the pipeline block AND every person's family, off one pass (see `LeadFamily`). */
export function buildOfferPipelineAndFamilies(input: {
  persons: readonly EnginePerson[];
  evidence: StepEvidence;
  declared: readonly DeclaredSalesFunnel[];
  values: ReadonlyMap<ChannelStepKey, StepValue>;
  /** lead-service's went-cold read; null when it was unreadable or not served. */
  cold: ColdLeadsRead | null;
  sets: OfferStepSets;
  /** The priced causes (`?cause=`, default our outreach): a cold lead is listed only when its interest was one. */
  pricedCauses?: readonly OutcomeCause[];
  /** How the pipeline prices a contacted-only lead (the revenue read's own `contactedPricingSoft`); null = at 0. */
  contactedPricing?: ContactedPricing | null;
  /** The offer revenue read's `headline.totalPipelineUsd`, to reconcile the exclusive total against; null = unread. */
  headlinePipelineUsd?: number | null;
  /** Asked: the sliced rows' dated % Conversion (`ConversionHistory`). Absent/null = not served (null on the wire). */
  conversionHistory?: ConversionHistoryInput | null;
}): { pipeline: OfferPipeline; families: LeadFamilyRow[] } {
  const persons = dedupPersonsByLead([...input.persons]);
  const priced = priceOnDeclaredFunnel([...input.declared]);
  const economics = priced.economics.economics;
  const ltr = economics?.lifetimeRevenueUsd ?? null;
  const engine = getFunnel("sales-cold-email-outreach");
  if (!engine) throw new Error("[features-service] the sales funnel engine is not registered");
  const paths: ResolvedPath[] | null = economics
    ? restrictPathsToDeclaredLegs(engine.resolvePaths({ economics, pricedFunnelKeys: priced.pricedFunnelKeys }), priced.pricedFunnelKeys)
    : null;
  const valueOf = (p: EnginePerson): number | null => (paths && ltr !== null ? expectedValueOfPerson(p, paths, ltr) : null);
  const probabilityOf = (p: EnginePerson, v: number): number | null => {
    const base = statedValue(p) ?? ltr;
    return base !== null && base > 0 ? (v / base) * 100 : null;
  };

  // CONTACTED.
  const contacted = persons.filter((p) => p.signals.contacted);
  const companies = new Set(contacted.map((p) => p.orgId).filter((id): id is string => Boolean(id)));

  // COLD — the offer's leads among lead-service's cold rows (lead id, else canonical email).
  const byLead = new Map(persons.map((p) => [p.leadId, p] as const));
  const byEmail = new Map(persons.filter((p) => p.email).map((p) => [p.email!.trim().toLowerCase(), p] as const));
  const coldLeads: ColdPipelineLead[] = [];
  const coldIds = new Set<string>();
  /** Every matched cold verdict, ours or not (a step's `lost` group, like hot leads, excludes any cold person). */
  const coldVerdicts = new Map<string, { coldSince: string; coldAtStep: { key: ChannelStepKey; label: string } }>();
  let coldOtherCauses = 0;
  const pricedCauses = new Set<OutcomeCause>(input.pricedCauses ?? DEFAULT_PRICED_CAUSES);
  if (input.cold) {
    const rows = [...input.cold.leads].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
    for (const row of rows) {
      const person = byLead.get(row.leadId) ?? (row.email ? byEmail.get(row.email) : undefined);
      if (!person || coldIds.has(person.leadId)) continue;
      coldIds.add(person.leadId);
      coldVerdicts.set(person.leadId, { coldSince: row.since, coldAtStep: stepWire(row.step) });
      // ONLY INTEREST WE CAUSED: the step it stalled on must be priced on this read (its cause verdict),
      // and must have happened after our first delivered email (the cause rule, `causeByDeliveryRule`).
      // A CRM deal that went cold in 2024, before we ever emailed, is not a lead we lost.
      const reachedSignal = COLD_REACHED_SIGNAL[row.after];
      const ours =
        !(person.unpricedSignals ?? []).includes(reachedSignal) &&
        pricedCauses.has(causeByDeliveryRule(row.stalledSince, person.signalDates?.delivered ?? null));
      if (!ours) {
        coldOtherCauses += 1;
        continue;
      }
      const v = valueOf(person);
      coldLeads.push({
        ...identity(person),
        step: stepWire(COLD_REACHED_STEP[row.after]),
        valueUsd: v,
        probabilityPct: v === null ? null : probabilityOf(person, v),
        coldAtStep: stepWire(row.step),
        coldSince: row.since,
        stalledSince: row.stalledSince,
      });
    }
  }
  const sumValues = (leads: readonly { valueUsd: number | null }[]): number | null =>
    paths ? leads.reduce((s, l) => s + (l.valueUsd ?? 0), 0) : null;
  const coldByStep = new Map<ChannelStepKey, ColdPipelineLead[]>();
  for (const lead of coldLeads) coldByStep.set(lead.step.key, [...(coldByStep.get(lead.step.key) ?? []), lead]);

  // LADDER.
  const pricedOn = (p: EnginePerson, signal: string) => !(p.unpricedSignals ?? []).includes(signal);
  const signalOfStep = (step: ChannelStepKey): string | null => {
    const field = STEP_LEAD_FIELD[step];
    return field ? LEAD_FIELD_TO_SIGNAL[field] : null;
  };
  // The priced twin of the step sets: per step, only the leads the step is priced for.
  const pricedSets: OfferStepSets = { contacted: input.sets.contacted, byStep: new Map() };
  for (const [step, set] of input.sets.byStep) {
    const signal = signalOfStep(step);
    pricedSets.byStep.set(
      step,
      set && signal ? new Set(persons.filter((p) => set.has(p.leadId) && pricedOn(p, signal)).map((p) => p.leadId)) : null,
    );
  }
  const card = (p: EnginePerson, signal: string): StepPerson => {
    const v = valueOf(p);
    return {
      ...identity(p),
      reachedAt: p.signalDates?.[signal] ?? null,
      valueUsd: v,
      probabilityPct: v === null ? null : probabilityOf(p, v),
    };
  };
  /** Descending on a string that may be null (null last), then ascending lead id. */
  const desc = (x: string | null, y: string | null) => ((x ?? "") < (y ?? "") ? 1 : (x ?? "") > (y ?? "") ? -1 : 0);
  const byLeadId = (a: { leadId: string }, b: { leadId: string }) => (a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0);
  const byValue = (a: StepPerson, b: StepPerson) =>
    (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || desc(a.reachedAt, b.reachedAt) || byLeadId(a, b);
  const peopleAt = (reached: ReadonlySet<string>, signal: string): StepPeople => {
    const ours: StepPerson[] = [];
    const lost: LostStepPerson[] = [];
    const notOurs: StepPerson[] = [];
    for (const p of persons) {
      if (!reached.has(p.leadId)) continue;
      const c = card(p, signal);
      if (!pricedOn(p, signal)) {
        notOurs.push(c);
        continue;
      }
      const cold = p.signals.closeWin ? undefined : coldVerdicts.get(p.leadId);
      if (cold) {
        lost.push({ ...c, lostReason: "went_cold", lostSince: cold.coldSince, coldAtStep: cold.coldAtStep });
      } else if (!p.signals.closeWin && (p.deadSignals?.length ?? 0) > 0 && c.valueUsd === 0) {
        lost.push({ ...c, lostReason: "ruled_out", lostSince: null, coldAtStep: null });
      } else {
        ours.push(c);
      }
    }
    ours.sort(byValue);
    notOurs.sort(byValue);
    lost.sort((a, b) => desc(a.lostSince, b.lostSince) || byLeadId(a, b));
    const group = <T>(xs: T[]): StepPeopleGroup<T> => ({ count: xs.length, leads: xs.slice(0, STEP_PEOPLE_LIMIT) });
    return { limit: STEP_PEOPLE_LIMIT, ours: group(ours), lost: group(lost), notOurs: group(notOurs) };
  };

  const ladder: LadderStep[] = LADDER_STEPS.map((step) => {
    const reached = input.sets.byStep.get(step) ?? null;
    const signal = signalOfStep(step);
    const pricedReached = pricedSets.byStep.get(step) ?? null;
    const pricedCount = reached && signal ? (pricedReached?.size ?? 0) : null;
    const value = input.values.get(step);
    return {
      step: stepWire(step),
      recipientsReached: reached ? reached.size : null,
      pricedRecipientsReached: pricedCount,
      valuePerOutcomeUsd: value?.valuePerOutcomeUsd ?? null,
      pricedValueUsd: pricedCount !== null && value ? pricedCount * value.valuePerOutcomeUsd : null,
      valueExplanation: explainStepValue(input.declared, step, value),
      conversionFromPrevious: reached ? stepConversion(step, reached, input.sets, priced.pricedFunnelKeys) : null,
      pricedConversionFromPrevious:
        reached && pricedReached ? stepConversion(step, pricedReached, pricedSets, priced.pricedFunnelKeys) : null,
      people: reached && signal ? peopleAt(reached, signal) : null,
      wentCold: input.cold
        ? { count: coldByStep.get(step)?.length ?? 0, valueUsd: sumValues(coldByStep.get(step) ?? []) }
        : null,
    };
  });

  // WON — on the priced causes; one organisation is one client, worth its best member's amount.
  const purchasedMeasured = stepMeasured("purchased", input.evidence);
  let customersWon: OfferPipeline["customersWon"] = null;
  const wonOurs: EnginePerson[] = [];
  if (purchasedMeasured) {
    const won = persons.filter((p) => p.signals.closeWin);
    const ours = won.filter((p) => !(p.unpricedSignals ?? []).includes("closeWin"));
    wonOurs.push(...ours);
    const byOrg = new Map<string, number | null>();
    for (const p of ours) {
      const key = p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`;
      const amount = statedValue(p) ?? ltr;
      const current = byOrg.get(key);
      byOrg.set(key, current === undefined ? amount : current === null || amount === null ? (current ?? amount) : Math.max(current, amount));
    }
    const amounts = [...byOrg.values()];
    customersWon = {
      count: byOrg.size,
      leadCount: ours.length,
      valueUsd: amounts.some((a) => a === null) ? null : amounts.reduce<number>((s, a) => s + (a ?? 0), 0),
      otherCausesLeadCount: won.length - ours.length,
    };
  }

  // HOT — live engaged leads still priced above 0, not won, not cold.
  let hotLeads: OfferPipeline["hotLeads"] = null;
  const hot: PricedPipelineLead[] = [];
  if (paths) {
    for (const p of persons) {
      if (p.signals.closeWin || coldIds.has(p.leadId)) continue;
      if (!ENGAGED_SIGNALS.some((s) => p.signals[s])) continue;
      const v = valueOf(p);
      const step = furthestStep(p);
      if (v === null || v <= 0 || !step) continue;
      hot.push({ ...identity(p), step: stepWire(step), valueUsd: v, probabilityPct: probabilityOf(p, v) });
    }
    hot.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || (a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0));
    hotLeads = {
      limit: HOT_LEADS_LIMIT,
      totalCount: hot.length,
      totalValueUsd: hot.reduce((s, l) => s + (l.valueUsd ?? 0), 0),
      leads: hot.slice(0, HOT_LEADS_LIMIT),
    };
  }

  // LOST — went cold on interest we caused (the cold list above), or engaged, ruled out by a human and
  // now priced at 0. ONE verdict, served as `lostLeads` (Today's Lost leads) and as the `lost` family.
  const ruledOut: EnginePerson[] = [];
  for (const p of persons) {
    if (p.signals.closeWin || coldIds.has(p.leadId)) continue;
    const engaged = ENGAGED_SIGNALS.some((s) => p.signals[s]);
    if (engaged && (p.deadSignals?.length ?? 0) > 0 && valueOf(p) === 0) ruledOut.push(p);
  }
  const lostLeads: LostPipelineLead[] = [
    ...coldLeads.map((l) => ({ ...l, lostReason: "went_cold" as const, lostSince: l.coldSince })),
    ...ruledOut.map((p) => {
      const v = valueOf(p);
      const step = furthestStep(p)!;
      return {
        ...identity(p),
        step: stepWire(step),
        valueUsd: v,
        probabilityPct: v === null ? null : probabilityOf(p, v),
        lostReason: "ruled_out" as const,
        lostSince: null,
        coldAtStep: null,
        coldSince: null,
        stalledSince: null,
      };
    }),
  ];

  // FAMILIES — the verdicts above, per person, strongest first.
  const familyOf = new Map<string, { family: LeadFamily; lostReason: LeadFamilyRow["lostReason"] }>();
  const assign = (leadId: string, family: LeadFamily, lostReason: LeadFamilyRow["lostReason"] = null) => {
    const current = familyOf.get(leadId);
    if (!current || LEAD_FAMILY_RANK[family] < LEAD_FAMILY_RANK[current.family]) familyOf.set(leadId, { family, lostReason });
  };
  for (const p of wonOurs) assign(p.leadId, "won");
  for (const l of hot) assign(l.leadId, "hot");
  for (const l of lostLeads) assign(l.leadId, "lost", l.lostReason);
  for (const p of persons) {
    if (p.signals.closeWin || coldIds.has(p.leadId)) continue;
    if (!ENGAGED_SIGNALS.some((s) => p.signals[s]) && p.signals.contacted) assign(p.leadId, "cold");
  }
  const families: LeadFamilyRow[] = persons
    .filter((p) => familyOf.has(p.leadId))
    .map((p) => ({
      leadId: p.leadId,
      email: p.email ? p.email.trim().toLowerCase() : null,
      campaignLeadIds: [...(p.campaignLeadIds ?? [])],
      ...familyOf.get(p.leadId)!,
    }));

  const exclusiveLadder = buildExclusiveLadder({
    persons,
    paths,
    ltr,
    values: input.values,
    sets: input.sets,
    pricedSets,
    signalOfStep,
    pricedOn,
    card,
    coldVerdicts,
    hotIds: hotLeads ? new Set(hot.map((l) => l.leadId)) : null,
    byValue,
    desc,
    byLeadId,
    contactedPricing: input.contactedPricing ?? null,
    headlinePipelineUsd: input.headlinePipelineUsd ?? null,
    history: input.conversionHistory ?? null,
  });

  const pipeline: OfferPipeline = {
    peopleContacted: contacted.length,
    companiesContacted: companies.size,
    contactedWithoutCompanyCount: contacted.filter((p) => !p.orgId).length,
    ladder,
    customersWon,
    coldRule: input.cold ? { applies: input.cold.applies, afterDays: input.cold.afterDays } : null,
    coldLeads: input.cold
      ? { count: coldLeads.length, valueUsd: sumValues(coldLeads), leads: coldLeads, otherCausesCount: coldOtherCauses }
      : null,
    lostLeads: input.cold
      ? {
          count: lostLeads.length,
          valueUsd: sumValues(lostLeads),
          wentColdCount: coldLeads.length,
          ruledOutCount: ruledOut.length,
          leads: lostLeads,
        }
      : null,
    hotLeads,
    leadValuesUnpricedReason: paths ? null : (priced.economics.unpricedReason ?? "no_priced_funnel"),
    exclusiveLadder,
  };
  return { pipeline, families };
}

/** The engine's entry routes, as the contacted row explains them (`lib/contacted-value.ts` ROUTE_* twins). */
const CONTACTED_ROUTE: Record<string, { step: ChannelStepKey; legKey: string }> = {
  clicked: { step: "website_visit", legKey: "start_to_website_visit" },
  positiveReply: { step: "conversation", legKey: "start_to_conversation" },
};

/** Half a cent: the tolerance two sums of the same values in different orders are held to. */
const sameCents = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

/** A sliced row's two counts the conversion column reads: priced people (null = not counted) and notOurs people. */
export interface SlicedRowCounts {
  step: ChannelStepKey;
  pricedPeople: number | null;
  notOursPeople: number | null;
}

/** A sliced row is displayed when it has people: priced (ours + lost) or notOurs. */
function displayedRowPeople(row: SlicedRowCounts): number | null {
  if (row.pricedPeople === null || row.notOursPeople === null) return null;
  return row.pricedPeople > 0 || row.notOursPeople > 0 ? row.pricedPeople : null;
}

/**
 * PURE, THE ONE RULE of the sliced % Conversion (see `ConversionFromRowAbove`), on counts alone, so today's
 * column and its dated series (`conversionHistory`) are the same function. `rows` climb (shallowest first),
 * so a row's "row above" is the next displayed row deeper in the array.
 */
export function conversionsFromRowAbove(
  rows: readonly SlicedRowCounts[],
  contactedCount: number,
): { rows: (ConversionFromRowAbove | null)[]; contacted: ConversionFromRowAbove | null } {
  let above: { step: ChannelStepKey; people: number } | null = null;
  const conversion = (rowPeople: number, a: { step: ChannelStepKey; people: number }): ConversionFromRowAbove => ({
    rowAbove: stepWire(a.step),
    rowAbovePeople: a.people,
    rowPeople,
    ratePct: rowPeople + a.people > 0 ? (a.people / (rowPeople + a.people)) * 100 : null,
  });
  const out: (ConversionFromRowAbove | null)[] = rows.map(() => null);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const people = displayedRowPeople(row);
    if (people === null) continue;
    out[i] = above ? conversion(people, above) : null;
    above = { step: row.step, people };
  }
  return { rows: out, contacted: above ? conversion(contactedCount, above) : null };
}

/** Fills `conversionFromRowAbove` on every displayed row and the contacted row (see `ConversionFromRowAbove`). */
export function applyConversionFromRowAbove(rows: ExclusiveLadderRow[], contacted: ExclusiveContactedRow): void {
  const result = conversionsFromRowAbove(
    rows.map((r) => ({ step: r.step.key, pricedPeople: r.people === null ? null : r.pricedPeople, notOursPeople: r.people?.notOurs.count ?? null })),
    contacted.count,
  );
  rows.forEach((row, i) => {
    row.conversionFromRowAbove = result.rows[i] ?? null;
  });
  contacted.conversionFromRowAbove = result.contacted;
}

/** PURE: the exclusive reading of the pipeline (see the module doc). */
function buildExclusiveLadder(input: {
  persons: readonly EnginePerson[];
  paths: ResolvedPath[] | null;
  ltr: number | null;
  values: ReadonlyMap<ChannelStepKey, StepValue>;
  sets: OfferStepSets;
  pricedSets: OfferStepSets;
  signalOfStep: (step: ChannelStepKey) => string | null;
  pricedOn: (p: EnginePerson, signal: string) => boolean;
  card: (p: EnginePerson, signal: string) => StepPerson;
  coldVerdicts: ReadonlyMap<string, { coldSince: string; coldAtStep: { key: ChannelStepKey; label: string } }>;
  /** The `hotLeads` verdict's people (every one, not only the listed top); null when hotLeads is null. */
  hotIds: ReadonlySet<string> | null;
  byValue: (a: StepPerson, b: StepPerson) => number;
  desc: (x: string | null, y: string | null) => number;
  byLeadId: (a: { leadId: string }, b: { leadId: string }) => number;
  contactedPricing: ContactedPricing | null;
  headlinePipelineUsd: number | null;
  history?: ConversionHistoryInput | null;
}): ExclusiveLadder {
  const { persons, paths, ltr } = input;
  const priced = paths !== null && ltr !== null;

  // WHAT EACH PERSON IS WORTH — the engine's own run (the offer revenue read's `computeRevenue`, contacted
  // pricing included). A person the engine lists nowhere is worth 0.
  const engine = priced ? computeRevenue(paths!, [...persons], ltr!, [], input.contactedPricing) : null;
  const evOf = new Map<string, number>((engine?.leads ?? []).map((l) => [l.leadId, l.expectedRevenueUsd] as const));
  const ev = (p: EnginePerson): number | null => (priced ? (evOf.get(p.leadId) ?? 0) : null);

  // ONE COMPANY IS COUNTED ONCE, at its most valuable member (ties: smallest lead id) — the engine's rule.
  const carrier = new Map<string, { leadId: string; ev: number }>();
  if (priced) {
    for (const p of persons) {
      const key = p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`;
      const v = ev(p)!;
      const cur = carrier.get(key);
      if (!cur || v > cur.ev || (v === cur.ev && p.leadId < cur.leadId)) carrier.set(key, { leadId: p.leadId, ev: v });
    }
  }
  const addsOf = (p: EnginePerson): { pipelineUsd: number | null; countedWithColleague: boolean; withColleagueUsd: number } => {
    const v = ev(p);
    if (v === null) return { pipelineUsd: null, countedWithColleague: false, withColleagueUsd: 0 };
    const key = p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`;
    const carries = carrier.get(key)?.leadId === p.leadId;
    return carries
      ? { pipelineUsd: v, countedWithColleague: false, withColleagueUsd: 0 }
      : { pipelineUsd: 0, countedWithColleague: v > 0, withColleagueUsd: v };
  };
  const probabilityOf = (p: EnginePerson, v: number): number | null => {
    const base = statedValue(p) ?? ltr;
    return base !== null && base > 0 ? (v / base) * 100 : null;
  };
  const exclusiveCard = (p: EnginePerson, signal: string | null): ExclusiveStepPerson => {
    const base: StepPerson = signal
      ? input.card(p, signal)
      : { ...identity(p), reachedAt: p.signalDates?.contacted ?? null, valueUsd: null, probabilityPct: null };
    const v = ev(p);
    const adds = addsOf(p);
    return {
      ...base,
      valueUsd: v,
      probabilityPct: v === null ? null : probabilityOf(p, v),
      pipelineUsd: adds.pipelineUsd,
      countedWithColleague: adds.countedWithColleague,
    };
  };

  // WHERE EACH PERSON STANDS: the furthest counted step priced for them, else (nothing priced) the furthest
  // counted step reached, else the contacted row.
  const climbing = [...LADDER_STEPS].reverse();
  const rowOf = new Map<string, { step: ChannelStepKey; ours: boolean } | "contacted">();
  for (const p of persons) {
    const pricedStep = climbing.find((s) => input.pricedSets.byStep.get(s)?.has(p.leadId));
    if (pricedStep) {
      rowOf.set(p.leadId, { step: pricedStep, ours: true });
      continue;
    }
    const reachedStep = climbing.find((s) => input.sets.byStep.get(s)?.has(p.leadId));
    if (reachedStep) rowOf.set(p.leadId, { step: reachedStep, ours: false });
    else if (p.signals.contacted) rowOf.set(p.leadId, "contacted");
  }

  const sumOr = (xs: readonly number[]): number | null => (priced ? xs.reduce((s, x) => s + x, 0) : null);
  const group = <T>(xs: T[]): StepPeopleGroup<T> => ({ count: xs.length, leads: xs.slice(0, STEP_PEOPLE_LIMIT) });

  const rows: ExclusiveLadderRow[] = LADDER_STEPS.map((step) => {
    const signal = input.signalOfStep(step);
    const counted = input.sets.byStep.get(step) !== null && input.sets.byStep.get(step) !== undefined && signal !== null;
    const ours: ExclusiveStepPerson[] = [];
    const lost: ExclusiveLostStepPerson[] = [];
    const notOurs: ExclusiveStepPerson[] = [];
    const hot: ExclusiveStepPerson[] = [];
    const adds: number[] = [];
    const withColleague: number[] = [];
    for (const p of persons) {
      const at = rowOf.get(p.leadId);
      if (!at || at === "contacted" || at.step !== step) continue;
      const c = exclusiveCard(p, signal);
      const a = addsOf(p);
      adds.push(a.pipelineUsd ?? 0);
      withColleague.push(a.withColleagueUsd);
      if (input.hotIds?.has(p.leadId)) hot.push(c);
      if (!at.ours) {
        notOurs.push(c);
        continue;
      }
      const cold = p.signals.closeWin ? undefined : input.coldVerdicts.get(p.leadId);
      if (cold) {
        lost.push({ ...c, lostReason: "went_cold", lostSince: cold.coldSince, coldAtStep: cold.coldAtStep });
      } else if (!p.signals.closeWin && (p.deadSignals?.length ?? 0) > 0 && c.valueUsd === 0) {
        lost.push({ ...c, lostReason: "ruled_out", lostSince: null, coldAtStep: null });
      } else {
        ours.push(c);
      }
    }
    ours.sort(input.byValue);
    notOurs.sort(input.byValue);
    hot.sort(input.byValue);
    lost.sort((a, b) => input.desc(a.lostSince, b.lostSince) || input.byLeadId(a, b));
    return {
      step: stepWire(step),
      pricedPeople: counted ? ours.length + lost.length : null,
      valuePerOutcomeUsd: input.values.get(step)?.valuePerOutcomeUsd ?? null,
      pipelineUsd: sumOr(adds),
      countedWithColleagueUsd: sumOr(withColleague),
      people: counted ? { limit: STEP_PEOPLE_LIMIT, ours: group(ours), lost: group(lost), notOurs: group(notOurs) } : null,
      hot: input.hotIds ? { limit: STEP_PEOPLE_LIMIT, ...group(hot) } : null,
      conversionFromRowAbove: null,
      conversionHistory: null,
    };
  });

  // THE CONTACTED ROW.
  const onContacted = persons.filter((p) => rowOf.get(p.leadId) === "contacted");
  const pricing = input.contactedPricing;
  const cutoff = pricing?.lastSentOnOrAfter ?? null;
  const cannotConvert = onContacted.filter((p) => p.signals.bounced || p.signals.unsubscribed);
  const canConvert = onContacted.filter((p) => !(p.signals.bounced || p.signals.unsubscribed));
  const expired = cutoff ? canConvert.filter((p) => contactedExpired(p, cutoff)) : [];
  const valued = canConvert.filter((p) => (ev(p) ?? 0) > 0);
  const contactedCards = onContacted.map((p) => exclusiveCard(p, null)).sort(input.byValue);
  const routes: ContactedEntryRouteExplained[] = [];
  if (priced && pricing && valued.length > 0) {
    for (const path of paths!) {
      const route = CONTACTED_ROUTE[path.signal];
      if (!path.engagementRoute || !route) continue;
      const rates = valued.map((p) => {
        const key = contactedGroupKey(p.campaignId, p.workflowSlug);
        const r = key === null ? undefined : pricing.entryRatePctByGroup[key]?.[path.signal];
        return typeof r === "number" && Number.isFinite(r) ? r : 0;
      });
      routes.push({
        signal: path.signal,
        step: stepWire(route.step),
        legKey: route.legKey,
        entryRatePct: rates.reduce((s, r) => s + r, 0) / rates.length,
        valueAtStepUsd: path.expectedRevenueUsd,
      });
    }
  }
  const contacted: ExclusiveContactedRow = {
    count: onContacted.length,
    valuedCount: valued.length,
    expiredCount: expired.length,
    cannotConvertCount: cannotConvert.length,
    unpricedCount: canConvert.length - expired.length - valued.length,
    valuePerPersonUsd: priced && valued.length > 0 ? valued.reduce((s, p) => s + ev(p)!, 0) / valued.length : null,
    pipelineUsd: sumOr(onContacted.map((p) => addsOf(p).pipelineUsd ?? 0)),
    countedWithColleagueUsd: sumOr(onContacted.map((p) => addsOf(p).withColleagueUsd)),
    explanation:
      routes.length > 0
        ? { routes, combine: "independent", expiryDays: CONTACTED_VALUE_EXPIRY_DAYS, lastSentOnOrAfter: pricing!.lastSentOnOrAfter }
        : null,
    people: { limit: STEP_PEOPLE_LIMIT, leads: contactedCards.slice(0, STEP_PEOPLE_LIMIT) },
    conversionFromRowAbove: null,
    conversionHistory: null,
  };
  applyConversionFromRowAbove(rows, contacted);
  if (input.history) {
    const history = buildConversionHistory({
      persons,
      sets: input.sets,
      pricedSets: input.pricedSets,
      dateOf: input.history.dateOf,
      today: input.history.today,
    });
    if (history) {
      rows.forEach((row, i) => {
        row.conversionHistory = history.rows[i] ?? null;
      });
      contacted.conversionHistory = history.contacted;
      // The last point IS today's column (same people, same rule) — said loudly if it ever is not.
      const last = (h: ConversionHistory | null) => h?.points[h.points.length - 1]?.ratePct ?? null;
      const agrees = (h: ConversionHistory | null, c: ConversionFromRowAbove | null) => h === null || last(h) === (c?.ratePct ?? null);
      if (!rows.every((r) => agrees(r.conversionHistory, r.conversionFromRowAbove)) || !agrees(contacted.conversionHistory, contacted.conversionFromRowAbove)) {
        console.error("[features-service] sliced conversion history: a last point disagrees with today's conversionFromRowAbove");
      }
    }
  }

  // THE TOTAL — the engine's own headline over this population; the rows add up to it.
  const pipelineUsd = engine ? engine.headline.totalPipelineUsd : null;
  // People on no row are never contacted and reached no step, so they add nothing — served, not assumed.
  const noRowPipelineUsd = sumOr(persons.filter((p) => !rowOf.has(p.leadId)).map((p) => addsOf(p).pipelineUsd ?? 0));
  if (pipelineUsd !== null) {
    const rowsSum = rows.reduce((s, r) => s + (r.pipelineUsd ?? 0), 0) + (contacted.pipelineUsd ?? 0) + (noRowPipelineUsd ?? 0);
    if (!sameCents(rowsSum, pipelineUsd)) {
      console.error(`[features-service] exclusive ladder rows add to ${rowsSum}, not the engine's pipeline ${pipelineUsd}`);
    }
  }
  const headline = input.headlinePipelineUsd;
  const gapUsd = pipelineUsd !== null && headline !== null ? headline - pipelineUsd : null;
  const gapReason: ExclusiveLadder["total"]["gapReason"] =
    pipelineUsd === null
      ? "unpriced"
      : headline === null
        ? "headline_unreadable"
        : sameCents(headline, pipelineUsd)
          ? null
          : "population_differs";
  if (gapReason === "population_differs") {
    console.error(
      `[features-service] exclusive ladder total ${pipelineUsd} ≠ the offer revenue headline ${headline} (gap ${gapUsd}): the two reads priced different people`,
    );
  }
  const onRow = persons.filter((p) => rowOf.has(p.leadId)).length;
  const hotIds = input.hotIds;
  const hotTotal = hotIds
    ? {
        count: hotIds.size,
        onRows: rows.reduce((s, r) => s + (r.hot?.count ?? 0), 0),
        onContactedRow: onContacted.filter((p) => hotIds.has(p.leadId)).length,
        onNoRow: persons.filter((p) => !rowOf.has(p.leadId) && hotIds.has(p.leadId)).length,
      }
    : null;
  if (hotTotal && hotTotal.onRows + hotTotal.onContactedRow + hotTotal.onNoRow !== hotTotal.count) {
    console.error(`[features-service] exclusive ladder hot counts do not add to hotLeads.totalCount ${hotTotal.count}`);
  }
  return {
    contacted,
    rows,
    total: {
      people: onRow,
      peopleOnNoRow: persons.length - onRow,
      noRowPipelineUsd,
      pipelineUsd,
      headlinePipelineUsd: headline,
      gapUsd: gapUsd === null ? null : sameCents(gapUsd, 0) ? 0 : gapUsd,
      gapReason,
      hot: hotTotal,
    },
  };
}

/** What the dated series needs beyond the ladder's own inputs: a person's date of a signal, and today. */
export interface ConversionHistoryInput {
  /** When the person reached `signal` (`contacted`, `delivered`, a step's signal); null = undated. */
  dateOf: (p: EnginePerson, signal: string) => string | null;
  /** The last point's UTC day, YYYY-MM-DD. */
  today: string;
}

const DAY_MS = 86_400_000;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * PURE: the sliced rows' % Conversion per day (see `ConversionHistory`), or null when no person of the offer
 * carries a delivery date (nothing to start the series on). Each person changes row only on the days one of
 * their dates falls, so the counts are built from per-person transitions, not a person × day walk.
 */
export function buildConversionHistory(input: {
  persons: readonly EnginePerson[];
  sets: OfferStepSets;
  pricedSets: OfferStepSets;
  dateOf: ConversionHistoryInput["dateOf"];
  today: string;
}): { rows: (ConversionHistory | null)[]; contacted: ConversionHistory } | null {
  const parse = (d: string | null): number | null => {
    if (!d) return null;
    const ms = Date.parse(d);
    return Number.isFinite(ms) ? ms : null;
  };
  const todayMs = Date.parse(`${input.today}T00:00:00.000Z`);
  if (!Number.isFinite(todayMs)) throw new Error(`buildConversionHistory: today "${input.today}" is not a YYYY-MM-DD day`);
  // NO POINT BEFORE OUR FIRST EMAIL: the series starts on the offer's first delivery.
  let firstMs: number | null = null;
  for (const p of input.persons) {
    const ms = parse(input.dateOf(p, "delivered"));
    if (ms !== null && (firstMs === null || ms < firstMs)) firstMs = ms;
  }
  if (firstMs === null) return null;
  const startMs = Math.min(Date.parse(`${utcDay(firstMs)}T00:00:00.000Z`), todayMs);
  const days = Math.round((todayMs - startMs) / DAY_MS) + 1;
  const last = days - 1;
  /** The day index a date counts from: before the start = day 0, after today or undated = the last day. */
  const indexOf = (d: string | null): { index: number; dated: boolean } => {
    const ms = parse(d);
    if (ms === null) return { index: last, dated: false };
    return { index: Math.max(0, Math.min(last, Math.floor((ms - startMs) / DAY_MS))), dated: true };
  };

  const steps = LADDER_STEPS;
  const CONTACTED = steps.length;
  const signalOf = (step: ChannelStepKey): string | null => {
    const field = STEP_LEAD_FIELD[step];
    return field ? LEAD_FIELD_TO_SIGNAL[field] : null;
  };
  // Per day, the change in each row's priced and notOurs people (row index; CONTACTED = the contacted row).
  const pricedDiff = steps.map(() => new Int32Array(days + 1));
  const notOursDiff = steps.map(() => new Int32Array(days + 1));
  const contactedDiff = new Int32Array(days + 1);
  const undated = new Array<number>(steps.length + 1).fill(0);
  type State = { row: number; ours: boolean } | null;
  const move = (state: State, day: number, sign: 1 | -1) => {
    if (!state) return;
    if (state.row === CONTACTED) contactedDiff[day]! += sign;
    else (state.ours ? pricedDiff : notOursDiff)[state.row]![day]! += sign;
  };

  for (const p of input.persons) {
    const reached: Array<{ row: number; ours: boolean; index: number; dated: boolean }> = [];
    steps.forEach((step, row) => {
      if (!input.sets.byStep.get(step)?.has(p.leadId)) return;
      const signal = signalOf(step);
      const at = indexOf(signal ? input.dateOf(p, signal) : null);
      reached.push({ row, ours: Boolean(input.pricedSets.byStep.get(step)?.has(p.leadId)), ...at });
    });
    const contactedAt = p.signals.contacted ? indexOf(input.dateOf(p, "contacted")) : null;
    if (reached.length === 0 && !contactedAt) continue;
    // Where the person stands on day d: the today rule, on what they had reached by d.
    const stateOn = (d: number): State => {
      const by = reached.filter((r) => r.index <= d);
      const ours = by.filter((r) => r.ours);
      const pick = (xs: typeof by) => xs.reduce((a, b) => (b.row > a.row ? b : a));
      if (ours.length > 0) return { row: pick(ours).row, ours: true };
      if (by.length > 0) return { row: pick(by).row, ours: false };
      return contactedAt && contactedAt.index <= d ? { row: CONTACTED, ours: true } : null;
    };
    const eventDays = [...new Set([...reached.map((r) => r.index), ...(contactedAt ? [contactedAt.index] : [])])].sort((a, b) => a - b);
    let current = null as State;
    for (const d of eventDays) {
      const next = stateOn(d);
      if (current?.row === next?.row && current?.ours === next?.ours) continue;
      move(current, d, -1);
      move(next, d, 1);
      current = next;
    }
    // Undated arrival on today's row: counted from the last point only.
    const final = current;
    if (final) {
      const arrival = final.row === CONTACTED ? contactedAt : reached.find((r) => r.row === final.row && r.ours === final.ours);
      if (arrival && !arrival.dated) undated[final.row]! += 1;
    }
  }

  const counted = steps.map((step) => input.sets.byStep.get(step) !== null && input.sets.byStep.get(step) !== undefined && signalOf(step) !== null);
  const rowPoints: ConversionHistoryPoint[][] = steps.map(() => []);
  const contactedPoints: ConversionHistoryPoint[] = [];
  const priced = steps.map(() => 0);
  const notOurs = steps.map(() => 0);
  let contactedCount = 0;
  for (let d = 0; d < days; d++) {
    steps.forEach((_, i) => {
      priced[i]! += pricedDiff[i]![d]!;
      notOurs[i]! += notOursDiff[i]![d]!;
    });
    contactedCount += contactedDiff[d]!;
    const result = conversionsFromRowAbove(
      steps.map((step, i) => ({ step, pricedPeople: counted[i] ? priced[i]! : null, notOursPeople: counted[i] ? notOurs[i]! : null })),
      contactedCount,
    );
    const date = utcDay(startMs + d * DAY_MS);
    const point = (rowPeople: number, c: ConversionFromRowAbove | null): ConversionHistoryPoint => ({
      date,
      ratePct: c?.ratePct ?? null,
      rowPeople,
      rowAbove: c?.rowAbove ?? null,
      rowAbovePeople: c?.rowAbovePeople ?? null,
    });
    steps.forEach((_, i) => {
      if (counted[i]) rowPoints[i]!.push(point(priced[i]!, result.rows[i] ?? null));
    });
    contactedPoints.push(point(contactedCount, result.contacted));
  }
  const series = (points: ConversionHistoryPoint[], undatedPeople: number): ConversionHistory => ({
    startsOn: utcDay(startMs),
    endsOn: input.today,
    undatedPeople,
    points,
  });
  return {
    rows: steps.map((_, i) => (counted[i] ? series(rowPoints[i]!, undated[i]!) : null)),
    contacted: series(contactedPoints, undated[CONTACTED]!),
  };
}
