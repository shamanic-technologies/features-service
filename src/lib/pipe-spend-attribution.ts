/**
 * EACH PIPE OF A SALES FUNNEL CAMPAIGN READS ITS OWN SPEND (owner 2026-10-11: "per pipe the client sees $ invested";
 * two wrong figures on one page is a bug).
 *
 * WHAT WAS WRONG. A sales funnel campaign runs one UNIT campaign per pipe: its sourcing pipes (Apollo cold
 * filters, Apollo buying signals, LinkedIn engagement signals: `start_to_lead_found`, featureSlug = the ORIGIN)
 * feed its outreach pipe (Cold email). Before ~2026-10-08 (lead-service #712, runs-service #299) every sourcing
 * serve ran under the OUTREACH campaign's id, while its run already recorded the origin as `feature_slug`. So
 * runs-service files that history under the outreach pipe: prod, funnel 7fcf42ab, $32.71 of
 * `sourcing-apollo-cold-filters` cost (2026-09-28..10-01) under the cold email pipe 1e95a4c3, $0 under the cold
 * filters pipe 5991f762. Since 10-08 a serve is filed under the source campaign: this is HISTORY, not a leak.
 *
 * THE RULE, read-time from recorded facts (no cost row is rewritten, no provenance invented). Within ONE sales
 * funnel campaign, a cost row under an OUTREACH unit whose run's `feature_slug` is an ORIGIN that one sibling
 * SOURCING unit runs belongs to that sourcing unit:
 *   - the outreach pipe RELEASES those origin slugs: they leave the origin expansion of its runs spend reads
 *     (`runsFeatureSlugsParam`), so its figure is its own outreach spend (+ any origin no sibling runs);
 *   - the sourcing pipe ADOPTS the outreach unit's campaign ids: its runs spend reads (already filtered on its
 *     origin slug alone) also cover them, so it counts exactly the rows the outreach pipe released.
 * Released and adopted are the same rows, so the funnel's total never moves. Two units of one origin in a funnel
 * = ambiguous: nothing moves (logged). A campaign in no funnel, or no sibling of the origin, keeps its rows.
 *
 * HOW. The attribution is resolved once by the route (`resolvePipeSpendAttribution`, `lib/pipe-spend-attribution-io.ts`) and carried by an
 * AsyncLocalStorage around the compute (`withPipeSpendAttribution`), because the per-pipe body is built by a dozen
 * runs reads deep in the engine. It applies ONLY to a runs read whose campaign scope IS the pipe's own identity
 * (`pipeRunsScope`): a brand-wide, offer or fleet read inside the same compute is untouched. A runs read keyed per
 * campaign folds the adopted ids back onto the pipe (`attributedCampaignId`). The route keys its Gold cell on
 * `pipeSpendAttributionKey`, absent when nothing moves (every other cell byte-unchanged).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { campaignScopeIds, type CampaignFilter } from "./campaign-scope.js";
import { SOURCING_CHANNEL_SLUGS, SOURCING_ORIGINS_BY_CHANNEL } from "./sourcing-origins.js";
import type { SalesFunnelCampaignRow } from "./sales-funnel-campaigns-client.js";

export interface PipeSpendAttribution {
  /** The pipe's own campaign identity: the scope a runs read must have for the attribution to apply. */
  pipeCampaignIds: readonly string[];
  /** Outreach pipe: origin slugs whose rows under it belong to a sibling sourcing pipe. Sorted. */
  releasedOriginSlugs: readonly string[];
  /** Sourcing pipe: outreach campaign ids whose rows of its origin are its own. Sorted. */
  adoptedCampaignIds: readonly string[];
}

/** PURE: what one pipe releases or adopts within its sales funnel campaign, before identity widening. */
export interface PipeSpendPlan {
  releasedOriginSlugs: string[];
  /** The outreach UNITS whose rows of this pipe's origin it adopts. */
  adoptFrom: { campaignId: string; featureSlug: string }[];
}

// Every sourcing channel (the origins and Lead Sourcing): a sourcing UNIT of the funnel.
const ORIGINS = new Set(SOURCING_CHANNEL_SLUGS);

/**
 * PURE. The plan for the unit `campaignId` reading as channel `featureSlug`, or null when nothing moves (not a
 * unit, a unit of another channel, a unit of several funnel campaigns, no sibling to give to / take from).
 */
export function planPipeSpend(rows: readonly SalesFunnelCampaignRow[], campaignId: string, featureSlug: string): PipeSpendPlan | null {
  const holders = rows.filter((r) => r.units.some((u) => u.campaignId === campaignId));
  if (holders.length === 0) return null;
  if (holders.length > 1) {
    console.error(`[features-service] pipe spend: campaign ${campaignId} is a unit of ${holders.length} sales funnel campaigns; its spend is not re-attributed`);
    return null;
  }
  const units = holders[0]!.units;
  const unit = units.find((u) => u.campaignId === campaignId)!;
  if (unit.featureSlug !== featureSlug) return null;

  const sourcingUnitsOf = (origin: string) => units.filter((u) => u.featureSlug === origin);
  const sole = (origin: string): boolean => {
    const n = sourcingUnitsOf(origin).length;
    if (n > 1) console.error(`[features-service] pipe spend: sales funnel campaign ${holders[0]!.id} runs ${n} ${origin} units; its ${origin} history stays on the outreach pipe`);
    return n === 1;
  };

  const servedOrigins = SOURCING_ORIGINS_BY_CHANNEL[featureSlug];
  if (servedOrigins) {
    const released = servedOrigins.filter(sole).sort();
    return released.length > 0 ? { releasedOriginSlugs: released, adoptFrom: [] } : null;
  }
  if (ORIGINS.has(featureSlug) && sole(featureSlug)) {
    const adoptFrom = units
      .filter((u) => (SOURCING_ORIGINS_BY_CHANNEL[u.featureSlug] ?? []).includes(featureSlug))
      .map((u) => ({ campaignId: u.campaignId, featureSlug: u.featureSlug }));
    return adoptFrom.length > 0 ? { releasedOriginSlugs: [], adoptFrom } : null;
  }
  return null;
}

/** The Gold key part: absent when nothing moves, so every other cell keeps its key. */
export function pipeSpendAttributionKey(attr: PipeSpendAttribution | null): string | undefined {
  if (!attr) return undefined;
  return [`r:${attr.releasedOriginSlugs.join(",")}`, `a:${attr.adoptedCampaignIds.join(",")}`].join("|");
}

const store = new AsyncLocalStorage<PipeSpendAttribution>();

/** Run `fn` with `attr` applied to every runs spend read scoped to the pipe. `null` = run `fn` as is. */
export function withPipeSpendAttribution<T>(attr: PipeSpendAttribution | null, fn: () => Promise<T>): Promise<T> {
  return attr ? store.run(attr, fn) : fn();
}

/** The active attribution when `campaignScope` IS the pipe's identity, else null. */
function activeFor(campaignScope: CampaignFilter | readonly string[]): PipeSpendAttribution | null {
  const attr = store.getStore();
  if (!attr) return null;
  const ids = new Set(Array.isArray(campaignScope) ? campaignScope : campaignScopeIds(campaignScope as CampaignFilter));
  if (ids.size !== attr.pipeCampaignIds.length || !attr.pipeCampaignIds.every((id) => ids.has(id))) return null;
  return attr;
}

/**
 * A runs spend read's scope under the active attribution: the campaign scope (+ the adopted outreach ids, which
 * turns it into a family every runs client already reads exactly) and the origin slugs to leave out.
 */
export function pipeRunsScope(campaignScope: CampaignFilter): { campaignScope: CampaignFilter; releasedOriginSlugs: readonly string[] } {
  const attr = activeFor(campaignScope);
  if (!attr) return { campaignScope, releasedOriginSlugs: [] };
  return {
    campaignScope: attr.adoptedCampaignIds.length > 0 ? [...campaignScopeIds(campaignScope), ...attr.adoptedCampaignIds] : campaignScope,
    releasedOriginSlugs: attr.releasedOriginSlugs,
  };
}

/** The same for a read that takes its scope as an id list (`[]` = brand-wide, never attributed). */
export function pipeRunsIds(ids: readonly string[]): { ids: string[]; releasedOriginSlugs: readonly string[] } {
  const attr = ids.length > 0 ? activeFor(ids) : null;
  if (!attr) return { ids: [...ids], releasedOriginSlugs: [] };
  return { ids: [...ids, ...attr.adoptedCampaignIds], releasedOriginSlugs: attr.releasedOriginSlugs };
}

/**
 * The origin slugs to leave out of a BRAND-WIDE runs read grouped per campaign, and the campaign a row of an
 * adopted id belongs to — for the reads that key their answer per campaign (maturity split, learning phase).
 * Releasing an origin brand-wide moves only the outreach pipe's own rows: every other campaign of the read is
 * unused by the caller, which keeps the pipe's ids alone.
 */
export function activePipeSpendAttribution(): PipeSpendAttribution | null {
  return store.getStore() ?? null;
}

/** A row's campaign under the active attribution: an adopted outreach id is the pipe's own (its first id). */
export function attributedCampaignId(campaignId: string): string;
export function attributedCampaignId(campaignId: string | null): string | null;
export function attributedCampaignId(campaignId: string | null): string | null {
  const attr = store.getStore();
  if (!attr || !campaignId || !attr.adoptedCampaignIds.includes(campaignId)) return campaignId;
  return attr.pipeCampaignIds[0] ?? campaignId;
}
