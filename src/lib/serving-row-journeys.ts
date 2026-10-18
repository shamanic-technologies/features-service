/**
 * A brand's timeline journeys, read for `lib/serving-row-credit.ts` (which row earned which signal). One
 * read per (org, brand), shared by every scope read in the same moment (a workflow-projection read asks the
 * brand, campaign and offer scopes at once) and held 60 s. FAIL-LOUD: the caller fails the way it fails on
 * its lead walk; never a silent return to the brand-wide attribution.
 */

import { fetchBrandJourneys } from "./brand-journeys-client.js";
import type { Journey } from "./lived-sales-paths.js";

const HOLD_MS = 60_000;
const held = new Map<string, { at: number; journeys: Promise<Journey[]> }>();

export function fetchServingRowJourneys(
  brandId: string,
  identity: { orgId: string; userId?: string; runId?: string },
): Promise<Journey[]> {
  const key = `${identity.orgId}:${brandId}`;
  const now = Date.now();
  const entry = held.get(key);
  if (entry && now - entry.at < HOLD_MS) return entry.journeys;
  const journeys = fetchBrandJourneys(brandId, identity).then((read) => {
    // The attribution keys on the SENDING workflow (`emailSends`, lead-service v0.83.116): a journey without
    // it would silently fall back to the serve row's workflow, the bug this read exists to fix. Fail loud.
    const missing = read.filter((j) => j.emailSends === undefined).length;
    if (missing > 0) {
      throw new Error(`lead-service timeline-journeys: ${missing} of ${read.length} journeys of brand ${brandId} state no emailSends`);
    }
    // Website visits count only on sends our tracker can screen (`lib/screened-visits.ts`): a send that states
    // no transport would read as "never screenable" and silently drop every visit. Fail loud.
    const unsplit = read.filter((j) => (j.emailSends ?? []).some((e) => e.screenable === undefined)).length;
    if (unsplit > 0) {
      throw new Error(`lead-service timeline-journeys: ${unsplit} of ${read.length} journeys of brand ${brandId} state sends with no transport`);
    }
    return read;
  });
  held.set(key, { at: now, journeys });
  journeys.catch(() => {
    if (held.get(key)?.journeys === journeys) held.delete(key);
  });
  // Bound the map: drop entries past their hold.
  for (const [k, v] of held) if (now - v.at >= HOLD_MS) held.delete(k);
  return journeys;
}

/** Test seam. */
export function __resetServingRowJourneys(): void {
  held.clear();
}
