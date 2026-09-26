/**
 * WAVE C4, PRODUCER HALF — the four funnel-keyed PUBLIC reads, re-stated per OUTCOME and per LEG.
 *
 * The fleet retired the sales funnel as an identity (org > brand > offer > outcome > leg). This service
 * is the last place the word survives, on public identity-free reads that customer-facing surfaces
 * consume. A consumer must be able to ask every question those reads answer WITHOUT naming a funnel, so
 * each one gets a twin keyed on the fleet's own vocabulary:
 *
 *   /public/stats/showcase-funnels          → /public/stats/showcase-outcomes
 *   /public/channel-funnel-economics        → /public/channel-outcome-economics  (PROJECTED)
 *   /public/stats/funnel-return-on-spend    → /public/stats/outcome-return-on-spend  (REALIZED)
 *   /public/channels `funnels[]` / `salesFunnels` → /public/channel-outcome-economics `outcomes[]` /
 *                                               `legs[]` / `paths[]` (+ the channel's own terms)
 *
 * NOTHING HERE IS A NEW COMPUTATION. Every figure is PROJECTED out of a value the funnel-keyed read
 * already computes, off the same warm, the same snapshot or the same cache: an outcome row is the
 * funnel rungs that land on that step, a leg row is the rung that leg moves a lead onto, a path is the
 * pair row under its LEG keys instead of its funnel key. So the two vocabularies cannot disagree, and a
 * brand (or a channel) that sells ONE path reads the byte-same numbers under both.
 *
 * WHERE SEVERAL PATHS REACH ONE OUTCOME the BEST one answers — the cheapest price for a projected
 * cost, the highest return — which is the engine's own best-path rule (a lead converts through
 * whichever of the brand's paths pays best). Every path is still listed beside it, so nothing is hidden
 * and nothing is blended.
 *
 * NOTHING FALLS BACK TO A FUNNEL. A figure that cannot be stated is `null` with a NAMED reason, never
 * 0 and never the funnel-keyed row's value borrowed under an outcome's name.
 */

import { CHANNEL_STEPS, CHANNEL_STEP_KEYS, FUNNEL_STEP_LABEL_TO_KEY, type ChannelStepKey } from "./acquisition-channels.js";
import type { ChannelStepDefWire, PublicChannel } from "./channel-catalogue.js";
import type { PairResult, PairUnmeasuredReason, StepUnpricedReason } from "./channel-funnel-economics.js";
import { buildFunnelReturnOnSpend, type FunnelReturnOnSpend, MIN_FUNNEL_RETURN_BRANDS } from "./fleet-funnel-return.js";
import type { BrandReturnRow } from "./fleet-return-on-spend.js";
import { funnelLeg, legKeysOfFunnel } from "./funnel-legs.js";
import type { SalesFunnelKey } from "./sales-funnels.js";
import {
  SHOWCASE_CONTACTED_KEY,
  SHOWCASE_CONTACTED_LABEL,
  type ShowcaseBrandFunnels,
  type ShowcaseFunnelsPayload,
  type ShowcaseGroup,
} from "./showcase-funnels.js";

const stepWire = (key: ChannelStepKey): ChannelStepDefWire => ({ ...CHANNEL_STEPS[key] });
const stepOrder = (key: ChannelStepKey): number => CHANNEL_STEP_KEYS.indexOf(key);

/** The step a leg moves a lead ONTO, or null when the key names no leg of the catalogue. */
function toStepOfLeg(legKey: string): ChannelStepKey | null {
  return (funnelLeg(legKey)?.toStep.key as ChannelStepKey | undefined) ?? null;
}

// ── 1. PROJECTED channel economics, per outcome and per leg ─────────────────────────────────────────

/** The fields of one funnel-keyed pair row this projection reads. Kept structural so the route owns
 *  its own row type and this module never imports a route. */
export interface ChannelPairInput {
  funnelKey: SalesFunnelKey;
  effectiveMinimumCommitmentDays: number;
  result: PairResult;
}

/** Why an outcome / leg / path has no projected price. The pair-level reasons (nothing spent, the
 *  entry step never produced or not measured, no economics stated) and the step-level ones (a rate not
 *  stated, a rate of 0) — the SAME vocabulary the funnel-keyed read uses, so a consumer migrates
 *  without a translation table. */
export type OutcomeUnpricedReason = PairUnmeasuredReason | StepUnpricedReason;

export interface PricedPathStep {
  step: ChannelStepDefWire;
  /** The leg that moves a lead onto this step on this path. */
  legKey: string;
  costPerOutcomeUsd: number | null;
  unpricedReason: OutcomeUnpricedReason | null;
}

/** One way this channel's legs chain to a paying client — the pair row, named by its LEGS. */
export interface ChannelOutcomePath {
  /** The path's legs, first to last. Its identity; a consumer never needs a funnel key to name it. */
  legKeys: string[];
  measured: boolean;
  unmeasuredReason: PairUnmeasuredReason | null;
  /** Every step of the path, in order, each priced or explicitly unpriced. */
  steps: PricedPathStep[];
  /** What one PAYING CLIENT costs through this path (the pair's `costPerSaleUsd`). */
  costPerPaidClientUsd: number | null;
  /** PROJECTED — `lifetimeRevenueUsd / costPerPaidClientUsd`. Never a realized return. */
  returnPerDollar: number | null;
  lifetimeRevenueUsd: number | null;
  /** Brands whose stated economics backed this path's rates. */
  statedBrandCount: number | null;
  effectiveMinimumCommitmentDays: number;
}

/** One candidate price for an outcome or a leg: which path, and what it said. */
interface Candidate {
  legKeys: string[];
  cost: number | null;
  reason: OutcomeUnpricedReason | null;
}

export interface ChannelOutcomeRow {
  step: ChannelStepDefWire;
  /** True when THIS channel performs a leg landing on the step (it produces it, or converts onto it). */
  landedByChannel: boolean;
  /** PROJECTED — the cheapest path's price for reaching this step. Null when no path prices it. */
  costPerOutcomeUsd: number | null;
  /** Present exactly when `costPerOutcomeUsd` is null — the reason of the first path in catalogue order. */
  unpricedReason: OutcomeUnpricedReason | null;
  /** The legs of the path the price was taken from (null when unpriced). */
  pricedThroughLegKeys: string[] | null;
  /** Every path reaching this step, each with its own price. They OVERLAP and must never be summed. */
  paths: Array<{ legKeys: string[]; costPerOutcomeUsd: number | null; unpricedReason: OutcomeUnpricedReason | null }>;
}

export interface ChannelLegRow {
  legKey: string;
  fromStep: ChannelStepDefWire | null;
  toStep: ChannelStepDefWire;
  /** True when THIS channel performs the leg. */
  performedByChannel: boolean;
  /** PROJECTED — what landing a lead on this leg's step costs, cheapest path containing the leg. */
  costPerOutcomeUsd: number | null;
  unpricedReason: OutcomeUnpricedReason | null;
}

export interface ChannelOutcomeEconomics {
  channelSlug: string;
  channelName: string;
  /** Every step the channel's paths reach, in the step vocabulary's order. */
  outcomes: ChannelOutcomeRow[];
  /** Every leg of those paths. */
  legs: ChannelLegRow[];
  /** The pair rows, named by legs. One per path, in catalogue order. */
  paths: ChannelOutcomePath[];
  /** PROJECTED — the best path's return per dollar. Null when no path states one. */
  returnPerDollar: number | null;
  /** The legs of the path that return was taken from. */
  returnPathLegKeys: string[] | null;
  /** The channel-wide evidence every path's prices ride on. Null when no path was measured. */
  evidence: { totalSpentUsd: number; conversationsProduced: number; websiteVisitsProduced: number } | null;
  /** The longest run a buyer of any of these paths commits to. Null when the channel has no path. */
  effectiveMinimumCommitmentDays: number | null;
}

function pickCheapest(candidates: Candidate[]): { cost: number | null; reason: OutcomeUnpricedReason | null; legKeys: string[] | null } {
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (c.cost == null) continue;
    if (best === null || c.cost < (best.cost as number)) best = c;
  }
  if (best) return { cost: best.cost, reason: null, legKeys: best.legKeys };
  return { cost: null, reason: candidates[0]?.reason ?? null, legKeys: null };
}

/** PURE: one channel's funnel-keyed pair rows → its per-outcome / per-leg / per-path answer. */
export function channelOutcomeEconomicsOf(channel: PublicChannel, pairs: readonly ChannelPairInput[]): ChannelOutcomeEconomics {
  const performed = new Set(channel.stepTransitions.map((t) => t.legKey));
  const landed = new Set(channel.stepTransitions.map((t) => t.to.key));

  const paths: ChannelOutcomePath[] = pairs.map((pair) => {
    const legKeys = legKeysOfFunnel(pair.funnelKey);
    const r = pair.result;
    const steps: PricedPathStep[] = legKeys.map((legKey, i) => {
      const stepKey = toStepOfLeg(legKey) as ChannelStepKey;
      if (!r.measured) return { step: stepWire(stepKey), legKey, costPerOutcomeUsd: null, unpricedReason: r.reason };
      const priced = r.economics.steps[i];
      // The pair walks the same labels in the same order; a mismatch means the two catalogues drifted.
      if (!priced || FUNNEL_STEP_LABEL_TO_KEY[priced.step] !== stepKey) {
        throw new Error(`channel-outcome economics: ${pair.funnelKey} step ${i} does not match leg ${legKey}`);
      }
      return { step: stepWire(stepKey), legKey, costPerOutcomeUsd: priced.costPerStepUsd, unpricedReason: priced.unpricedReason };
    });
    return {
      legKeys,
      measured: r.measured,
      unmeasuredReason: r.measured ? null : r.reason,
      steps,
      costPerPaidClientUsd: r.measured ? r.economics.costPerSaleUsd : null,
      returnPerDollar: r.measured ? r.economics.returnPerDollar : null,
      lifetimeRevenueUsd: r.measured ? r.economics.lifetimeRevenueUsd : null,
      statedBrandCount: r.measured ? r.economics.evidence.brandCount : null,
      effectiveMinimumCommitmentDays: pair.effectiveMinimumCommitmentDays,
    };
  });

  const byStep = new Map<ChannelStepKey, Candidate[]>();
  const byLeg = new Map<string, Candidate[]>();
  for (const path of paths) {
    for (const s of path.steps) {
      const c: Candidate = { legKeys: path.legKeys, cost: s.costPerOutcomeUsd, reason: s.unpricedReason };
      const key = s.step.key as ChannelStepKey;
      byStep.set(key, [...(byStep.get(key) ?? []), c]);
      byLeg.set(s.legKey, [...(byLeg.get(s.legKey) ?? []), c]);
    }
  }

  const outcomes: ChannelOutcomeRow[] = [...byStep.entries()]
    .sort(([a], [b]) => stepOrder(a) - stepOrder(b))
    .map(([key, candidates]) => {
      const best = pickCheapest(candidates);
      return {
        step: stepWire(key),
        landedByChannel: landed.has(key),
        costPerOutcomeUsd: best.cost,
        unpricedReason: best.reason,
        pricedThroughLegKeys: best.legKeys,
        paths: candidates.map((c) => ({ legKeys: c.legKeys, costPerOutcomeUsd: c.cost, unpricedReason: c.reason })),
      };
    });

  const legs: ChannelLegRow[] = [...byLeg.entries()].map(([legKey, candidates]) => {
    const def = funnelLeg(legKey);
    if (!def) throw new Error(`channel-outcome economics: unknown leg ${legKey}`);
    const best = pickCheapest(candidates);
    return {
      legKey,
      fromStep: def.fromStep ? { ...def.fromStep } : null,
      toStep: { ...def.toStep },
      performedByChannel: performed.has(legKey),
      costPerOutcomeUsd: best.cost,
      unpricedReason: best.reason,
    };
  });

  let bestReturn: ChannelOutcomePath | null = null;
  for (const p of paths) {
    if (p.returnPerDollar == null) continue;
    if (bestReturn === null || p.returnPerDollar > (bestReturn.returnPerDollar as number)) bestReturn = p;
  }
  const measuredPair = pairs.find((p) => p.result.measured);
  const evidence =
    measuredPair && measuredPair.result.measured
      ? {
          totalSpentUsd: measuredPair.result.economics.evidence.totalSpentUsd,
          conversationsProduced: measuredPair.result.economics.evidence.conversationsProduced,
          websiteVisitsProduced: measuredPair.result.economics.evidence.websiteVisitsProduced,
        }
      : null;

  return {
    channelSlug: channel.slug,
    channelName: channel.name,
    outcomes,
    legs,
    paths,
    returnPerDollar: bestReturn?.returnPerDollar ?? null,
    returnPathLegKeys: bestReturn?.legKeys ?? null,
    evidence,
    effectiveMinimumCommitmentDays:
      pairs.length === 0 ? null : Math.max(...pairs.map((p) => p.effectiveMinimumCommitmentDays)),
  };
}

// ── 2. REALIZED return on spend, per (channel × leg) and per (channel × outcome) ───────────────────

/** Why a realized per-leg / per-outcome median is not stated. */
export type OutcomeReturnUnmeasuredReason =
  | "no_snapshot_yet"
  /** A snapshot exists but was written before brand legs were recorded; the next warm fills them in. */
  | "legs_not_recorded_yet"
  | "not_enough_brands";

export interface OutcomeReturnFigures extends Omit<FunnelReturnOnSpend, "reason"> {
  reason: OutcomeReturnUnmeasuredReason | null;
}

/**
 * PURE: the median REALIZED return over the brands whose campaigns on this channel perform one of
 * `legKeys`. Each brand's figure is its CHANNEL-WIDE return (mature pipeline ÷ mature committed
 * spend, net) — a campaign is bought for one leg, and the dollar it spent bought the channel's
 * outreach whichever leg it was bought for. A brand that sells ONE path is the byte-same row the
 * funnel-keyed read takes its median over (that read REUSES the channel pass for such a brand).
 */
export function buildOutcomeReturnOnSpend(
  rows: readonly BrandReturnRow[] | null,
  legKeys: ReadonlySet<string>,
  minSpendUsd: number,
): OutcomeReturnFigures {
  if (rows !== null && rows.length > 0 && rows.every((r) => r.legKeys === undefined)) {
    const empty = buildFunnelReturnOnSpend([], minSpendUsd, MIN_FUNNEL_RETURN_BRANDS);
    return { ...empty, reason: "legs_not_recorded_yet" };
  }
  const population =
    rows === null
      ? null
      : rows
          .filter((r) => (r.legKeys ?? []).some((k) => legKeys.has(k)))
          .map((r) => ({
            brandId: r.brandId,
            committedSpendUsd: r.committedSpendUsd,
            expectedPipelineUsd: r.expectedPipelineUsd,
            expectedPaidClients: r.expectedPaidClients ?? null,
          }));
  return buildFunnelReturnOnSpend(population, minSpendUsd, MIN_FUNNEL_RETURN_BRANDS);
}

// ── 3. The homepage showcase, per outcome ───────────────────────────────────────────────────────────

export interface ShowcaseOutcome {
  /** A step of the shared vocabulary, or `contacted` for the outreach base. */
  key: ChannelStepKey | typeof SHOWCASE_CONTACTED_KEY;
  label: string;
  /** The legs landing on this step on the paths the brand sells (empty for the outreach base). */
  legKeys: string[];
  /** DISTINCT people who reached the step. `0` is measured; `null` is "we have no figure". */
  peopleReached: number | null;
  /** Committed NET spend ÷ people reached, in dollars. OBSERVED; `null` when there is no denominator. */
  costPerReachUsd: number | null;
}

export type ShowcaseOutcomeUnmeasuredReason =
  | "brand_has_no_channels"
  /** The brand's campaigns perform no leg, so no outcome can be named. */
  | "no_leg_performed"
  | "no_lead_membership"
  | "read_failed";

export interface ShowcaseBrandOutcomes {
  brand: { id: string; name: string | null; domain: string | null };
  outcomes: ShowcaseOutcome[];
  /**
   * REALIZED — what a dollar came back as for this client, across every path it sells: the brand's
   * own `costEconomics.roiMultiple` (net), the figure on its own dashboard. For a brand that sells ONE
   * path it IS that path's `returnPerDollar` on the funnel-keyed read. Null = could not measure.
   */
  returnPerDollar: number | null;
  measured: boolean;
  unmeasuredReason: ShowcaseOutcomeUnmeasuredReason | null;
}

export interface ShowcaseOutcomeGroup extends Omit<ShowcaseGroup, "brands"> {
  brands: ShowcaseBrandOutcomes[];
}

export interface ShowcaseOutcomesPayload {
  brands: ShowcaseBrandOutcomes[];
  groups: { recentlyStarted: ShowcaseOutcomeGroup; highestReturn: ShowcaseOutcomeGroup };
  minSpendUsd: number;
}

/**
 * PURE: one showcase brand's walked chains → its outcomes.
 *
 * A rung's count is the brand's DISTINCT leads carrying that step's flag, and its cost divides the
 * brand's whole committed spend — neither depends on which path the rung was walked on, so two paths
 * that reach one step state the same figures. They are merged by step, the legs landing on it listed.
 */
export function showcaseOutcomesOf(entry: ShowcaseBrandFunnels, brandReturnPerDollar: number | null): ShowcaseBrandOutcomes {
  const reason: ShowcaseOutcomeUnmeasuredReason | null =
    entry.unmeasuredReason === "no_funnel_sold" ? "no_leg_performed" : entry.unmeasuredReason;
  const byKey = new Map<string, ShowcaseOutcome>();
  for (const chain of entry.funnels) {
    for (const s of chain.steps) {
      if (s.key === SHOWCASE_CONTACTED_KEY) {
        if (!byKey.has(s.key)) {
          byKey.set(s.key, { key: SHOWCASE_CONTACTED_KEY, label: SHOWCASE_CONTACTED_LABEL, legKeys: [], peopleReached: s.peopleReached, costPerReachUsd: s.costPerReachUsd });
        }
        continue;
      }
      const stepKey = toStepOfLeg(s.key);
      if (stepKey === null) throw new Error(`showcase outcomes: rung key ${s.key} names no leg`);
      const existing = byKey.get(stepKey);
      if (existing) {
        if (!existing.legKeys.includes(s.key)) existing.legKeys.push(s.key);
        continue;
      }
      byKey.set(stepKey, {
        key: stepKey,
        label: CHANNEL_STEPS[stepKey].label,
        legKeys: [s.key],
        peopleReached: s.peopleReached,
        costPerReachUsd: s.costPerReachUsd,
      });
    }
  }
  const outcomes = [...byKey.values()].sort((a, b) => {
    const ia = a.key === SHOWCASE_CONTACTED_KEY ? -1 : stepOrder(a.key as ChannelStepKey);
    const ib = b.key === SHOWCASE_CONTACTED_KEY ? -1 : stepOrder(b.key as ChannelStepKey);
    return ia - ib;
  });
  return {
    brand: entry.brand,
    outcomes,
    returnPerDollar: entry.measured ? brandReturnPerDollar : null,
    measured: entry.measured,
    unmeasuredReason: reason,
  };
}

/** PURE: the funnel-keyed showcase payload → its per-outcome twin, same picks, same order. */
export function showcaseOutcomesPayloadOf(
  payload: ShowcaseFunnelsPayload,
  brandReturns: ReadonlyMap<string, number | null>,
): ShowcaseOutcomesPayload {
  const of = (e: ShowcaseBrandFunnels) => showcaseOutcomesOf(e, brandReturns.get(e.brand.id) ?? null);
  const group = (g: ShowcaseGroup): ShowcaseOutcomeGroup => ({ ...g, brands: g.brands.map(of) });
  return {
    brands: payload.brands.map(of),
    groups: { recentlyStarted: group(payload.groups.recentlyStarted), highestReturn: group(payload.groups.highestReturn) },
    minSpendUsd: payload.minSpendUsd,
  };
}
