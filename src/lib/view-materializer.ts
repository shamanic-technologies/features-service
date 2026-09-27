import type { CampaignIdentityRow } from "./campaign-identity.js";
import { buildCampaignFamilies } from "./campaign-identity.js";

/**
 * THE FLEET MATERIALIZER — the pure half: which requests the keeper (`lib/view-keeper.ts`) asks of the
 * refresher so that every money cell a customer dashboard reads EXISTS before its first read.
 *
 * WHY NOT PRE-AGGREGATED ROWS. Every figure these views serve comes out of one engine pass over the
 * brand's whole lead population: the per-organisation EV combination is not additive across partitions,
 * the ratios divide a maturity cohort whose cutoff moves daily, and every EV re-prices when a measured
 * rate moves. A sum of per-(campaign, day) rows cannot reproduce them, and the no-go is that no served
 * number may change. So the Gold layer stays a snapshot of the EXACT response body, computed by the SAME
 * handler — what moves is WHEN it is computed: ahead of the read, for every scope a dashboard can open.
 *
 * SHAPES. A dashboard's reads are a small, stable set of request SHAPES (`/brands/:id/revenue?pricing=net`,
 * `/features/:slug/revenue?brandId&campaignId&pricing=net`, …). The keeper harvests them from what
 * customers actually requested (the `replay_url` of recently read cells, fleet-wide) — so a shape one
 * customer opens is precomputed for every brand — and instantiates each for every brand, every channel
 * it runs, every campaign identity, every offer, every leg a campaign is bought for. Nothing is invented:
 * a shape nobody reads is never computed, and an instance only swaps ids the shape already carried.
 *
 * WHAT IS NOT A SHAPE. Requests naming a per-lead list (`leadIds`, `limit`), one workflow drill-down
 * (`workflow`), a viewer's own clock (`timezone`), or a cross-org read (`/public`, `/internal`) are not
 * instantiated: they are either unbounded per brand, or not a brand's cell at all.
 */

/** Query parameters whose presence makes a request a one-off rather than a dashboard shape. */
const NON_SHAPE_PARAMS = new Set(["workflow", "leadIds", "limit", "timezone"]);

export type ShapeKind = "brandPath" | "offerPath" | "featureBrand" | "featureCampaign" | "featureOffer";

export interface RequestShape {
  kind: ShapeKind;
  /** The path after the scoping id (`/revenue`, `/audience-stats`, …). */
  suffix: string;
  /** The fixed query parameters (every id and `leg` removed), sorted. */
  params: [string, string][];
  /** Whether the shape names `brandId` in its query. */
  brandIdParam: boolean;
  /** Whether the shape names a leg (it takes the campaign's own leg, or each leg the brand runs). */
  legParam: boolean;
}

/** A stable key for a shape, so the same shape read by two customers is one shape. */
export function shapeKey(shape: RequestShape): string {
  return JSON.stringify([shape.kind, shape.suffix, shape.params, shape.brandIdParam, shape.legParam]);
}

/** The shape of one recorded request, or null when it is not a brand dashboard shape. */
export function shapeOf(url: string): RequestShape | null {
  const parsed = new URL(url, "http://local");
  for (const name of parsed.searchParams.keys()) if (NON_SHAPE_PARAMS.has(name)) return null;
  const q = parsed.searchParams;
  const params = [...q.entries()]
    .filter(([k]) => k !== "brandId" && k !== "campaignId" && k !== "offerId" && k !== "leg")
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  const brandIdParam = q.has("brandId");
  const legParam = q.has("leg");
  const brandPath = /^\/brands\/[^/]+(\/.*)$/.exec(parsed.pathname);
  if (brandPath) return { kind: "brandPath", suffix: brandPath[1], params, brandIdParam, legParam };
  const offerPath = /^\/offers\/[^/]+(\/.*)$/.exec(parsed.pathname);
  if (offerPath) return brandIdParam ? { kind: "offerPath", suffix: offerPath[1], params, brandIdParam, legParam } : null;
  const featurePath = /^\/features\/[^/]+(\/.*)$/.exec(parsed.pathname);
  if (!featurePath || !brandIdParam) return null;
  const kind: ShapeKind = q.has("campaignId") ? "featureCampaign" : q.has("offerId") ? "featureOffer" : "featureBrand";
  return { kind, suffix: featurePath[1], params, brandIdParam, legParam };
}

/** What a brand's shapes are instantiated over — read from campaign-service, never guessed. */
export interface BrandScopes {
  brandId: string;
  /** One campaign per identity (the live one, else the latest), with its channel and leg. */
  campaigns: { id: string; featureSlug: string | null; legKey: string | null; live: boolean }[];
  /** Every offer a campaign sells, with the channels it is sold through. */
  offers: { id: string; featureSlugs: string[] }[];
  /** Every channel the brand runs, with the legs it is bought for on it. */
  channels: { featureSlug: string; legKeys: string[] }[];
}

export function brandScopesOf(brandId: string, rows: CampaignIdentityRow[]): BrandScopes {
  const families = buildCampaignFamilies(rows);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const representatives = new Map<string, boolean>();
  for (const row of rows) {
    const identity = families.identityOf(row.id);
    const repId = identity ? identity.representativeId : row.id;
    representatives.set(repId, (representatives.get(repId) ?? false) || row.status === "ongoing");
  }
  const campaigns = [...representatives]
    .map(([id, live]) => ({
      id,
      featureSlug: byId.get(id)?.featureSlug ?? null,
      legKey: byId.get(id)?.legKey ?? null,
      live,
    }))
    // Live campaigns first: those are the pages a customer opens.
    .sort((a, b) => Number(b.live) - Number(a.live) || (a.id < b.id ? -1 : 1));
  const offers = new Map<string, Set<string>>();
  const channels = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.featureSlug) {
      const legs = channels.get(row.featureSlug) ?? new Set<string>();
      if (row.legKey) legs.add(row.legKey);
      channels.set(row.featureSlug, legs);
    }
    if (!row.offerId) continue;
    const slugs = offers.get(row.offerId) ?? new Set<string>();
    if (row.featureSlug) slugs.add(row.featureSlug);
    offers.set(row.offerId, slugs);
  }
  return {
    brandId,
    campaigns,
    offers: [...offers].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, s]) => ({ id, featureSlugs: [...s].sort() })),
    channels: [...channels].sort(([a], [b]) => (a < b ? -1 : 1)).map(([featureSlug, legs]) => ({ featureSlug, legKeys: [...legs].sort() })),
  };
}

/** Path + query with the query sorted, so two spellings of one request compare equal. */
export function canonicalRequest(url: string): string {
  const parsed = new URL(url, "http://local");
  const params = [...parsed.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  const query = new URLSearchParams(params).toString();
  return query ? `${parsed.pathname}?${query}` : parsed.pathname;
}

export interface ShapeInstance {
  url: string;
  /** Attribution headers the request must carry so no downstream read names another scope. */
  campaignId: string | null;
  featureSlug: string | null;
}

function build(path: string, shape: RequestShape, ids: { brandId?: string; campaignId?: string; offerId?: string; leg?: string }): string {
  const params: [string, string][] = [...shape.params];
  if (ids.brandId) params.push(["brandId", ids.brandId]);
  if (ids.campaignId) params.push(["campaignId", ids.campaignId]);
  if (ids.offerId) params.push(["offerId", ids.offerId]);
  if (ids.leg) params.push(["leg", ids.leg]);
  const query = new URLSearchParams(params).toString();
  return canonicalRequest(query ? `${path}?${query}` : path);
}

/** Every request a shape asks of one brand (see the module doc). */
export function instancesOf(shape: RequestShape, scopes: BrandScopes): ShapeInstance[] {
  const b = scopes.brandId;
  const brandParam = shape.brandIdParam ? b : undefined;
  const out: ShapeInstance[] = [];
  switch (shape.kind) {
    case "brandPath":
      if (shape.legParam) return out;
      out.push({ url: build(`/brands/${b}${shape.suffix}`, shape, { brandId: brandParam }), campaignId: null, featureSlug: null });
      break;
    case "offerPath":
      if (shape.legParam) return out;
      for (const offer of scopes.offers) {
        out.push({ url: build(`/offers/${offer.id}${shape.suffix}`, shape, { brandId: brandParam }), campaignId: null, featureSlug: null });
      }
      break;
    case "featureBrand":
      for (const channel of scopes.channels) {
        const path = `/features/${channel.featureSlug}${shape.suffix}`;
        if (!shape.legParam) {
          out.push({ url: build(path, shape, { brandId: b }), campaignId: null, featureSlug: channel.featureSlug });
          continue;
        }
        for (const leg of channel.legKeys) {
          out.push({ url: build(path, shape, { brandId: b, leg }), campaignId: null, featureSlug: channel.featureSlug });
        }
      }
      break;
    case "featureCampaign":
      for (const campaign of scopes.campaigns) {
        if (!campaign.featureSlug) continue; // cannot name the channel this campaign runs on
        if (shape.legParam && !campaign.legKey) continue; // a leg-keyed read of a campaign bought for no leg
        const path = `/features/${campaign.featureSlug}${shape.suffix}`;
        out.push({
          url: build(path, shape, { brandId: b, campaignId: campaign.id, leg: shape.legParam ? campaign.legKey! : undefined }),
          campaignId: campaign.id,
          featureSlug: campaign.featureSlug,
        });
      }
      break;
    case "featureOffer":
      if (shape.legParam) return out;
      for (const offer of scopes.offers) {
        for (const featureSlug of offer.featureSlugs) {
          out.push({
            url: build(`/features/${featureSlug}${shape.suffix}`, shape, { brandId: b, offerId: offer.id }),
            campaignId: null,
            featureSlug,
          });
        }
      }
      break;
  }
  return out;
}

/** Order the brand's instances are asked in: brand grain, then live campaigns, then the rest. */
const KIND_PRIORITY: Record<ShapeKind, number> = { brandPath: 0, featureBrand: 1, offerPath: 2, featureCampaign: 3, featureOffer: 4 };

export function orderShapes(shapes: RequestShape[]): RequestShape[] {
  return [...shapes].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || (shapeKey(a) < shapeKey(b) ? -1 : 1));
}

/**
 * The headers a materialized request carries: the org's own most recent customer read (so its identity
 * is a real user of that org, exactly as a replayed read), with every attribution header set to the
 * scope this request names — or removed when it names none — so no downstream read is attributed to
 * the scope the recorded read happened to be about. A header the org's reads never carry is not added.
 */
export function headersFor(recorded: Record<string, string>, brandId: string, instance: ShapeInstance): Record<string, string> {
  const headers: Record<string, string> = { ...recorded };
  delete headers["x-api-key"];
  delete headers["x-workflow-slug"];
  // Swap only what the org's own reads already send; a header they never send is never added.
  if (headers["x-brand-id"] !== undefined) headers["x-brand-id"] = brandId;
  if (headers["x-campaign-id"] !== undefined) {
    if (instance.campaignId) headers["x-campaign-id"] = instance.campaignId;
    else delete headers["x-campaign-id"];
  }
  if (headers["x-feature-slug"] !== undefined) {
    if (instance.featureSlug) headers["x-feature-slug"] = instance.featureSlug;
    else delete headers["x-feature-slug"];
  }
  return headers;
}
