/**
 * WHAT KIND OF CHANNEL A FEATURE IS — the ONE typology (owner 2026-10-09).
 *
 * Every channel and every leg of a sales funnel is the same kind of thing and is treated the same way.
 * Channels differ only by this TYPE, which lets a surface structure what it shows (a Sourcing page lists
 * the `sourcing` channels, an Outbound page the `outbound` ones) without the user getting lost. A surface
 * groups or excludes channels by `channelType`, never by "does this feature carry an acquisition-channel
 * block" and never by a slug list of its own.
 *
 * It SUPERSEDES the acquisition-channel `family` (`outbound_one_to_one | paid_reach | earned | conversion`):
 * the owner wants one typology, not two. `family` is still served, unchanged, for its current readers (the
 * admin model page) and marked deprecated on the wire; nothing new keys on it.
 *
 * Stated on EVERY feature, active and deprecated, channel or not: `tool` is the type of the features that
 * are not a channel at all (scoring, page generation, outlet discovery). Membership is the owner's, listed
 * here once; `channel-types.test.ts` fails when a seeded feature has no type or a type names no feature.
 */

export const CHANNEL_TYPES = [
  "sourcing",
  "outbound",
  "conversion",
  "paid",
  "earned",
  "pr",
  "fundraising",
  "hiring",
  "tool",
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** The owner's membership (2026-10-09), verbatim. */
const MEMBERS: Record<ChannelType, readonly string[]> = {
  sourcing: [
    "sourcing-apollo-cold-filters",
    "sourcing-apollo-buying-signals",
    "sourcing-linkedin-engagement-signals",
    "sourcing-crm-contacts",
    "sourcing-apify-search",
  ],
  outbound: [
    "sales-cold-email-outreach",
    "feedback-request-cold-email-outreach",
    "sales-crm-email-outreach",
    "cold-call-outreach",
    "cold-instagram-outreach",
    "cold-linkedin-outreach",
    "cold-reddit-outreach",
    "cold-sms-outreach",
    "cold-whatsapp-outreach",
    "cold-x-outreach",
  ],
  conversion: [
    "ai-meeting-booking",
    "ai-instant-call",
    "agency-meeting-booking",
    "your-team-meeting-booking",
    "agency-meeting-attendance",
    "your-team-meeting-attendance",
    "agency-closing-calls",
    "your-team-closing-calls",
    "agency-signup-conversion",
    "your-team-signup-conversion",
  ],
  paid: [
    "google-ads",
    "meta-ads",
    "linkedin-ads",
    "tiktok-ads",
    "youtube-ads",
    "x-ads",
    "reddit-ads",
    "bing-ads",
    "quora-ads",
    "newsletter-sponsorships",
    "podcast-sponsorships",
    "creator-sponsorships",
    "paid-directory-listings",
  ],
  earned: [
    "seo-content",
    "podcast-guesting",
    "affiliate-programme",
    "organic-linkedin-publishing",
    "organic-x-publishing",
    "organic-reddit-publishing",
    "organic-youtube-publishing",
  ],
  pr: ["pr-cold-email-outreach", "press-placements", "pr-expert-quote-opportunities", "pr-expert-quote-outreach"],
  fundraising: ["vc-cold-email-outreach", "accelerators-cold-email-outreach"],
  hiring: ["hiring-cold-email-outreach"],
  tool: ["ai-visibility-scoring", "press-kit-page-generation", "outlet-database-discovery"],
};

const TYPE_BY_SLUG: ReadonlyMap<string, ChannelType> = new Map(
  CHANNEL_TYPES.flatMap((type) => MEMBERS[type].map((slug) => [slug, type] as const)),
);

/** Every slug the typology names, for the guard test. */
export const CHANNEL_TYPED_SLUGS: readonly string[] = [...TYPE_BY_SLUG.keys()];

/** Thrown when a feature has no stated type. FAIL LOUD: a feature without one would fall out of every
 *  surface that groups by type, silently. */
export class UntypedFeatureError extends Error {
  constructor(slug: string) {
    super(`Feature "${slug}" states no channelType (lib/channel-types.ts)`);
    this.name = "UntypedFeatureError";
  }
}

export function channelTypeOf(slug: string): ChannelType {
  const type = TYPE_BY_SLUG.get(slug);
  if (!type) throw new UntypedFeatureError(slug);
  return type;
}

/** The OUTBOUND slugs: the only channels whose legs are re-keyed `lead_found_to_*` (LOCKED, owner 2026-10-09). */
export const OUTBOUND_CHANNEL_SLUGS: ReadonlySet<string> = new Set(MEMBERS.outbound);

export const isOutboundChannel = (slug: string | null | undefined): boolean => !!slug && OUTBOUND_CHANNEL_SLUGS.has(slug);

/** A served feature row, with its type stated beside the stored columns. */
export function withChannelType<R extends { slug: string }>(row: R): R & { channelType: ChannelType } {
  return { ...row, channelType: channelTypeOf(row.slug) };
}
