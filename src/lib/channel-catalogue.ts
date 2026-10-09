/**
 * THE PUBLIC ACQUISITION-CHANNEL CATALOGUE — what a customer can buy and on what terms, read off the
 * feature rows with no customer identity anywhere in the path.
 *
 * The marketing site is generated from this, which is the whole reason it is served rather than written
 * down twice: a page that restates the terms is a page that can drift from what we actually charge.
 *
 * Everything here is a pure reading of a feature row. Nothing measures, nothing fans out, and there is
 * no availability flag to read — every published channel is bookable, and a channel we are slower to
 * deliver says so through its own `maxDaysToFirstProduction` and `dailyOperatingCostCents`.
 *
 * A channel states the LEGS it performs (`stepTransitions`). `producibleSteps` — the steps it produces
 * from nothing — is DERIVED from those, and keeps its name and its meaning: it is what the catalogue
 * published back when producing an entry step was the only thing a channel could do.
 */

import {
  CHANNEL_FAMILIES,
  CHANNEL_OPERATORS,
  CHANNEL_PERFORMERS,
  CHANNEL_TRIGGERS,
  type ChannelTrigger,
  CHANNEL_STEPS,
  CHANNEL_STEP_KEYS,
  matchChannelStepKey,
  isProactiveTransition,
  producibleStepsOf,
  sellableFunnelsFor,
  SALES_FUNNEL_ENTRY_STEP,
  type ChannelFamily,
  type ChannelOperator,
  type ChannelPerformer,
  type ChannelStepKey,
  type ChannelStepTransition,
  type AcquisitionChannel,
} from "./acquisition-channels.js";
import { legKeyFor, FUNNEL_LEGS, OUTBOUND_LEG_KEY_CORRESPONDENCE, type FunnelLegDef } from "./funnel-legs.js";
import { channelTypeOf, type ChannelType } from "./channel-types.js";
import { sourcingOriginBySlug } from "./sourcing-origins.js";
import { SALES_PATH_CATALOGUE_CHANNEL_SLUGS } from "./sales-path-cost-benchmarks.js";
import { MANAGED_CHANNEL_SLUGS, channelLegMinimumMonthlyCents } from "./channel-leg-minimums.js";
import { legMaturity, type LegMaturity } from "./maturity.js";
import { channelShortDescription } from "./channel-short-descriptions.js";
import { SALES_FUNNELS, SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";
import { composeMinimumCommitment, minimumCommitmentDaysFor, type ComposedMinimumCommitment } from "./funnel-commercial-terms.js";

/** A feature row, narrowed to what the catalogue reads. */
export interface CatalogueFeatureRow {
  slug: string;
  name: string;
  description: string;
  icon: string;
  displayOrder: number;
  acquisitionChannel: unknown;
  /**
   * The slug that replaced this one, when this spelling is RETIRED. `null` is every current slug.
   * A retired row is never published — see `buildChannelCatalogue`.
   */
  supersededBySlug?: string | null;
}

export interface ChannelStepDefWire {
  key: ChannelStepKey;
  label: string;
  description: string;
  shortDescription: string;
}

/** One leg, rendered: the step it takes a lead out of (null when the lead did not exist on the funnel
 *  yet) and the step it moves them to, each carrying its own buyer-facing wording — plus the ONE
 *  canonical identifier of the leg it is (`lib/funnel-legs.ts`). The identifier is what the fleet
 *  keys a campaign and a budget on, so a consumer names this leg with `legKey` alone and reads
 *  `from`/`to` as data rather than splitting the string. An ENTRY leg carries an ordinary key too. */
export interface ChannelStepTransitionWire {
  /** The leg's single canonical identifier. Published contract — never parsed back into its parts. */
  legKey: string;
  from: ChannelStepDefWire | null;
  to: ChannelStepDefWire;
  /** RETIRED 2026-10-04 (owner): always null. Superseded by `campaignName`. Kept on the wire as null so
   *  no strict reader breaks. */
  crewName: null;
  /** The CAMPAIGN's name (this channel × this leg), shared across every client and stable forever, from
   *  the same pool as the sales path names and never equal to one (`lib/sales-path-names.ts`). Set on every
   *  leg of a `salesPathEligible` channel; null otherwise, and on the PURE build's output. */
  campaignName: string | null;
  /** True when the leg moves a lead out of a step it already reached (`from` set); false on an entry leg. */
  reactive: boolean;
  /** The minimum monthly budget a customer commits to this (channel × leg) item, whole cents (`lib/channel-leg-minimums.ts`). */
  minimumMonthlyBudgetCents: number;
}

export interface PublicChannel {
  slug: string;
  name: string;
  description: string;
  /** The one-line card caption under the channel's name (`lib/channel-short-descriptions.ts`); the
   *  channel twin of a step's `shortDescription`. `description` stays the long paragraph. */
  shortDescription: string;
  icon: string;
  displayOrder: number;
  /** WHAT KIND of channel this is, the ONE typology (`lib/channel-types.ts`). Supersedes `family`. */
  channelType: ChannelType;
  /** DEPRECATED, superseded by `channelType`. Served unchanged for its current readers. */
  family: ChannelFamily;
  /** Who puts the hours in: `platform` is us (our software, or a specialist of ours — the channel's NAME
   *  says which), `customer` is their own founder or team. A `customer`-operated channel puts nobody of
   *  ours on it, which is what makes its zero daily operating cost a statement rather than a blank. The
   *  converse does not hold: a platform-run channel can carry a zero day-rate too, so read this field
   *  for who is on it and never infer it from the price. */
  operatedBy: ChannelOperator;
  /** True when the platform runs this channel today (`MANAGED_CHANNEL_SLUGS`). */
  managed: boolean;
  /** True when the channel can appear in a sales path (`SALES_PATH_CATALOGUE_CHANNEL_SLUGS`). */
  salesPathEligible: boolean;
  /** WHAT does the leg's work: `software` (a machine end to end) or `person` (somebody by hand — the
   *  customer's team, a specialist of ours, a caller). Orthogonal to `operatedBy`: our agency channels
   *  are `platform` + `person`, our AI channel is `platform` + `software`. */
  performedBy: ChannelPerformer;
  /** What starts the channel's work. `daily_budget`: funded and paced on a daily budget (every channel
   *  but one). `step_reached`: runs when a lead reaches the step its leg moves out of (the instant call
   *  rings the moment a reply is qualified) — NOT fundable or schedulable, so offer no daily budget. */
  trigger: ChannelTrigger;
  /** The commercial terms a buyer commits to, before any performance is measured. */
  terms: AcquisitionChannel["terms"];
  /** Every leg this channel performs, `from` → `to`. `from: null` is "from nothing". */
  stepTransitions: ChannelStepTransitionWire[];
  /** The steps this channel produces FROM NOTHING — the `to` of its entry legs. DERIVED; a channel that
   *  only performs internal legs of a funnel legitimately produces none. */
  producibleSteps: ChannelStepDefWire[];
  /** The sales funnels this channel may be sold through — every funnel one of its legs belongs to.
   *  Each carries the pair's MINIMUM RUN LENGTH already composed against this channel's own
   *  `terms.minimumCommitmentDays`: a consumer renders `effectiveMinimumCommitmentDays` and never
   *  combines two of our fields. Note the same funnel legitimately reads a DIFFERENT effective figure
   *  under a different channel — the figure is a property of the pair, not of the funnel. */
  salesFunnels: Array<{
    key: SalesFunnelKey;
    name: string;
    steps: readonly string[];
  } & ComposedMinimumCommitment>;
}

/**
 * Thrown when a row's stored channel blob is not a channel. FAIL LOUD: a public price list that
 * silently drops or half-reads a malformed row would publish terms nobody set, which is worse than an
 * error page. There is no partial parse and no default.
 */
export class MalformedAcquisitionChannelError extends Error {
  constructor(slug: string, detail: string) {
    super(`Feature "${slug}" carries a malformed acquisition_channel: ${detail}`);
    this.name = "MalformedAcquisitionChannelError";
  }
}

const isFamily = (v: unknown): v is ChannelFamily => (CHANNEL_FAMILIES as readonly string[]).includes(v as string);
const isOperator = (v: unknown): v is ChannelOperator => (CHANNEL_OPERATORS as readonly string[]).includes(v as string);
const isPerformer = (v: unknown): v is ChannelPerformer => (CHANNEL_PERFORMERS as readonly string[]).includes(v as string);
const isTrigger = (v: unknown): v is ChannelTrigger => (CHANNEL_TRIGGERS as readonly string[]).includes(v as string);
const isWholeNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

function parseTransition(slug: string, raw: unknown): ChannelStepTransition {
  if (typeof raw !== "object" || raw == null || Array.isArray(raw)) {
    throw new MalformedAcquisitionChannelError(slug, "a step transition is not an object");
  }
  const entry = raw as Record<string, unknown>;

  if (typeof entry.to !== "string") throw new MalformedAcquisitionChannelError(slug, "a step transition states no `to`");
  const to = matchChannelStepKey(entry.to);
  if (!to) throw new MalformedAcquisitionChannelError(slug, `unknown step ${JSON.stringify(entry.to)}`);

  // `from: null` is a WRITTEN statement — the channel moves a lead from nothing onto the funnel — so it
  // must be stated, exactly like every other "this is the special case" answer in this catalogue. An
  // absent key is a row nobody finished, and reading it as "from nothing" would publish a channel as an
  // entry channel because a field was forgotten.
  if (!("from" in entry)) throw new MalformedAcquisitionChannelError(slug, "a step transition states no `from` (use null for 'from nothing')");
  let from: ChannelStepKey | null = null;
  if (entry.from != null) {
    if (typeof entry.from !== "string") throw new MalformedAcquisitionChannelError(slug, "a step transition's `from` is neither a step nor null");
    from = matchChannelStepKey(entry.from);
    if (!from) throw new MalformedAcquisitionChannelError(slug, `unknown step ${JSON.stringify(entry.from)}`);
  }

  // A leg that ends where it starts moves nobody anywhere.
  if (from === to) throw new MalformedAcquisitionChannelError(slug, `a step transition goes from ${to} to itself`);

  return { from, to };
}

/** Read one row's stored blob into a channel, or throw. `null` means "not an acquisition channel" and
 *  is returned as `null` — that is a statement the row makes, not a parse failure. */
export function parseAcquisitionChannel(slug: string, raw: unknown): AcquisitionChannel | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new MalformedAcquisitionChannelError(slug, "not an object");
  const blob = raw as Record<string, unknown>;

  if (!isFamily(blob.family)) throw new MalformedAcquisitionChannelError(slug, `unknown family ${JSON.stringify(blob.family)}`);
  if (!isOperator(blob.operatedBy)) throw new MalformedAcquisitionChannelError(slug, `unknown operator ${JSON.stringify(blob.operatedBy)}`);

  // Stated, never defaulted: a row missing it would publish a person's work as a machine's (or hide a
  // machine's legs as a person's), and nothing downstream could tell.
  if (!isPerformer(blob.performedBy)) throw new MalformedAcquisitionChannelError(slug, `unknown performer ${JSON.stringify(blob.performedBy)}`);
  // The customer's own team is people; a customer-operated channel run by software is a contradiction.
  if (blob.operatedBy === "customer" && blob.performedBy !== "person") {
    throw new MalformedAcquisitionChannelError(slug, "a customer-operated channel must be performed by a person");
  }

  if (!Array.isArray(blob.stepTransitions)) throw new MalformedAcquisitionChannelError(slug, "stepTransitions is not an array");
  const transitions = blob.stepTransitions.map((entry) => parseTransition(slug, entry));
  // A channel that performs no leg could be paired with no funnel and sold to nobody; that is a broken
  // row rather than a restriction someone chose.
  if (transitions.length === 0) throw new MalformedAcquisitionChannelError(slug, "performs no step transition at all");

  const rawTerms = blob.terms;
  if (typeof rawTerms !== "object" || rawTerms == null) throw new MalformedAcquisitionChannelError(slug, "terms missing");
  const t = rawTerms as Record<string, unknown>;
  // Money is whole cents and a day count is a whole number of days — a fractional price or a fractional
  // commitment is a corrupt row, not something to round into shape.
  if (!isWholeNonNegative(t.dailyOperatingCostCents)) throw new MalformedAcquisitionChannelError(slug, "dailyOperatingCostCents is not whole cents ≥ 0");
  if (!isPositiveInt(t.minimumCommitmentDays)) throw new MalformedAcquisitionChannelError(slug, "minimumCommitmentDays is not a whole number of days > 0");
  if (!isWholeNonNegative(t.maxDaysToFirstProduction)) throw new MalformedAcquisitionChannelError(slug, "maxDaysToFirstProduction is not a whole number of days ≥ 0");

  // A channel the CUSTOMER operates spends none of the platform's money, so any figure above zero here
  // would be us charging for a day of work we do not do.
  if (blob.operatedBy === "customer" && t.dailyOperatingCostCents !== 0) {
    throw new MalformedAcquisitionChannelError(slug, "a customer-operated channel states a non-zero daily operating cost");
  }

  // Absent on every blob predating the field, and every one of those is funded on a daily budget.
  if (blob.trigger !== undefined && !isTrigger(blob.trigger)) {
    throw new MalformedAcquisitionChannelError(slug, `unknown trigger ${JSON.stringify(blob.trigger)}`);
  }
  return {
    family: blob.family,
    operatedBy: blob.operatedBy,
    performedBy: blob.performedBy,
    ...(blob.trigger !== undefined ? { trigger: blob.trigger as ChannelTrigger } : {}),
    stepTransitions: transitions,
    terms: {
      dailyOperatingCostCents: t.dailyOperatingCostCents,
      minimumCommitmentDays: t.minimumCommitmentDays,
      maxDaysToFirstProduction: t.maxDaysToFirstProduction,
    },
  };
}

const stepWire = (key: ChannelStepKey): ChannelStepDefWire => ({ ...CHANNEL_STEPS[key] });

/** We run it today: the managed channels, and every LIVE sourcing origin (billing has treated a live
 *  origin's source campaign as managed since 2026-10-07). */
const isManagedChannel = (slug: string): boolean => MANAGED_CHANNEL_SLUGS.has(slug) || sourcingOriginBySlug(slug)?.live === true;

/**
 * Every acquisition channel among these feature rows, ordered as the catalogue orders features. A row
 * that is not a channel is simply not one of them.
 *
 * `producibleSteps` and `salesFunnels` are both DERIVED here from the legs the channel performs, exactly
 * as the seed derives them, so the public list and the stored column cannot disagree about which
 * pairings exist.
 *
 * A RETIRED SLUG IS NOT PUBLISHED. A row naming a successor in `supersededBySlug` is the same offering
 * under a spelling we no longer sell, so publishing it would render a second identical channel page,
 * split one offering's measured evidence across two identities, and invite a stranger to book the dead
 * one. The row itself is untouched — live campaigns, live budgets and the cost ledger reference it and
 * every authenticated read of it keeps answering. This reads the marker rather than any particular
 * slug, so the next retirement states its successor and needs nothing here.
 */
export function buildChannelCatalogue(
  rows: readonly CatalogueFeatureRow[],
  shortDescriptionOf: (slug: string) => string = channelShortDescription,
  channelTypeOfSlug: (slug: string) => ChannelType = channelTypeOf,
): PublicChannel[] {
  const channels: PublicChannel[] = [];
  for (const row of rows) {
    if (row.supersededBySlug != null) continue;
    const channel = parseAcquisitionChannel(row.slug, row.acquisitionChannel);
    if (!channel) continue;
    channels.push({
      slug: row.slug,
      name: row.name,
      description: row.description,
      shortDescription: shortDescriptionOf(row.slug),
      icon: row.icon,
      displayOrder: row.displayOrder,
      channelType: channelTypeOfSlug(row.slug),
      family: channel.family,
      operatedBy: channel.operatedBy,
      managed: isManagedChannel(row.slug),
      salesPathEligible: SALES_PATH_CATALOGUE_CHANNEL_SLUGS.has(row.slug),
      performedBy: channel.performedBy,
      trigger: channel.trigger ?? "daily_budget",
      terms: channel.terms,
      stepTransitions: channel.stepTransitions.map((t) => ({
        legKey: legKeyFor(t),
        from: t.from == null ? null : stepWire(t.from),
        to: stepWire(t.to),
        crewName: null,
        campaignName: null,
        reactive: !isProactiveTransition(t),
        minimumMonthlyBudgetCents: channelLegMinimumMonthlyCents({ slug: row.slug, operatedBy: channel.operatedBy }, !isProactiveTransition(t)),
      })),
      producibleSteps: producibleStepsOf(channel.stepTransitions).map(stepWire),
      salesFunnels: sellableFunnelsFor(channel.stepTransitions).map((key) => ({
        key,
        name: SALES_FUNNELS[key].name,
        steps: SALES_FUNNELS[key].steps,
        ...composeMinimumCommitment(channel.terms.minimumCommitmentDays, minimumCommitmentDaysFor(key)),
      })),
    });
  }
  return channels.sort((a, b) => a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));
}

/** One leg's MATURITY RULE as published: how long a run must have started ago before its spend and the
 *  leads it served count as mature, and how many mature outcomes of the leg's step make a scope mature
 *  (`lib/maturity.ts`, features-service#1196). The leg is the entry it rides on. */
export type PublishedLegMaturity = Omit<LegMaturity, "legKey">;

/** One leg of the published vocabulary, carrying its maturity rule. */
export type PublicFunnelLeg = FunnelLegDef & { reactive: boolean; maturity: PublishedLegMaturity };

/** The LEG vocabulary itself, published beside the channels so a consumer never has to hardcode it
 *  and never has to derive a leg from a pair of steps. Every leg of every declared funnel, each
 *  naming the funnels it is a leg of — usually several, which is why a campaign is bought per leg
 *  rather than per funnel. Their figures overlap and must never be summed. Each leg states its OWN
 *  maturity rule, read from the one module every figure is cut on, so a published parameter and a
 *  served figure can never disagree. */
export function funnelLegCatalogue(): PublicFunnelLeg[] {
  const funnelLegs = FUNNEL_LEGS.map((a) => {
    const { legKey: _legKey, ...maturity } = legMaturity(a.legKey);
    return {
      ...a,
      funnelKeys: [...a.funnelKeys],
      reactive: !isProactiveTransition({ from: (a.fromStep?.key as ChannelStepKey | undefined) ?? null }),
      maturity,
    };
  });
  // The OUTBOUND legs (wave 2, `lib/funnel-legs.ts`): what an outbound channel's entry leg is served as,
  // Lead found -> Positive reply / Website visit. Same funnels and maturity rule as the funnel's own entry
  // leg it feeds (a non-outbound channel still performs that one, `start_to_*`), appended so every leg
  // published before keeps its position.
  const outboundLegs = OUTBOUND_LEG_KEY_CORRESPONDENCE.map((c) => {
    const twin = funnelLegs.find((l) => l.legKey === c.legacyLegKey);
    if (!twin) throw new Error(`[features-service] outbound leg ${c.legKey}: the funnel leg ${c.legacyLegKey} is not in the catalogue`);
    return { ...twin, legKey: c.legKey, fromStep: { ...c.fromStep }, funnelKeys: [...twin.funnelKeys], reactive: false };
  });
  return [...funnelLegs, ...outboundLegs];
}

/** The step vocabulary itself, published beside the channels so a consumer never has to hardcode it. */
export function channelStepCatalogue(): ChannelStepDefWire[] {
  return CHANNEL_STEP_KEYS.map(stepWire);
}

/** One sales funnel, published in its own right rather than only nested inside the channels that sell
 *  it — so the list is complete whether or not a channel happens to sell a given funnel today, and so
 *  the STEP A FUNNEL STARTS ON is readable without walking anybody's legs. */
export interface PublicSalesFunnel {
  key: SalesFunnelKey;
  /** brand-service's own name for it. Customer-facing; the KEY is the wire token and never moves. */
  name: string;
  /** The funnel, in order, in brand-service's own wording. */
  steps: readonly string[];
  /**
   * The step this funnel STARTS on, as a step of the shared vocabulary.
   *
   * This is the join a consumer needs and the one it could not make before: "which funnels does this
   * producible step lead into" is `funnels.filter(f => f.entryStep.key === step.key)`, with no local
   * translation table and no string to compose. A channel's `producibleSteps` are spelled in exactly
   * these tokens, which is what makes the match a lookup rather than a guess.
   */
  entryStep: ChannelStepDefWire;
  /** The entry leg's canonical identifier, so a consumer can key the same join on the leg vocabulary
   *  it already uses for everything else instead of composing `start_to_<step>` itself. */
  entryLegKey: string;
}

/**
 * Every declared sales funnel, in the catalogue's canonical order, mirrored from brand-service.
 *
 * Published beside the channels because the channel list alone cannot answer "what is the catalogue":
 * a funnel no channel currently sells would simply be invisible, and a consumer would read its absence
 * as a statement we never made.
 */
export function salesFunnelCatalogue(): PublicSalesFunnel[] {
  return SALES_FUNNEL_KEYS.map((key) => {
    const entryStepKey = SALES_FUNNEL_ENTRY_STEP[key];
    return {
      key,
      name: SALES_FUNNELS[key].name,
      steps: SALES_FUNNELS[key].steps,
      entryStep: stepWire(entryStepKey),
      entryLegKey: legKeyFor({ from: null, to: entryStepKey }),
    };
  });
}
