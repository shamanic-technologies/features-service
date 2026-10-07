/**
 * WHERE A LEAD COMES FROM — the SOURCING origins, a first-class part of the feature catalogue.
 *
 * A cold-email campaign does two different things, and a customer wants to see each one's cost:
 *   - SOURCING: finding the person to write to (an Apollo search on the audience's filters, a buying
 *     signal, people who engaged with a competitor's LinkedIn posts, the client's own CRM upload). In
 *     runs-service this is the whole cost subtree of a `lead-service:lead-serve` run: the pre-pay screen,
 *     the provider reveal and enrichment, email finding and verification.
 *   - OUTREACH: what is done with the person (the channel: writing, sending, reading replies).
 * Until 2026-10-07 the outreach feature carried both under its own slug; a campaign then read
 * "[sourcing origin] -> [outreach channel] -> outcome".
 *
 * ONE ORIGIN PER LIST KIND human-service states on an audience (`channels[].list`), so the origin of an
 * audience is a read of what human-service already knows, never a guess from a name or a cost name.
 * Each origin IS a feature slug (seeded in `seed/features.ts`, `acquisitionChannel: null`: an origin
 * produces no funnel step, it hands a person to a channel that does).
 *
 * ── THE TRANSITION (both states read correctly, nothing counted twice) ─────────────────────────────
 * Old runs: the serve subtree carries the OUTREACH slug it inherited. New runs (once lead-service and
 * human-service switch): it carries the ORIGIN's slug. So:
 *   - a serve's origin = its run's own slug when that slug is an origin, else its audience's list kind;
 *   - every runs-service SPEND read about a channel that sources leads also counts the origin slugs
 *     (`SOURCING_PARENT_CHANNEL_SLUGS`), so the campaign total of a campaign is the same in both states.
 *     A run carries exactly ONE slug, so an `IN (...)` filter counts it once either way.
 */

/** human-service's `channels[].list` values (GET /orgs/audiences). */
export type AudienceListKind = "apollo_search" | "apollo_buying_signal" | "linkedin_engagement" | "crm_contacts" | "apify_search";

export type SourcingFamily = "cold_filters" | "signal" | "own_contacts";

export interface SourcingOrigin {
  slug: string;
  name: string;
  /** One line a customer reads under the name. */
  description: string;
  family: SourcingFamily;
  /** The audience list kinds this origin is (human-service's vocabulary). */
  audienceLists: readonly AudienceListKind[];
  /** False on an origin nothing serves from any more (kept: its history still costs what it cost). */
  live: boolean;
  displayOrder: number;
}

export const SOURCING_ORIGINS: readonly SourcingOrigin[] = [
  {
    slug: "sourcing-apollo-cold-filters",
    name: "Apollo Cold Filters",
    description: "People who match your target, found on Apollo by title, company and location.",
    family: "cold_filters",
    audienceLists: ["apollo_search"],
    live: true,
    displayOrder: 101,
  },
  {
    slug: "sourcing-apollo-buying-signals",
    name: "Apollo Buying Signals",
    description: "People who match your target and show a buying signal right now.",
    family: "signal",
    audienceLists: ["apollo_buying_signal"],
    live: true,
    displayOrder: 102,
  },
  {
    slug: "sourcing-linkedin-engagement-signals",
    name: "LinkedIn Engagement Signals",
    description: "People who recently reacted to or commented on your competitors' LinkedIn posts.",
    family: "signal",
    audienceLists: ["linkedin_engagement"],
    live: true,
    displayOrder: 103,
  },
  {
    slug: "sourcing-crm-contacts",
    name: "Your CRM Contacts",
    description: "People from the contact list you uploaded.",
    family: "own_contacts",
    audienceLists: ["crm_contacts"],
    live: true,
    displayOrder: 104,
  },
  {
    slug: "sourcing-apify-search",
    name: "Apify Search",
    description: "People found by our former search provider. Retired, kept for its history.",
    family: "cold_filters",
    audienceLists: ["apify_search"],
    live: false,
    displayOrder: 105,
  },
];

export const SOURCING_ORIGIN_SLUGS: readonly string[] = SOURCING_ORIGINS.map((o) => o.slug);

const ORIGIN_BY_SLUG = new Map(SOURCING_ORIGINS.map((o) => [o.slug, o] as const));
const ORIGIN_BY_LIST = new Map<string, SourcingOrigin>(
  SOURCING_ORIGINS.flatMap((o) => o.audienceLists.map((l) => [l, o] as const)),
);

export function sourcingOriginBySlug(slug: string | null | undefined): SourcingOrigin | null {
  return slug ? (ORIGIN_BY_SLUG.get(slug) ?? null) : null;
}

export function sourcingOriginOfList(list: string | null | undefined): SourcingOrigin | null {
  return list ? (ORIGIN_BY_LIST.get(list) ?? null) : null;
}

/**
 * The channels whose runs SOURCE leads, and the origins each one serves from. A spend read about a
 * channel counts ONLY its own origins, so a brand running two of them never counts one channel's
 * sourcing under the other. Measured 2026-10-07 (runs × human-service audiences, lifetime):
 * `sales-cold-email-outreach` served apollo (202k) + apify (529) audiences, `feedback-request-cold-
 * email-outreach` apollo (519, inactive since 2026-08-25), `sales-crm-email-outreach` no audience so far,
 * and human-service routes CRM audiences onto it (never onto cold email). A channel that starts serving
 * another origin must list it here, or its spend reads lose that sourcing cost once serves carry the
 * origin slug.
 */
const SEARCH_AND_SIGNAL_ORIGINS = [
  "sourcing-apollo-cold-filters",
  "sourcing-apollo-buying-signals",
  "sourcing-linkedin-engagement-signals",
  "sourcing-apify-search",
] as const;
export const SOURCING_ORIGINS_BY_CHANNEL: Readonly<Record<string, readonly string[]>> = {
  "sales-cold-email-outreach": SEARCH_AND_SIGNAL_ORIGINS,
  "feedback-request-cold-email-outreach": SEARCH_AND_SIGNAL_ORIGINS,
  "sales-crm-email-outreach": ["sourcing-crm-contacts"],
};

export const SOURCING_PARENT_CHANNEL_SLUGS: readonly string[] = Object.keys(SOURCING_ORIGINS_BY_CHANNEL).sort();

/**
 * The slugs a runs-service SPEND read must filter on to count a channel's whole cost in both states:
 * the scope itself, plus the origins each sourcing channel of the scope serves from. Sorted +
 * de-duplicated, so the producer's `IN (...)` counts each run once.
 */
export function withSourcingSlugs(slugs: readonly string[]): string[] {
  const set = new Set(slugs);
  for (const s of slugs) for (const o of SOURCING_ORIGINS_BY_CHANNEL[s] ?? []) set.add(o);
  return [...set].sort();
}

/**
 * The origin of one serve: the run's own slug when it is an origin (new runs), else the list kind of
 * the audience it served from (old runs). Null = unknown (no audience on the run, or an audience
 * human-service states no list for): reported as unattributed, never guessed.
 */
export function originOfServe(input: {
  runFeatureSlug: string | null;
  audienceId: string | null;
  listOfAudience: ReadonlyMap<string, string | null>;
}): SourcingOrigin | null {
  const bySlug = sourcingOriginBySlug(input.runFeatureSlug);
  if (bySlug) return bySlug;
  if (!input.audienceId) return null;
  return sourcingOriginOfList(input.listOfAudience.get(input.audienceId) ?? null);
}
