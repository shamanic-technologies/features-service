/**
 * WHICH ACQUISITION CHANNELS A BRAND RUNS — the offer partition, read one narrowing wider.
 *
 * `offer-channels.ts` answers "which channels is THIS OFFER sold through". A brand holds several
 * offers and each of those sells through several channels, so the brand's own channel set is neither
 * one offer's set nor the union assembled by a consumer: it is every channel any campaign of the brand
 * runs through, and it lives on the campaign row exactly as the offer's does.
 *
 * ── THE QUESTION, AND WHY IT IS BROKEN TODAY ────────────────────────────────────────────────────
 *
 * The brand Overview reads a per-FEATURE endpoint, so its money describes ONE acquisition channel
 * while the page presents it as the brand's. Since a brand now runs several channels, the figure is
 * short by whatever the others did — and it shows up as a FRACTION with two grains in it: the
 * numerator is one channel's spend, the denominator is billing's BRAND daily budget. Prod 2026-08-20,
 * brand `75d7e3e8…`: `sales-cold-email-outreach` spent $40.07 today against its own $40 ceiling,
 * `feedback-request-cold-email-outreach` spent $10.32 against its own $10, and the page read
 * "$40 / 50". Both halves are real; they are simply about different things, and nothing errors.
 *
 * ── WHAT THIS MODULE ASSUMES, AND WHAT IT DOES NOT ──────────────────────────────────────────────
 *
 * Exactly what `offer-channels.ts` assumes: campaign-service owns the campaign row and states the
 * `featureSlug` it runs through. Nothing is inferred and nothing is re-attributed. The read is NOT
 * narrowed to a feature slug, because the set of slugs is the answer — a caller cannot be asked to
 * enumerate the channels first, since it does not own that list.
 *
 * ── THE CAMPAIGN IDS ARE FOR THE READER, NOT FOR THE SCOPE ──────────────────────────────────────
 *
 * The offer grain SCOPES on its campaign ids, because a campaign is the frozen link between an offer
 * and its evidence. A brand needs no such narrowing: `brandId` is itself a producer filter on every
 * read here, so the brand grain scopes on the CHANNEL SET alone and leaves the campaign filter
 * unset. Two consequences, both wanted:
 *
 *   - a campaign campaign-service does not list still has its spend counted, because the money is
 *     read by (brand × channel) and never by an enumerated campaign list;
 *   - a brand running exactly ONE channel issues the byte-same downstream requests its own
 *     per-feature read issues today, so its answer cannot move.
 *
 * The ids ride each channel row of the breakdown all the same, so a reader can see what a row is made
 * of without a second call.
 */
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";

/** One acquisition channel a brand runs, and the campaigns campaign-service lists for it. */
export interface BrandChannel {
  /** The channel — a feature slug, this fleet's only name for an acquisition channel. */
  featureSlug: string;
  /** The brand's campaigns campaign-service states run through this channel, ascending. */
  campaignIds: string[];
}

/**
 * A read named a brand campaign-service lists no campaign for.
 *
 * Its own type because the route answers it 404 with a named reason rather than 502: a brand running
 * no channel has no channel-scoped evidence, and there is no number to serve. Distinguishable from a
 * campaign-service OUTAGE, which fails loud for the opposite reason — with the channel set unreadable
 * we cannot tell which channels the money should span, and answering anyway would print a figure
 * about an unknown subset of them, which is the exact bug this grain removes.
 */
export class BrandHasNoChannelsError extends Error {
  constructor(readonly brandId: string) {
    super(
      `campaign-service lists no campaign for brand ${brandId}, so it runs no acquisition channel and there is nothing to measure`,
    );
    this.name = "BrandHasNoChannelsError";
  }
}

/** PURE: partition a brand's campaign rows by the channel each one runs through. */
export function buildBrandChannels(rows: CampaignIdentityRow[]): BrandChannel[] {
  const byChannel = new Map<string, string[]>();
  for (const row of rows) {
    // A row stating no channel cannot be told from another channel's, and answering per channel is
    // the whole point here — so it is deliberately in no bucket rather than parked on one. Its money
    // is NOT lost: the brand grain reads spend by (brand × channel set), so a campaign missing from
    // this list still counts under whichever channel its runs were tagged with.
    if (!row.featureSlug) continue;
    const bucket = byChannel.get(row.featureSlug);
    if (bucket) {
      if (row.id) bucket.push(row.id);
    } else byChannel.set(row.featureSlug, row.id ? [row.id] : []);
  }
  return [...byChannel.entries()]
    .map(([featureSlug, campaignIds]) => ({ featureSlug, campaignIds: [...campaignIds].sort() }))
    .sort((a, b) => (a.featureSlug < b.featureSlug ? -1 : a.featureSlug > b.featureSlug ? 1 : 0));
}

/**
 * Read EVERY campaign of the brand — no channel narrowing — and partition by channel.
 *
 * FAIL-LOUD. The channel set IS the scope here: with it unreadable there is no way to know how many
 * channels a figure should span, so the only alternative to failing is answering about an unknown
 * subset of them under the brand's name.
 */
export async function fetchBrandChannels(
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<BrandChannel[]> {
  return buildBrandChannels(await fetchBrandCampaignRows(brandId, undefined, headers));
}

/**
 * The channels a brand runs.
 *
 * Throws {@link BrandHasNoChannelsError} rather than returning `[]`: an empty channel set reads as
 * UNFILTERED everywhere downstream (no producer takes an empty `featureSlugs` to mean "nothing"), so
 * returning it would silently widen a brand's cold-email question into every feature it ever touched.
 */
export async function resolveBrandChannels(
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<BrandChannel[]> {
  const channels = await fetchBrandChannels(brandId, headers);
  if (channels.length === 0) throw new BrandHasNoChannelsError(brandId);
  return channels;
}

/** Every channel the brand runs, ascending — the feature scope its money is read over. */
export function brandFeatureSlugs(channels: BrandChannel[]): string[] {
  return channels.map((channel) => channel.featureSlug);
}
