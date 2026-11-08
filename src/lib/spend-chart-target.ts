/**
 * A CAMPAIGN'S CHART READS ITS TARGET (owner 2026-11-08, SPEND-CHART-TARGET-1108: "why Positive replies in Day by day,
 * is it hardcoded?"). PURE.
 *
 * A funnel campaign states its Target (campaign-service `target`, the outcome the client asked it for); its "Spend, day
 * by day" chart counts THAT outcome: $ per Target and % to Target, at zero Units Learning with the expected figure
 * beside it. Never the first pipe that does more than find people (the retired leading-unit rule), never an
 * intermediate milestone (those stay on the Milestones cards). An offer's or a brand's chart reads the Target its
 * campaigns state (most campaigns, ties: the most recent campaign's).
 *
 *   - Target = campaign-service's `target`, else the last step of the funnel the campaign runs.
 *   - Entry (the step % to Target counts from) = the first milestone of the campaign's own units chain to its Target
 *     (`milestoneChainOf`: Lead found on a proactive funnel); a chain that IS the Target counts from the step its unit
 *     takes people over at (a reactive campaign's trigger step), from Start nobody (`no_entry_population`).
 *   - EXPECTED, read off the priced route of the scope's expected model (`expectedRouteOf`):
 *       cost from the route's start to the Target: C(to) = C(from) / y + c along the route (y = the leg's rate,
 *       c = one outcome of the leg; the customer's own team costs $0), C(route start) = 0;
 *       conversion = Π leg rates from the entry step to the Target, the entry leg's rate (a route prices none on its
 *       first leg) = the fleet's measured conversion of that channel x leg, else the seeded entry default.
 */
import { milestoneChainOf } from "./campaign-milestone-cards.js";
import { DEFAULT_ENTRY_RATE_PCT } from "./default-leg-rates.js";
import { pipeLegKeyOf, storedLegKeyOf } from "./funnel-legs.js";
import type { ChannelStepKey } from "./acquisition-channels.js";
import type { ExpectedRouteLeg } from "./expected-return.js";
import type { SpendChartExpected } from "./spend-charts.js";

/** What a scope's chart counts: its Target and the step its conversion counts from. */
export interface ChartTarget {
  /** The outcome counted (a catalogue step key). */
  step: string;
  /** Where the conversion counts from; null = nobody enters before the Target (no conversion). */
  fromStep: string | null;
  /** `campaign_target`: campaign-service states it; `funnel_last_step`: not stated, the funnel's last step. */
  source: "campaign_target" | "funnel_last_step";
}

type Basis = "measured" | "stated" | "fleet" | "default";
const ORDER: Basis[] = ["measured", "stated", "fleet", "default"];
const weakest = (bases: ReadonlyArray<Basis | null>): Basis | null =>
  bases.reduce<Basis | null>((w, b) => (b === null ? w : w === null || ORDER.indexOf(b) > ORDER.indexOf(w) ? b : w), null);

/** One unit of a campaign: the steps its pipe moves people between. */
export interface TargetUnitEdge {
  campaignId: string;
  fromStep: string | null;
  toStep: string;
}

/**
 * PURE. A funnel campaign's chart Target: its stated Target, else its funnel's last step; entry = the first milestone of
 * its units chain to the Target (`milestoneChainOf`, the Milestones cards' own chain). Null when neither is known.
 */
export function campaignChartTarget(stated: string | null | undefined, funnelLastStep: string | null, units: readonly TargetUnitEdge[]): ChartTarget | null {
  const step = stated ?? funnelLastStep;
  if (!step) return null;
  const chain = milestoneChainOf(units, step);
  const first = chain[0]?.step ?? null;
  // A chain that IS the Target (a reactive campaign whose unit lands on it): it counts from the step its people were
  // taken over at (the trigger step), the step its own unit leaves; from Start = nobody to convert.
  const takeover =
    first === step ? units.find((u) => chain[0]!.unitCampaignIds.includes(u.campaignId) && u.fromStep !== null && u.fromStep !== "start")?.fromStep ?? null : null;
  return { step, fromStep: first !== null && first !== step ? first : takeover, source: stated ? "campaign_target" : "funnel_last_step" };
}

/**
 * PURE. The Target of several campaigns charted as one scope (an offer, a brand): the Target most of them state, ties
 * to the most recent campaign's; its entry = the entry most of THOSE campaigns count from (same tie rule).
 */
export function groupChartTarget(members: ReadonlyArray<{ target: ChartTarget | null; createdAt: string }>): ChartTarget | null {
  const pick = <K>(items: ReadonlyArray<{ key: K; createdAt: string }>, keyOf: (k: K) => string): K | null => {
    const counts = new Map<string, { key: K; n: number; latest: string }>();
    for (const it of items) {
      const k = keyOf(it.key);
      const c = counts.get(k);
      counts.set(k, { key: it.key, n: (c?.n ?? 0) + 1, latest: c && c.latest > it.createdAt ? c.latest : it.createdAt });
    }
    return [...counts.values()].sort((a, b) => b.n - a.n || b.latest.localeCompare(a.latest))[0]?.key ?? null;
  };
  const stated = members.filter((m): m is { target: ChartTarget; createdAt: string } => m.target !== null);
  const step = pick(stated.map((m) => ({ key: m.target.step, createdAt: m.createdAt })), (k) => k);
  if (step === null) return null;
  const same = stated.filter((m) => m.target.step === step);
  const fromStep = pick(same.map((m) => ({ key: m.target.fromStep, createdAt: m.createdAt })), (k) => k ?? "");
  return { step, fromStep, source: same.some((m) => m.target.source === "campaign_target") ? "campaign_target" : "funnel_last_step" };
}

/** PURE. The leg key the Target's maturity and Learning bar are read on: entry -> Target as one leg (default rule when the catalogue has none). */
export const targetLegKeyOf = (t: ChartTarget): string => storedLegKeyOf(`${t.fromStep ?? "start"}_to_${t.step}`);

/**
 * PURE. The Target's EXPECTED cost (from the route's start) and conversion (from the entry step), off the scope's
 * expected route. Null + reason when the model has no route or the route does not reach the Target.
 */
export function expectedTargetFigures(
  route: ReadonlyArray<ExpectedRouteLeg> | null,
  target: ChartTarget,
  /** The fleet's measured entry conversion per `<leg>|<channel>` (outcome prices). */
  fleetConversions: ReadonlyMap<string, number>,
  modelUnavailableReason: string | null,
): SpendChartExpected {
  const none = (reason: string): SpendChartExpected => ({
    costPerOutcomeUsd: null,
    costPerOutcomeBasis: null,
    costPerOutcomeUnavailableReason: reason,
    conversionRatePct: null,
    conversionBasis: null,
    conversionSource: null,
    conversionUnavailableReason: target.fromStep === null ? "no_entry_population" : reason,
  });
  if (route === null || route.length === 0) return none(modelUnavailableReason ?? "no_expected_route");
  // An outreach entry leg in its stored spelling starts from nothing (`start_to_conversation`): its people are the leads
  // found (the sales path counts from Lead found), so it leaves Lead found; a sourcing leg alone leaves Start.
  route = route.map((l) => (l.fromStep === null && l.toStep !== "lead_found" ? { ...l, fromStep: "lead_found" } : l));
  const reaches = route.findIndex((l) => l.toStep === target.step);
  if (reaches < 0) return none("target_not_on_expected_route");

  // Cost from the route's start to the Target: C(to) = C(from) / y + c.
  let cost: number | null = 0;
  const costBases: Array<Basis | null> = [];
  for (let i = 0; i <= reaches; i += 1) {
    const l = route[i]!;
    if (cost === null) break;
    if (l.costPerOutcomeUsd === null) {
      cost = null;
      break;
    }
    costBases.push(l.costBasis as Basis | null);
    if (cost > 0) {
      if (l.ratePct === null || !(l.ratePct > 0)) {
        cost = null;
        break;
      }
      costBases.push(l.rateBasis as Basis | null);
      cost = cost / (l.ratePct / 100) + l.costPerOutcomeUsd;
    } else cost = l.costPerOutcomeUsd;
  }
  const costPart =
    cost !== null && cost > 0
      ? { costPerOutcomeUsd: cost, costPerOutcomeBasis: weakest(costBases) ?? "default", costPerOutcomeUnavailableReason: null }
      : { costPerOutcomeUsd: null, costPerOutcomeBasis: null, costPerOutcomeUnavailableReason: cost === null ? "route_leg_unpriced" : "target_is_route_start" };

  // Conversion from the entry step to the Target: Π rates, the entry leg on the fleet's (else the seeded default).
  let conversionPart: Pick<SpendChartExpected, "conversionRatePct" | "conversionBasis" | "conversionSource" | "conversionUnavailableReason">;
  const start = target.fromStep === null ? -1 : route.findIndex((l) => l.fromStep === target.fromStep);
  if (target.fromStep === null) conversionPart = { conversionRatePct: null, conversionBasis: null, conversionSource: null, conversionUnavailableReason: "no_entry_population" };
  else if (start < 0 || start > reaches) conversionPart = { conversionRatePct: null, conversionBasis: null, conversionSource: null, conversionUnavailableReason: "entry_not_on_expected_route" };
  else {
    let p: number | null = 1;
    const bases: Array<Basis | null> = [];
    let source = "expected_route";
    for (let i = start; i <= reaches; i += 1) {
      const l = route[i]!;
      let rate = l.ratePct;
      let basis = l.rateBasis as Basis | null;
      if (rate === null && i === start) {
        // The key every spend chart reads the fleet's entry conversion on (`expectedConversionOf`).
        const fleet = l.channelSlug ? fleetConversions.get(`${storedLegKeyOf(pipeLegKeyOf(l.channelSlug, l.legKey))}|${l.channelSlug}`) : undefined;
        if (fleet !== undefined) [rate, basis, source] = [fleet, "fleet", "expected_route_fleet_entry"];
        else {
          const d = DEFAULT_ENTRY_RATE_PCT[l.toStep as ChannelStepKey];
          if (d !== undefined) [rate, basis, source] = [d, "default", "expected_route_default_entry"];
        }
      }
      if (rate === null) {
        p = null;
        break;
      }
      bases.push(basis);
      p *= rate / 100;
    }
    conversionPart =
      p === null
        ? { conversionRatePct: null, conversionBasis: null, conversionSource: null, conversionUnavailableReason: "no_rate_for_leg" }
        : { conversionRatePct: p * 100, conversionBasis: weakest(bases) ?? "default", conversionSource: source, conversionUnavailableReason: null };
  }
  return { ...costPart, ...conversionPart };
}
