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
 *
 * ── ONE ROW PER COMBINATION (owner 2026-10-04) ────────────────────────────────────────────────
 *
 *   A row is a COMBINATION: a chain of ticked legs × ONE managed channel per leg a managed channel can
 *   work (human legs stay human). Every combination is priced and ranked on its own with the formula
 *   above, so the same chain on another entry channel competes as its own row — adding a managed channel
 *   to a leg grows the rows by construction. `pathKey` stays the CHAIN (shared by its combinations);
 *   `combinationKey` (`combinationKeyOf`) is the row's unique identity and the key of its NAME
 *   (`lib/sales-path-names.ts`: one poetic word, shared across clients, stable forever). Per leg,
 *   `channel` is the combination's channel; `channel.choice` says whether it is the leg's cheapest.
 *
 * ── WHICH CHANNELS COUNT: ONLY THE THREE WE MANAGE (owner 2026-09-29) ────────────────────────
 *
 *   The platform MANAGES exactly `MANAGED_CHANNEL_SLUGS` (cold email, AI meeting booking, AI instant
 *   call) — "on ne gère rien du reste". A leg is `workedBy: "platform"` only when one of those publishes
 *   it, and only those are channel candidates. Every other leg (meeting attendance, closing, a booking
 *   call turned into a meeting, …) is the customer's own team: `workedBy: "human"`, it carries its rate
 *   and costs 0 to us, whatever other catalogue channel (agency, SMS, …) also publishes it.
 *
 * ── EVERY MANAGED LEG IS PRICED (the cost cascade, like the rate cascade ends on a default) ──
 *
 *   costPerOutcome = the recommended workflow's net cost per outcome (the ladder, above)   `workflow`
 *                  > the channel's MEASURED fleet cost per outcome on the leg, when real
 *                    spend exists (runs-service, `/public/stats/outcome-prices` legs)     `fleet_measured`
 *                  > the seeded `DEFAULT_COST_PER_OUTCOME_USD` for (channel, leg)        `default`
 *
 *   So a managed leg never yields `leg_cost_unavailable` merely because no workflow is active or
 *   eligible; `costSource` states which rung priced it.
 *
 * ── `?scope=catalogue`: THE WHOLE COMBINATORY (owner 2026-10-04) ──────────────────────────────
 *
 *   The default read (`scope: "ticked"`, above) is what campaign-service funds and onboarding launches
 *   first, and it is unchanged. `scope: "catalogue"` lists EVERY chain the leg catalogue allows (ticked or
 *   not; each row and leg says `ticked`) × one channel of the owner's SHORTLIST per leg that channel
 *   publishes (`SALES_PATH_CATALOGUE_CHANNEL_SLUGS`, `lib/sales-path-cost-benchmarks.ts`). Per leg,
 *   `channel.managed` says whether we run that channel today. A managed channel prices exactly as above; a
 *   channel we do not run prices on the fleet's real spend when there is some, else on its sourced market
 *   BENCHMARK (`costSource: "benchmark"`, `costBenchmarkSource` cites it). The customer's own team
 *   (`your-team-*`, `operatedBy: customer`) is named on its leg and costs nothing to us, exactly like a
 *   human leg of the default read, so one combination reads ONE price in both scopes. A leg no shortlisted
 *   channel publishes (a visitor signing up, a booking call turned into a meeting) has no channel.
 *
 *   A DEFAULT PRICES, NEVER CHOOSES (the leg-rate rule, applied to costs): a row with any
 *   benchmark-priced leg (`pricedOnBenchmark`) ranks after every row priced on our own evidence, so a
 *   stack of market benchmarks never out-ranks a path we measured; each tier is ordered by ROI. And the
 *   self-serve CHECKOUT legs (`website_visit_to_purchase`) are a property of the offer, not a channel
 *   choice: the catalogue lists them only when the offer ticked that leg (a high-ticket offer that sells
 *   through meetings has no checkout; a 2% generic purchase rate on ad clicks read 57x for one).
 *
 *   `combinationKey` suffixes `@<slug>` only on a leg a PLATFORM channel works, so a leg the customer's
 *   team works keys bare in both scopes: the same combination keeps the same key and NAME in both reads.
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
import { FUNNEL_LEG_KEYS } from "./funnel-legs.js";
import {
  SALES_PATH_CATALOGUE_CHANNEL_SLUGS,
  SALES_PATH_COST_BENCHMARKS,
  type SalesPathCostBenchmark,
} from "./sales-path-cost-benchmarks.js";

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

/** The ONLY channels the platform manages today. A leg nothing here publishes is the customer's team. */
export const MANAGED_CHANNEL_SLUGS: ReadonlySet<string> = new Set([
  "sales-cold-email-outreach",
  "ai-meeting-booking",
  "ai-instant-call",
]);

/**
 * The LAST rung of the cost cascade: a conservative cost per outcome for every (managed channel, leg),
 * used only when neither a workflow nor the fleet can price the leg. Net USD per outcome of the leg's
 * TO step. Keyed `${legKey}|${channelSlug}` (`priceKey`).
 *
 *  - cold email → positive reply $50: above the fleet's live best (~$45 on the offer that surfaced
 *    this), inside the documented $70-250 market band's lower edge — conservative, never flattering.
 *  - cold email → website visit $5: the documented $4-7 per click band, mid-point.
 *  - AI meeting booking → meeting booked $5: a few AI email turns (LLM tokens + sends) per conversation
 *    worked, ~1 in 3 conversations booking, at our price multiple.
 *  - AI instant call → booking call $2: one bridged phone call (Twilio both legs, a few minutes) plus
 *    the LLM qualification, counting unanswered rings, at our price multiple.
 */
export const DEFAULT_COST_PER_OUTCOME_USD: ReadonlyMap<string, number> = new Map([
  ["start_to_conversation|sales-cold-email-outreach", 50],
  ["start_to_website_visit|sales-cold-email-outreach", 5],
  ["conversation_to_meeting_booked|ai-meeting-booking", 5],
  ["conversation_to_booking_call|ai-instant-call", 2],
]);

/** Which rung of the cost cascade priced a candidate. */
export type SalesPathCostSource = "workflow" | "fleet_measured" | "default" | "benchmark";

/** Which combinatory a read lists: the offer's ticked legs × managed channels (default), or the whole catalogue × the shortlist. */
export type SalesPathScope = "ticked" | "catalogue";

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
  /** True when the platform runs this channel today (`MANAGED_CHANNEL_SLUGS`). */
  managed: boolean;
  /** `customer`: the customer's own team works the leg (`your-team-*`). */
  operatedBy: "platform" | "customer";
  /** The cost the cascade resolved (workflow > fleet measured > default). Null only when nothing priced it. */
  costPerOutcomeUsd: number | null;
  /** Which rung priced it. Null when unpriced. */
  costSource: SalesPathCostSource | null;
  workflowDynastySlug: string | null;
  grain: string | null;
  /** Null when priced (by any rung); otherwise why this channel states no price for the leg. */
  unpricedReason: string | null;
  /** Why the WORKFLOW rung did not price it (the ladder's reason), even when a later rung did. Null when it did. */
  workflowUnpricedReason: string | null;
  /** The cited source of the market benchmark, when `costSource` is `benchmark`. Null otherwise. */
  costBenchmarkSource: string | null;
}

export type SalesPathChannelChoice =
  /** The only platform channel that could price the leg. */
  | "only_priced_channel"
  /** The cheapest of several platform channels that priced the leg. */
  | "cheapest_cost_per_outcome"
  /** A platform channel publishes the leg but none could price it. */
  | "no_priced_channel"
  /** This combination runs the leg on a channel other than the cheapest priced one (another row runs the cheapest). */
  | "alternative_channel";

export interface SalesPathLeg {
  legKey: string;
  /** Whether the customer ticked this leg on the offer. */
  ticked: boolean;
  fromStep: ChannelStepDefWire | null;
  toStep: ChannelStepDefWire;
  /** Null on an entry leg (from nothing). */
  conversionRatePct: number | null;
  rateSource: SalesPathRateSource | null;
  /** The four inputs the rate was resolved from, so a reader sees the alternatives. Null on an entry leg. */
  rateInputs: {
    measured: {
      basis: "our_leads" | "crm";
      fromReached: number | null;
      toReached: number | null;
      /** Leads at TO that came through ANOTHER leg into the same step, so not counted in `toReached`. */
      toReachedThroughOtherLegs: number | null;
      ratePct: number | null;
      sufficient: boolean;
    };
    customerStatedPct: number | null;
    fleetMedian: { ratePct: number | null; brandCount: number };
    industryDefaultPct: number | null;
  } | null;
  /** `platform`: a platform channel works this leg in this combination. `human`: the customer's team does
   *  (a `your-team-*` channel in the catalogue scope, or no channel at all). */
  workedBy: "platform" | "human";
  /** The channel THIS combination works the leg on, and why. Null when no candidate channel publishes the leg. */
  channel: {
    slug: string | null;
    name: string | null;
    trigger: "daily_budget" | "step_reached" | null;
    managed: boolean;
    operatedBy: "platform" | "customer";
    costBenchmarkSource: string | null;
    workflowDynastySlug: string | null;
    grain: string | null;
    costSource: SalesPathCostSource | null;
    choice: SalesPathChannelChoice;
    candidates: SalesPathChannelCandidate[];
  } | null;
  /** Outcomes of this leg's step needed per paying client. Null when a later leg converts at 0%. */
  outcomesNeededPerPayingClient: number | null;
  /** Cost of one outcome of this leg's step on the chosen channel. Null on a human leg or unpriced. */
  costPerOutcomeUsd: number | null;
  /** Which rung of the cost cascade priced the leg. Null on a human leg or unpriced. */
  costSource: SalesPathCostSource | null;
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
  /** The row's unique identity: the legs in order, each managed leg `@<channel slug>` (`combinationKeyOf`). */
  combinationKey: string;
  /** The combination's name, shared across every client and stable forever (`lib/sales-path-names.ts`).
   *  Null only on the PURE build's output; the route names every row before serving it. */
  name: string | null;
  /** The CHAIN of legs, shared by every combination of it. */
  pathKey: string;
  legKeys: string[];
  steps: ChannelStepDefWire[];
  entryLegKey: string;
  /** The combination's channel on the entry leg (what a budget behind this row buys). Null on a human entry leg. */
  entryChannelSlug: string | null;
  /** Whether the customer ticked EVERY leg of the chain (always true in the ticked scope). */
  ticked: boolean;
  /** A leg rests on a market benchmark: the row ranks after every row priced on our own evidence. */
  pricedOnBenchmark: boolean;
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
  scope: SalesPathScope;
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
  /** `${legKey}|${channelSlug}` → the channel's MEASURED fleet cost per outcome on the leg (real spend only). */
  fleetPrices?: ReadonlyMap<string, number>;
  /** The channels the platform manages (default `MANAGED_CHANNEL_SLUGS`). */
  managedChannelSlugs?: ReadonlySet<string>;
  /** The last rung of the cost cascade (default `DEFAULT_COST_PER_OUTCOME_USD`). */
  defaultCosts?: ReadonlyMap<string, number>;
  /** Which combinatory to list (default `ticked`). */
  scope?: SalesPathScope;
  /** The catalogue scope's channel shortlist (default `SALES_PATH_CATALOGUE_CHANNEL_SLUGS`). */
  catalogueChannelSlugs?: ReadonlySet<string>;
  /** The catalogue scope's last cost rung for a channel we do not run (default `SALES_PATH_COST_BENCHMARKS`). */
  benchmarks?: ReadonlyMap<string, SalesPathCostBenchmark>;
}

export const priceKey = (legKey: string, slug: string): string => `${legKey}|${slug}`;

/** PURE: a combination's identity — the legs in order, each leg a managed channel works `@<channel slug>`. */
export function combinationKeyOf(legs: ReadonlyArray<{ legKey: string; channelSlug: string | null }>): string {
  // Callers pass `channelSlug` only for a PLATFORM channel: a leg the customer's team works keys bare.
  return legs.map((l) => (l.channelSlug ? `${l.legKey}@${l.channelSlug}` : l.legKey)).join("+");
}

/** PURE: every pick of one option per position (the cartesian product), first position slowest. */
function cartesian<T>(options: ReadonlyArray<readonly T[]>): T[][] {
  return options.reduce<T[][]>((acc, opts) => acc.flatMap((prefix) => opts.map((o) => [...prefix, o])), [[]]);
}

/** PURE: the MANAGED platform channels publishing each leg — the (leg, channel) pairs the route must price. */
export function platformChannelsForLeg(
  channels: readonly SalesPathChannelInput[],
  legKey: string,
  managed: ReadonlySet<string> = MANAGED_CHANNEL_SLUGS,
): SalesPathChannelInput[] {
  return channels.filter((c) => c.operatedBy === "platform" && managed.has(c.slug) && c.legKeys.includes(legKey));
}

const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** PURE: the candidate channels of a leg in a scope — managed platform channels (ticked), or the shortlist (catalogue). */
export function legChannelsForScope(
  channels: readonly SalesPathChannelInput[],
  legKey: string,
  scope: SalesPathScope,
  managed: ReadonlySet<string> = MANAGED_CHANNEL_SLUGS,
  shortlist: ReadonlySet<string> = SALES_PATH_CATALOGUE_CHANNEL_SLUGS,
): SalesPathChannelInput[] {
  if (scope === "ticked") return platformChannelsForLeg(channels, legKey, managed);
  return channels.filter((c) => shortlist.has(c.slug) && c.legKeys.includes(legKey));
}

/** Legs an offer either has or does not (a self-serve checkout): the catalogue lists them only when ticked. */
export const OFFER_PROPERTY_LEG_KEYS: ReadonlySet<string> = new Set(["website_visit_to_purchase"]);

/** PURE: the legs a scope enumerates chains over. */
export function legKeysForScope(scope: SalesPathScope, ticked: readonly string[]): string[] {
  if (scope === "ticked") return [...ticked];
  return FUNNEL_LEG_KEYS.filter((k) => !OFFER_PROPERTY_LEG_KEYS.has(k) || ticked.includes(k));
}

/** PURE: the cost cascade for one (leg, channel) — workflow > fleet measured > default. */
export function resolveLegChannelCost(
  price: LegChannelPrice | undefined,
  fleetCost: number | undefined,
  defaultCost: number | undefined,
): { costPerOutcomeUsd: number | null; costSource: SalesPathCostSource | null } {
  if (usable(price?.costPerOutcomeUsd)) return { costPerOutcomeUsd: price!.costPerOutcomeUsd, costSource: "workflow" };
  if (usable(fleetCost)) return { costPerOutcomeUsd: fleetCost, costSource: "fleet_measured" };
  if (usable(defaultCost)) return { costPerOutcomeUsd: defaultCost, costSource: "default" };
  return { costPerOutcomeUsd: null, costSource: null };
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
  const scope = input.scope ?? "ticked";
  if (scope === "ticked") {
    if (!input.stated) return { ...base, scope, status: "not_stated", paths: [] };
    if (selected.length - unknownLegKeys.length === 0) return { ...base, scope, status: "no_legs_selected", paths: [] };
  }

  const chains = enumerateSalesPaths(legKeysForScope(scope, input.stated ? selected : []));
  if (chains.length === 0) return { ...base, scope, status: "no_complete_path", paths: [] };
  const tickedLegs = new Set(input.stated ? selected : []);
  const shortlist = input.catalogueChannelSlugs ?? SALES_PATH_CATALOGUE_CHANNEL_SLUGS;
  const benchmarks = input.benchmarks ?? SALES_PATH_COST_BENCHMARKS;

  const arrows = new Map(input.rates.map((a) => [legPairKey(a.fromStep, a.toStep), a]));
  const managed = input.managedChannelSlugs ?? MANAGED_CHANNEL_SLUGS;
  const fleetPrices = input.fleetPrices ?? new Map<string, number>();
  const defaultCosts = input.defaultCosts ?? DEFAULT_COST_PER_OUTCOME_USD;
  const ltr = input.lifetimeRevenueUsd;

  const paths = chains.flatMap((legKeys): Array<Omit<SalesPath, "rank">> => {
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

    // Per leg: every candidate channel (priced by the cascade), and the cheapest of them.
    const legCandidates = defs.map((d) => {
      const offered = legChannelsForScope(input.channels, d.legKey, scope, managed, shortlist);
      if (offered.length === 0) return null;
      const candidates: SalesPathChannelCandidate[] = offered.map((c) => {
        const key = priceKey(d.legKey, c.slug);
        const p = input.prices.get(key);
        const isManaged = managed.has(c.slug);
        const isTeam = c.operatedBy === "customer";
        const benchmark = isManaged || isTeam ? undefined : benchmarks.get(key);
        // A channel we run: workflow > fleet > seeded default. One we do not: fleet > market benchmark.
        const resolved = isTeam
          ? { costPerOutcomeUsd: null, costSource: null }
          : isManaged
          ? resolveLegChannelCost(p, fleetPrices.get(key), defaultCosts.get(key))
          : usable(fleetPrices.get(key))
            ? { costPerOutcomeUsd: fleetPrices.get(key)!, costSource: "fleet_measured" as const }
            : usable(benchmark?.costPerOutcomeUsd)
              ? { costPerOutcomeUsd: benchmark!.costPerOutcomeUsd, costSource: "benchmark" as const }
              : { costPerOutcomeUsd: null, costSource: null };
        const workflowPriced = resolved.costSource === "workflow";
        const workflowUnpricedReason = workflowPriced
          ? null
          : !isManaged
            ? "channel_not_managed"
            : p
              ? (p.unpricedReason ?? "recommended_workflow_unpriced")
              : "not_priced";
        return {
          slug: c.slug,
          name: c.name,
          trigger: c.trigger,
          managed: isManaged,
          operatedBy: c.operatedBy,
          costBenchmarkSource: resolved.costSource === "benchmark" ? benchmark!.source : null,
          costPerOutcomeUsd: resolved.costPerOutcomeUsd,
          costSource: resolved.costSource,
          workflowDynastySlug: workflowPriced ? (p?.workflowDynastySlug ?? null) : null,
          grain: workflowPriced ? (p?.grain ?? null) : resolved.costSource === "fleet_measured" ? "crossOrg" : null,
          unpricedReason: isTeam ? null : resolved.costSource === null ? (isManaged ? workflowUnpricedReason : "no_benchmark") : null,
          workflowUnpricedReason,
        };
      });
      return { candidates, ...chooseLegChannel(candidates) };
    });

    // One combination per pick of a candidate on every platform leg (a human leg has the one option: null).
    const picks = cartesian(legCandidates.map((lc) => (lc ? lc.candidates : [null])));
    return picks.map((pick): Omit<SalesPath, "rank"> => {
      let costUnavailable = false;
      let anyCosted = false;
      let total = 0;
      const legs: SalesPathLeg[] = defs.map((d, i) => {
        const arrow = legRates[i];
        const lc = legCandidates[i];
        const picked = pick[i];
        let channel: SalesPathLeg["channel"] = null;
        let costPerOutcomeUsd: number | null = null;
        let costPerPayingClientUsd: number | null = null;
        if (lc && picked) {
          const team = picked.operatedBy === "customer";
          if (!team) anyCosted = true;
          channel = {
            slug: picked.slug,
            name: picked.name,
            trigger: picked.trigger,
            managed: picked.managed,
            operatedBy: picked.operatedBy,
            costBenchmarkSource: picked.costBenchmarkSource,
            workflowDynastySlug: picked.workflowDynastySlug,
            grain: picked.grain,
            costSource: picked.costSource,
            choice: lc.chosen === null || lc.chosen.slug === picked.slug ? lc.choice : "alternative_channel",
            candidates: lc.candidates,
          };
          costPerOutcomeUsd = picked.costPerOutcomeUsd;
          if (costPerOutcomeUsd === null) {
            if (!team) costUnavailable = true;
          } else if (needed[i] !== null) {
            costPerPayingClientUsd = costPerOutcomeUsd * needed[i]!;
            total += costPerPayingClientUsd;
          }
        }
        return {
          legKey: d.legKey,
          ticked: scope === "ticked" || tickedLegs.has(d.legKey),
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
                  toReachedThroughOtherLegs: arrow.measured.toReachedThroughOtherLegs,
                  ratePct: arrow.measured.ratePct,
                  sufficient: arrow.measured.sufficient,
                },
                customerStatedPct: arrow.manualRatePct,
                fleetMedian: arrow.median,
                industryDefaultPct: arrow.defaultRatePct,
              }
            : null,
          workedBy: picked && picked.operatedBy === "platform" ? "platform" : "human",
          channel,
          outcomesNeededPerPayingClient: needed[i],
          costPerOutcomeUsd,
          costSource: channel?.costSource ?? null,
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
      else if (!anyCosted || total <= 0) roiUnavailableReason = "no_platform_cost";
      else if (ltr === null) roiUnavailableReason = "no_lifetime_revenue";
      const costPerPayingClientUsd = zeroRate || costUnavailable || !anyCosted ? null : total;
      const roi = roiUnavailableReason === null ? ltr! / total : null;

      const steps = [stepWire(defs[0].toStep.key), ...defs.slice(1).map((d) => stepWire(d.toStep.key))];
      return {
        combinationKey: combinationKeyOf(
          legs.map((l) => ({ legKey: l.legKey, channelSlug: l.channel?.operatedBy === "platform" ? l.channel.slug : null })),
        ),
        name: null,
        pathKey: legKeys.join("+"),
        legKeys,
        steps,
        entryLegKey: legKeys[0],
        entryChannelSlug: legs[0].channel?.slug ?? null,
        ticked: legs.every((l) => l.ticked),
        pricedOnBenchmark: legs.some((l) => l.costSource === "benchmark"),
        legs,
        entryToPayingClientPct,
        lifetimeRevenueUsd: ltr,
        costPerPayingClientUsd,
        roi,
        roiUnavailableReason,
      };
    });
  });

  const tie = (a: Omit<SalesPath, "rank">, b: Omit<SalesPath, "rank">) =>
    a.pathKey.localeCompare(b.pathKey) || a.combinationKey.localeCompare(b.combinationKey);
  paths.sort((a, b) => {
    if (a.pricedOnBenchmark !== b.pricedOnBenchmark) return a.pricedOnBenchmark ? 1 : -1;
    if (a.roi !== null && b.roi !== null) return b.roi - a.roi || tie(a, b);
    if (a.roi !== null) return -1;
    if (b.roi !== null) return 1;
    const ca = a.costPerPayingClientUsd ?? Infinity;
    const cb = b.costPerPayingClientUsd ?? Infinity;
    return ca - cb || tie(a, b);
  });

  return { ...base, scope, status: "ok", paths: paths.map((p, i) => ({ rank: i + 1, ...p })) };
}

/** PURE: the body with every row's name from `names` (keyed on `combinationKey`). Throws on a row left unnamed. */
export function withSalesPathNames(body: OfferSalesPathsBody, names: ReadonlyMap<string, string>): OfferSalesPathsBody {
  return {
    ...body,
    paths: body.paths.map((p) => {
      const name = names.get(p.combinationKey);
      if (!name) throw new Error(`sales path combination ${p.combinationKey} has no name`);
      return { ...p, name };
    }),
  };
}
