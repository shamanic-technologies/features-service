/**
 * THE BEST CONVERSION RATE WE HAVE FOR EACH ARROW OF A BRAND'S FUNNEL — and which one it is.
 *
 * Conversion rates moved from the OFFER to the BRAND (owner decision, 2026-09-25): a brand converts
 * the way it converts whatever it is selling, so there is ONE rate per (brand, sales funnel, arrow).
 * Lifetime revenue stays per offer. Every money figure this service states — pipeline, ROI, CAC, every
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
 *   2. MANUAL — what the brand stated by hand in brand-service's brand-grain store.
 *   3. MEDIAN — the cross-org median of what OTHER brands stated for the same (funnel, arrow). Stated
 *      values only: the store has no default behind it, so a brand that stated nothing contributes
 *      nothing.
 *
 * When none of the three exists the answer is `null` with `unresolvedReason` — never a default, never
 * a 0, never borrowed from a neighbouring arrow.
 *
 * ── A RATE IS CONDITIONAL ON THE FROM STEP ──────────────────────────────────────────────────────
 *
 * The measured rate is `leads that reached FROM and TO ÷ leads that reached FROM`. A lead flag does not
 * record which path a lead took, so a raw `count(TO) ÷ count(FROM)` would credit a positive-reply →
 * meeting arrow with every meeting booked off the WEBSITE too, and can exceed 100% — a probability no
 * funnel can be priced on. Where every lead at TO also passed FROM (the ordinary case), this is the
 * byte-same figure `funnelSteps.conversionFromPreviousPct` states for the rung.
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
import { fetchBrandFunnelRates, type BrandFunnelRates } from "./brand-funnel-rates-client.js";
import { fetchDeclaredSalesFunnels, type DeclaredSalesFunnel } from "./sales-funnels-client.js";
import type { DeclaredFunnelLeg } from "./funnel-leg-rates.js";
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
  | "below_learning_bar";

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

/** The FROM step of an ad funnel's first arrow is DELIVERED by the ad platform and counted by nothing. */
function leadFieldOfStep(funnelKey: SalesFunnelKey, step: string, index: number): LeadStepField | null {
  if (index === 0 && (funnelKey === "sales_meetings_from_ads" || funnelKey === "lead_forms_from_ads")) return null;
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

/** PURE: the measured rate of one arrow over one measurement. */
export function measuredArrowRate(
  measurement: BrandStepMeasurement,
  fromField: LeadStepField | null,
  toField: LeadStepField | null,
): MeasuredArrowRate {
  if (fromField === null || toField === null) {
    return { fromReached: null, toReached: null, ratePct: null, sufficient: false, gap: "step_not_counted" };
  }
  if (!stepMeasured(fromField, measurement.evidence) || !stepMeasured(toField, measurement.evidence)) {
    return { fromReached: null, toReached: null, ratePct: null, sufficient: false, gap: "evidence_unreadable" };
  }
  let fromReached = 0;
  let toReached = 0;
  for (const lead of measurement.reached) {
    if (!lead[fromField]) continue;
    fromReached += 1;
    if (lead[toField]) toReached += 1;
  }
  const ratePct = fromReached > 0 ? (toReached / fromReached) * 100 : null;
  const sufficient = fromReached >= MIN_MEASURED_FROM_REACHED;
  return { fromReached, toReached, ratePct, sufficient, gap: sufficient ? null : "below_learning_bar" };
}

// ── MEDIAN: what the fleet stated ────────────────────────────────────────────────────────────

const arrowKey = (funnelKey: SalesFunnelKey, fromStep: string, toStep: string): string =>
  `${funnelKey}|${normaliseStep(fromStep)}|${normaliseStep(toStep)}`;

export type FleetArrowMedians = Map<string, { ratePct: number | null; brandCount: number }>;

/** PURE: the median per (funnel, arrow) over the brands that STATED it — one data point per brand. */
export function buildFleetArrowMedians(perBrand: readonly BrandFunnelRates[][]): FleetArrowMedians {
  const values = new Map<string, number[]>();
  for (const funnels of perBrand) {
    for (const funnel of funnels) {
      for (const arrow of funnel.arrows) {
        if (!arrow.stated || arrow.ratePct === null) continue;
        const key = arrowKey(funnel.funnelKey, arrow.fromStep, arrow.toStep);
        const list = values.get(key) ?? [];
        list.push(arrow.ratePct);
        values.set(key, list);
      }
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
    fetchBrandFunnelRates(brandId, orgId).catch((err) => {
      console.warn(`[features-service] fleet conversion-rate median: brand ${brandId} (org ${orgId}) statements unreadable, contributes no data point: ${(err as Error).message}`);
      return [] as BrandFunnelRates[];
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

/** PURE: every arrow of every funnel, from the three inputs. */
export function buildBrandEffectiveRates(input: {
  brandId: string;
  funnelKeys: readonly SalesFunnelKey[];
  measurement: BrandStepMeasurement;
  manual: readonly BrandFunnelRates[];
  medians: FleetArrowMedians;
}): BrandEffectiveRates {
  const manualByArrow = new Map<string, number>();
  // brand-service's OWN wording for each arrow (it owns the step vocabulary — its form rung reads
  // "Form filled" where ours reads "Form submitted"), so a consumer joins a served arrow to the
  // brand-service write without translating. Ours stands in only where brand-service names none.
  const producerLabels = new Map<string, { fromStep: string; toStep: string }>();
  for (const funnel of input.manual) {
    for (const arrow of funnel.arrows) {
      const key = arrowKey(funnel.funnelKey, arrow.fromStep, arrow.toStep);
      producerLabels.set(key, { fromStep: arrow.fromStep, toStep: arrow.toStep });
      if (arrow.stated && arrow.ratePct !== null) manualByArrow.set(key, arrow.ratePct);
    }
  }
  const funnels = [...input.funnelKeys]
    .sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b))
    .map((funnelKey): EffectiveFunnelRates => ({
      funnelKey,
      name: SALES_FUNNELS[funnelKey].name,
      steps: SALES_FUNNELS[funnelKey].steps,
      arrows: funnelArrows(funnelKey).map(({ fromStep, toStep, fromIndex }) => {
        const key = arrowKey(funnelKey, fromStep, toStep);
        const label = producerLabels.get(key) ?? { fromStep, toStep };
        return resolveArrow(
          label.fromStep,
          label.toStep,
          measuredArrowRate(
            input.measurement,
            leadFieldOfStep(funnelKey, fromStep, fromIndex),
            leadFieldOfStep(funnelKey, toStep, fromIndex + 1),
          ),
          manualByArrow.get(key) ?? null,
          input.medians.get(key) ?? { ratePct: null, brandCount: 0 },
        );
      }),
    }));
  return {
    brandId: input.brandId,
    minMeasuredFromReached: MIN_MEASURED_FROM_REACHED,
    contactedRecipients: input.measurement.contactedRecipients,
    funnels,
  };
}

/**
 * Compute a brand's effective rates live, for EVERY funnel of the catalogue — exactly the set
 * brand-service's own brand-grain read serves, so a brand deciding to sell through a new funnel finds
 * its rates already resolved. Fail-loud on the lead read and the manual read: "we could not read the
 * brand's leads" must never read as "nothing measured".
 */
export async function computeBrandEffectiveRates(brandId: string, orgId: string): Promise<BrandEffectiveRates> {
  const [measurement, manual, medians] = await Promise.all([
    // A "never" statement only marks a lead's dead legs for PRICING; which steps it reached does not
    // depend on the funnels priced, so the measurement needs none.
    measureBrandSteps(brandId, orgId, []),
    fetchBrandFunnelRates(brandId, orgId),
    getFleetArrowMedians(),
  ]);
  return buildBrandEffectiveRates({ brandId, funnelKeys: SALES_FUNNEL_KEYS, measurement, manual, medians });
}

/**
 * The brand's effective rates, served through the Gold snapshot layer: one brand-wide lead walk per
 * refresh, shared by every surface that prices this brand (and by the dashboard's read of the rates).
 */
export function getBrandEffectiveRates(brandId: string, orgId: string): Promise<BrandEffectiveRates> {
  return servedCached({
    view: "brand-effective-conversion-rates",
    scopeKey: buildScopeKey(brandId, { orgId }),
    orgId,
    compute: () => computeBrandEffectiveRates(brandId, orgId),
  });
}

// ── Pricing: the declared funnels, carried on the effective rates ─────────────────────────────

/**
 * PURE: the brand's declared funnels with every arrow replaced by its EFFECTIVE rate — the one input
 * every pricing surface reads (`declaredEconomics` → `statedLegRates`). An arrow with an effective
 * rate is marked `stated_<source>`, so it wins over the funnel's named rate exactly as a stated arrow
 * does. The named per-offer rates are DROPPED: they are the declared values this replaces, and an
 * arrow with no effective rate must read as "we have no rate" rather than resurrect one of them.
 * Lifetime revenue stays the offer's own, untouched.
 */
export function applyEffectiveRates(
  funnels: readonly DeclaredSalesFunnel[],
  rates: BrandEffectiveRates,
): DeclaredSalesFunnel[] {
  const byKey = new Map(rates.funnels.map((f) => [f.funnelKey, f]));
  return funnels.map((funnel) => {
    const effective = byKey.get(funnel.funnelKey);
    if (!effective) return funnel;
    const arrows: DeclaredFunnelLeg[] = effective.arrows.map((a) => ({
      fromStep: a.fromStep,
      toStep: a.toStep,
      ratePct: a.effectiveRatePct,
      provenance: a.source ? `stated_${a.source}` : "unstated",
      rateKey: null,
    }));
    return { ...funnel, rates: {}, arrows };
  });
}

/**
 * The brand's declared funnels as every PRICING surface must read them: the offer's lifetime revenue,
 * on the brand's EFFECTIVE rates. Throws exactly as the declared read does (an unreadable or several-
 * offer declaration is the caller's to handle, unchanged). If the effective rates themselves cannot be
 * resolved, the declared funnels are returned as they were — the pre-effective answer, a real one — and
 * the failure is logged loud rather than 502-ing a page whose every other figure is right.
 */
export async function fetchDeclaredFunnelsOnEffectiveRates(
  brandId: string,
  orgId: string,
  offerId?: string | null,
): Promise<DeclaredSalesFunnel[]> {
  const declared = await fetchDeclaredSalesFunnels(brandId, orgId, offerId);
  try {
    return applyEffectiveRates(declared, await getBrandEffectiveRates(brandId, orgId));
  } catch (error) {
    console.error(
      `[features-service] effective conversion rates unavailable for brand ${brandId} (org ${orgId}); pricing on the declared rates: ${(error as Error).message}`,
    );
    return declared;
  }
}
