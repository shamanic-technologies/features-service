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
import { withSourcingSlugs } from "./sourcing-origins.js";

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

/**
 * WHICH SLUGS A RUNS-SERVICE SPEND READ COUNTS for a channel (owner 2026-10-11: a sourcing pipe's spend is its OWN cost
 * and ROI, no longer folded into the outreach pipe's):
 *   - `fed`: the channel PLUS the sourcing origins that feed it (`runsFeatureSlugsParam`). What a scope SPENT and what a
 *     budget BUYS: money totals, the forecasts (workflow-projection ladders, pipeline activity, outcome prices), since a
 *     budget pays the sourcing its outreach asks for.
 *   - `own`: the channel's slugs alone (`runsOwnFeatureSlugsParam`). A PIPE's own measured cost, the one the agent
 *     catalogue prices a pipe and composes a funnel with (`routes/agent-catalogue.ts`): every sourcing pipe is measured
 *     on its own slug, so the outreach pipe is its outreach alone and two funnels that differ only by their source
 *     price differently.
 */
export type SpendSlugs = "fed" | "own";

/** A channel's OWN slugs (see `SpendSlugs`). */
export function runsOwnFeatureSlugsParam(scope: FeatureScope): string {
  return featureSlugsParam(scope);
}

/** The slugs of `mode` for `scope`. */
export function runsSpendSlugsParam(scope: FeatureScope, mode: SpendSlugs): string {
  return mode === "own" ? runsOwnFeatureSlugsParam(scope) : runsFeatureSlugsParam(scope);
}

/** `mode`, or `fed` when both read the same slugs (a channel no origin feeds): one cache cell, never two equal ones. */
export function effectiveSpendSlugs(scope: FeatureScope, mode: SpendSlugs): SpendSlugs {
  return mode === "own" && runsOwnFeatureSlugsParam(scope) !== runsFeatureSlugsParam(scope) ? "own" : "fed";
}

/**
 * The value for runs-service's `featureSlugs` on a MONEY read (what a campaign, offer, brand or org SPENT): the scope, plus every sourcing origin slug
 * when the scope holds a channel that sources leads (`lib/sourcing-origins.ts`). A serve run carries the
 * outreach slug today and its origin's slug once lead-service / human-service switch, so a spend figure
 * reads the same in both states; a run carries ONE slug, so the producer's `IN (...)` counts it once.
 * Only for runs-service: email-gateway, workflow-service and lead reads keep `featureSlugsParam`.
 * `releasedOriginSlugs`: the origins a pipe's sibling sourcing pipe owns (`pipeRunsScope`); omitted = byte-identical.
 */
export function runsFeatureSlugsParam(scope: FeatureScope, releasedOriginSlugs: readonly string[] = []): string {
  // An origin a sibling sourcing pipe owns (`lib/pipe-spend-attribution.ts`) leaves the EXPANSION only: a slug the
  // scope names itself is never dropped, so the filter can never go empty (= unfiltered at runs).
  const own = new Set(featureSlugList(scope));
  return withSourcingSlugs([...own])
    .filter((s) => own.has(s) || !releasedOriginSlugs.includes(s))
    .join(",");
}
