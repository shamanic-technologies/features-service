/**
 * The FLEET's positive repliers per workflow slug, counted on the SAME per-person basis the brand /
 * offer / campaign grains count them on (`fetchPositiveRepliers` — CRM evidence included, one per lead).
 *
 * Why this exists: those finer grains moved off email-gateway's per-slug sums onto the person set
 * (#1075/#1078), while the crossOrg grain kept reading email-gateway's fleet sums. Two bases under one
 * word, and the fleet can then state FEWER replies than a brand it contains — prod 2026-09-27, brand
 * `75d7e3e8…` / nimbus: crossOrg 0 positive replies beside a brand grain of 1 (a CRM-evidenced reply
 * email-gateway cannot see). Here the fleet count is the SUM over every (org, brand) pair of that pair's
 * person count, so every finer grain is a subset by construction.
 *
 * COST: one whole-population lead walk per (org, brand) running the feature — a fleet sweep, so it runs
 * off any interactive view's live lead copy (lib/lead-copy.ts) and is cached per feature with
 * stale-while-revalidate (15 min fresh / 6 h stale, single-flight). The REQUESTING pair is never read
 * from the cell: the caller hands over its own live repliers and they replace that pair's cached entry,
 * so a stale cell can only under-state OTHER brands — never put the fleet below the brand beside it.
 *
 * FAIL-LOUD: a pair whose walk fails fails the build. A cold cell therefore throws (the caller 502s)
 * rather than serve a fleet total missing a brand; a failed BACKGROUND refresh keeps the previous cell.
 */

import { mapWithConcurrency } from "./concurrency.js";
import { crmRepliesBySlug, fetchPositiveRepliers, type PositiveReplier } from "./crm-only-repliers.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { outsideInteractiveView } from "./lead-copy.js";

const FRESH_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
/** Whole-population walks held at once: ONE, because a big brand's parse is ~100 MB of a 384 MB heap. */
const PAIR_CONCURRENCY = 1;

interface FleetCell {
  /** `${orgId}:${brandId}` → distinct positive repliers per workflow slug. */
  byPair: Map<string, Map<string, number>>;
  computedAt: number;
}

const cells = new Map<string, FleetCell>();
const inFlight = new Map<string, Promise<FleetCell>>();

const pairKey = (orgId: string, brandId: string) => `${orgId}:${brandId}`;

async function buildCell(featureSlug: string): Promise<FleetCell> {
  return outsideInteractiveView(async () => {
    const memberships = await fetchFeatureMemberships(featureSlug);
    const pairs = new Map<string, { orgId: string; brandId: string }>();
    for (const m of memberships) {
      if (m.orgId && m.brandId) pairs.set(pairKey(m.orgId, m.brandId), { orgId: m.orgId, brandId: m.brandId });
    }
    const entries = await mapWithConcurrency([...pairs.entries()], PAIR_CONCURRENCY, async ([key, p]) => {
      const repliers = await fetchPositiveRepliers(p.brandId, undefined, { orgId: p.orgId });
      return [key, crmRepliesBySlug(repliers)] as const;
    });
    return { byPair: new Map(entries), computedAt: Date.now() };
  });
}

function refresh(featureSlug: string): Promise<FleetCell> {
  const existing = inFlight.get(featureSlug);
  if (existing) return existing;
  const p = buildCell(featureSlug)
    .then((cell) => {
      cells.set(featureSlug, cell);
      return cell;
    })
    .finally(() => inFlight.delete(featureSlug));
  inFlight.set(featureSlug, p);
  return p;
}

async function getCell(featureSlug: string): Promise<FleetCell> {
  const cell = cells.get(featureSlug);
  const age = cell ? Date.now() - cell.computedAt : Infinity;
  if (cell && age < FRESH_MS) return cell;
  if (cell && age < STALE_MS) {
    refresh(featureSlug).catch((err) =>
      console.error(`[features-service] fleet positive repliers refresh failed (${featureSlug}), keeping previous cell:`, err),
    );
    return cell;
  }
  return refresh(featureSlug);
}

/**
 * Fleet positive repliers per workflow slug for `featureSlug`: every other (org, brand) pair from the
 * cell, plus the requesting pair's OWN live repliers in place of its cached entry.
 */
export async function fetchFleetPositiveRepliesBySlug(
  featureSlug: string,
  own: { orgId: string; brandId: string; repliers: readonly PositiveReplier[] },
): Promise<Map<string, number>> {
  const cell = await getCell(featureSlug);
  const ownKey = pairKey(own.orgId, own.brandId);
  const total = new Map<string, number>();
  const add = (bySlug: Map<string, number>) => {
    for (const [slug, n] of bySlug) total.set(slug, (total.get(slug) ?? 0) + n);
  };
  for (const [key, bySlug] of cell.byPair) if (key !== ownKey) add(bySlug);
  add(crmRepliesBySlug(own.repliers));
  return total;
}

/** Build the cell ahead of the first read (boot). Fire-and-forget; a failure is logged, never thrown. */
export async function warmFleetPositiveRepliers(featureSlug: string): Promise<void> {
  try {
    await refresh(featureSlug);
  } catch (err) {
    console.error(`[features-service] fleet positive repliers warm failed (${featureSlug}):`, err);
  }
}

/** Test seam. */
export function __resetFleetPositiveRepliers(): void {
  cells.clear();
  inFlight.clear();
}
