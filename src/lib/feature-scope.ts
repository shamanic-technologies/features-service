/**
 * WHICH ACQUISITION CHANNELS A READ IS ABOUT — one, or several.
 *
 * Every stats surface here used to be about exactly ONE feature slug, because the route names one.
 * An OFFER is sold through several channels at once (a channel IS a feature slug — see the catalogue
 * note at the top of CLAUDE.md), so a read at the offer grain is about a SET of them.
 *
 * This is deliberately the thinnest possible type: `string | string[]`. Every existing caller passes a
 * string and keeps compiling and behaving byte-identically, and only the offer routes pass an array.
 * Introducing a wrapper object instead would have touched every call site for no gain.
 *
 * ── WHY A CSV AT THE WIRE, AND WHY THAT IS NOT A GUESS ──────────────────────────────────────────
 *
 * The two producers that hold feature-scoped evidence already take a PLURAL parameter:
 * runs-service `featureSlugs` (`GET /v1/stats/costs` and `/v1/stats/public/costs/timeseries` both
 * comma-split it server-side) and email-gateway's `/orgs/stats` mirror of it. So a multi-channel read
 * is ONE call with a comma-joined value, not N calls summed here — which also means the producer does
 * the de-duplication, and a cost row counted under two slugs is impossible (a run carries exactly one
 * `feature_slug`).
 *
 * Where a producer takes only a SINGULAR slug, do NOT reach for this type: read once per channel and
 * merge, which is exact for anything a producer tags to one campaign. See
 * `fetchOfferDailyBroadcastActivity` in `routes/pipeline-activity.ts` for that shape.
 */
export type FeatureScope = string | string[];

/** The scope as a list, ascending + de-duplicated, so a scope is deterministic wherever it is keyed. */
export function featureSlugList(scope: FeatureScope): string[] {
  return [...new Set(typeof scope === "string" ? [scope] : scope)].sort();
}

/**
 * The value for a producer's plural `featureSlugs` parameter.
 *
 * A single-slug scope produces the slug itself, so every request this service already makes is byte
 * unchanged — which is what keeps a one-channel offer's answer identical to that channel's own read.
 */
export function featureSlugsParam(scope: FeatureScope): string {
  return featureSlugList(scope).join(",");
}

/**
 * The ONE channel this read is about, or `undefined` when it is about several.
 *
 * Used for two different things, and both are honest only because it is undefined for a mix:
 *   - the `x-feature-slug` / `x-brand-id`-style attribution headers, where naming one of several
 *     channels would attribute the whole read to it;
 *   - anything that is a PROPERTY OF ONE CHANNEL rather than of the evidence — the cross-org
 *     best-workflow benchmark above all. A benchmark is a channel's benchmark; there is no such thing
 *     as the benchmark of a mix, and combining two of them into one number would be the cross-workflow
 *     pooled estimate this service refuses to publish.
 */
export function soleFeatureSlug(scope: FeatureScope): string | undefined {
  const slugs = featureSlugList(scope);
  return slugs.length === 1 ? slugs[0] : undefined;
}
