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
 * The same cell answers the FLEET'S MATURE COHORT (`fetchFleetMatureSlugStats`): each pair's population is
 * held bucketed by (campaign, workflow slug, serve day), so the cohort a day-granular cutoff keeps is a sum
 * of whole buckets and no second walk is made.
 *
 * COST: one whole-population lead walk per (org, brand) running the feature — a fleet sweep, so it runs
 * off any interactive view's live lead copy (lib/lead-copy.ts) and is cached per feature with
 * stale-while-revalidate (15 min fresh / 6 h stale, single-flight). The cell is STORED (lib/fleet-cell-store.ts):
 * the server, the refresher and every new boot start from the last build, and one process rebuilds it. The REQUESTING pair is never read
 * from the cell: the caller hands over its own live repliers and they replace that pair's cached entry,
 * so a stale cell can only under-state OTHER brands — never put the fleet below the brand beside it.
 *
 * FAIL-LOUD: a pair whose walk fails fails the build. A cold cell therefore throws (the caller 502s)
 * rather than serve a fleet total missing a brand; a failed BACKGROUND refresh keeps the previous cell.
 */

import { mapWithConcurrency } from "./concurrency.js";
import { crmRepliesBySlug, fetchScopePersons, type PositiveReplier } from "./crm-only-repliers.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { outsideInteractiveView } from "./lead-copy.js";
import { claimFleetCellBuild, loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";
import { matureSlugStats, serveDatesStated } from "./mature-evidence.js";
import type { EnginePerson } from "./revenue-engine.js";

const FRESH_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
/** Whole-population walks held at once: ONE, because a big brand's parse is ~100 MB of a 384 MB heap. */
const PAIR_CONCURRENCY = 1;

/**
 * One pair's population, reduced to what a count needs: per (campaign, workflow slug, SERVE DAY), how many
 * of its deduped persons were contacted, clicked, replied positively. Kept per CAMPAIGN so a LEG-scoped
 * read keeps only that leg's campaigns, and per SERVE DAY so the mature cohort (`lib/maturity.ts`, a
 * day-granular cutoff on the serve clock) is a sum of whole buckets. A person never served sits on day
 * `""`, which every cutoff keeps (never lose information).
 */
interface PairPopulation {
  /** FALSE when this pair's rows state no serve date at all (a producer predating the field). */
  serveDatesStated: boolean;
  /** `${campaignId}\t${workflowSlug}\t${servedDay}` → [contacted, clicks, positive replies]. */
  buckets: Map<string, [number, number, number]>;
}

interface FleetCell {
  /** `${orgId}:${brandId}` → that pair's population, bucketed (see {@link PairPopulation}). */
  byPair: Map<string, PairPopulation>;
  computedAt: number;
}

const BUCKET_SEP = "\t";

/** PURE. Bucket one pair's deduped persons (see {@link PairPopulation}). */
export function bucketPopulation(persons: readonly EnginePerson[]): PairPopulation {
  const buckets = new Map<string, [number, number, number]>();
  for (const p of persons) {
    if (!p.signals.contacted && !p.signals.clicked && !p.signals.positiveReply) continue;
    const day = p.servedAt ? p.servedAt.slice(0, 10) : "";
    const key = [p.campaignId ?? "", p.workflowSlug ?? "", day].join(BUCKET_SEP);
    const b = buckets.get(key) ?? [0, 0, 0];
    if (p.signals.contacted) b[0] += 1;
    if (p.signals.clicked) b[1] += 1;
    if (p.signals.positiveReply) b[2] += 1;
    buckets.set(key, b);
  }
  return { serveDatesStated: serveDatesStated(persons), buckets };
}

function splitBucketKey(key: string): { campaignId: string; slug: string; day: string } {
  const [campaignId = "", slug = "", day = ""] = key.split(BUCKET_SEP);
  return { campaignId, slug, day };
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
      const persons = await fetchScopePersons(p.brandId, undefined, { orgId: p.orgId });
      return [key, bucketPopulation(persons)] as const;
    });
    return { byPair: new Map(entries), computedAt: Date.now() };
  });
}

/** The stored cell's key: the channel, and the stored FORMAT (bump it when {@link encodeCell} changes). */
const storeKeyOf = (featureSlug: string) => `${featureSlug}|cell=v1`;
/** How long one process may hold a rebuild before another takes over (a build walks the fleet: minutes). */
const BUILD_CLAIM_MS = 10 * 60_000;
/** How often a process whose cell has gone stale looks for a newer one another process stored. */
const STORE_CHECK_MS = 60_000;
const lastStoreCheck = new Map<string, number>();
/** When this process last found another one rebuilding a cell — it does not ask again for a while. */
const claimLostAt = new Map<string, number>();

/** EXPORTED FOR TESTS. A cell as stored text — every pair, every bucket, in insertion order. */
export function encodeCell(cell: FleetCell): string {
  return JSON.stringify({
    computedAt: cell.computedAt,
    byPair: [...cell.byPair].map(([key, pair]) => [key, pair.serveDatesStated, [...pair.buckets]]),
  });
}

/** EXPORTED FOR TESTS. The inverse of {@link encodeCell}. */
export function decodeCell(text: string): FleetCell {
  const raw = JSON.parse(text) as { computedAt: number; byPair: [string, boolean, [string, [number, number, number]][]][] };
  return {
    computedAt: raw.computedAt,
    byPair: new Map(raw.byPair.map(([key, serveDatesStated, buckets]) => [key, { serveDatesStated, buckets: new Map(buckets) }])),
  };
}

/** Adopt a newer cell another process (or a previous boot) stored, at most once per {@link STORE_CHECK_MS}. */
async function adoptStoredCell(featureSlug: string): Promise<void> {
  const now = Date.now();
  if (now - (lastStoreCheck.get(featureSlug) ?? 0) < STORE_CHECK_MS) return;
  lastStoreCheck.set(featureSlug, now);
  const stored = await loadFleetCell(storeKeyOf(featureSlug));
  if (!stored) return;
  const held = cells.get(featureSlug);
  if (held && held.computedAt >= stored.computedAt) return;
  cells.set(featureSlug, decodeCell(stored.text));
}

function refresh(featureSlug: string): Promise<FleetCell> {
  const existing = inFlight.get(featureSlug);
  if (existing) return existing;
  const p = (async () => {
    const held = cells.get(featureSlug);
    // Another process is rebuilding this cell: keep serving the one held; its build is adopted on a
    // later read. With nothing held at all the read must still be answered, so it builds.
    if (held && !(await claimFleetCellBuild(storeKeyOf(featureSlug), BUILD_CLAIM_MS))) {
      claimLostAt.set(featureSlug, Date.now());
      return held;
    }
    const cell = await buildCell(featureSlug);
    cells.set(featureSlug, cell);
    await storeFleetCell(storeKeyOf(featureSlug), encodeCell(cell), cell.computedAt);
    return cell;
  })().finally(() => inFlight.delete(featureSlug));
  inFlight.set(featureSlug, p);
  return p;
}

async function getCell(featureSlug: string): Promise<FleetCell> {
  const held = cells.get(featureSlug);
  if (!held || Date.now() - held.computedAt >= FRESH_MS) await adoptStoredCell(featureSlug);
  const cell = cells.get(featureSlug);
  const age = cell ? Date.now() - cell.computedAt : Infinity;
  if (cell && age < FRESH_MS) return cell;
  if (cell && age < STALE_MS) {
    // Another process holds the rebuild: its stored cell is adopted on a later read.
    if (Date.now() - (claimLostAt.get(featureSlug) ?? 0) < STORE_CHECK_MS) return cell;
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
  // LEG scope: keep only the repliers served under these campaigns (every org's campaigns performing
  // the leg). Omitted → every replier, the leg-less read, unchanged.
  campaignIds?: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const cell = await getCell(featureSlug);
  const ownKey = pairKey(own.orgId, own.brandId);
  const total = new Map<string, number>();
  for (const [key, pair] of cell.byPair) {
    if (key === ownKey) continue;
    for (const [bucketKey, [, , replies]] of pair.buckets) {
      if (replies === 0) continue;
      const { campaignId, slug } = splitBucketKey(bucketKey);
      if (!slug) continue;
      if (campaignIds && (!campaignId || !campaignIds.has(campaignId))) continue;
      total.set(slug, (total.get(slug) ?? 0) + replies);
    }
  }
  const scoped = campaignIds
    ? own.repliers.filter((r) => r.campaignId !== null && campaignIds.has(r.campaignId))
    : own.repliers;
  for (const [slug, n] of crmRepliesBySlug(scoped)) total.set(slug, (total.get(slug) ?? 0) + n);
  return total;
}

/**
 * THE FLEET'S MATURE COHORT per workflow slug (`lib/maturity.ts`): every (org, brand) pair's deduped
 * persons SERVED before `cutoffIso` (run-start clock) — how many were contacted, clicked, replied
 * positively — in email-gateway's stats shape. Restricted to `campaignIds` on a leg. The requesting pair
 * is never read from the cell: its own live persons replace it, exactly as for the positive repliers.
 *
 * NULL when any pair's rows state no serve date (a producer predating the field): the cohort cannot be cut,
 * and a count that silently kept every lead would be the flash figure under the mature name.
 */
export async function fetchFleetMatureSlugStats(
  featureSlug: string,
  /** The requesting pair, read LIVE. NULL on a fleet read with no requesting brand: every pair comes
   *  from the cell. */
  own: { orgId: string; brandId: string; persons: readonly EnginePerson[] } | null,
  cutoffIso: string,
  campaignIds?: ReadonlySet<string>,
): Promise<Map<string, Record<string, number>> | null> {
  if (own && !serveDatesStated(own.persons)) return null;
  const cell = await getCell(featureSlug);
  const ownKey = own ? pairKey(own.orgId, own.brandId) : null;
  const cutoffDay = cutoffIso.slice(0, 10);
  const counts = new Map<string, [number, number, number]>();
  for (const [key, pair] of cell.byPair) {
    if (key === ownKey) continue;
    if (!pair.serveDatesStated) return null;
    for (const [bucketKey, [c, k, r]] of pair.buckets) {
      const { campaignId, slug, day } = splitBucketKey(bucketKey);
      if (!slug || day >= cutoffDay) continue;
      if (campaignIds && (!campaignId || !campaignIds.has(campaignId))) continue;
      const t = counts.get(slug) ?? [0, 0, 0];
      t[0] += c;
      t[1] += k;
      t[2] += r;
      counts.set(slug, t);
    }
  }
  const total = new Map<string, Record<string, number>>(
    [...counts].map(([slug, [c, k, r]]) => [
      slug,
      { recipientsContacted: c, recipientsClicked: k, recipientsRepliesPositive: r },
    ]),
  );
  for (const [slug, stats] of own ? matureSlugStats(own.persons, cutoffIso, campaignIds ?? null) : []) {
    const prev = total.get(slug);
    if (!prev) {
      total.set(slug, { ...stats });
      continue;
    }
    for (const [k, v] of Object.entries(stats)) prev[k] = (prev[k] ?? 0) + v;
  }
  return total;
}

/** Build the cell ahead of the first read (boot). Fire-and-forget; a failure is logged, never thrown. */
export async function warmFleetPositiveRepliers(featureSlug: string): Promise<void> {
  try {
    // A boot starts from the stored cell and rebuilds only what is stale (getCell), never the whole fleet.
    await getCell(featureSlug);
  } catch (err) {
    console.error(`[features-service] fleet positive repliers warm failed (${featureSlug}):`, err);
  }
}

/** Test seam. */
export function __resetFleetPositiveRepliers(): void {
  cells.clear();
  inFlight.clear();
  lastStoreCheck.clear();
  claimLostAt.clear();
}
