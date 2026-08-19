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
 */

import {
  CHANNEL_FAMILIES,
  PRODUCIBLE_STEPS,
  PRODUCIBLE_STEP_KEYS,
  matchProducibleStepKey,
  sellableFunnelsFor,
  type ChannelFamily,
  type ProducibleStepKey,
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

export interface PublicChannel {
  slug: string;
  name: string;
  description: string;
  icon: string;
  displayOrder: number;
  family: ChannelFamily;
  /** The commercial terms a buyer commits to, before any performance is measured. */
  terms: AcquisitionChannel["terms"];
  /** The kinds of step this channel can produce, each with its buyer-facing wording. */
  producibleSteps: Array<{ key: ProducibleStepKey; label: string; description: string }>;
  /** The sales funnels this channel may be sold through — every chain whose entry step it produces. */
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
const isWholeNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Read one row's stored blob into a channel, or throw. `null` means "not an acquisition channel" and
 *  is returned as `null` — that is a statement the row makes, not a parse failure. */
export function parseAcquisitionChannel(slug: string, raw: unknown): AcquisitionChannel | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new MalformedAcquisitionChannelError(slug, "not an object");
  const blob = raw as Record<string, unknown>;

  if (!isFamily(blob.family)) throw new MalformedAcquisitionChannelError(slug, `unknown family ${JSON.stringify(blob.family)}`);

  if (!Array.isArray(blob.producibleSteps)) throw new MalformedAcquisitionChannelError(slug, "producibleSteps is not an array");
  const steps: ProducibleStepKey[] = [];
  for (const entry of blob.producibleSteps) {
    if (typeof entry !== "string") throw new MalformedAcquisitionChannelError(slug, "a producible step is not a string");
    const key = matchProducibleStepKey(entry);
    if (!key) throw new MalformedAcquisitionChannelError(slug, `unknown producible step ${JSON.stringify(entry)}`);
    steps.push(key);
  }
  // A channel that can produce nothing could be paired with no funnel and sold to nobody; that is a
  // broken row rather than a restriction someone chose.
  if (steps.length === 0) throw new MalformedAcquisitionChannelError(slug, "produces no step at all");

  const rawTerms = blob.terms;
  if (typeof rawTerms !== "object" || rawTerms == null) throw new MalformedAcquisitionChannelError(slug, "terms missing");
  const t = rawTerms as Record<string, unknown>;
  // Money is whole cents and a day count is a whole number of days — a fractional price or a fractional
  // commitment is a corrupt row, not something to round into shape.
  if (!isWholeNonNegative(t.dailyOperatingCostCents)) throw new MalformedAcquisitionChannelError(slug, "dailyOperatingCostCents is not whole cents ≥ 0");
  if (!isPositiveInt(t.minimumCommitmentDays)) throw new MalformedAcquisitionChannelError(slug, "minimumCommitmentDays is not a whole number of days > 0");
  if (!isWholeNonNegative(t.maxDaysToFirstProduction)) throw new MalformedAcquisitionChannelError(slug, "maxDaysToFirstProduction is not a whole number of days ≥ 0");

  return {
    family: blob.family,
    producibleSteps: steps,
    terms: {
      dailyOperatingCostCents: t.dailyOperatingCostCents,
      minimumCommitmentDays: t.minimumCommitmentDays,
      maxDaysToFirstProduction: t.maxDaysToFirstProduction,
    },
  };
}

/**
 * Every acquisition channel among these feature rows, ordered as the catalogue orders features. A row
 * that is not a channel is simply not one of them.
 *
 * `salesFunnels` is DERIVED here from what the channel produces, exactly as the seed derives it, so the
 * public list and the stored column cannot disagree about which pairings exist.
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
      terms: channel.terms,
      producibleSteps: channel.producibleSteps.map((key) => ({ ...PRODUCIBLE_STEPS[key] })),
      salesFunnels: sellableFunnelsFor(channel.producibleSteps).map((key) => ({
        key,
        name: SALES_FUNNELS[key].name,
        steps: SALES_FUNNELS[key].steps,
      })),
    });
  }
  return channels.sort((a, b) => a.displayOrder - b.displayOrder || a.slug.localeCompare(b.slug));
}

/** The step vocabulary itself, published beside the channels so a consumer never has to hardcode it. */
export function producibleStepCatalogue(): ProducibleStepDefWire[] {
  return PRODUCIBLE_STEP_KEYS.map((key) => ({ ...PRODUCIBLE_STEPS[key] }));
}

export interface ProducibleStepDefWire {
  key: ProducibleStepKey;
  label: string;
  description: string;
}
