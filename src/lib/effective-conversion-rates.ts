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
 *      `MIN_MEASURED_FROM_REACHED` (10, the fleet's learning bar) of them reached the arrow's FROM step.
 *      The bar is on the DENOMINATOR on purpose: an arrow that is genuinely at 0% must still become
 *      measured, and a bar on the outcome count would keep it on a stated guess forever. Our lead data
 *      already merges the customer's own statements, our tracker and their CRM (the same overlays
 *      `funnelSteps` counts on), so this is the brand's reality, not a sample of it.
 *   2. MANUAL — what the brand stated by hand for the leg (brand-service `offer-economics` leg rates).
 *   3. MEDIAN — the cross-org median of what OTHER brands stated for the same leg. Stated
 *      values only: the store has no default behind it, so a brand that stated nothing contributes
 *      nothing.
 *
 * When none of the three exists the answer is `null` with `unresolvedReason` — never a default, never
 * a 0, never borrowed from a neighbouring arrow.
 *
 * ── THE MEASURED RATE IS THE FUNNEL-STEP CONVERSION, BYTE FOR BYTE ─────────────────────────────
 *
 * `count(leads at TO) ÷ count(leads at FROM)` — exactly what `funnelSteps.conversionFromPreviousPct`
 * states for the rung, so the rate a brand is priced on and the funnel it reads on its Overview are one
 * number. NOT the intersection (leads at FROM that also reached TO): shipped that way first (v0.172.7)
 * and measured wrong in prod the same hour — brand `75d7e3e8…` has 14 booked meetings of which only 5
 * carry a positive-reply flag (bookings stated by hand or qualified without a reply classification), so
 * the intersection read reply → meeting at 21.7% against the rung's 60.9%. A producer that records the
 * later rung and misses the earlier one makes the intersection understate, silently. When TO exceeds
 * FROM the ratio is no probability: `gap: "to_exceeds_from"`, never clamped, and the next source wins.
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
  stepMeasured,
  type LeadStepField,
  type StepEvidence,
} from "./funnel-steps.js";
import { LEARNING_OUTCOMES_REQUIRED } from "./learning-phase.js";
import { SALES_FUNNELS, SALES_FUNNEL_KEYS, salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";
import { fetchBrandLegEconomics, type BrandLegEconomics, type BrandLegRate } from "./brand-leg-economics-client.js";
import { FUNNEL_STEP_LABEL_TO_KEY } from "./acquisition-channels.js";
import { median } from "./stated-economics.js";
import { mapWithConcurrency } from "./concurrency.js";
import { servedCached, buildScopeKey } from "./view-cache.js";

/** The fleet's learning bar: a measured rate needs at least this many leads on its FROM step. */
export const MIN_MEASURED_FROM_REACHED = LEARNING_OUTCOMES_REQUIRED;

export type EffectiveRateSource = "measured" | "manual" | "median";

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

export interface MeasuredArrowRate {
  /** Distinct leads that reached the FROM step. Null when that step is not counted or unreadable. */
  fromReached: number | null;
  /** Of those, the leads that ALSO reached the TO step. Same null rule. */
  toReached: number | null;
  /** `toReached ÷ fromReached × 100`. Null when either is null or `fromReached` is 0. */
  ratePct: number | null;
  /** True exactly when this measured rate is the effective one. */
  sufficient: boolean;
  /** Null when sufficient; otherwise which of the three reasons applies. */
  gap: MeasuredRateGap | null;
}

export interface EffectiveArrowRate {
  fromStep: string;
  toStep: string;
  /** The rate every money figure is priced on for this arrow, 0..100. Null when no source exists. */
  effectiveRatePct: number | null;
  /** Which source `effectiveRatePct` is. Null exactly when it is null. */
  source: EffectiveRateSource | null;
  /** Present exactly when `effectiveRatePct` is null. */
  unresolvedReason: "no_rate_available" | null;
  measured: MeasuredArrowRate;
  /** What the brand stated by hand for this arrow, or null when it has not. */
  manualRatePct: number | null;
  /** The cross-org median of what brands stated for this (funnel, arrow), over `brandCount` brands. */
  median: { ratePct: number | null; brandCount: number };
}

export interface EffectiveFunnelRates {
  funnelKey: SalesFunnelKey;
  name: string;
  steps: readonly string[];
  arrows: EffectiveArrowRate[];
}

export interface BrandEffectiveRates {
  brandId: string;
  minMeasuredFromReached: number;
  /** Distinct leads this brand has contacted — the population every measured rate is read from. */
  contactedRecipients: number;
  funnels: EffectiveFunnelRates[];
  /** Every leg of the catalogue, once — the grain a rate actually lives at. */
  legs: EffectiveArrowRate[];
}

// ── Steps and the lead flags that count them ──────────────────────────────────────────────────

const normaliseStep = (label: string): string => {
  const flat = label.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return flat === "form filled" || flat === "lead form submitted" ? "form submitted" : flat;
};

/**
 * The `leads[]` flag that says a lead REACHED a step, or null for a step nothing in the fleet counts.
 * Keyed on the step's own wording, so an arrow is measured the same way in every funnel it appears in.
 */
const STEP_LEAD_FIELD: Record<string, LeadStepField | null> = {
  "positive reply": "repliedPositive",
  "website visit": "clicked",
  "meeting booked": "meetingBooked",
  "meeting attended": "meetingAttended",
  signup: "signup",
  "form submitted": "formSubmission",
  "paid client": "purchased",
  // A checkout on the brand's own site: nothing counts it (see FUNNEL_LEG_SIGNALS).
  "direct purchase": null,
  purchase: null,
};

/**
 * The lead flag counting a step. A leg is measured the same way whichever funnel reads it: a rate is a
 * property of the (brand, leg) pair, never of a funnel, so a booked meeting becoming an attended one is
 * one measurement for the brand.
 */
function leadFieldOfStep(step: string): LeadStepField | null {
  return STEP_LEAD_FIELD[normaliseStep(step)] ?? null;
}

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

  applySignalOverlays(persons, null, observed?.byEmail ?? null, quals, pricedFunnelKeys);
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
  };
}

/**
 * The measurement reduced to what a rate reads: how many deduped leads reached each step. A measured
 * rate counts FROM and TO independently, so the per-lead rows add nothing past these counts — and the
 * counts are what the snapshot layer stores (a few dozen bytes against ~1 MB of per-lead rows).
 */
export interface BrandStepCounts {
  contactedRecipients: number;
  evidence: StepEvidence;
  reachedCounts: Record<LeadStepField, number>;
}

/** PURE: a measurement's per-step counts. Idempotent on counts already summarised. */
export function summariseMeasurement(measurement: BrandStepMeasurement | BrandStepCounts): BrandStepCounts {
  if ("reachedCounts" in measurement) return measurement;
  const fields = Object.keys(LEAD_FIELD_TO_SIGNAL) as LeadStepField[];
  const reachedCounts = Object.fromEntries(fields.map((f) => [f, 0])) as Record<LeadStepField, number>;
  for (const lead of measurement.reached) for (const f of fields) if (lead[f]) reachedCounts[f] += 1;
  return { contactedRecipients: measurement.contactedRecipients, evidence: measurement.evidence, reachedCounts };
}

/** PURE: the measured rate of one arrow over one measurement. */
export function measuredArrowRate(
  input: BrandStepMeasurement | BrandStepCounts,
  fromField: LeadStepField | null,
  toField: LeadStepField | null,
): MeasuredArrowRate {
  const measurement = summariseMeasurement(input);
  if (fromField === null || toField === null) {
    return { fromReached: null, toReached: null, ratePct: null, sufficient: false, gap: "step_not_counted" };
  }
  if (!stepMeasured(fromField, measurement.evidence) || !stepMeasured(toField, measurement.evidence)) {
    return { fromReached: null, toReached: null, ratePct: null, sufficient: false, gap: "evidence_unreadable" };
  }
  const fromReached = measurement.reachedCounts[fromField] ?? 0;
  const toReached = measurement.reachedCounts[toField] ?? 0;
  const ratePct = fromReached > 0 ? (toReached / fromReached) * 100 : null;
  // More leads at TO than at FROM: the FROM step is under-counted (a producer records the later rung
  // but not the earlier one), so the ratio is not a probability. Unmeasurable, never clamped to 100%.
  if (ratePct !== null && ratePct > 100) {
    return { fromReached, toReached, ratePct, sufficient: false, gap: "to_exceeds_from" };
  }
  const sufficient = fromReached >= MIN_MEASURED_FROM_REACHED;
  return { fromReached, toReached, ratePct, sufficient, gap: sufficient ? null : "below_learning_bar" };
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

const FLEET_MEDIAN_FRESH_MS = 15 * 60_000;
const FLEET_MEDIAN_STALE_MS = 6 * 60 * 60_000;
const FLEET_BRAND_CONCURRENCY = 8;
let fleetMedianCache: { value: FleetArrowMedians; at: number } | null = null;
let fleetMedianInFlight: Promise<FleetArrowMedians> | null = null;

/** Test seam. */
export function __resetFleetArrowMediansCache(): void {
  fleetMedianCache = null;
  fleetMedianInFlight = null;
}

async function computeFleetArrowMedians(): Promise<FleetArrowMedians> {
  // Every brand any feature has leads for, under its first claiming org — the same enumeration the
  // showcase uses, so a brand running any channel is in the population.
  const allSlugs = (await db.query.features.findMany()).map((f) => f.slug);
  const memberships = allSlugs.length > 0 ? await fetchFeatureMemberships(allSlugs.join(",")) : [];
  const orgByBrand = new Map<string, string>();
  for (const m of memberships) if (!orgByBrand.has(m.brandId)) orgByBrand.set(m.brandId, m.orgId);

  // One brand's unreadable statements cost the median ONE data point, loudly — never the whole fleet.
  const perBrand = await mapWithConcurrency([...orgByBrand.entries()], FLEET_BRAND_CONCURRENCY, ([brandId, orgId]) =>
    fetchBrandLegEconomics(brandId, orgId)
      .then((e) => e.legRates)
      .catch((err) => {
        console.warn(`[features-service] fleet conversion-rate median: brand ${brandId} (org ${orgId}) leg rates unreadable, contributes no data point: ${(err as Error).message}`);
        return [] as BrandLegRate[];
      }),
  );
  return buildFleetArrowMedians(perBrand);
}

/**
 * The fleet medians, off a single-flighted in-memory cell: fresh for 15 minutes (a median over the
 * fleet's hand-stated rates cannot visibly move faster), served stale up to 6 hours while ONE refresh
 * runs behind the read.
 */
export async function getFleetArrowMedians(): Promise<FleetArrowMedians> {
  const now = Date.now();
  const refresh = (): Promise<FleetArrowMedians> => {
    if (!fleetMedianInFlight) {
      fleetMedianInFlight = computeFleetArrowMedians()
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
    refresh().catch((err) => console.error(`[features-service] fleet conversion-rate median refresh failed (serving the last value): ${(err as Error).message}`));
    return fleetMedianCache.value;
  }
  return refresh();
}

// ── Resolution ────────────────────────────────────────────────────────────────────────────────

/** PURE: resolve one arrow from its three sources, in order. */
export function resolveArrow(
  fromStep: string,
  toStep: string,
  measured: MeasuredArrowRate,
  manualRatePct: number | null,
  medianRate: { ratePct: number | null; brandCount: number },
): EffectiveArrowRate {
  let effectiveRatePct: number | null = null;
  let source: EffectiveRateSource | null = null;
  if (measured.sufficient && measured.ratePct !== null) {
    effectiveRatePct = measured.ratePct;
    source = "measured";
  } else if (manualRatePct !== null) {
    effectiveRatePct = manualRatePct;
    source = "manual";
  } else if (medianRate.ratePct !== null) {
    effectiveRatePct = medianRate.ratePct;
    source = "median";
  }
  return {
    fromStep,
    toStep,
    effectiveRatePct,
    source,
    unresolvedReason: effectiveRatePct === null ? "no_rate_available" : null,
    measured,
    manualRatePct,
    median: medianRate,
  };
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
  const resolveLeg = (fromStep: string, toStep: string): EffectiveArrowRate => {
    const key = legPairKey(fromStep, toStep);
    const cached = legs.get(key);
    if (cached) return cached;
    const label = producerLabels.get(key) ?? { fromStep, toStep };
    const resolved = resolveArrow(
      label.fromStep,
      label.toStep,
      measuredArrowRate(measurement, leadFieldOfStep(fromStep), leadFieldOfStep(toStep)),
      manualByLeg.get(key) ?? null,
      input.medians.get(key) ?? { ratePct: null, brandCount: 0 },
    );
    legs.set(key, resolved);
    return resolved;
  };
  // Every leg of the whole catalogue is resolved, so a pricing read can walk any path from any step.
  for (const funnelKey of SALES_FUNNEL_KEYS) for (const a of funnelArrows(funnelKey)) resolveLeg(a.fromStep, a.toStep);
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
    scopeKey: buildScopeKey(brandId, { orgId, m: "funnel-step" }),
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
