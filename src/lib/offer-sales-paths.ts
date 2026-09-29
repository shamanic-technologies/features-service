/**
 * EVERY SALES PATH AN OFFER CAN SELL THROUGH, RANKED BY ROI — `GET /offers/:offerId/sales-paths`.
 *
 * Owner decision 2026-09-29 (phase 2 of "how an offer sells"). brand-service stores, per offer, the
 * steps and legs the customer ticked (`GET /internal/offers/:offerId/sales-path`). A SALES PATH is a
 * chain of those ticked legs that starts with an ENTRY leg (a leg from nothing) and ends on `paid_client`,
 * never visiting a step twice. Nothing else is a path: an offer that ticked nothing, or whose ticked
 * legs form no complete chain, is told so (`status`) and served no path — none is invented.
 *
 * ── THE FORMULA (stated verbatim in the API description) ──────────────────────────────────────
 *
 *   For a path  entry leg L1 (∅ → s1), L2 (s1 → s2), …, Ln (s(n-1) → paid_client):
 *
 *     rate(Li)            the leg's EFFECTIVE conversion rate (i ≥ 2), 0..100 — the brand's own
 *                         resolution (`lib/effective-conversion-rates.ts`: CRM-measured / measured on our
 *                         leads > the customer's own value > fleet median > industry default). An entry
 *                         leg has no rate (nobody was on the path before it).
 *     needed(paid_client) = 1
 *     needed(s(i-1))      = needed(s(i)) ÷ (rate(Li) / 100)      — outcomes of each step per paying client
 *     legCost(Li)         = costPerOutcome(Li) × needed(s(i))     — for a leg a channel of ours works
 *                         = 0 (stated as null)                    — for a human leg (no channel of ours)
 *     costPerPayingClient = Σ legCost(Li)
 *     roi                 = lifetimeRevenue(offer) ÷ costPerPayingClient   (a return multiple)
 *
 *   `costPerOutcome(Li)` is the NET cost per outcome of the leg's own step on the channel we would run it
 *   on: for every platform channel publishing the leg, the RECOMMENDED workflow of that channel's
 *   leg-keyed `workflow-projection` ladder for this brand and offer (`?leg=&offerId=&pricing=net`, the
 *   exact read campaign-service ranks on), read off its brand-level row (`resolved.costPerOutcomeUsd`).
 *   The channel chosen is the one with the lowest such cost.
 *
 * ── NULLS ARE REASONS, NEVER ZEROS ────────────────────────────────────────────────────────────
 *
 * A path with a platform leg no channel could price, a leg converting at 0%, or an offer with no lifetime
 * revenue states `roi: null` + `roiUnavailableReason` and sorts after every priced path. It is never
 * priced as free. Pure: every input is read by the route.
 */
import type { ChannelStepDefWire } from "./channel-catalogue.js";
import { CHANNEL_STEPS } from "./acquisition-channels.js";
import { funnelLeg } from "./funnel-legs.js";
import { legPairKey, type EffectiveArrowRate } from "./effective-conversion-rates.js";

/** Where the rate retained for a leg came from, in the customer's terms. */
export type SalesPathRateSource =
  /** Measured on the client's own CRM (their sales team at work). */
  | "crm_measured"
  /** Measured on the leads we contacted for this brand. */
  | "measured_on_our_leads"
  /** The value the customer stated for the leg. */
  | "customer_stated"
  /** The median of what other brands stated for the leg. */
  | "fleet_median"
  /** The seeded industry benchmark for the leg. */
  | "industry_default";

export interface SalesPathChannelInput {
  slug: string;
  name: string;
  operatedBy: "platform" | "customer";
  trigger: "daily_budget" | "step_reached";
  legKeys: readonly string[];
}

/** What one channel's leg-keyed ladder answered for the leg (for this brand and offer, net pricing). */
export interface LegChannelPrice {
  costPerOutcomeUsd: number | null;
  workflowDynastySlug: string | null;
  /** The grain the price rests on (`crossOrg` is the fleet benchmark, `brand`/`offer` the brand's own). */
  grain: string | null;
  /** Null when priced; otherwise why this channel states no price for the leg. */
  unpricedReason: string | null;
}

export interface SalesPathChannelCandidate {
  slug: string;
  name: string;
  trigger: "daily_budget" | "step_reached";
  costPerOutcomeUsd: number | null;
  workflowDynastySlug: string | null;
  grain: string | null;
  unpricedReason: string | null;
}

export type SalesPathChannelChoice =
  /** The only platform channel that could price the leg. */
  | "only_priced_channel"
  /** The cheapest of several platform channels that priced the leg. */
  | "cheapest_cost_per_outcome"
  /** A platform channel publishes the leg but none could price it. */
  | "no_priced_channel";

export interface SalesPathLeg {
  legKey: string;
  fromStep: ChannelStepDefWire | null;
  toStep: ChannelStepDefWire;
  /** Null on an entry leg (from nothing). */
  conversionRatePct: number | null;
  rateSource: SalesPathRateSource | null;
  /** The four inputs the rate was resolved from, so a reader sees the alternatives. Null on an entry leg. */
  rateInputs: {
    measured: { basis: "our_leads" | "crm"; fromReached: number | null; toReached: number | null; ratePct: number | null; sufficient: boolean };
    customerStatedPct: number | null;
    fleetMedian: { ratePct: number | null; brandCount: number };
    industryDefaultPct: number | null;
  } | null;
  /** `platform`: at least one channel of ours publishes this leg. `human`: none does (the customer's team). */
  workedBy: "platform" | "human";
  /** Present on a platform leg: the channel we would run it on, and why. */
  channel: {
    slug: string | null;
    name: string | null;
    trigger: "daily_budget" | "step_reached" | null;
    workflowDynastySlug: string | null;
    grain: string | null;
    choice: SalesPathChannelChoice;
    candidates: SalesPathChannelCandidate[];
  } | null;
  /** Outcomes of this leg's step needed per paying client. Null when a later leg converts at 0%. */
  outcomesNeededPerPayingClient: number | null;
  /** Cost of one outcome of this leg's step on the chosen channel. Null on a human leg or unpriced. */
  costPerOutcomeUsd: number | null;
  /** `costPerOutcomeUsd × outcomesNeededPerPayingClient`. Null on a human leg (no cost) or unpriced. */
  costPerPayingClientUsd: number | null;
}

export type SalesPathRoiUnavailableReason =
  | "leg_cost_unavailable"
  | "zero_conversion_rate"
  | "no_lifetime_revenue"
  | "no_platform_cost";

export interface SalesPath {
  rank: number;
  pathKey: string;
  legKeys: string[];
  steps: ChannelStepDefWire[];
  entryLegKey: string;
  /** The channel chosen for the entry leg (what a budget behind this path buys). Null when none is priced. */
  entryChannelSlug: string | null;
  legs: SalesPathLeg[];
  /** Share of entry outcomes that become a paying client: Π rate(Li)/100 over the non-entry legs, in %. */
  entryToPayingClientPct: number | null;
  lifetimeRevenueUsd: number | null;
  costPerPayingClientUsd: number | null;
  roi: number | null;
  roiUnavailableReason: SalesPathRoiUnavailableReason | null;
}

export type OfferSalesPathsStatus = "ok" | "not_stated" | "no_legs_selected" | "no_complete_path";

export interface OfferSalesPathsBody {
  offerId: string;
  brandId: string;
  status: OfferSalesPathsStatus;
  statedAt: string | null;
  selectedLegKeys: string[];
  /** Ticked keys naming no leg of the catalogue — ignored, stated so they are not silently dropped. */
  unknownLegKeys: string[];
  lifetimeRevenueUsd: number | null;
  pricing: "net";
  paths: SalesPath[];
}

const stepWire = (key: keyof typeof CHANNEL_STEPS): ChannelStepDefWire => ({ ...CHANNEL_STEPS[key] });

function rateSourceOf(arrow: EffectiveArrowRate): SalesPathRateSource | null {
  switch (arrow.source) {
    case "measured":
      return arrow.measured.basis === "crm" ? "crm_measured" : "measured_on_our_leads";
    case "manual":
      return "customer_stated";
    case "median":
      return "fleet_median";
    case "default":
      return "industry_default";
    default:
      return null;
  }
}

/** PURE: every chain of `legKeys` from an entry leg to `paid_client`, visiting no step twice. */
export function enumerateSalesPaths(legKeys: readonly string[]): string[][] {
  const legs = legKeys.map((k) => funnelLeg(k)).filter((l): l is NonNullable<typeof l> => l !== null);
  const byFrom = new Map<string, typeof legs>();
  for (const l of legs) {
    const from = l.fromStep?.key ?? "∅";
    byFrom.set(from, [...(byFrom.get(from) ?? []), l]);
  }
  const out: string[][] = [];
  const walk = (step: string, chain: string[], seen: Set<string>) => {
    if (step === "paid_client") {
      out.push(chain);
      return;
    }
    for (const l of byFrom.get(step) ?? []) {
      if (seen.has(l.toStep.key)) continue;
      walk(l.toStep.key, [...chain, l.legKey], new Set([...seen, l.toStep.key]));
    }
  };
  walk("∅", [], new Set());
  return out;
}

/** PURE: the channel a platform leg would run on, from what each candidate's ladder priced. */
export function chooseLegChannel(candidates: SalesPathChannelCandidate[]): {
  chosen: SalesPathChannelCandidate | null;
  choice: SalesPathChannelChoice;
} {
  const priced = candidates
    .filter((c) => c.costPerOutcomeUsd !== null && Number.isFinite(c.costPerOutcomeUsd))
    .sort((a, b) => a.costPerOutcomeUsd! - b.costPerOutcomeUsd! || a.slug.localeCompare(b.slug));
  if (priced.length === 0) return { chosen: null, choice: "no_priced_channel" };
  return { chosen: priced[0], choice: priced.length === 1 ? "only_priced_channel" : "cheapest_cost_per_outcome" };
}

export interface BuildOfferSalesPathsInput {
  offerId: string;
  brandId: string;
  stated: boolean;
  statedAt: string | null;
  legKeys: readonly string[] | null;
  lifetimeRevenueUsd: number | null;
  /** The brand's effective rate of every leg (`BrandEffectiveRates.legs`). */
  rates: readonly EffectiveArrowRate[];
  channels: readonly SalesPathChannelInput[];
  /** `${legKey}|${channelSlug}` → what that channel's ladder priced for the leg. */
  prices: ReadonlyMap<string, LegChannelPrice>;
}

export const priceKey = (legKey: string, slug: string): string => `${legKey}|${slug}`;

/** PURE: the platform channels publishing each leg — the (leg, channel) pairs the route must price. */
export function platformChannelsForLeg(channels: readonly SalesPathChannelInput[], legKey: string): SalesPathChannelInput[] {
  return channels.filter((c) => c.operatedBy === "platform" && c.legKeys.includes(legKey));
}

/** PURE: the whole body. */
export function buildOfferSalesPaths(input: BuildOfferSalesPathsInput): OfferSalesPathsBody {
  const selected = [...new Set(input.legKeys ?? [])];
  const unknownLegKeys = selected.filter((k) => funnelLeg(k) === null);
  const base = {
    offerId: input.offerId,
    brandId: input.brandId,
    statedAt: input.statedAt,
    selectedLegKeys: selected,
    unknownLegKeys,
    lifetimeRevenueUsd: input.lifetimeRevenueUsd,
    pricing: "net" as const,
  };
  if (!input.stated) return { ...base, status: "not_stated", paths: [] };
  if (selected.length - unknownLegKeys.length === 0) return { ...base, status: "no_legs_selected", paths: [] };

  const chains = enumerateSalesPaths(selected);
  if (chains.length === 0) return { ...base, status: "no_complete_path", paths: [] };

  const arrows = new Map(input.rates.map((a) => [legPairKey(a.fromStep, a.toStep), a]));
  const ltr = input.lifetimeRevenueUsd;

  const paths = chains.map((legKeys): Omit<SalesPath, "rank"> => {
    const defs = legKeys.map((k) => funnelLeg(k)!);
    // Walk backward from the paying client: outcomes needed at each leg's step.
    const needed: Array<number | null> = new Array(defs.length).fill(null);
    let zeroRate = false;
    let n: number | null = 1;
    const legRates: Array<EffectiveArrowRate | null> = defs.map((d) =>
      d.fromStep ? (arrows.get(`${d.fromStep.key}>${d.toStep.key}`) ?? null) : null,
    );
    for (let i = defs.length - 1; i >= 0; i--) {
      needed[i] = n;
      if (i === 0) break;
      const rate = legRates[i]?.effectiveRatePct ?? null;
      if (n === null || rate === null || rate <= 0) {
        if (rate !== null && rate <= 0) zeroRate = true;
        n = null;
      } else {
        n = n / (rate / 100);
      }
    }

    let costUnavailable = false;
    let anyPlatform = false;
    let total = 0;
    const legs: SalesPathLeg[] = defs.map((d, i) => {
      const arrow = legRates[i];
      const platform = platformChannelsForLeg(input.channels, d.legKey);
      let channel: SalesPathLeg["channel"] = null;
      let costPerOutcomeUsd: number | null = null;
      let costPerPayingClientUsd: number | null = null;
      if (platform.length > 0) {
        anyPlatform = true;
        const candidates: SalesPathChannelCandidate[] = platform.map((c) => {
          const p = input.prices.get(priceKey(d.legKey, c.slug));
          return {
            slug: c.slug,
            name: c.name,
            trigger: c.trigger,
            costPerOutcomeUsd: p?.costPerOutcomeUsd ?? null,
            workflowDynastySlug: p?.workflowDynastySlug ?? null,
            grain: p?.grain ?? null,
            unpricedReason: p ? p.unpricedReason : "not_priced",
          };
        });
        const { chosen, choice } = chooseLegChannel(candidates);
        channel = {
          slug: chosen?.slug ?? null,
          name: chosen?.name ?? null,
          trigger: chosen?.trigger ?? null,
          workflowDynastySlug: chosen?.workflowDynastySlug ?? null,
          grain: chosen?.grain ?? null,
          choice,
          candidates,
        };
        costPerOutcomeUsd = chosen?.costPerOutcomeUsd ?? null;
        if (costPerOutcomeUsd === null) costUnavailable = true;
        else if (needed[i] !== null) {
          costPerPayingClientUsd = costPerOutcomeUsd * needed[i]!;
          total += costPerPayingClientUsd;
        }
      }
      return {
        legKey: d.legKey,
        fromStep: d.fromStep ? stepWire(d.fromStep.key) : null,
        toStep: stepWire(d.toStep.key),
        conversionRatePct: arrow?.effectiveRatePct ?? null,
        rateSource: arrow ? rateSourceOf(arrow) : null,
        rateInputs: arrow
          ? {
              measured: {
                basis: arrow.measured.basis,
                fromReached: arrow.measured.fromReached,
                toReached: arrow.measured.toReached,
                ratePct: arrow.measured.ratePct,
                sufficient: arrow.measured.sufficient,
              },
              customerStatedPct: arrow.manualRatePct,
              fleetMedian: arrow.median,
              industryDefaultPct: arrow.defaultRatePct,
            }
          : null,
        workedBy: platform.length > 0 ? "platform" : "human",
        channel,
        outcomesNeededPerPayingClient: needed[i],
        costPerOutcomeUsd,
        costPerPayingClientUsd,
      };
    });

    let entryToPayingClientPct: number | null = 100;
    for (let i = 1; i < legs.length; i++) {
      const r = legs[i].conversionRatePct;
      entryToPayingClientPct = r === null || entryToPayingClientPct === null ? null : (entryToPayingClientPct * r) / 100;
    }

    let roiUnavailableReason: SalesPathRoiUnavailableReason | null = null;
    if (zeroRate) roiUnavailableReason = "zero_conversion_rate";
    else if (costUnavailable) roiUnavailableReason = "leg_cost_unavailable";
    else if (!anyPlatform || total <= 0) roiUnavailableReason = "no_platform_cost";
    else if (ltr === null) roiUnavailableReason = "no_lifetime_revenue";
    const costPerPayingClientUsd = zeroRate || costUnavailable || !anyPlatform ? null : total;
    const roi = roiUnavailableReason === null ? ltr! / total : null;

    const steps = [stepWire(defs[0].toStep.key), ...defs.slice(1).map((d) => stepWire(d.toStep.key))];
    return {
      pathKey: legKeys.join("+"),
      legKeys,
      steps,
      entryLegKey: legKeys[0],
      entryChannelSlug: legs[0].channel?.slug ?? null,
      legs,
      entryToPayingClientPct,
      lifetimeRevenueUsd: ltr,
      costPerPayingClientUsd,
      roi,
      roiUnavailableReason,
    };
  });

  paths.sort((a, b) => {
    if (a.roi !== null && b.roi !== null) return b.roi - a.roi || a.pathKey.localeCompare(b.pathKey);
    if (a.roi !== null) return -1;
    if (b.roi !== null) return 1;
    const ca = a.costPerPayingClientUsd ?? Infinity;
    const cb = b.costPerPayingClientUsd ?? Infinity;
    return ca - cb || a.pathKey.localeCompare(b.pathKey);
  });

  return { ...base, status: "ok", paths: paths.map((p, i) => ({ rank: i + 1, ...p })) };
}
