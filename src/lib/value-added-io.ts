/**
 * The reads behind `lib/value-added.ts` for a campaign that TOOK ITS PEOPLE OVER at a step (a reactive funnel
 * campaign answering Positive replies another campaign produced, or one of its units): its people = the people
 * its units served ∪ the people they ACTED on (lead-service follow-up ledger); its spend = the units' committed
 * spend (the same runs read every campaign figure uses); each person's value on the offer's terms, through the
 * one revenue engine. Fail-loud (the caller is a money read).
 */
import { fetchFollowupActedLeads } from "./followup-actions-client.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { fetchObservedStepFacts } from "./observed-steps.js";
import { fetchQualifications } from "./qualifications-client.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { DEFAULT_PRICED_CAUSES } from "./outcome-cause.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import { getFunnel, restrictPathsToDeclaredLegs } from "./funnel-registry.js";
import { fetchRunsCostCents } from "./runs-cost-client.js";
import { buildCostEconomics, type CostEconomics } from "./cost-economics.js";
import { legMaturityFigures, outcomeFigures } from "./maturity.js";
import type { ScopeMaturity } from "./scope-maturity.js";
import type { FunnelPricedEconomics } from "./offer-pricing.js";
import type { PipelineUnpricedReason } from "./offer-priced-economics.js";
import type { Pricing } from "./pricing.js";
import { reachedCount, STEP_SIGNAL, valueAdded, type ValueAdded } from "./value-added.js";

export interface TakeoverReturn {
  headline: { totalPipelineUsd: number | null; unpricedReason: PipelineUnpricedReason | null };
  costEconomics: CostEconomics;
  maturity: ScopeMaturity;
  valueAdded: (ValueAdded & { takeoverStep: string }) | null;
}

export async function computeTakeoverReturn(args: {
  brandId: string;
  unitCampaignIds: readonly string[];
  featureSlugs: readonly string[];
  takeoverStep: string;
  /** The unit leg that takes the people over (its outcome step decides the maturity count). */
  takeoverLeg: { legKey: string; toStep: string };
  priced: FunnelPricedEconomics | undefined;
  pricing: Pricing;
  headers: { orgId: string; userId?: string; runId?: string };
}): Promise<TakeoverReturn> {
  const { brandId, unitCampaignIds, featureSlugs, takeoverStep, takeoverLeg, priced, pricing, headers } = args;
  const units = new Set(unitCampaignIds);
  const [cost, acted, all] = await Promise.all([
    fetchRunsCostCents(brandId, [...unitCampaignIds], [...featureSlugs], headers, pricing),
    fetchFollowupActedLeads(brandId, [...unitCampaignIds]),
    fetchLeadsForRevenue(brandId, undefined, headers),
  ]);
  const actedIds = new Set([...acted.values()].flatMap((s) => [...s]));
  const persons: EnginePerson[] = dedupPersonsByLead(all.filter((p) => actedIds.has(p.leadId) || (p.campaignId != null && units.has(p.campaignId))));
  if (persons.length > 0) {
    const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
    // The step statements and legacy qualifications ride FAIL-SOFT with a loud log, exactly as the engine reads
    // them on every revenue read (an unreadable overlay leaves those rungs unobserved, never a 502).
    const [observed, quals] = await Promise.all([
      fetchObservedStepFacts(brandId, DEFAULT_PRICED_CAUSES).catch((err: Error) => {
        console.warn(`[features-service] value added: step statements unreadable for brand ${brandId} (overlay skipped): ${err.message}`);
        return null;
      }),
      fetchQualifications(brandId, undefined, emails, headers).catch((err: Error) => {
        console.warn(`[features-service] value added: qualifications unreadable for brand ${brandId} (overlay skipped): ${err.message}`);
        return null;
      }),
    ]);
    applySignalOverlays(persons, null, observed?.byEmail ?? null, quals, [], DEFAULT_PRICED_CAUSES);
  }

  const economics = priced?.economics.economics ?? null;
  const engine = getFunnel("sales-cold-email-outreach");
  if (!engine) throw new Error("[features-service] the sales funnel engine is not registered");
  const ltr = economics?.lifetimeRevenueUsd ?? null;
  const added =
    economics && ltr !== null && priced
      ? valueAdded(
          persons,
          takeoverStep,
          restrictPathsToDeclaredLegs(engine.resolvePaths({ economics, pricedFunnelKeys: priced.pricedFunnelKeys }), priced.pricedFunnelKeys),
          ltr,
        )
      : null;

  const spendUsd = cost.committedCents / 100;
  const outcomes = reachedCount(persons, takeoverLeg.toStep, !STEP_SIGNAL[takeoverLeg.toStep]);
  const figures = outcomes === null ? null : outcomeFigures(spendUsd, persons.length, outcomes);
  // This leg's maturity rule is read from `lib/maturity.ts` like every leg's; a 0-day leg's mature figures ARE its flash figures.
  const leg = legMaturityFigures(takeoverLeg.legKey, figures, figures);
  return {
    headline: added
      ? { totalPipelineUsd: added.valueAddedUsd, unpricedReason: null }
      : { totalPipelineUsd: null, unpricedReason: priced?.economics.unpricedReason ?? "no_priced_funnel" },
    costEconomics: learningUntilMature(
      buildCostEconomics({
        committedCostInUsdCents: cost.committedCents,
        actualCostInUsdCents: cost.actualCents,
        totalPipelineUsd: added ? added.valueAddedUsd : null,
        lifetimeRevenueUsd: ltr,
      }),
      leg.isMature,
    ),
    maturity: { isMature: leg.isMature, legs: [leg] },
    valueAdded: added ? { ...added, takeoverStep } : null,
  };
}

/**
 * LEARNING UNTIL MATURE (owner 2026-10-11, "reactive ones then read Learning/maturing like Bliss until mature"):
 * while the takeover leg has not reached its own maturity bar (`lib/maturity.ts`, e.g. 10 outcomes), the ratios
 * read null with `unmeasuredReason: "maturing"`, the same statement a young proactive campaign makes; never a
 * 0x on a handful of cents. The totals (spend, value added) stay served.
 */
export function learningUntilMature(block: CostEconomics, isMature: boolean | null): CostEconomics {
  if (isMature !== false || !(block.committedCostUsd > 0)) return block;
  return { ...block, roiMultiple: null, costOfAcquisitionPct: null, costPerAcquisitionUsd: null, unmeasuredReason: "maturing" };
}
