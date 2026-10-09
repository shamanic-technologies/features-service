/**
 * THE BEST CONVERSION RATE WE HAVE FOR EACH LEG OF A BRAND — and which one it is.
 *
 * Conversion rates live on the BRAND, per LEG (owner decisions, 2026-09-25): a brand converts the way it
 * converts whatever it is selling, and no sales funnel is part of the key — ONE rate per (brand, leg),
 * shared by every funnel that reads that leg (wave C1: nothing here reads a declared funnel). Lifetime
 * revenue stays per offer. Every money figure this service states — pipeline, ROI, CAC, every
 * projection — rests on the rate resolved here, and the customer can see which source it came from.
 *
 * ── THREE SOURCES, IN THIS ORDER, AND NOTHING ELSE ──────────────────────────────────────────────
 *
 *   1. MEASURED — the rate observed on this brand's OWN leads, once at least
 *      `MIN_MEASURED_FROM_REACHED` (10, a sample-size bar on the rate's denominator) of them reached the arrow's FROM step.
 *      The bar is on the DENOMINATOR on purpose: an arrow that is genuinely at 0% must still become
 *      measured, and a bar on the outcome count would keep it on a stated guess forever. Our lead data
 *      already merges the customer's own statements, our tracker and their CRM (the same overlays
 *      `funnelSteps` counts on), so this is the brand's reality, not a sample of it.
 *   2. MANUAL — what the brand stated by hand for the leg (brand-service `offer-economics` leg rates).
 *   3. MEDIAN — the cross-org median of what OTHER brands stated for the same leg. Stated
 *      values only: the store has no default behind it, so a brand that stated nothing contributes
 *      nothing. It overrides the default only once at least `MIN_FLEET_MEDIAN_BRANDS` (5) brands
 *      stated the leg (owner rule, 2026-10-03): a median of two customers' guesses is two guesses, and
 *      it once ranked website visit → meeting booked at 4.99% (2 brands) over the 2% benchmark, which
 *      put a path nothing measured first on an offer's Sales paths. Below the bar the default is kept
 *      and served as `source: "default"`; the median still rides along in `median` with its brandCount.
 *      Website-visit legs take the median like every other leg (owner 2026-10-04, superseding the
 *      2026-10-03 exclusion): the stated visit rates that inflated it were corrected AT THE SOURCE (the
 *      six brands stating visit → form were divided by ten in brand-service, after 0 of 461 of our
 *      cold-email clickers converted), never by a factor applied here.
 *
 *   4. DEFAULT — the seeded per-leg industry benchmark (`lib/default-leg-rates.ts`, owner rule
 *      2026-09-29: every leg is prefilled, none may be empty). Served as `source: "default"`, so a
 *      reader always tells it apart from the brand's own number. Supersedes "null, never a default".
 *
 * Only a leg outside the catalogue with none of the four is `null` + `unresolvedReason`; never a 0, never
 * borrowed from a neighbouring arrow.
 *
 * ── THE MEASURED RATE IS THE FUNNEL-STEP CONVERSION, BYTE FOR BYTE ─────────────────────────────
 *
 * `count(leads at FROM that also reached TO) ÷ count(leads at FROM)` — exactly what
 * `funnelSteps.conversionFromPreviousPct` states for the rung, so the rate a brand is priced on and the
 * funnel it reads on its Overview are one number (`reachedThroughLeg`, `lib/funnel-steps.ts`). The
 * numerator is a subset of the denominator (owner 2026-10-08): a lead at TO who was never at FROM —
 * booked off a reply on the website-visit leg (brand `75d7e3e8…` once read visit → meeting at 6 of 106
 * while zero clickers booked), or attended with no booking recorded (the same brand read booked →
 * attended "4 of 8" beside its ladder's 3 of 8) — is served as `toReachedThroughOtherLegs`, never
 * counted. This supersedes #1053's benefit of the doubt. When TO exceeds FROM (CRM basis) the ratio is
 * no probability: `gap: "to_exceeds_from"`, never clamped, and the next source wins.
 *
 * ── WHERE A LEG IS MEASURED: THE CLIENT'S CRM, OR OUR LEADS (owner rule, 2026-09-26) ────────────
 *
 * A leg is measured WHERE ITS DATA LIVES, decided by the data rather than a per-leg table:
 *
 *   - the brand's CRM (crm-service funnel reach, the WHOLE CRM history) directly evidences BOTH ends
 *     of the leg → the leg is measured on the CRM: `contactsAtOrBeyond(TO) ÷ contactsAtOrBeyond(FROM)`,
 *     the division crm-service itself names. That is the client's own sales team at work (booked →
 *     attended, attended → won), and the few CRM contacts paired with our leads are a small, biased
 *     sample of it (many last-name-only matches, many clients who closed before we ever wrote).
 *   - otherwise → measured on OUR leads, counting only outcomes OUR OUTREACH caused (lead-service's
 *     `causedByOutreach`; the legacy qualifications judged by the same delivery rule). A leg only our
 *     outreach can observe (a reply becoming a meeting) must not be credited with meetings the CRM
 *     pairing attached to our leads for reasons that had nothing to do with us.
 *
 * Both halves apply ONLY when the brand's CRM is `available`. No connection, not synced yet, meanings
 * still pending, or the read failing → today's behaviour for that brand, byte for byte (every outcome
 * counted on our leads), and `crm.status` on the response says which. Every measured rate names its
 * `basis` and, on our leads, which outcomes it counted.
 *
 * This filter is about MEASURING a leg. What the ROI PRICES (count every conversion, price only ours —
 * #1058) is untouched.
 *
 * ── RIGHT-CENSORING IS ACCEPTED ─────────────────────────────────────────────────────────────────
 *
 * A meeting booked yesterday cannot have been attended yet, so a measured rate reads slightly low for
 * a brand still accumulating. Owner decision, 2026-09-25: keep it simple for now.
 */

import { db } from "../db/index.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { fetchObservedStepFacts } from "./observed-steps.js";
import { fetchQualifications } from "./qualifications-client.js";
import { fetchConversionEmails } from "./conversion-emails-client.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { dedupPersonsByLead } from "./revenue-engine.js";
import {
  LEAD_FIELD_TO_SIGNAL,
  leadFieldOfStep,
  reachedThroughLeg,
  normaliseStep,
  stepMeasured,
  type LeadStepField,
  type StepEvidence,
} from "./funnel-steps.js";
import { SALES_FUNNELS, SALES_FUNNEL_KEYS, salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";
import { fetchBrandLegEconomics, type BrandLegEconomics, type BrandLegRate, type BrandOfferEconomics } from "./brand-leg-economics-client.js";
import { CHANNEL_STEP_KEYS, FUNNEL_STEP_LABEL_TO_KEY, type ChannelStepKey } from "./acquisition-channels.js";
import { FUNNEL_LEGS, funnelLeg, legKeyBetween } from "./funnel-legs.js";
import { defaultLegRatePct } from "./default-leg-rates.js";
import { median } from "./stated-economics.js";
import { mapWithConcurrency } from "./concurrency.js";
import { servedCached, buildScopeKey } from "./view-cache.js";
import { fetchEventTimestamps, type SignalDates } from "./email-status-client.js";
import {
  fetchCrmFunnelReach,
  type CrmFunnelReach,
  type CrmReachStep,
  type CrmReachUnavailableReason,
} from "./crm-funnel-reach-client.js";

/**
 * A measured rate needs at least this many leads on its FROM step — a SAMPLE-SIZE bar on a between-step
 * rate's DENOMINATOR. It is deliberately NOT a leg's maturity count (`lib/maturity.ts`, which bars the
 * OUTCOMES of the leg's own step, 1 positive reply on the conversation leg): it stays 10 on every arrow.
 */
export const MIN_MEASURED_FROM_REACHED = 10;

/** Brands that must have STATED a leg before their median overrides the leg's industry default (owner
 *  rule, 2026-10-03). Below it the median is still served beside the rate, never used as the rate. */
export const MIN_FLEET_MEDIAN_BRANDS = 5;

/** PURE: whether the fleet median may stand in for this leg's rate (≥ 5 brands stated it, every leg alike). */
export function fleetMedianApplies(medianRate: { ratePct: number | null; brandCount: number }): boolean {
  return medianRate.ratePct !== null && medianRate.brandCount >= MIN_FLEET_MEDIAN_BRANDS;
}

export type EffectiveRateSource = "measured" | "manual" | "median" | "default";

/** Why an arrow's measured rate is not the effective one. */
export type MeasuredRateGap =
  /** One of the two steps is not a step anything in the fleet counts (an ad-delivered step, a checkout). */
  | "step_not_counted"
  /** The producer behind one of the steps could not be read on this computation. */
  | "evidence_unreadable"
  /** Counted, but fewer than `MIN_MEASURED_FROM_REACHED` leads reached the FROM step. */
  | "below_learning_bar"
  /** More leads reached TO than FROM — the FROM step is under-counted, so the ratio is no probability. */
  | "to_exceeds_from";

/** WHERE a measured rate was read: this brand's leads, or the client's whole CRM. */
export type MeasurementBasis = "our_leads" | "crm";

/** On our leads, WHICH outcomes the counts include. Null on a CRM-measured rate. */
export type MeasuredOutcomes = "all" | "caused_by_our_outreach";

export interface MeasuredArrowRate {
  /** Where the counts below were read. `fromReached` is the population the rate is measured on. */
  basis: MeasurementBasis;
  /** On our leads: every outcome, or only the ones our outreach caused. Null on the CRM. */
  outcomesCounted: MeasuredOutcomes | null;
  /** Distinct leads (or CRM contacts) that reached the FROM step. Null when that step is not counted or unreadable. */
  fromReached: number | null;
  /** Leads that reached the TO step THROUGH this leg (see the module header). Same null rule. */
  toReached: number | null;
  /** Leads at the TO step NOT counted because they got there only through ANOTHER leg into it (a meeting
   *  booked off a reply, on the website-visit leg). 0 on a single-route TO step; null on the CRM basis
   *  and whenever `toReached` is null. */
  toReachedThroughOtherLegs: number | null;
  /** `toReached ÷ fromReached × 100`. Null when either is null or `fromReached` is 0. */
  ratePct: number | null;
  /** True exactly when this measured rate is the effective one. */
  sufficient: boolean;
  /** Null when sufficient; otherwise which of the three reasons applies. */
  gap: MeasuredRateGap | null;
}

export interface EffectiveArrowRate {
  /** brand-service's own wording for the FROM step (joins the brand-service leg-rate write). */
  fromStep: string;
  /** brand-service's own wording for the TO step. */
  toStep: string;
  /**
   * The leg's identity in this service's PUBLIC catalogue (`/public/channels` `legs[].legKey`), so a
   * consumer joins the two reads on one token with no translation table: brand-service may still spell
   * a step differently ("Form filled", "Purchase") from the catalogue ("Form submitted", "Direct
   * purchase"). Null only for a leg the catalogue does not carry.
   */
  legKey: string | null;
  /** The FROM step's catalogue label (`legs[].fromStep.label`). Null when `legKey` is. */
  catalogueFromStep: string | null;
  /** The TO step's catalogue label (`legs[].toStep.label`). Null when `legKey` is. */
  catalogueToStep: string | null;
  /** The rate every money figure is priced on for this arrow, 0..100. Never null on a catalogue leg: the
   *  per-leg default is the last source (`lib/default-leg-rates.ts`). */
  effectiveRatePct: number | null;
  /** Which source `effectiveRatePct` is: `default` is the seeded industry benchmark, never the brand's. */
  source: EffectiveRateSource | null;
  /** Kept for readers of the older contract: null on every catalogue leg now that a default exists.
   *  Set only for a leg outside the catalogue that no source prices. */
  unresolvedReason: "no_rate_available" | null;
  measured: MeasuredArrowRate;
  /** What the brand stated by hand for this arrow, or null when it has not. */
  manualRatePct: number | null;
  /** The cross-org median of what brands stated for this (funnel, arrow), over `brandCount` brands. */
  median: { ratePct: number | null; brandCount: number };
  /** The seeded per-leg default (industry benchmark), whether or not it is the effective source. */
  defaultRatePct: number | null;
  /** Every source the precedence weighed for this leg that holds a number, in precedence order, exactly one `kept` (see `RateCandidate`). */
  candidates: RateCandidate[];
}

/** Where a rate candidate comes from: measured on the client's CRM, measured on our leads, or a source of the precedence. */
export type RateCandidateBasis = "crm" | "our_leads" | "manual" | "median" | "default";

/**
 * ONE RATE THE PRECEDENCE WEIGHED FOR A LEG (owner 2026-10-08, the step side panel: "Measured in your CRM:
 * 28 of 43 (65%) [Kept] / Measured in our data: 1 of 4 (25%) / Your value: 32%"). Exposes what
 * `resolveArrow` already weighs; the precedence and the kept rate are unchanged. A source holding no number
 * is absent. Exactly one candidate is `kept` when the leg has a rate, and its `ratePct` IS the leg's rate.
 */
export interface RateCandidate {
  basis: RateCandidateBasis;
  ratePct: number;
  /** Measured candidates: the population (FROM) and the people through the leg (TO). Null otherwise. */
  fromReached: number | null;
  toReached: number | null;
  /** our_leads only: which outcomes the counts include. Null otherwise. */
  outcomesCounted: MeasuredOutcomes | null;
  /** median only: over how many brands' statements. Null otherwise. */
  brandCount: number | null;
  kept: boolean;
  /**
   * Null when kept. Otherwise why not: `outranked` (usable, a source earlier in the precedence won),
   * `below_learning_bar` (fewer than `MIN_MEASURED_FROM_REACHED` at FROM), `to_exceeds_from` (no
   * probability), `too_few_brands` (median over fewer than `MIN_FLEET_MEDIAN_BRANDS`),
   * `crm_measures_this_leg` (our leads, when the client's CRM is where this leg is measured).
   */
  notKeptReason: "outranked" | "below_learning_bar" | "to_exceeds_from" | "too_few_brands" | "crm_measures_this_leg" | null;
}

/** PURE: the candidates of a resolved leg (see `RateCandidate`). `ourLeads` = the our-leads measurement beside a CRM one. */
export function rateCandidatesOf(
  leg: Pick<EffectiveArrowRate, "source" | "effectiveRatePct" | "measured" | "manualRatePct" | "median" | "defaultRatePct">,
  ourLeads: MeasuredArrowRate | null,
): RateCandidate[] {
  const keptBasis: RateCandidateBasis | null =
    leg.source === "measured" ? leg.measured.basis : leg.source;
  const none = { fromReached: null, toReached: null, outcomesCounted: null, brandCount: null };
  const out: RateCandidate[] = [];
  const push = (basis: RateCandidateBasis, ratePct: number, extra: Partial<RateCandidate>, blocked: RateCandidate["notKeptReason"]) => {
    const kept = basis === keptBasis;
    out.push({ basis, ratePct, ...none, ...extra, kept, notKeptReason: kept ? null : (blocked ?? "outranked") });
  };
  const measuredBlock = (m: MeasuredArrowRate): RateCandidate["notKeptReason"] =>
    m.gap === "below_learning_bar" || m.gap === "to_exceeds_from" ? m.gap : null;
  for (const m of [leg.measured, ourLeads]) {
    if (!m || m.ratePct === null) continue;
    const counts = { fromReached: m.fromReached, toReached: m.toReached, outcomesCounted: m.outcomesCounted };
    // Our leads beside a CRM measurement: the CRM is where this leg is measured, our leads are shown, never weighed.
    const blocked = m === ourLeads ? "crm_measures_this_leg" : measuredBlock(m);
    push(m.basis, m.ratePct, counts, blocked);
  }
  if (leg.manualRatePct !== null) push("manual", leg.manualRatePct, {}, null);
  if (leg.median.ratePct !== null) {
    push("median", leg.median.ratePct, { brandCount: leg.median.brandCount }, fleetMedianApplies(leg.median) ? null : "too_few_brands");
  }
  if (leg.defaultRatePct !== null) push("default", leg.defaultRatePct, {}, null);
  return out;
}

export interface EffectiveFunnelRates {
  funnelKey: SalesFunnelKey;
  name: string;
  steps: readonly string[];
  arrows: EffectiveArrowRate[];
}

/** Whether the brand's CRM took part in the measurement, and why not when it did not. */
export type CrmMeasurementStatus = "used" | CrmReachUnavailableReason | "unreadable";

export interface CrmMeasurement {
  status: CrmMeasurementStatus;
  /** Contacts in the CRM, per crm-service's coverage. Null when not used. */
  totalContacts: number | null;
  lastSyncedAt: string | null;
  /** Per CRM step, direct evidence and at-or-beyond reach. Null when not used. */
  reach: Partial<Record<CrmReachStep, { contacts: number; contactsAtOrBeyond: number }>> | null;
}

export interface BrandEffectiveRates {
  brandId: string;
  /**
   * The brand's CRM in this measurement. Null only for a measurement that never asked (a pure caller
   * passing counts without it) — the served read always carries it.
   */
  crm: { status: CrmMeasurementStatus; totalContacts: number | null; lastSyncedAt: string | null } | null;
  minMeasuredFromReached: number;
  /** Distinct leads this brand has contacted — the population every measured rate is read from. */
  contactedRecipients: number;
  funnels: EffectiveFunnelRates[];
  /** Every leg of the catalogue, once — the grain a rate actually lives at. */
  legs: EffectiveArrowRate[];
}

// ── Steps and the lead flags that count them ──────────────────────────────────────────────────
//
// The step-wording → lead-flag map lives in `lib/funnel-steps.ts` (`leadFieldOfStep`), ONE copy: the
// funnel walk places its rungs by it, and an arrow here is measured by it. A leg is measured the same
// way whichever funnel reads it: a rate is a property of the (brand, leg) pair, never of a funnel, so a
// booked meeting becoming an attended one is one measurement for the brand.

/** The arrows of a funnel: every consecutive pair of its steps, in order. */
export function funnelArrows(funnelKey: SalesFunnelKey): Array<{ fromStep: string; toStep: string; fromIndex: number }> {
  const steps = SALES_FUNNELS[funnelKey].steps;
  const out: Array<{ fromStep: string; toStep: string; fromIndex: number }> = [];
  for (let i = 0; i + 1 < steps.length; i++) out.push({ fromStep: steps[i], toStep: steps[i + 1], fromIndex: i });
  return out;
}

// ── MEASURED: this brand's own leads ─────────────────────────────────────────────────────────

/** Per deduped lead, which counted steps it reached — plus which steps were readable at all. */
export interface BrandStepMeasurement {
  contactedRecipients: number;
  evidence: StepEvidence;
  reached: Array<Record<LeadStepField, boolean>>;
  /** Per lead, the steps it reached through an outcome OUR outreach caused. Same order as `reached`. */
  ourReached?: Array<Record<LeadStepField, boolean>>;
  crm?: CrmMeasurement;
}

/**
 * Read the brand's WHOLE lead population and the per-lead overlays, exactly as the brand revenue read
 * does — the same lead read, the same human statements, the same legacy qualifications and the same
 * website-conversion attribution — so a measured rate and the brand's `funnelSteps` count one set of
 * people. The lead read is fail-loud (it is the population); each overlay is fail-soft and its step
 * then reads as unreadable rather than 0.
 */
export async function measureBrandSteps(
  brandId: string,
  orgId: string,
  pricedFunnelKeys: readonly SalesFunnelKey[],
): Promise<BrandStepMeasurement> {
  // The CRM read rides beside the lead read. Fail-soft and LOUD: a CRM we cannot read leaves the brand
  // on today's lead-only measurement, stated as `crm.status: "unreadable"`, never a zero.
  const crmPromise: Promise<CrmFunnelReach | null> = fetchCrmFunnelReach(brandId, orgId).catch((err) => {
    console.error(`[features-service] effective conversion rates: CRM funnel reach unreadable for brand ${brandId} (measured on our leads, every outcome, as before): ${(err as Error).message}`);
    return null;
  });
  const headers = { orgId };
  const persons = await fetchLeadsForRevenue(brandId, undefined, headers);
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const soft = <T>(what: string, p: Promise<T>): Promise<T | null> =>
    p.catch((err) => {
      console.warn(`[features-service] effective conversion rates: ${what} unreadable for brand ${brandId} (its steps read as unmeasured): ${(err as Error).message}`);
      return null;
    });
  const [observed, quals, signupEmails, formEmails] = await Promise.all([
    soft("observed step statements", fetchObservedStepFacts(brandId)),
    soft("legacy qualifications", fetchQualifications(brandId, undefined, emails, headers)),
    soft("signup attribution", fetchConversionEmails(brandId, "signup")),
    soft("form-submission attribution", fetchConversionEmails(brandId, "form_submission")),
  ]);

  const crmReach = await crmPromise;
  const crm = crmMeasurementOf(crmReach);

  // Only when the CRM is used do we need to know WHOSE outcome each one was: a legacy qualification
  // carries no cause, so it is judged by the delivery rule against our first delivered email — read
  // for those few emails alone. Unreadable → those outcomes are undecided (never ours), loudly.
  let legacyDelivery: Map<string, SignalDates> | null = null;
  if (crm.status === "used" && quals && quals.size > 0) {
    legacyDelivery = await fetchEventTimestamps(brandId, undefined, [...quals.keys()], headers).catch((err) => {
      console.error(`[features-service] effective conversion rates: delivery dates unreadable for brand ${brandId}'s legacy qualifications (they count as not ours): ${(err as Error).message}`);
      return null;
    });
  }

  applySignalOverlays(persons, legacyDelivery, observed?.byEmail ?? null, quals, pricedFunnelKeys);
  for (const person of persons) {
    const email = person.email?.trim().toLowerCase();
    if (!email) continue;
    if (signupEmails?.has(email)) person.signals.signup = true;
    if (formEmails?.has(email)) person.signals.formSubmission = true;
  }

  const deduped = dedupPersonsByLead(persons);
  const fields = Object.keys(LEAD_FIELD_TO_SIGNAL) as LeadStepField[];
  return {
    contactedRecipients: deduped.reduce((n, p) => n + (p.signals.contacted ? 1 : 0), 0),
    evidence: {
      observedSteps: observed !== null,
      legacyQualifications: quals !== null,
      signupAttribution: signupEmails !== null,
      formSubmissionAttribution: formEmails !== null,
    },
    reached: deduped.map(
      (p) => Object.fromEntries(fields.map((f) => [f, Boolean(p.signals[LEAD_FIELD_TO_SIGNAL[f]])])) as Record<LeadStepField, boolean>,
    ),
    // A rung reached ONLY through outcomes our outreach did not cause is not ours (`unpricedSignals`,
    // the same per-lead mark the #1058 pricing reads, default cause set = outreach).
    ourReached: deduped.map((p) => {
      const notOurs = new Set(p.unpricedSignals ?? []);
      return Object.fromEntries(
        fields.map((f) => {
          const signal = LEAD_FIELD_TO_SIGNAL[f];
          return [f, Boolean(p.signals[signal]) && !notOurs.has(signal)];
        }),
      ) as Record<LeadStepField, boolean>;
    }),
    crm,
  };
}

/** PURE: the CRM half of a measurement, from crm-service's answer (null = the read failed). */
export function crmMeasurementOf(reach: CrmFunnelReach | null): CrmMeasurement {
  if (reach === null) return { status: "unreadable", totalContacts: null, lastSyncedAt: null, reach: null };
  if (!reach.available) return { status: reach.reason, totalContacts: null, lastSyncedAt: null, reach: null };
  const byStep: Partial<Record<CrmReachStep, { contacts: number; contactsAtOrBeyond: number }>> = {};
  for (const s of reach.steps) byStep[s.step] = { contacts: s.contacts, contactsAtOrBeyond: s.contactsAtOrBeyond };
  return { status: "used", totalContacts: reach.totalContacts, lastSyncedAt: reach.lastSyncedAt, reach: byStep };
}

/**
 * The measurement reduced to what a rate reads: how many deduped leads reached each step, and how many
 * leads share each COMBINATION of reached steps (`reachedPatterns`, keyed by the reached fields sorted
 * and joined with "+"; leads that reached none are left out). The combinations are what tell which leg a
 * lead reached TO through, and they are what the snapshot layer stores (a dozen entries against ~1 MB of
 * per-lead rows).
 */
export interface BrandStepCounts {
  contactedRecipients: number;
  evidence: StepEvidence;
  reachedCounts: Record<LeadStepField, number>;
  reachedPatterns: Record<string, number>;
  /** Leads that reached each step through an outcome our outreach caused. */
  ourReachedCounts?: Record<LeadStepField, number>;
  ourReachedPatterns?: Record<string, number>;
  crm?: CrmMeasurement;
}

/** PURE: the per-combination tally of per-lead rows (see `BrandStepCounts.reachedPatterns`). */
function tallyPatterns(rows: ReadonlyArray<Record<LeadStepField, boolean>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const lead of rows) {
    const key = (Object.keys(lead) as LeadStepField[]).filter((f) => lead[f]).sort().join("+");
    if (key) out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** PURE: leads of a pattern tally at `to`, split into through the leg `from → to` and through another. */
function throughLeg(patterns: Record<string, number>, from: LeadStepField, to: LeadStepField): { through: number; other: number } {
  let through = 0;
  let other = 0;
  for (const [key, n] of Object.entries(patterns)) {
    const reached = Object.fromEntries(key.split("+").map((f) => [f, true])) as Partial<Record<LeadStepField, boolean>>;
    if (!reached[to]) continue;
    if (reachedThroughLeg(reached, from, to)) through += n;
    else other += n;
  }
  return { through, other };
}

/** PURE: a measurement's per-step counts. Idempotent on counts already summarised. */
export function summariseMeasurement(measurement: BrandStepMeasurement | BrandStepCounts): BrandStepCounts {
  if ("reachedCounts" in measurement) return measurement;
  const fields = Object.keys(LEAD_FIELD_TO_SIGNAL) as LeadStepField[];
  const tally = (rows: ReadonlyArray<Record<LeadStepField, boolean>>): Record<LeadStepField, number> => {
    const counts = Object.fromEntries(fields.map((f) => [f, 0])) as Record<LeadStepField, number>;
    for (const lead of rows) for (const f of fields) if (lead[f]) counts[f] += 1;
    return counts;
  };
  return {
    contactedRecipients: measurement.contactedRecipients,
    evidence: measurement.evidence,
    reachedCounts: tally(measurement.reached),
    reachedPatterns: tallyPatterns(measurement.reached),
    ...(measurement.ourReached
      ? { ourReachedCounts: tally(measurement.ourReached), ourReachedPatterns: tallyPatterns(measurement.ourReached) }
      : {}),
    ...(measurement.crm ? { crm: measurement.crm } : {}),
  };
}

/** PURE: the measured rate of one arrow over one measurement. */
export function measuredArrowRate(
  input: BrandStepMeasurement | BrandStepCounts,
  fromField: LeadStepField | null,
  toField: LeadStepField | null,
  outcomesCounted: MeasuredOutcomes = "all",
): MeasuredArrowRate {
  const measurement = summariseMeasurement(input);
  const basis = { basis: "our_leads" as const, outcomesCounted };
  const unmeasured = { fromReached: null, toReached: null, toReachedThroughOtherLegs: null, ratePct: null, sufficient: false };
  if (fromField === null || toField === null) return { ...basis, ...unmeasured, gap: "step_not_counted" };
  if (!stepMeasured(fromField, measurement.evidence) || !stepMeasured(toField, measurement.evidence)) {
    return { ...basis, ...unmeasured, gap: "evidence_unreadable" };
  }
  let counts = measurement.reachedCounts;
  let patterns = measurement.reachedPatterns;
  if (outcomesCounted === "caused_by_our_outreach") {
    if (!measurement.ourReachedCounts || !measurement.ourReachedPatterns) {
      throw new Error("measuredArrowRate: an outreach-caused rate needs ourReachedCounts and ourReachedPatterns, and this measurement carries none");
    }
    counts = measurement.ourReachedCounts;
    patterns = measurement.ourReachedPatterns;
  }
  if (!patterns) throw new Error("measuredArrowRate: a measurement without reachedPatterns cannot tell which leg a lead came through");
  const { through, other } = throughLeg(patterns, fromField, toField);
  return { ...fromCounts(basis, counts[fromField] ?? 0, through), toReachedThroughOtherLegs: other };
}

/** PURE: the rate, bar and gap of two counts — one rule, whichever population they were read on. */
function fromCounts(
  basis: { basis: MeasurementBasis; outcomesCounted: MeasuredOutcomes | null },
  fromReached: number,
  toReached: number,
): MeasuredArrowRate {
  const ratePct = fromReached > 0 ? (toReached / fromReached) * 100 : null;
  const counts = { fromReached, toReached, toReachedThroughOtherLegs: null, ratePct };
  // More leads at TO than at FROM: the FROM step is under-counted (a producer records the later rung
  // but not the earlier one), so the ratio is not a probability. Unmeasurable, never clamped to 100%.
  if (ratePct !== null && ratePct > 100) {
    return { ...basis, ...counts, sufficient: false, gap: "to_exceeds_from" };
  }
  const sufficient = fromReached >= MIN_MEASURED_FROM_REACHED;
  return { ...basis, ...counts, sufficient, gap: sufficient ? null : "below_learning_bar" };
}

/** Our step wording → the CRM step that evidences it. A step absent here is one no CRM records. */
const STEP_CRM_STEP: Record<string, CrmReachStep> = {
  "form submitted": "form_submitted",
  "meeting booked": "meeting_booked",
  "meeting attended": "meeting_attended",
  "paid client": "sale",
};

/**
 * PURE: the leg measured on the client's WHOLE CRM, or null when the CRM does not directly evidence
 * BOTH ends (at least one contact with direct evidence of each step). Divides `contactsAtOrBeyond`, as
 * crm-service states (monotone, so never over 100% along its own ladder).
 */
export function crmArrowRate(crm: CrmMeasurement, fromStep: string, toStep: string): MeasuredArrowRate | null {
  if (crm.status !== "used" || !crm.reach) return null;
  const from = STEP_CRM_STEP[normaliseStep(fromStep)];
  const to = STEP_CRM_STEP[normaliseStep(toStep)];
  if (!from || !to) return null;
  const f = crm.reach[from];
  const t = crm.reach[to];
  if (!f || !t || f.contacts === 0 || t.contacts === 0) return null;
  return fromCounts({ basis: "crm", outcomesCounted: null }, f.contactsAtOrBeyond, t.contactsAtOrBeyond);
}

// ── MEDIAN: what the fleet stated ────────────────────────────────────────────────────────────

/**
 * One key per LEG — the two steps it connects, resolved to our step keys so brand-service's wording
 * ("Form filled") and ours ("Form submitted") meet. No funnel is part of it: a brand states ONE rate
 * per leg, shared by every funnel that reads the leg.
 */
export function legPairKey(fromStep: string, toStep: string): string {
  const key = (label: string): string => FUNNEL_STEP_LABEL_TO_KEY[label.trim()] ?? normaliseStep(label);
  return `${key(fromStep)}>${key(toStep)}`;
}

/** PURE: the catalogue identity of the leg between two step LABELS (either spelling), or nulls when the
 *  public catalogue carries no such leg. */
export function catalogueLegOf(fromStep: string, toStep: string): Pick<EffectiveArrowRate, "legKey" | "catalogueFromStep" | "catalogueToStep"> {
  const [from, to] = legPairKey(fromStep, toStep).split(">");
  const leg = isChannelStepKey(from) && isChannelStepKey(to) ? funnelLeg(legKeyBetween(from, to)) : null;
  if (!leg || !leg.fromStep) return { legKey: null, catalogueFromStep: null, catalogueToStep: null };
  return { legKey: leg.legKey, catalogueFromStep: leg.fromStep.label, catalogueToStep: leg.toStep.label };
}

/** The seeded default of the leg between two step LABELS (either spelling), or null when none is seeded. */
function defaultRateOfLeg(fromStep: string, toStep: string): number | null {
  const [from, to] = legPairKey(fromStep, toStep).split(">");
  return isChannelStepKey(from) && isChannelStepKey(to) ? defaultLegRatePct(from, to) : null;
}
const isChannelStepKey = (v: string | undefined): v is ChannelStepKey =>
  v !== undefined && (CHANNEL_STEP_KEYS as readonly string[]).includes(v);

export type FleetArrowMedians = Map<string, { ratePct: number | null; brandCount: number }>;

/** PURE: the median per LEG over the brands that STATED it — one data point per brand. */
export function buildFleetArrowMedians(perBrand: readonly (readonly BrandLegRate[])[]): FleetArrowMedians {
  const values = new Map<string, number[]>();
  for (const legs of perBrand) {
    const seen = new Set<string>();
    for (const leg of legs) {
      if (!leg.stated || leg.ratePct === null) continue;
      const key = legPairKey(leg.fromStep, leg.toStep);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = values.get(key) ?? [];
      list.push(leg.ratePct);
      values.set(key, list);
    }
  }
  const out: FleetArrowMedians = new Map();
  for (const [key, list] of values) out.set(key, { ratePct: median(list), brandCount: list.length });
  return out;
}

/**
 * PURE: the fleet median of the lifetime revenues OFFERS stated — one data point per offer (a stated value
 * is > 0 by brand-service's contract; anything else is not a statement). Null when no offer states one.
 * The default every unstated offer is priced on (owner 2026-10-09: "We always need a LTR, it can never
 * be 0. Fill it by default with our median value"). Never an average, never per brand.
 */
export function buildFleetLifetimeRevenueMedian(perBrandOffers: readonly (readonly BrandOfferEconomics[])[]): {
  usd: number | null;
  offerCount: number;
} {
  const seen = new Set<string>();
  const values: number[] = [];
  for (const offers of perBrandOffers) {
    for (const offer of offers) {
      if (seen.has(offer.offerId)) continue;
      seen.add(offer.offerId);
      const v = offer.lifetimeRevenueUsd;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) values.push(v);
    }
  }
  return { usd: median(values), offerCount: values.length };
}

interface FleetStatedMedians {
  arrows: FleetArrowMedians;
  lifetimeRevenue: { usd: number | null; offerCount: number };
}

const FLEET_MEDIAN_FRESH_MS = 15 * 60_000;
const FLEET_MEDIAN_STALE_MS = 6 * 60 * 60_000;
const FLEET_BRAND_CONCURRENCY = 8;
let fleetMedianCache: { value: FleetStatedMedians; at: number } | null = null;
let fleetMedianInFlight: Promise<FleetStatedMedians> | null = null;

/** Test seam. */
export function __resetFleetArrowMediansCache(): void {
  fleetMedianCache = null;
  fleetMedianInFlight = null;
}

async function computeFleetStatedMedians(): Promise<FleetStatedMedians> {
  // Every brand any feature has leads for, under its first claiming org — the same enumeration the
  // showcase uses, so a brand running any channel is in the population.
  const allSlugs = (await db.query.features.findMany()).map((f) => f.slug);
  const memberships = allSlugs.length > 0 ? await fetchFeatureMemberships(allSlugs.join(",")) : [];
  const orgByBrand = new Map<string, string>();
  for (const m of memberships) if (!orgByBrand.has(m.brandId)) orgByBrand.set(m.brandId, m.orgId);

  // One brand's unreadable statements cost the median ONE data point, loudly — never the whole fleet.
  const perBrand = await mapWithConcurrency([...orgByBrand.entries()], FLEET_BRAND_CONCURRENCY, ([brandId, orgId]) =>
    fetchBrandLegEconomics(brandId, orgId).catch((err) => {
      console.warn(`[features-service] fleet stated median: brand ${brandId} (org ${orgId}) statements unreadable, contributes no data point: ${(err as Error).message}`);
      return { legRates: [], offers: [] } as BrandLegEconomics;
    }),
  );
  return {
    arrows: buildFleetArrowMedians(perBrand.map((e) => e.legRates)),
    lifetimeRevenue: buildFleetLifetimeRevenueMedian(perBrand.map((e) => e.offers)),
  };
}

/**
 * The fleet medians, off a single-flighted in-memory cell: fresh for 15 minutes (a median over the
 * fleet's hand-stated rates cannot visibly move faster), served stale up to 6 hours while ONE refresh
 * runs behind the read.
 */
/**
 * Boot warm, after listen() and fire-and-forget: the medians live in memory only, so without it the first
 * priced read of every brand after a deploy waited on the fleet scan (O(brands) leg-economics reads).
 */
export function warmFleetArrowMediansOnBoot(): void {
  getFleetArrowMedians().catch((err) => console.error(`[features-service] fleet conversion-rate median boot warm failed: ${(err as Error).message}`));
}

async function getFleetStatedMedians(): Promise<FleetStatedMedians> {
  const now = Date.now();
  const refresh = (): Promise<FleetStatedMedians> => {
    if (!fleetMedianInFlight) {
      fleetMedianInFlight = computeFleetStatedMedians()
        .then((value) => {
          fleetMedianCache = { value, at: Date.now() };
          return value;
        })
        .finally(() => {
          fleetMedianInFlight = null;
        });
    }
    return fleetMedianInFlight;
  };
  if (fleetMedianCache && now - fleetMedianCache.at < FLEET_MEDIAN_FRESH_MS) return fleetMedianCache.value;
  if (fleetMedianCache && now - fleetMedianCache.at < FLEET_MEDIAN_STALE_MS) {
    refresh().catch((err) => console.error(`[features-service] fleet stated median refresh failed (serving the last value): ${(err as Error).message}`));
    return fleetMedianCache.value;
  }
  return refresh();
}

export async function getFleetArrowMedians(): Promise<FleetArrowMedians> {
  return (await getFleetStatedMedians()).arrows;
}

/** The fleet median of the offers' stated lifetime revenues (same sweep, same cell as the leg medians). */
export async function getFleetLifetimeRevenueMedian(): Promise<{ usd: number | null; offerCount: number }> {
  return (await getFleetStatedMedians()).lifetimeRevenue;
}

// ── Resolution ────────────────────────────────────────────────────────────────────────────────

/** PURE: resolve one arrow from its sources, in order (a fleet median counts only over ≥ MIN_FLEET_MEDIAN_BRANDS brands). */
export function resolveArrow(
  fromStep: string,
  toStep: string,
  measured: MeasuredArrowRate,
  manualRatePct: number | null,
  medianRate: { ratePct: number | null; brandCount: number },
  defaultRatePct: number | null = null,
  /** The our-leads measurement when `measured` is the CRM's: a candidate shown beside it, never weighed. */
  ourLeadsMeasured: MeasuredArrowRate | null = null,
): EffectiveArrowRate {
  let effectiveRatePct: number | null = null;
  let source: EffectiveRateSource | null = null;
  if (measured.sufficient && measured.ratePct !== null) {
    effectiveRatePct = measured.ratePct;
    source = "measured";
  } else if (manualRatePct !== null) {
    effectiveRatePct = manualRatePct;
    source = "manual";
  } else if (medianRate.ratePct !== null && fleetMedianApplies(medianRate)) {
    effectiveRatePct = medianRate.ratePct;
    source = "median";
  } else if (defaultRatePct !== null) {
    effectiveRatePct = defaultRatePct;
    source = "default";
  }
  const resolved = {
    fromStep,
    toStep,
    ...catalogueLegOf(fromStep, toStep),
    effectiveRatePct,
    source,
    unresolvedReason: effectiveRatePct === null ? ("no_rate_available" as const) : null,
    measured,
    manualRatePct,
    median: medianRate,
    defaultRatePct,
  };
  return { ...resolved, candidates: rateCandidatesOf(resolved, measured.basis === "crm" ? ourLeadsMeasured : null) };
}

/**
 * PURE: every LEG of the catalogue resolved once — keyed by `legPairKey` — and every funnel of
 * `funnelKeys` read as the legs it is made of. A leg shared by several funnels carries ONE effective
 * rate in all of them (owner model, 2026-09-25: one rate per (brand, leg)).
 */
export function buildBrandEffectiveRates(input: {
  brandId: string;
  funnelKeys: readonly SalesFunnelKey[];
  measurement: BrandStepMeasurement | BrandStepCounts;
  manual: readonly BrandLegRate[];
  medians: FleetArrowMedians;
}): BrandEffectiveRates {
  const measurement = summariseMeasurement(input.measurement);
  const manualByLeg = new Map<string, number>();
  // brand-service's OWN wording for each leg (it owns the step vocabulary — its form rung reads "Form
  // filled" where ours reads "Form submitted"), so a consumer joins a served arrow to the brand-service
  // write without translating. Ours stands in only where brand-service names none.
  const producerLabels = new Map<string, { fromStep: string; toStep: string }>();
  for (const leg of input.manual) {
    const key = legPairKey(leg.fromStep, leg.toStep);
    if (!producerLabels.has(key)) producerLabels.set(key, { fromStep: leg.fromStep, toStep: leg.toStep });
    if (leg.stated && leg.ratePct !== null && !manualByLeg.has(key)) manualByLeg.set(key, leg.ratePct);
  }
  const legs = new Map<string, EffectiveArrowRate>();
  const crm = measurement.crm ?? null;
  const crmUsed = crm?.status === "used";
  // The measurement precedence is unchanged: the CRM when it evidences both ends, else our leads. Beside a
  // CRM measurement, our leads' own rate is read too (a candidate shown, never weighed).
  const measureLeg = (fromStep: string, toStep: string): { measured: MeasuredArrowRate; ourLeads: MeasuredArrowRate | null } => {
    const crmRate = crmUsed ? crmArrowRate(crm!, fromStep, toStep) : null;
    const canReadOurs = !crmUsed || (measurement.ourReachedCounts !== undefined && measurement.ourReachedPatterns !== undefined);
    const ours = canReadOurs
      ? measuredArrowRate(measurement, leadFieldOfStep(fromStep), leadFieldOfStep(toStep), crmUsed ? "caused_by_our_outreach" : "all")
      : null;
    if (crmRate) return { measured: crmRate, ourLeads: ours };
    if (!ours) throw new Error("measuredArrowRate: an outreach-caused rate needs ourReachedCounts and ourReachedPatterns, and this measurement carries none");
    return { measured: ours, ourLeads: null };
  };
  const resolveLeg = (fromStep: string, toStep: string): EffectiveArrowRate => {
    const key = legPairKey(fromStep, toStep);
    const cached = legs.get(key);
    if (cached) return cached;
    const label = producerLabels.get(key) ?? { fromStep, toStep };
    const { measured, ourLeads } = measureLeg(fromStep, toStep);
    const resolved = resolveArrow(
      label.fromStep,
      label.toStep,
      measured,
      manualByLeg.get(key) ?? null,
      input.medians.get(key) ?? { ratePct: null, brandCount: 0 },
      defaultRateOfLeg(fromStep, toStep),
      ourLeads,
    );
    legs.set(key, resolved);
    return resolved;
  };
  // Every leg of the whole catalogue is resolved, so a pricing read can walk any path from any step.
  for (const funnelKey of SALES_FUNNEL_KEYS) for (const a of funnelArrows(funnelKey)) resolveLeg(a.fromStep, a.toStep);
  // ...and every leg between two steps of the PUBLIC catalogue, by its catalogue labels, so a leg the
  // catalogue gains is served (with its default at worst) without anyone remembering to add it here.
  for (const leg of FUNNEL_LEGS) if (leg.fromStep) resolveLeg(leg.fromStep.label, leg.toStep.label);
  const funnels = [...input.funnelKeys]
    .sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b))
    .map((funnelKey): EffectiveFunnelRates => ({
      funnelKey,
      name: SALES_FUNNELS[funnelKey].name,
      steps: SALES_FUNNELS[funnelKey].steps,
      arrows: funnelArrows(funnelKey).map(({ fromStep, toStep }) => resolveLeg(fromStep, toStep)),
    }));
  return {
    brandId: input.brandId,
    crm: crm ? { status: crm.status, totalContacts: crm.totalContacts, lastSyncedAt: crm.lastSyncedAt } : null,
    minMeasuredFromReached: MIN_MEASURED_FROM_REACHED,
    contactedRecipients: measurement.contactedRecipients,
    funnels,
    legs: [...legs.values()],
  };
}

/** PURE: the effective rate of the leg between two steps, or null when nothing prices it. */
export function effectiveLegRatePct(rates: BrandEffectiveRates, fromStep: string, toStep: string): number | null {
  const key = legPairKey(fromStep, toStep);
  return rates.legs.find((l) => legPairKey(l.fromStep, l.toStep) === key)?.effectiveRatePct ?? null;
}

/**
 * The brand's per-step counts, served through the Gold snapshot layer: one brand-wide lead walk per
 * refresh, shared by every surface that prices this brand. ONLY the measurement is cached — it is the
 * expensive half and it is allowed to lag a refresh.
 */
export function getBrandStepCounts(brandId: string, orgId: string): Promise<BrandStepCounts> {
  return servedCached({
    view: "brand-conversion-step-counts",
    // `m` names the measurement rule, so a snapshot computed under a retired rule is never served.
    scopeKey: buildScopeKey(brandId, { orgId, m: "funnel-step-crm-through-leg-v2" }),
    // An INTERNAL measurement, never a response body: `m` is its shape. Keyed on the build's response
    // shape it went cold on every deploy touching any route, and every priced read of the brand (the
    // Unibox lead families included) waited on a 9-30 s lead walk BEFORE its own cache lookup (prod
    // 2026-10-08, brand `75d7e3e8…`). Change `m` when the measurement's shape or rule changes.
    responseShape: "internal-measurement",
    orgId,
    compute: async () => summariseMeasurement(await measureBrandSteps(brandId, orgId, [])),
  });
}

/**
 * The brand's effective rates: the cached measurement, the fleet medians, and the brand's OWN leg
 * statements read LIVE on every call. The statements are what a person just edited, so they must never
 * come off a snapshot. `legEconomics` lets a caller that already read the statements pass them in.
 */
export async function getBrandEffectiveRates(
  brandId: string,
  orgId: string,
  legEconomics?: BrandLegEconomics,
): Promise<BrandEffectiveRates> {
  const [measurement, statements, medians] = await Promise.all([
    getBrandStepCounts(brandId, orgId),
    legEconomics ? Promise.resolve(legEconomics) : fetchBrandLegEconomics(brandId, orgId),
    getFleetArrowMedians(),
  ]);
  return buildBrandEffectiveRates({ brandId, funnelKeys: SALES_FUNNEL_KEYS, measurement, manual: statements.legRates, medians });
}
