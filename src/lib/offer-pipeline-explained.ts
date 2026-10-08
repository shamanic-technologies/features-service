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
 *   - COLD: lead-service's went-cold rule, exactly as served (CRM brands only; nothing re-derived). A
 *     cold lead is worth what the pipeline prices it at TODAY (`expectedValueOfPerson`, the dead-step
 *     overlay already applied), i.e. back to whatever path the cold step does not kill.
 *   - HOT: live engaged leads (any step reached, not won, not cold) the pipeline still prices above 0,
 *     ranked by that value; the top `HOT_LEADS_LIMIT` are listed, the whole set is counted and summed.
 *   - WON: paying clients on the priced causes (default: our outreach only). One organisation is one
 *     client, worth the amount stated on its sale, else the offer's lifetime revenue (the Deals board's
 *     Won rule, narrowed to the priced causes).
 *   - CONTACTED: distinct people and distinct companies contacted.
 */
import { CHANNEL_STEPS, funnelStepKeys, type ChannelStepKey } from "./acquisition-channels.js";
import { getFunnel, restrictPathsToDeclaredLegs } from "./funnel-registry.js";
import { LEAD_FIELD_TO_SIGNAL, stepMeasured, type StepEvidence } from "./funnel-steps.js";
import { legKeyFor } from "./funnel-legs.js";
import { STEP_LEAD_FIELD, type StepValue } from "./offer-outcomes.js";
import { priceOnDeclaredFunnel } from "./offer-pricing.js";
import { dedupPersonsByLead, expectedValueOfPerson, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";
import { DISPLAY_ONLY_SALES_FUNNELS, SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";
import type { ColdLeadsRead } from "./step-outcomes-client.js";
import type { MeasurementBasis } from "./effective-conversion-rates.js";

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
    legs.push({
      fromStep: { key: from, label: CHANNEL_STEPS[from].label },
      toStep: { key: to, label: CHANNEL_STEPS[to].label },
      legKey: legKeyFor({ from, to }),
      ratePct: arrow.ratePct,
      source,
      measured:
        source === "measured" && arrow.measured
          ? { basis: arrow.measured.basis, fromReached: arrow.measured.fromReached, toReached: arrow.measured.toReached }
          : null,
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

/** How many hot leads are listed (all are counted and summed). */
export const HOT_LEADS_LIMIT = 25;

const ENGAGED_SIGNALS = ["clicked", "positiveReply", "signup", "formSubmission", "meeting", "meetingAttended"] as const;

export interface PipelineLeadIdentity {
  leadId: string;
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

export interface LadderStep {
  step: { key: ChannelStepKey; label: string };
  /** Distinct leads of the offer that reached the step, every cause counted. Null = not counted / unreadable. */
  recipientsReached: number | null;
  /** Of those, the ones whose step is priced (`?cause=`, default our outreach). */
  pricedRecipientsReached: number | null;
  valuePerOutcomeUsd: number | null;
  valueExplanation: StepValueExplanation | null;
  conversionFromPrevious: StepConversion | null;
  /** Leads that reached this step and then went cold; null when who went cold could not be read. */
  wentCold: { count: number; valueUsd: number | null } | null;
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
  coldLeads: { count: number; valueUsd: number | null; leads: ColdPipelineLead[] } | null;
  hotLeads: { limit: number; totalCount: number; totalValueUsd: number; leads: PricedPipelineLead[] } | null;
  /** Why lead values (hot, cold values) are null: the offer has no priced economics. */
  leadValuesUnpricedReason: string | null;
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
  firstName: p.firstName ?? null,
  lastName: p.lastName ?? null,
  title: p.title ?? null,
  orgName: p.orgName ?? null,
  orgDomain: p.orgDomain ?? null,
  orgLogoUrl: p.orgLogoUrl ?? null,
});

const statedValue = (p: EnginePerson): number | null =>
  typeof p.valueUsd === "number" && Number.isFinite(p.valueUsd) && p.valueUsd >= 0 ? p.valueUsd : null;

/** PURE: the whole pipeline block. `values`/`explanations` are the outcome rows' own (one source). */
export function buildOfferPipeline(input: {
  persons: readonly EnginePerson[];
  evidence: StepEvidence;
  declared: readonly DeclaredSalesFunnel[];
  values: ReadonlyMap<ChannelStepKey, StepValue>;
  /** lead-service's went-cold read; null when it was unreadable or not served. */
  cold: ColdLeadsRead | null;
  sets: OfferStepSets;
}): OfferPipeline {
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
  if (input.cold) {
    const rows = [...input.cold.leads].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
    for (const row of rows) {
      const person = byLead.get(row.leadId) ?? (row.email ? byEmail.get(row.email) : undefined);
      if (!person || coldIds.has(person.leadId)) continue;
      coldIds.add(person.leadId);
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
  const ladder: LadderStep[] = LADDER_STEPS.map((step) => {
    const reached = input.sets.byStep.get(step) ?? null;
    const field = STEP_LEAD_FIELD[step];
    const signal = field ? LEAD_FIELD_TO_SIGNAL[field] : null;
    const pricedCount =
      reached && signal
        ? persons.filter((p) => reached.has(p.leadId) && !(p.unpricedSignals ?? []).includes(signal)).length
        : null;
    const value = input.values.get(step);
    return {
      step: stepWire(step),
      recipientsReached: reached ? reached.size : null,
      pricedRecipientsReached: pricedCount,
      valuePerOutcomeUsd: value?.valuePerOutcomeUsd ?? null,
      valueExplanation: explainStepValue(input.declared, step, value),
      conversionFromPrevious: reached ? stepConversion(step, reached, input.sets, priced.pricedFunnelKeys) : null,
      wentCold: input.cold
        ? { count: coldByStep.get(step)?.length ?? 0, valueUsd: sumValues(coldByStep.get(step) ?? []) }
        : null,
    };
  });

  // WON — on the priced causes; one organisation is one client, worth its best member's amount.
  const purchasedMeasured = stepMeasured("purchased", input.evidence);
  let customersWon: OfferPipeline["customersWon"] = null;
  if (purchasedMeasured) {
    const won = persons.filter((p) => p.signals.closeWin);
    const ours = won.filter((p) => !(p.unpricedSignals ?? []).includes("closeWin"));
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
  if (paths) {
    const hot: PricedPipelineLead[] = [];
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

  return {
    peopleContacted: contacted.length,
    companiesContacted: companies.size,
    contactedWithoutCompanyCount: contacted.filter((p) => !p.orgId).length,
    ladder,
    customersWon,
    coldRule: input.cold ? { applies: input.cold.applies, afterDays: input.cold.afterDays } : null,
    coldLeads: input.cold
      ? { count: coldLeads.length, valueUsd: sumValues(coldLeads), leads: coldLeads }
      : null,
    hotLeads,
    leadValuesUnpricedReason: paths ? null : (priced.economics.unpricedReason ?? "no_priced_funnel"),
  };
}
