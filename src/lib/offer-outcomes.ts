/**
 * WHAT AN OFFER BUYS, ONE ROW PER OUTCOME — and, under each outcome, every leg × channel serving it.
 *
 * The product is retiring the sales funnel as an identity. A campaign is (offer × LEG × channel): a
 * channel of ours takes a lead sitting at one step and moves it to the next. An OUTCOME is a step at
 * least one of our channels lands a leg on — it is derived here from the campaigns the offer actually
 * runs, never stored. A customer reading an offer asks, per outcome, "what did I get and what did it
 * cost": that is the question this module answers.
 *
 * ── WHY THE FUNNEL READS COULD NOT ANSWER IT ────────────────────────────────────────────────────
 *
 * `funnelSteps` answers per FUNNEL. The same leg (nothing → Website visit) lives inside several
 * funnels, so the same people reach the same step through each of them, and summing two funnels'
 * "Website visit" rungs counts a lead twice. Only this service holds the per-lead sets, so the union is
 * taken here: an outcome's count is DISTINCT LEADS, always ≤ the sum of the funnel rungs it replaces.
 *
 * ── THE FIVE FIGURES, AND THE BASIS EACH ONE RIDES ──────────────────────────────────────────────
 *
 *   recipientsReached   distinct leads that reached the step. Every cause is COUNTED (the owner's rule:
 *                       count every conversion, price only ours). Whole history. 0 is measured, null is
 *                       "we could not read the producer behind this step".
 *   spentUsd            COMMITTED spend of the campaigns whose leg LANDS on this step — the one basis
 *                       every money figure here rides. A campaign carries exactly one leg, so this adds
 *                       across the legs of one outcome with nothing counted twice. Whole history.
 *   costPerOutcomeUsd   spentUsd ÷ recipientsReached — OBSERVED, never floored; null at 0 of either.
 *                       For an offer whose one funnel has one entry leg this is byte the funnel rung's
 *                       `costPerReachCents` (same persons, same committed cents), which is the AC.
 *   valuePerOutcomeUsd  what REACHING the step is worth: P(paid client | reached it) × lifetime revenue,
 *                       taken as the BEST PATH (max) across the offer's declared funnels that contain the
 *                       step — the same max-per-signal rule the revenue engine and the audience return
 *                       price with. A rate the brand never declared leaves it null, never 0.
 *   valueUsd            PRICED outcomes × valuePerOutcomeUsd — only the outcomes we caused are priced
 *                       (`?cause=`, default `outreach`), as on every other money surface.
 *   roiMultiple         value ÷ spend on the MATURE COHORT (`lib/roi-maturity.ts`): a campaign on a
 *                       fourteen-day leg counts only the spend of runs started before the cutoff and the
 *                       leads first contacted before it. `maturing` when nothing spent is mature yet.
 *
 * ── WHAT DOES NOT ADD ───────────────────────────────────────────────────────────────────────────
 *
 * Rows are NOT additive across outcomes: one lead that replied and then booked a meeting is in both the
 * Positive-reply row and the Meeting-booked row, and each row's value is the value of STANDING on that
 * step, which the next step's value already contains. Same property channels and offers carry.
 *
 * ── WHICH LEGS APPEAR ───────────────────────────────────────────────────────────────────────────
 *
 * Only legs a channel of OURS performs. A campaign on a customer-operated channel is hidden (its id
 * rides `hiddenCampaignIds`, never dropped in silence). A campaign stating no leg is placed on the one
 * leg its channel performs inside the funnel it states, when there is exactly one (`legSource:
 * "derived_from_funnel"`); otherwise it is in `unattributedCampaignIds`.
 */
import { funnelStepKeys, CHANNEL_STEPS, CHANNEL_STEP_KEYS, type AcquisitionChannel, type ChannelStepKey } from "./acquisition-channels.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";
import { observedCostPerOutcome } from "./cost-engine.js";
import { declaredEconomicsForFunnel, mergeFunnelEconomics } from "./declared-funnels.js";
import { funnelLeg, legKeyFor, legKeysOfFunnel, matchFunnelLegKey } from "./funnel-legs.js";
import { getFunnel, type SalesEconomics } from "./funnel-registry.js";
import { LEAD_FIELD_TO_SIGNAL, stepMeasured, type LeadStepField, type StepEvidence } from "./funnel-steps.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";
import { matchSalesFunnelKey, type SalesFunnelKey } from "./sales-funnels.js";

/** The `leads[]` field each step is counted by. `purchase` has no signal anywhere in the fleet. */
export const STEP_LEAD_FIELD: Record<ChannelStepKey, LeadStepField | null> = {
  conversation: "repliedPositive",
  website_visit: "clicked",
  meeting_booked: "meetingBooked",
  meeting_attended: "meetingAttended",
  signup: "signup",
  form_submitted: "formSubmission",
  purchase: null,
  paid_client: "purchased",
};

/** How a campaign's leg was known. */
export type LegSource = "stated" | "derived_from_funnel";

/** One (leg × channel) of the offer, and the campaigns carrying it. */
export interface OfferLegGroup {
  legKey: string;
  fromStep: ChannelStepKey | null;
  toStep: ChannelStepKey;
  featureSlug: string;
  campaignIds: string[];
  /** `derived_from_funnel` when ANY member's leg was derived rather than stated. */
  legSource: LegSource;
}

export interface OfferLegPartition {
  groups: OfferLegGroup[];
  /** Campaigns of the offer whose leg we could not know. Their spend is in no outcome row. */
  unattributedCampaignIds: string[];
  /** Campaigns of the offer on a channel the CUSTOMER operates — hidden from the outcome rows. */
  hiddenCampaignIds: string[];
}

/**
 * PURE: partition ONE offer's campaign rows by (leg × channel). `channelOf` answers the catalogue for a
 * feature slug (`null` = not an acquisition channel this service describes).
 */
export function buildOfferLegPartition(
  rows: readonly CampaignIdentityRow[],
  offerId: string,
  channelOf: (featureSlug: string) => AcquisitionChannel | null,
): OfferLegPartition {
  const byGroup = new Map<string, OfferLegGroup>();
  const unattributed: string[] = [];
  const hidden: string[] = [];

  for (const row of rows) {
    if (!row.id || row.offerId !== offerId || !row.featureSlug) continue;
    const channel = channelOf(row.featureSlug);
    if (channel?.operatedBy === "customer") {
      hidden.push(row.id);
      continue;
    }

    let legKey: string | null = null;
    let source: LegSource = "stated";
    if (row.legKey) {
      legKey = matchFunnelLegKey(row.legKey);
    } else {
      // A pre-leg ancestor: the funnel it states names the ONE leg its channel performs inside it, when
      // there is exactly one. Two candidates would be a guess, so the row stays unattributed instead.
      const funnelKey = row.funnelKey ? matchSalesFunnelKey(row.funnelKey) : null;
      if (funnelKey && channel) {
        const inFunnel = new Set(legKeysOfFunnel(funnelKey));
        const candidates = [...new Set(channel.stepTransitions.map(legKeyFor))].filter((k) => inFunnel.has(k));
        if (candidates.length === 1) {
          legKey = candidates[0];
          source = "derived_from_funnel";
        }
      }
    }
    const leg = legKey ? funnelLeg(legKey) : null;
    if (!legKey || !leg) {
      unattributed.push(row.id);
      continue;
    }

    const id = `${legKey}|${row.featureSlug}`;
    const existing = byGroup.get(id);
    if (existing) {
      existing.campaignIds.push(row.id);
      if (source === "derived_from_funnel") existing.legSource = source;
    } else {
      byGroup.set(id, {
        legKey,
        fromStep: (leg.fromStep?.key as ChannelStepKey | undefined) ?? null,
        toStep: leg.toStep.key as ChannelStepKey,
        featureSlug: row.featureSlug,
        campaignIds: [row.id],
        legSource: source,
      });
    }
  }

  const groups = [...byGroup.values()]
    .map((g) => ({ ...g, campaignIds: [...g.campaignIds].sort() }))
    .sort((a, b) => stepOrder(a.toStep) - stepOrder(b.toStep) || cmp(a.legKey, b.legKey) || cmp(a.featureSlug, b.featureSlug));
  return { groups, unattributedCampaignIds: unattributed.sort(), hiddenCampaignIds: hidden.sort() };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const stepOrder = (s: ChannelStepKey): number => (CHANNEL_STEP_KEYS as readonly string[]).indexOf(s);

/** What reaching a step is worth, and through which declared funnel that best value was found. */
export interface StepValue {
  valuePerOutcomeUsd: number;
  basisFunnelKey: SalesFunnelKey;
}

/**
 * PURE: the value of standing on each step — BEST PATH (max) over the offer's declared funnels that
 * contain it, each priced on its OWN declared terms merged over the brand's effective economics (the
 * merge every funnel-narrowed read uses). Absent from the map ⇒ no declared funnel prices that step.
 */
export function stepValues(
  declared: readonly DeclaredSalesFunnel[],
  brandEconomics: SalesEconomics | null,
): Map<ChannelStepKey, StepValue> {
  const out = new Map<ChannelStepKey, StepValue>();
  if (!brandEconomics) return out;
  const engine = getFunnel("sales-cold-email-outreach");
  if (!engine) throw new Error("[features-service] the sales funnel engine is not registered");
  for (const funnel of declared) {
    const economics = mergeFunnelEconomics(brandEconomics, declaredEconomicsForFunnel([...declared], funnel.funnelKey));
    if (!economics) continue;
    const paths = engine.resolvePaths({ economics, pricedFunnelKeys: [funnel.funnelKey] });
    for (const step of new Set(funnelStepKeys(funnel.funnelKey))) {
      const field = STEP_LEAD_FIELD[step];
      if (!field) continue;
      const signal = LEAD_FIELD_TO_SIGNAL[field];
      const path = paths.find((p) => p.signal === signal);
      if (!path || !Number.isFinite(path.expectedRevenueUsd)) continue;
      const current = out.get(step);
      if (!current || path.expectedRevenueUsd > current.valuePerOutcomeUsd) {
        out.set(step, { valuePerOutcomeUsd: path.expectedRevenueUsd, basisFunnelKey: funnel.funnelKey });
      }
    }
  }
  return out;
}

/** Why a row's return is null. */
export type OutcomeUnmeasuredReason =
  | "step_not_counted"
  | "evidence_unreadable"
  | "no_value_defined"
  | "nothing_spent"
  | "maturing";

/** The five figures, stated identically on an outcome row and on each of its legs. */
export interface OutcomeFigures {
  recipientsReached: number | null;
  spentUsd: number;
  costPerOutcomeUsd: number | null;
  valuePerOutcomeUsd: number | null;
  valueUsd: number | null;
  roiMultiple: number | null;
  unmeasuredReason: OutcomeUnmeasuredReason | null;
}

/** The per-group inputs the route read. Cents are COMMITTED, on the request's pricing basis. */
export interface GroupSpend {
  committedCents: number;
  /** Committed cents of runs STARTED before the cutoff; equals `committedCents` for a zero-delay leg. */
  matureCommittedCents: number;
  /** UTC-midnight cutoff for a delayed leg, null for a zero-delay one. */
  cutoffIso: string | null;
}

export interface OfferOutcomeLeg extends OutcomeFigures {
  legKey: string;
  fromStep: { key: ChannelStepKey; label: string } | null;
  toStep: { key: ChannelStepKey; label: string };
  featureSlug: string;
  channelName: string;
  campaignIds: string[];
  legSource: LegSource;
  /**
   * `campaign_leads` — an ENTRY leg counts the leads its own campaigns reached the step with.
   * `leg_crossings` — an INTERNAL leg's campaigns serve no lead of their own (they act on leads another
   * campaign found), so it counts the offer's leads that stood on its FROM step and reached its TO step.
   * Two channels performing the same internal leg therefore read the same count.
   */
  countBasis: "campaign_leads" | "leg_crossings";
}

export interface OfferOutcomeRow extends OutcomeFigures {
  step: { key: ChannelStepKey; label: string; description: string };
  /** The declared funnel the best value was found through, or null when none prices the step. */
  valueBasisFunnelKey: SalesFunnelKey | null;
  legs: OfferOutcomeLeg[];
}

interface ReachedSets {
  measured: boolean;
  /** True when the step (or the leg's FROM step) has no signal anywhere in the fleet. */
  notCounted: boolean;
  all: Set<string>;
  priced: Set<string>;
  maturePriced: Set<string>;
}

function reachedByGroup(
  group: OfferLegGroup,
  persons: readonly EnginePerson[],
  evidence: StepEvidence,
  cutoffIso: string | null,
): ReachedSets {
  const toField = STEP_LEAD_FIELD[group.toStep];
  const fromField = group.fromStep ? STEP_LEAD_FIELD[group.fromStep] : null;
  const empty = { all: new Set<string>(), priced: new Set<string>(), maturePriced: new Set<string>() };
  if (!toField || (group.fromStep && !fromField)) return { measured: false, notCounted: true, ...empty };
  if (!stepMeasured(toField, evidence) || (fromField && !stepMeasured(fromField, evidence))) {
    return { measured: false, notCounted: false, ...empty };
  }
  const toSignal = LEAD_FIELD_TO_SIGNAL[toField];
  const fromSignal = fromField ? LEAD_FIELD_TO_SIGNAL[fromField] : null;
  const ids = new Set(group.campaignIds);
  // An entry leg's people are its own campaigns' leads; an internal leg acts on the offer's whole
  // population (its campaigns serve no lead of their own).
  const rows = group.fromStep === null ? persons.filter((p) => p.campaignId && ids.has(p.campaignId)) : [...persons];
  const isMature = (p: EnginePerson): boolean => {
    if (!cutoffIso) return true;
    const contacted = p.signalDates?.contacted ?? null;
    return !contacted || contacted < cutoffIso;
  };
  const out = { measured: true, notCounted: false, ...empty };
  const matureIds = new Set(dedupPersonsByLead(rows.filter(isMature)).map((p) => p.leadId));
  for (const p of dedupPersonsByLead(rows)) {
    if (!p.signals[toSignal]) continue;
    if (fromSignal && !p.signals[fromSignal]) continue;
    out.all.add(p.leadId);
    const priced = !(p.unpricedSignals ?? []).includes(toSignal);
    if (priced) {
      out.priced.add(p.leadId);
      if (matureIds.has(p.leadId)) out.maturePriced.add(p.leadId);
    }
  }
  return out;
}

function figures(
  reached: ReachedSets,
  spend: { committedCents: number; matureCommittedCents: number },
  value: StepValue | undefined,
): OutcomeFigures {
  const count = reached.measured ? reached.all.size : null;
  const unit = value?.valuePerOutcomeUsd ?? null;
  const cost = count === null ? null : observedCostPerOutcome(spend.committedCents, count);
  let roi: number | null = null;
  let reason: OutcomeUnmeasuredReason | null = null;
  if (reached.notCounted) reason = "step_not_counted";
  else if (!reached.measured) reason = "evidence_unreadable";
  else if (unit === null) reason = "no_value_defined";
  else if (spend.committedCents <= 0) reason = "nothing_spent";
  else if (spend.matureCommittedCents <= 0) reason = "maturing";
  else roi = (reached.maturePriced.size * unit * 100) / spend.matureCommittedCents;
  return {
    recipientsReached: count,
    spentUsd: spend.committedCents / 100,
    costPerOutcomeUsd: cost === null ? null : cost / 100,
    valuePerOutcomeUsd: unit,
    valueUsd: reached.measured && unit !== null ? reached.priced.size * unit : null,
    roiMultiple: roi,
    unmeasuredReason: reason,
  };
}

const stepWire = (key: ChannelStepKey) => ({ key, label: CHANNEL_STEPS[key].label });

/**
 * PURE: assemble the outcome rows from the partition, the offer's overlaid persons, each group's spend
 * and the step values. One row per step a leg lands on, in the catalogue's step order.
 */
export function assembleOfferOutcomes(input: {
  groups: readonly OfferLegGroup[];
  persons: readonly EnginePerson[];
  evidence: StepEvidence;
  spendByGroup: ReadonlyMap<OfferLegGroup, GroupSpend>;
  values: ReadonlyMap<ChannelStepKey, StepValue>;
  channelName: (featureSlug: string) => string;
}): OfferOutcomeRow[] {
  const byStep = new Map<ChannelStepKey, OfferLegGroup[]>();
  for (const g of input.groups) {
    const list = byStep.get(g.toStep);
    if (list) list.push(g);
    else byStep.set(g.toStep, [g]);
  }

  const rows: OfferOutcomeRow[] = [];
  for (const step of CHANNEL_STEP_KEYS) {
    const groups = byStep.get(step);
    if (!groups) continue;
    const value = input.values.get(step);
    const union: ReachedSets = { measured: true, notCounted: false, all: new Set(), priced: new Set(), maturePriced: new Set() };
    const total = { committedCents: 0, matureCommittedCents: 0 };
    const legs: OfferOutcomeLeg[] = [];
    for (const group of groups) {
      const spend = input.spendByGroup.get(group);
      if (!spend) throw new Error(`[features-service] no spend read for leg ${group.legKey} on ${group.featureSlug}`);
      const reached = reachedByGroup(group, input.persons, input.evidence, spend.cutoffIso);
      if (!reached.measured) union.measured = false;
      if (reached.notCounted) union.notCounted = true;
      for (const id of reached.all) union.all.add(id);
      for (const id of reached.priced) union.priced.add(id);
      for (const id of reached.maturePriced) union.maturePriced.add(id);
      total.committedCents += spend.committedCents;
      total.matureCommittedCents += spend.matureCommittedCents;
      legs.push({
        legKey: group.legKey,
        fromStep: group.fromStep ? stepWire(group.fromStep) : null,
        toStep: stepWire(group.toStep),
        featureSlug: group.featureSlug,
        channelName: input.channelName(group.featureSlug),
        campaignIds: group.campaignIds,
        legSource: group.legSource,
        countBasis: group.fromStep === null ? "campaign_leads" : "leg_crossings",
        ...figures(reached, spend, value),
      });
    }
    rows.push({
      step: { ...CHANNEL_STEPS[step] },
      valueBasisFunnelKey: value?.basisFunnelKey ?? null,
      ...figures(union, total, value),
      legs,
    });
  }
  return rows;
}
