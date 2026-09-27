/**
 * THE FLEET'S EVIDENCE ON ONE LEG OF ONE CHANNEL — the crossOrg grain of a leg-keyed
 * `workflow-projection` (owner rule 2026-09-27: a workflow's figure is ALWAYS its figure on one leg ×
 * one channel, never in the absolute).
 *
 * The leg-less crossOrg grain reads every spend and every send of the channel per workflow slug, so a
 * workflow that only ever ran conversation-leg campaigns was priced on the visit leg from the link
 * clicks those campaigns happened to produce (prod 2026-09-27: cerulean at $167 per website visit on
 * the visit leg, having run no visit campaign at all). Here the population is the campaigns — every org's
 * — whose STATED `legKey` is the leg (`fetchFleetLegCampaigns`, campaign-service's own field, never
 * inferred), and both legs of the evidence are narrowed to them by the producers that froze the
 * attribution: runs-service `campaignIds` (≤500 a request) and email-gateway `campaignIds` (≤200 a
 * request; it sums the per-campaign answers, and a send carries ONE campaign, so nobody counts twice).
 * A legacy row stating no leg is in no leg's population.
 *
 * A leg nobody performs is an EMPTY answer — no cost group, no send — never the channel's: an unfiltered
 * read here is exactly the leak this closes.
 *
 * COST: the email half is one provider read per campaign server-side (~110-134 per leg in prod), so the
 * answer is held per (feature, leg, pricing) with stale-while-revalidate (15 min fresh / 6 h stale,
 * single-flight) — the freshness every other cross-org fleet benchmark here has. FAIL-LOUD: a cold cell
 * whose build fails throws (the caller 502s); a failed background refresh keeps the previous cell.
 */

import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "./brand-spend-by-day-client.js";
import { EMAIL_GATEWAY_CAMPAIGN_IDS_PER_REQUEST } from "./email-gateway-family.js";
import { fetchFleetLegCampaigns, type FleetLegCampaign } from "./fleet-leg-campaigns.js";
import { fetchPublicCosts, fetchPublicEmailStats, type CostGroup } from "./public-stats-clients.js";
import type { Pricing } from "./pricing.js";

const FRESH_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;

export interface LegFleetEvidence {
  /** Every campaign (every org) performing the leg of the channel. */
  campaigns: FleetLegCampaign[];
  /** Fleet cost groups `groupBy=workflowSlug`, those campaigns only, gross-or-net per `pricing`. */
  costGroups: CostGroup[];
  /** Fleet send stats `groupBy=workflowSlug`, those campaigns only. */
  emailStats: Map<string, Record<string, number>>;
}

interface Cell {
  value: LegFleetEvidence;
  computedAt: number;
}

const cells = new Map<string, Cell>();
const inFlight = new Map<string, Promise<Cell>>();

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** PURE: sum cost groups that share a workflow slug (the answers of several `campaignIds` chunks). */
export function mergeCostGroupsBySlug(groups: readonly CostGroup[]): CostGroup[] {
  const bySlug = new Map<string, CostGroup>();
  for (const g of groups) {
    const slug = g.dimensions.workflowSlug ?? "__total__";
    const prev = bySlug.get(slug);
    if (!prev) {
      bySlug.set(slug, { ...g, dimensions: { ...g.dimensions } });
      continue;
    }
    prev.totalCostInUsdCents = String(Number(prev.totalCostInUsdCents) + Number(g.totalCostInUsdCents));
    prev.runCount = Number(prev.runCount) + Number(g.runCount);
    if (g.minStartedAt && (!prev.minStartedAt || g.minStartedAt < prev.minStartedAt)) prev.minStartedAt = g.minStartedAt;
    if (g.maxStartedAt && (!prev.maxStartedAt || g.maxStartedAt > prev.maxStartedAt)) prev.maxStartedAt = g.maxStartedAt;
  }
  return [...bySlug.values()];
}

/** PURE: sum per-slug send stats across chunks. */
export function mergeEmailStats(maps: readonly Map<string, Record<string, number>>[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const m of maps) {
    for (const [slug, stats] of m) {
      const prev = out.get(slug);
      if (!prev) {
        out.set(slug, { ...stats });
        continue;
      }
      for (const [k, v] of Object.entries(stats)) prev[k] = (prev[k] ?? 0) + (v ?? 0);
    }
  }
  return out;
}

async function build(featureSlug: string, legKey: string, pricing: Pricing): Promise<Cell> {
  const campaigns = await fetchFleetLegCampaigns(featureSlug, legKey);
  const ids = [...new Set(campaigns.map((c) => c.campaignId))].sort();
  if (ids.length === 0) {
    return { value: { campaigns, costGroups: [], emailStats: new Map() }, computedAt: Date.now() };
  }
  const [costChunks, emailChunks] = await Promise.all([
    Promise.all(
      chunk(ids, RUNS_CAMPAIGN_IDS_PER_REQUEST).map((c) => fetchPublicCosts(featureSlug, "workflowSlug", pricing, undefined, c)),
    ),
    Promise.all(
      chunk(ids, EMAIL_GATEWAY_CAMPAIGN_IDS_PER_REQUEST).map((c) =>
        fetchPublicEmailStats(featureSlug, "workflowSlug", undefined, undefined, c),
      ),
    ),
  ]);
  return {
    value: { campaigns, costGroups: mergeCostGroupsBySlug(costChunks.flat()), emailStats: mergeEmailStats(emailChunks) },
    computedAt: Date.now(),
  };
}

function refresh(key: string, featureSlug: string, legKey: string, pricing: Pricing): Promise<Cell> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = build(featureSlug, legKey, pricing)
    .then((cell) => {
      cells.set(key, cell);
      return cell;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** The fleet's evidence on `legKey` of `featureSlug`. Each call gets its own copy of the send stats. */
export async function fetchLegFleetEvidence(featureSlug: string, legKey: string, pricing: Pricing): Promise<LegFleetEvidence> {
  const key = `${featureSlug}|${legKey}|${pricing}`;
  const cell = cells.get(key);
  const age = cell ? Date.now() - cell.computedAt : Infinity;
  let value: LegFleetEvidence;
  if (cell && age < FRESH_MS) value = cell.value;
  else if (cell && age < STALE_MS) {
    refresh(key, featureSlug, legKey, pricing).catch((err) =>
      console.error(`[features-service] leg fleet evidence refresh failed (${key}), keeping previous cell:`, err),
    );
    value = cell.value;
  } else value = (await refresh(key, featureSlug, legKey, pricing)).value;
  // Callers overwrite reply counts in place (setReplyCountsOnSlugStats): never hand out the cached maps.
  return {
    campaigns: value.campaigns,
    costGroups: value.costGroups,
    emailStats: new Map([...value.emailStats].map(([k, v]) => [k, { ...v }])),
  };
}

/** Test seam. */
export function __resetLegFleetEvidence(): void {
  cells.clear();
  inFlight.clear();
}
