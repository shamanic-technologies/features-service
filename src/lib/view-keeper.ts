import { and, gt, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots } from "../db/schema.js";
import { SEED_FEATURES } from "../seed/features.js";
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { decodeSnapshotBody, factsGateStats, familyKeyOf } from "./view-cache.js";
import { brandIdOfRequest, factsFingerprint } from "./view-facts.js";
import {
  brandScopesOf,
  canonicalRequest,
  headersFor,
  instancesOf,
  orderShapes,
  shapeKey,
  shapeOf,
  type BrandScopes,
  type RequestShape,
} from "./view-materializer.js";
import { PRECOMPUTE_HEADER, REFRESH_HEADER, VERIFY_HEADER, refresherBaseUrl } from "./view-refresher.js";

export { canonicalRequest } from "./view-materializer.js";

/**
 * THE VIEW KEEPER — keeps the Gold cell of every money read a customer dashboard can make READY before
 * it is asked for, keeps it no older than a day, and proves it says what a fresh computation says.
 *
 * MATERIALIZE. A cell nobody had read (a brand's first visit, a campaign just created, a query shape
 * that brand never opened) was a blocking cold compute on the customer's first read: 7-35s, almost all
 * of it waiting on ~13 sibling reads. Each round (`materializeRound`) takes the request SHAPES customers
 * read anywhere in the fleet over the last {@link SHAPE_WINDOW_MS} and instantiates them for every
 * (org, brand) that runs a channel, over every channel, campaign identity, offer and leg the brand runs
 * (`lib/view-materializer.ts`), and asks the refresher for each instance no cell holds yet, through the
 * ordinary read path (`x-view-precompute: 1`). The request is a real request of the org's own identity
 * (its most recent customer read's headers, ids swapped), so the SAME handler computes it and the cell
 * is byte-for-byte what that customer's first read would have computed — no figure is derived a second
 * way, nothing is approximated. A precompute is not a read: no `last_read_at`.
 *
 * KEEP FRESH. A held instance whose cell is older than {@link REASK_AFTER_MS} is asked again: the
 * refresher then serves it stale and refreshes it behind (facts-gated), so a cell a customer opens for
 * the first time in a week is at most a day old, and SWR brings it current on that same read.
 *
 * BOUNDED. At most {@link DEFAULT_KEEPER_CONCURRENCY} requests in flight, at most
 * {@link DEFAULT_KEEPER_MAX_PER_ROUND} per round and never past {@link DEFAULT_KEEPER_ROUND_BUDGET_MS}:
 * the refresher also answers customers, and every compute reads ~13 siblings.
 *
 * NOT COVERED, and why: an org that has never read a dashboard has no identity to replay under (every
 * route needs a real user of the org), so its brands are counted in `noIdentity` and computed on its
 * first read. A one-off request (a workflow drill-down, a lead list, a viewer's timezone) is not a shape.
 *
 * DRIFT CHECK. `checkDrift` replays a stored cell's request against the refresher in VERIFY mode (compute,
 * never persist) and compares the fresh body with what is stored, path by path. With `mode: "moment"` it
 * first refreshes the cell and then verifies it at once — the "stored vs fresh at the same moment" check;
 * with `mode: "stored"` it compares whatever is being served now, which also measures how stale the facts
 * gate lets a cell get. Every difference is reported loudly with its paths.
 */

/** A customer read this recent makes its request a shape, fleet-wide. */
const SHAPE_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** A held cell older than this is asked again (refreshed behind the answer). */
const REASK_AFTER_MS = 24 * 60 * 60_000;
const DEFAULT_KEEPER_INTERVAL_MS = 5 * 60_000;
const DEFAULT_KEEPER_MAX_PER_ROUND = 60;
const DEFAULT_KEEPER_CONCURRENCY = 2;
/**
 * A stale re-ask answers at once and refreshes BEHIND the answer inside the refresher, so the
 * concurrency bound does not hold it: they get their own, smaller, per-round cap.
 */
const DEFAULT_KEEPER_MAX_STALE_PER_ROUND = 8;
const DEFAULT_KEEPER_ROUND_BUDGET_MS = 4 * 60_000;
/** A precompute the handler refused (e.g. a 404 for a campaign with no funnel) is not retried for this long. */
const REFUSED_RETRY_MS = 6 * 60 * 60_000;
/** A precompute that finished is not re-asked for this long, even if its cell was never written. */
const DONE_RETRY_MS = 60 * 60_000;
/** A brand's campaign rows are re-read at most this often. */
const SCOPES_TTL_MS = 15 * 60_000;

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface PrecomputeReport {
  at: string;
  shapes: number;
  brands: number;
  noIdentity: number;
  instances: number;
  held: number;
  missing: number;
  stale: number;
  asked: number;
  computed: number;
  refreshedStale: number;
  refused: { url: string; status: number }[];
  deferred: number;
  errors: string[];
  durationMs: number;
}

interface Target {
  orgId: string;
  brandId: string;
  headers: Record<string, string>;
  lastReadMs: number;
}

interface WorkItem {
  url: string;
  headers: Record<string, string>;
  key: string;
  stale: boolean;
}

const refusedUntil = new Map<string, number>();
const doneUntil = new Map<string, number>();
const scopesCache = new Map<string, { at: number; scopes: BrandScopes }>();
let lastReport: PrecomputeReport | null = null;
let running = false;

const heldKey = (orgId: string, url: string) => `${orgId} ${url}`;

/** Test seam: forget what earlier rounds asked. */
export function __resetKeeperStateForTest(): void {
  refusedUntil.clear();
  doneUntil.clear();
  scopesCache.clear();
}

/** All seed feature slugs, as lead-service's membership read takes them. */
function allFeatureSlugsCsv(): string {
  return SEED_FEATURES.map((f) => f.slug).join(",");
}

async function scopesOf(target: Target): Promise<BrandScopes> {
  const key = `${target.orgId} ${target.brandId}`;
  const cached = scopesCache.get(key);
  if (cached && Date.now() - cached.at < SCOPES_TTL_MS) return cached.scopes;
  const rows = await fetchBrandCampaignRows(target.brandId, undefined, {
    orgId: target.orgId,
    userId: target.headers["x-user-id"],
    runId: target.headers["x-run-id"],
  });
  // The campaign read is org-scoped server-side; keep only this org's rows defensively.
  const scopes = brandScopesOf(target.brandId, rows.filter((r) => !r.orgId || r.orgId === target.orgId));
  scopesCache.set(key, { at: Date.now(), scopes });
  return scopes;
}

/** One materialize round (see the module doc). Bounded, never throws. */
export async function materializeRound(): Promise<PrecomputeReport> {
  const began = Date.now();
  const report: PrecomputeReport = {
    at: new Date(began).toISOString(),
    shapes: 0,
    brands: 0,
    noIdentity: 0,
    instances: 0,
    held: 0,
    missing: 0,
    stale: 0,
    asked: 0,
    computed: 0,
    refreshedStale: 0,
    refused: [],
    deferred: 0,
    errors: [],
    durationMs: 0,
  };
  const base = refresherBaseUrl();
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!base || !apiKey) {
    report.errors.push("no refresher up (or no api key) — nothing precomputed");
    return report;
  }
  const cap = positiveNumberEnv("VIEW_KEEPER_MAX_PER_ROUND", DEFAULT_KEEPER_MAX_PER_ROUND);
  const concurrency = positiveNumberEnv("VIEW_KEEPER_CONCURRENCY", DEFAULT_KEEPER_CONCURRENCY);
  const budgetMs = positiveNumberEnv("VIEW_KEEPER_ROUND_BUDGET_MS", DEFAULT_KEEPER_ROUND_BUDGET_MS);
  const staleCap = positiveNumberEnv("VIEW_KEEPER_MAX_STALE_PER_ROUND", DEFAULT_KEEPER_MAX_STALE_PER_ROUND);

  const cells = await db
    .select({
      replayUrl: featureViewSnapshots.replayUrl,
      replayHeaders: featureViewSnapshots.replayHeaders,
      orgId: featureViewSnapshots.orgId,
      brandId: featureViewSnapshots.brandId,
      lastReadAt: featureViewSnapshots.lastReadAt,
      computedAt: featureViewSnapshots.computedAt,
    })
    .from(featureViewSnapshots)
    .where(isNotNull(featureViewSnapshots.replayUrl));

  // What is held (newest cell per org + request), the fleet's shapes, and each org's identity.
  const held = new Map<string, number>();
  const shapes = new Map<string, RequestShape>();
  const identity = new Map<string, { headers: Record<string, string>; at: number }>();
  const brandLastRead = new Map<string, number>();
  const shapeCutoff = began - SHAPE_WINDOW_MS;
  for (const cell of cells) {
    if (!cell.replayUrl) continue;
    const computedMs = new Date(cell.computedAt).getTime();
    const key = heldKey(cell.orgId, canonicalRequest(cell.replayUrl));
    held.set(key, Math.max(held.get(key) ?? 0, computedMs));
    if (!cell.lastReadAt) continue;
    const readMs = new Date(cell.lastReadAt).getTime();
    const headers = (cell.replayHeaders ?? {}) as Record<string, string>;
    if (headers["x-user-id"] && headers["x-run-id"] && readMs > (identity.get(cell.orgId)?.at ?? 0)) {
      identity.set(cell.orgId, { headers, at: readMs });
    }
    if (cell.brandId) {
      const k = `${cell.orgId} ${cell.brandId}`;
      brandLastRead.set(k, Math.max(brandLastRead.get(k) ?? 0, readMs));
    }
    if (readMs < shapeCutoff) continue;
    const shape = shapeOf(cell.replayUrl);
    if (shape) shapes.set(shapeKey(shape), shape);
  }
  const ordered = orderShapes([...shapes.values()]);
  report.shapes = ordered.length;

  // Every (org, brand) that runs a channel, plus every brand a customer has read.
  const pairs = new Set<string>();
  try {
    for (const m of await fetchFeatureMemberships(allFeatureSlugsCsv())) pairs.add(`${m.orgId} ${m.brandId}`);
  } catch (err) {
    report.errors.push(`feature memberships: ${(err as Error).message.slice(0, 200)}`);
  }
  for (const k of brandLastRead.keys()) pairs.add(k);
  const targets: Target[] = [];
  for (const pair of pairs) {
    const [orgId, brandId] = pair.split(" ");
    const id = identity.get(orgId);
    if (!id) {
      report.noIdentity += 1;
      continue;
    }
    targets.push({ orgId, brandId, headers: id.headers, lastReadMs: brandLastRead.get(pair) ?? id.at - 1 });
  }
  // The brands customers read most recently first.
  targets.sort((a, b) => b.lastReadMs - a.lastReadMs || (a.brandId < b.brandId ? -1 : 1));
  report.brands = targets.length;

  const now = Date.now();
  for (const [k, until] of refusedUntil) if (until < now) refusedUntil.delete(k);
  for (const [k, until] of doneUntil) if (until < now) doneUntil.delete(k);

  const missing: WorkItem[] = [];
  const stale: WorkItem[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    let scopes: BrandScopes;
    try {
      scopes = await scopesOf(target);
    } catch (err) {
      report.errors.push(`campaigns of brand ${target.brandId}: ${(err as Error).message.slice(0, 200)}`);
      continue;
    }
    for (const shape of ordered) {
      for (const instance of instancesOf(shape, scopes)) {
        const key = heldKey(target.orgId, instance.url);
        if (seen.has(key)) continue;
        seen.add(key);
        report.instances += 1;
        if (refusedUntil.has(key) || doneUntil.has(key)) continue;
        const computedMs = held.get(key);
        const item = { url: instance.url, headers: headersFor(target.headers, target.brandId, instance), key, stale: computedMs !== undefined };
        if (computedMs === undefined) missing.push(item);
        else if (now - computedMs > REASK_AFTER_MS) stale.push(item);
        else report.held += 1;
      }
    }
  }
  report.missing = missing.length;
  report.stale = stale.length;

  // Missing cells first (a first read would block on them); a stale one is still served instantly.
  const queue = [...missing, ...stale.slice(0, staleCap)];
  const work = queue.slice(0, cap);
  report.deferred = queue.length - work.length + Math.max(0, stale.length - staleCap);
  await mapWithConcurrency(work, concurrency, async (item) => {
    if (Date.now() - began > budgetMs) {
      report.deferred += 1;
      return;
    }
    report.asked += 1;
    const headers: Record<string, string> = { ...item.headers, "x-api-key": apiKey, [PRECOMPUTE_HEADER]: "1" };
    try {
      const res = await fetch(`${base}${item.url}`, { headers, signal: AbortSignal.timeout(120_000) });
      await res.arrayBuffer();
      if (res.ok) {
        if (item.stale) report.refreshedStale += 1;
        else report.computed += 1;
        doneUntil.set(item.key, Date.now() + DONE_RETRY_MS);
      } else {
        refusedUntil.set(item.key, Date.now() + REFUSED_RETRY_MS);
        report.refused.push({ url: item.url, status: res.status });
      }
    } catch (err) {
      report.errors.push(`${item.url}: ${(err as Error).message.slice(0, 200)}`);
    }
  });
  report.durationMs = Date.now() - began;
  console.log(
    `[features-service] view keeper: ${report.shapes} shapes x ${report.brands} brands (${report.noIdentity} with no identity) -> ` +
      `${report.instances} cells, ${report.held} held fresh, ${report.missing} missing, ${report.stale} older than a day; ` +
      `${report.computed} precomputed, ${report.refreshedStale} refreshed, ${report.refused.length} refused, ${report.deferred} deferred, ` +
      `${report.errors.length} errors in ${report.durationMs}ms`,
  );
  return report;
}

/** Start the keeper loop (server role, outside tests). `VIEW_KEEPER_ENABLED=false` is the kill switch. */
export function startViewKeeper(): void {
  if (process.env.VIEW_KEEPER_ENABLED === "false") return;
  const interval = positiveNumberEnv("VIEW_KEEPER_INTERVAL_MS", DEFAULT_KEEPER_INTERVAL_MS);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      lastReport = await materializeRound();
    } catch (err) {
      console.error(`[features-service] view keeper round failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  // First round after the refresher has had time to come up.
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), interval).unref();
}

export function keeperStatus(): { lastRound: PrecomputeReport | null; running: boolean; factsGate: typeof factsGateStats } {
  return { lastRound: lastReport, running, factsGate: factsGateStats };
}

// ── Drift check ────────────────────────────────────────────────────────────────────────────────

export interface DriftCell {
  view: string;
  scopeKey: string;
  brandId: string | null;
  equal: boolean;
  differences: number;
  paths: string[];
  storedAgeMs: number;
  factsMoved: boolean | null;
  error?: string;
}

export interface DriftReport {
  mode: "moment" | "stored";
  cells: number;
  brands: number;
  equal: number;
  different: number;
  errors: number;
  results: DriftCell[];
}

/** Every path at which two JSON values differ (object keys unordered), capped at `max`. */
export function diffPaths(a: unknown, b: unknown, max = 20, path = "$", out: string[] = []): string[] {
  if (out.length >= max) return out;
  if (Object.is(a, b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length(${a.length}!=${b.length})`);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < max; i++) diffPaths(a[i], b[i], max, `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) {
      if (out.length >= max) break;
      diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], max, `${path}.${k}`, out);
    }
    return out;
  }
  out.push(path);
  return out;
}

async function askRefresher(
  base: string,
  url: string,
  headers: Record<string, string>,
  view: string,
  scopeKey: string,
  verify: boolean,
): Promise<unknown> {
  const apiKey = process.env.FEATURES_SERVICE_API_KEY ?? "";
  const target = Buffer.from(JSON.stringify({ view, familyKey: familyKeyOf(scopeKey) })).toString("base64url");
  const res = await fetch(`${base}${url}`, {
    headers: { ...headers, "x-api-key": apiKey, [REFRESH_HEADER]: target, ...(verify ? { [VERIFY_HEADER]: "1" } : {}) },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  const parsed = res.ok ? (JSON.parse(text) as Record<string, unknown>) : null;
  if (!parsed || !("__viewRefresherComputed" in parsed)) {
    throw new Error(`refresher answered ${res.status} without a computed value: ${text.slice(0, 200)}`);
  }
  return parsed.__viewRefresherComputed;
}

/**
 * Compare stored cells with a fresh computation (see the module doc). Bodies are compared AS SERVED
 * (the decoded snapshot vs the value the handler would cache) — nothing is normalised away.
 */
export async function checkDrift(opts: {
  mode: "moment" | "stored";
  brandId?: string;
  view?: string;
  limit: number;
  readWithinMs?: number;
}): Promise<DriftReport> {
  const base = refresherBaseUrl();
  if (!base) throw new Error("no refresher is up — a drift check needs one");
  const conditions = [isNotNull(featureViewSnapshots.replayUrl)];
  if (opts.brandId) conditions.push(sql`${featureViewSnapshots.brandId} = ${opts.brandId}`);
  if (opts.view) conditions.push(sql`${featureViewSnapshots.view} = ${opts.view}`);
  if (opts.readWithinMs) conditions.push(gt(featureViewSnapshots.lastReadAt, new Date(Date.now() - opts.readWithinMs)));
  const cells = await db
    .select()
    .from(featureViewSnapshots)
    .where(and(...conditions))
    .orderBy(featureViewSnapshots.view)
    .limit(opts.limit);

  const results: DriftCell[] = [];
  for (const cell of cells) {
    const headers = (cell.replayHeaders ?? {}) as Record<string, string>;
    const brandId = cell.brandId ?? (cell.replayUrl ? brandIdOfRequest(cell.replayUrl, headers) : null);
    const base0: DriftCell = {
      view: cell.view,
      scopeKey: cell.scopeKey,
      brandId,
      equal: false,
      differences: 0,
      paths: [],
      storedAgeMs: Date.now() - new Date(cell.computedAt).getTime(),
      factsMoved: null,
    };
    try {
      let stored: unknown;
      if (opts.mode === "moment") {
        stored = await askRefresher(base, cell.replayUrl!, headers, cell.view, cell.scopeKey, false);
        base0.storedAgeMs = 0;
      } else {
        stored = typeof cell.bodyText === "string" ? JSON.parse(cell.bodyText) : decodeSnapshotBody(cell.body);
      }
      const fresh = await askRefresher(base, cell.replayUrl!, headers, cell.view, cell.scopeKey, true);
      // A fresh value that went through JSON (as the stored one did) compares like for like.
      const paths = diffPaths(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(fresh)));
      base0.paths = paths;
      base0.differences = paths.length;
      base0.equal = paths.length === 0;
      if (brandId && cell.factsFingerprint) {
        const now = await factsFingerprint({ orgId: cell.orgId, brandId, userId: headers["x-user-id"], runId: headers["x-run-id"] });
        base0.factsMoved = now === null ? null : now !== cell.factsFingerprint;
      }
    } catch (err) {
      base0.error = (err as Error).message.slice(0, 300);
    }
    if (!base0.equal && !base0.error) {
      console.error(
        `[features-service] VIEW DRIFT view=${cell.view} brand=${brandId} mode=${opts.mode} differences=${base0.differences} ` +
          `paths=${base0.paths.slice(0, 5).join(",")}`,
      );
    }
    results.push(base0);
  }
  const brands = new Set(results.map((r) => r.brandId).filter(Boolean));
  return {
    mode: opts.mode,
    cells: results.length,
    brands: brands.size,
    equal: results.filter((r) => r.equal).length,
    different: results.filter((r) => !r.equal && !r.error).length,
    errors: results.filter((r) => r.error).length,
    results,
  };
}
