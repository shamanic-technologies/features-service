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
  CHANNEL_STEPS,
  CHANNEL_STEP_KEYS,
  matchChannelStepKey,
  producibleStepsOf,
  sellableFunnelsFor,
  type ChannelFamily,
  type ChannelOperator,
  type ChannelStepKey,
  type ChannelStepTransition,
  type AcquisitionChannel,
} from "./acquisition-channels.js";
import { SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";

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
}

/** One leg, rendered: the step it takes a lead out of (null when the lead did not exist on the chain
 *  yet) and the step it moves them to, each carrying its own buyer-facing wording. */
export interface ChannelStepTransitionWire {
  from: ChannelStepDefWire | null;
  to: ChannelStepDefWire;
}

export interface PublicChannel {
  slug: string;
  name: string;
  description: string;
  icon: string;
  displayOrder: number;
  family: ChannelFamily;
  /** Who puts the hours in. A `customer`-operated channel spends none of the platform's money, which is
   *  what makes its zero daily operating cost a statement rather than a blank. */
  operatedBy: ChannelOperator;
  /** The commercial terms a buyer commits to, before any performance is measured. */
  terms: AcquisitionChannel["terms"];
  /** Every leg this channel performs, `from` → `to`. `from: null` is "from nothing". */
  stepTransitions: ChannelStepTransitionWire[];
  /** The steps this channel produces FROM NOTHING — the `to` of its entry legs. DERIVED; a channel that
   *  only performs internal legs of a chain legitimately produces none. */
  producibleSteps: ChannelStepDefWire[];
  /** The sales funnels this channel may be sold through — every chain one of its legs belongs to. */
  salesFunnels: Array<{ key: SalesFunnelKey; name: string; steps: readonly string[] }>;
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

  // `from: null` is a WRITTEN statement — the channel moves a lead from nothing onto the chain — so it
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

  if (!Array.isArray(blob.stepTransitions)) throw new MalformedAcquisitionChannelError(slug, "stepTransitions is not an array");
  const transitions = blob.stepTransitions.map((entry) => parseTransition(slug, entry));
  // A channel that performs no leg could be paired with no chain and sold to nobody; that is a broken
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

  return {
    family: blob.family,
    operatedBy: blob.operatedBy,
    stepTransitions: transitions,
    terms: {
      dailyOperatingCostCents: t.dailyOperatingCostCents,
      minimumCommitmentDays: t.minimumCommitmentDays,
      maxDaysToFirstProduction: t.maxDaysToFirstProduction,
    },
  };
}

const stepWire = (key: ChannelStepKey): ChannelStepDefWire => ({ ...CHANNEL_STEPS[key] });

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
export function buildChannelCatalogue(rows: readonly CatalogueFeatureRow[]): PublicChannel[] {
  const channels: PublicChannel[] = [];
  for (const row of rows) {
    if (row.supersededBySlug != null) continue;
    const channel = parseAcquisitionChannel(row.slug, row.acquisitionChannel);
    if (!channel) continue;
    channels.push({
      slug: row.slug,
      name: row.name,
      description: row.description,
      icon: row.icon,
      displayOrder: row.displayOrder,
      family: channel.family,
      operatedBy: channel.operatedBy,
      terms: channel.terms,
      stepTransitions: channel.stepTransitions.map((t) => ({
        from: t.from == null ? null : stepWire(t.from),
        to: stepWire(t.to),
      })),
      producibleSteps: producibleStepsOf(channel.stepTransitions).map(stepWire),
      salesFunnels: sellableFunnelsFor(channel.stepTransitions).map((key) => ({
        key,
        name: SALES_FUNNELS[key].name,
        steps: SALES_FUNNELS[key].steps,
      })),
    });
  }
  return channels.sort((a, b) => a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));
}

/** The step vocabulary itself, published beside the channels so a consumer never has to hardcode it. */
export function channelStepCatalogue(): ChannelStepDefWire[] {
  return CHANNEL_STEP_KEYS.map(stepWire);
}
