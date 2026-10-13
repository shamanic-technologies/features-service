/**
 * A NEW SALES FUNNEL CAMPAIGN'S MONEY IS COMPUTED BEFORE ANYONE ASKS (owner 2026-10-13, INSTANT-CAMPAIGN-ROWS).
 *
 * The Campaigns table read (`GET /brands/:brandId/sales-funnel-campaigns`) holds each row's money in its own
 * Gold cells (`sales-funnel-campaign-money`, `-activity`), keyed on the funnel campaign's unit ids: a campaign
 * created seconds ago has no cell, so the customer's first read waited on a cold compute. This asks the
 * refresher for that read NOW, through the ordinary read path (`x-view-precompute: 1`, the keeper's own door,
 * `lib/view-keeper.ts`): the same handler computes and persists every row's cells under the caller's own
 * identity, so the first customer read is a hit. Nothing about a figure moves: no value is derived here.
 *
 * Shapes warmed: the dashboard's (`?offerId=<offer>&pricing=net`, brand-wide `?pricing=net`) plus every shape
 * this (org, brand) was already read under (`replay_url` of its stored money cells) for that offer or all.
 *
 * Fire-and-forget, bounded: one request in flight per (org, url), the same (org, url) not re-asked within
 * {@link REASK_WITHIN_MS}. Failures are logged loudly and never reach a caller (a warm is not a read).
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots } from "../db/schema.js";
import { isReplayableIdentity } from "./identity-headers.js";
import { PRECOMPUTE_HEADER, refresherBaseUrl } from "./view-refresher.js";

const REASK_WITHIN_MS = 30_000;
const WARM_TIMEOUT_MS = 120_000;
const MAX_URLS = 6;

const inFlight = new Map<string, Promise<void>>();
const askedAt = new Map<string, number>();

/** Test seam. */
export function __resetFunnelCampaignWarm(): void {
  inFlight.clear();
  askedAt.clear();
}

/** PURE: the request paths to warm for a brand (and an offer), the dashboard's first, deduped, capped. */
export function warmUrlsFor(brandId: string, offerId: string | null, recorded: readonly string[]): string[] {
  const base = `/brands/${encodeURIComponent(brandId)}/sales-funnel-campaigns`;
  const defaults = [...(offerId ? [`${base}?${new URLSearchParams({ offerId, pricing: "net" })}`] : []), `${base}?pricing=net`];
  const fits = recorded.filter((u) => {
    const [path, query = ""] = u.split("?");
    if (path !== base) return false;
    const params = new URLSearchParams(query);
    if (params.has("fields")) return false;
    const o = params.get("offerId");
    return o === null || o === offerId;
  });
  return [...new Set([...defaults, ...fits])].slice(0, MAX_URLS);
}

async function recordedUrls(orgId: string, brandId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ url: featureViewSnapshots.replayUrl })
    .from(featureViewSnapshots)
    .where(
      and(
        eq(featureViewSnapshots.orgId, orgId),
        eq(featureViewSnapshots.brandId, brandId),
        eq(featureViewSnapshots.view, "sales-funnel-campaign-money"),
        isNotNull(featureViewSnapshots.replayUrl),
        sql`${featureViewSnapshots.lastReadAt} > now() - interval '14 days'`,
      ),
    )
    .limit(20);
  return rows.flatMap((r) => (r.url ? [r.url] : []));
}

/**
 * Ask the refresher to compute every funnel campaign row of the brand (optionally narrowed to an offer) under
 * `identity` (x-org-id, x-user-id, x-run-id). Resolves once every ask has settled; never throws.
 */
export async function warmFunnelCampaignReads(input: {
  brandId: string;
  offerId: string | null;
  identity: { orgId: string; userId: string; runId: string };
}): Promise<{ urls: string[]; skippedReason: string | null }> {
  const headers: Record<string, string> = { "x-org-id": input.identity.orgId, "x-user-id": input.identity.userId, "x-run-id": input.identity.runId };
  const base = refresherBaseUrl();
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!base || !apiKey) {
    console.error(`[features-service] funnel campaign warm: brand ${input.brandId}: no refresher or api key in this process, nothing warmed`);
    return { urls: [], skippedReason: "refresher_unavailable" };
  }
  if (!isReplayableIdentity(headers)) {
    console.error(`[features-service] funnel campaign warm: brand ${input.brandId}: identity is not replayable, nothing warmed`);
    return { urls: [], skippedReason: "identity_not_replayable" };
  }
  let recorded: string[] = [];
  try {
    recorded = await recordedUrls(input.identity.orgId, input.brandId);
  } catch (err) {
    console.error(`[features-service] funnel campaign warm: brand ${input.brandId}: recorded shapes unreadable, warming the dashboard's only: ${(err as Error).message}`);
  }
  const urls = warmUrlsFor(input.brandId, input.offerId, recorded);
  await Promise.all(
    urls.map((url) => {
      const key = `${input.identity.orgId}|${url}`;
      const running = inFlight.get(key);
      if (running) return running;
      if (Date.now() - (askedAt.get(key) ?? 0) < REASK_WITHIN_MS) return undefined;
      askedAt.set(key, Date.now());
      const began = Date.now();
      const ask = fetch(`${base}${url}`, { headers: { ...headers, "x-api-key": apiKey, [PRECOMPUTE_HEADER]: "1" }, signal: AbortSignal.timeout(WARM_TIMEOUT_MS) })
        .then(async (res) => {
          await res.arrayBuffer();
          if (res.ok) console.log(`[features-service] funnel campaign warm: ${url} computed in ${Date.now() - began}ms`);
          else console.error(`[features-service] funnel campaign warm: ${url} answered ${res.status}`);
        })
        .catch((err: Error) => console.error(`[features-service] funnel campaign warm: ${url} failed: ${err.message}`))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, ask);
      return ask;
    }),
  );
  return { urls, skippedReason: null };
}
