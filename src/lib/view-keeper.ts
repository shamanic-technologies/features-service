import { and, gt, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots } from "../db/schema.js";
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import { buildCampaignFamilies, type CampaignIdentityRow } from "./campaign-identity.js";
import { decodeSnapshotBody, factsGateStats, familyKeyOf } from "./view-cache.js";
import { brandIdOfRequest, factsFingerprint } from "./view-facts.js";
import { PRECOMPUTE_HEADER, REFRESH_HEADER, VERIFY_HEADER, refresherBaseUrl } from "./view-refresher.js";

/**
 * THE VIEW KEEPER — keeps the Gold cells of every brand a customer reads READY before they are asked
 * for, and proves they say what a fresh computation says.
 *
 * PRECOMPUTE. A cell nobody has read yet (a campaign just created, an offer opened for the first time)
 * was a blocking cold compute on the customer's first read: 7.6-9s measured in prod 2026-09-26 on the
 * two largest brands, almost all of it waiting on ~13 sibling reads. The keeper takes every request a
 * customer made in the last {@link TEMPLATE_WINDOW_MS} (recorded on its cell as `replay_url`), and for
 * each campaign- or offer-scoped one asks the same question of the brand's OTHER campaigns / offers —
 * the representative campaign of every identity campaign-service states, every offer a campaign sells —
 * through the refresher, so the answer is persisted before anybody opens it. The request is the
 * customer's own with one id swapped: the SAME handler computes it, so the body is exactly what that
 * customer's first read would have computed (no second derivation of any figure). A precompute is not a
 * read: its cell carries no `last_read_at` and ages out after the retention window if nobody opens it.
 *
 * DRIFT CHECK. `checkDrift` replays a stored cell's request against the refresher in VERIFY mode (compute,
 * never persist) and compares the fresh body with what is stored, path by path. With `mode: "moment"` it
 * first refreshes the cell and then verifies it at once — the "stored vs fresh at the same moment" check;
 * with `mode: "stored"` it compares whatever is being served now, which also measures how stale the facts
 * gate lets a cell get. Every difference is reported loudly with its paths.
 */

/** A read this old or newer makes its request a template. */
const TEMPLATE_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** How often a precompute round runs, and the most computes one round may ask for. */
const DEFAULT_KEEPER_INTERVAL_MS = 5 * 60_000;
const DEFAULT_KEEPER_MAX_PER_ROUND = 12;
/** A precompute the handler refused (e.g. a 404 for a campaign with no funnel) is not retried for this long. */
const REFUSED_RETRY_MS = 6 * 60 * 60_000;
/** A precompute that finished is not re-asked for this long, even if its cell was never written. */
const DONE_RETRY_MS = 60 * 60_000;

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The entities a template can be replayed for — read from campaign-service, never guessed. */
export interface BrandEntities {
  /** One campaign per identity (the live one, else the latest), with the channel it runs on. */
  campaigns: { id: string; featureSlug: string | null }[];
  /** Every offer a campaign of the brand sells. */
  offerIds: string[];
}

export function brandEntitiesOf(rows: CampaignIdentityRow[]): BrandEntities {
  const families = buildCampaignFamilies(rows);
  const bySlug = new Map(rows.map((r) => [r.id, r.featureSlug ?? null] as const));
  const representatives = new Set<string>();
  for (const row of rows) {
    const identity = families.identityOf(row.id);
    representatives.add(identity ? identity.representativeId : row.id);
  }
  const offerIds = new Set<string>();
  for (const row of rows) if (row.offerId) offerIds.add(row.offerId);
  return {
    campaigns: [...representatives].sort().map((id) => ({ id, featureSlug: bySlug.get(id) ?? null })),
    offerIds: [...offerIds].sort(),
  };
}

/** Path + query with the query sorted, so two spellings of one request compare equal. */
export function canonicalRequest(url: string): string {
  const parsed = new URL(url, "http://local");
  const params = [...parsed.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  const query = new URLSearchParams(params).toString();
  return query ? `${parsed.pathname}?${query}` : parsed.pathname;
}

/**
 * The same request asked of the brand's OTHER campaigns (a campaign-scoped template) or OTHER offers (an
 * offer-scoped one). A campaign's channel rides the `/features/:slug/` path, so it moves with the id; a
 * template scoped to neither yields nothing (a brand-grain cell is already the brand's).
 */
export function siblingRequests(templateUrl: string, entities: BrandEntities): string[] {
  const parsed = new URL(templateUrl, "http://local");
  const out = new Set<string>();
  const campaignId = parsed.searchParams.get("campaignId");
  if (campaignId) {
    for (const campaign of entities.campaigns) {
      if (campaign.id === campaignId) continue;
      const next = new URL(parsed.toString());
      next.searchParams.set("campaignId", campaign.id);
      const featurePath = /^\/features\/([^/]+)(\/.*)$/.exec(next.pathname);
      if (featurePath) {
        if (!campaign.featureSlug) continue; // cannot name the channel this campaign runs on
        next.pathname = `/features/${campaign.featureSlug}${featurePath[2]}`;
      }
      out.add(canonicalRequest(next.pathname + next.search));
    }
    return [...out];
  }
  const offerPath = /^\/offers\/([^/]+)(\/.*)$/.exec(parsed.pathname);
  if (offerPath) {
    for (const offerId of entities.offerIds) {
      if (offerId === offerPath[1]) continue;
      out.add(canonicalRequest(`/offers/${offerId}${offerPath[2]}${parsed.search}`));
    }
  }
  return [...out];
}

interface Template {
  url: string;
  headers: Record<string, string>;
  orgId: string;
  brandId: string;
}

export interface PrecomputeReport {
  at: string;
  templates: number;
  brands: number;
  candidates: number;
  asked: number;
  computed: number;
  refused: { url: string; status: number }[];
  skippedKnown: number;
  deferred: number;
  errors: string[];
}

const refusedUntil = new Map<string, number>();
const doneUntil = new Map<string, number>();
let lastReport: PrecomputeReport | null = null;
let running = false;

/** One precompute round (see the module doc). Sequential, bounded, never throws. */
export async function precomputeSiblingScopes(): Promise<PrecomputeReport> {
  const report: PrecomputeReport = {
    at: new Date().toISOString(),
    templates: 0,
    brands: 0,
    candidates: 0,
    asked: 0,
    computed: 0,
    refused: [],
    skippedKnown: 0,
    deferred: 0,
    errors: [],
  };
  const base = refresherBaseUrl();
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!base || !apiKey) {
    report.errors.push("no refresher up (or no api key) — nothing precomputed");
    return report;
  }
  const cap = positiveNumberEnv("VIEW_KEEPER_MAX_PER_ROUND", DEFAULT_KEEPER_MAX_PER_ROUND);

  const cells = await db
    .select({
      replayUrl: featureViewSnapshots.replayUrl,
      replayHeaders: featureViewSnapshots.replayHeaders,
      orgId: featureViewSnapshots.orgId,
      brandId: featureViewSnapshots.brandId,
      lastReadAt: featureViewSnapshots.lastReadAt,
    })
    .from(featureViewSnapshots)
    .where(isNotNull(featureViewSnapshots.replayUrl));

  const known = new Set<string>();
  const templates = new Map<string, Template>();
  const cutoff = Date.now() - TEMPLATE_WINDOW_MS;
  for (const cell of cells) {
    if (!cell.replayUrl) continue;
    known.add(canonicalRequest(cell.replayUrl));
    if (!cell.brandId || !cell.lastReadAt || new Date(cell.lastReadAt).getTime() < cutoff) continue;
    const headers = (cell.replayHeaders ?? {}) as Record<string, string>;
    templates.set(canonicalRequest(cell.replayUrl), { url: cell.replayUrl, headers, orgId: cell.orgId, brandId: cell.brandId });
  }
  report.templates = templates.size;

  const byBrand = new Map<string, Template[]>();
  for (const t of templates.values()) {
    const list = byBrand.get(t.brandId);
    if (list) list.push(t);
    else byBrand.set(t.brandId, [t]);
  }
  report.brands = byBrand.size;

  const now = Date.now();
  for (const [k, until] of refusedUntil) if (until < now) refusedUntil.delete(k);
  for (const [k, until] of doneUntil) if (until < now) doneUntil.delete(k);

  const queue: { url: string; template: Template }[] = [];
  for (const [brandId, list] of byBrand) {
    const first = list[0];
    let entities: BrandEntities;
    try {
      entities = brandEntitiesOf(
        await fetchBrandCampaignRows(brandId, undefined, {
          orgId: first.orgId,
          userId: first.headers["x-user-id"],
          runId: first.headers["x-run-id"],
        }),
      );
    } catch (err) {
      report.errors.push(`campaigns of brand ${brandId}: ${(err as Error).message.slice(0, 200)}`);
      continue;
    }
    for (const template of list) {
      for (const url of siblingRequests(template.url, entities)) {
        report.candidates += 1;
        if (known.has(url) || refusedUntil.has(url) || doneUntil.has(url)) {
          report.skippedKnown += 1;
          continue;
        }
        known.add(url);
        queue.push({ url, template });
      }
    }
  }

  for (const [i, item] of queue.entries()) {
    if (i >= cap) {
      report.deferred = queue.length - cap;
      break;
    }
    report.asked += 1;
    const headers: Record<string, string> = { ...item.template.headers, "x-api-key": apiKey, [PRECOMPUTE_HEADER]: "1" };
    // The swapped request names another campaign: its campaign header must follow, or a downstream
    // attribution header would name the template's campaign.
    const swapped = new URL(item.url, "http://local");
    const campaignId = swapped.searchParams.get("campaignId");
    if (campaignId && headers["x-campaign-id"]) headers["x-campaign-id"] = campaignId;
    const featurePath = /^\/features\/([^/]+)\//.exec(swapped.pathname);
    if (featurePath && headers["x-feature-slug"]) headers["x-feature-slug"] = featurePath[1];
    try {
      const res = await fetch(`${base}${item.url}`, { headers, signal: AbortSignal.timeout(120_000) });
      await res.arrayBuffer();
      if (res.ok) {
        report.computed += 1;
        doneUntil.set(item.url, Date.now() + DONE_RETRY_MS);
      } else {
        refusedUntil.set(item.url, Date.now() + REFUSED_RETRY_MS);
        report.refused.push({ url: item.url, status: res.status });
      }
    } catch (err) {
      report.errors.push(`${item.url}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  console.log(
    `[features-service] view keeper: ${report.templates} templates / ${report.brands} brands -> ${report.candidates} sibling scopes, ` +
      `${report.skippedKnown} already held, ${report.computed} precomputed, ${report.refused.length} refused, ${report.deferred} deferred, ` +
      `${report.errors.length} errors`,
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
      lastReport = await precomputeSiblingScopes();
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
        stored = decodeSnapshotBody(cell.body);
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
