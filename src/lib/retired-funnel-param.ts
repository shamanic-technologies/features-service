/**
 * `?funnel=` IS RETIRED (wave C2 of retiring the sales funnel as an identity).
 *
 * Since wave C1 every figure is priced from the brand's per-LEG rates and the offer's lifetime revenue,
 * read through the funnels a scope's campaigns' legs READ — so a caller naming a funnel was asking a
 * question the service no longer answers differently. No caller in the fleet sends it any more. A
 * request that still does is REFUSED, never silently ignored: dropping the parameter would answer a
 * different question than the one asked, with nothing on the body saying so.
 *
 * Name a leg (`?leg=`, where the route takes one) or nothing.
 */
export const FUNNEL_RETIRED_BODY = {
  error: "the funnel parameter is retired; name a leg (?leg=) or nothing",
  reason: "funnel_retired",
} as const;

/**
 * True when the request names a funnel. An EMPTY value (`?funnel=`) names nothing and was always read
 * as absent by every route, so it stays absent — refusing it would break a caller that merely builds
 * its query string with an empty slot, which is not a caller asking for a funnel.
 */
export function namesRetiredFunnel(query: Record<string, unknown>): boolean {
  const value = query.funnel;
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some((v) => v !== "");
  return value !== "";
}
