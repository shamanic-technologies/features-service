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
import { runsCostsUrl, selectCostCentsString, type Pricing } from "./pricing.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { sumDecimalStrings } from "./decimal.js";
import { startedBeforeParam } from "./maturity.js";
import { fetchFleetMatureSlugStats } from "./fleet-positive-repliers.js";
import type { EnginePerson } from "./revenue-engine.js";

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

// ── THE FLEET'S MATURE EVIDENCE ON ONE LEG (`lib/maturity.ts`) ─────────────────────────────────────
//
// The crossOrg grain's MATURE twin: the spend of runs STARTED before the cutoff on the leg's campaigns
// (every org), and the outcomes — whenever they landed — of the leads those runs SERVED. Both halves are
// narrowed to the SAME campaign population the flash grain above reads, so the mature figure is a subset
// of the flash one by construction.
//
// SPEND: runs-service's public aggregation takes no `startedBefore`, so the leg's campaigns are read per
// ORG through the org-scoped aggregation, which does (x-org-id of that org, api-key only — a fleet read
// forwards no user). One read per org (≤500 campaign ids a request), summed EXACTLY per slug. The basis
// is INCURRED, like every crossOrg figure: a workflow's cost to produce an outcome does not depend on
// whether we billed one org for it.
// OUTCOMES: the fleet person cell (lib/fleet-positive-repliers.ts), bucketed by serve day.
//
// Held per (feature, leg, pricing, cutoff) with the same freshness as the flash cell (15 min fresh / 6 h
// stale, single-flight). FAIL-LOUD on a cold cell; a failed background refresh keeps the previous cell.

interface MatureCostCell {
  value: CostGroup[];
  computedAt: number;
}

const matureCostCells = new Map<string, MatureCostCell>();
const matureCostInFlight = new Map<string, Promise<MatureCostCell>>();
const MATURE_ORG_CONCURRENCY = 4;

async function readOrgMatureCostGroups(
  featureSlug: string,
  orgId: string,
  campaignIds: readonly string[],
  pricing: Pricing,
  startedBefore: string,
): Promise<CostGroup[]> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({
    groupBy: "workflowSlug",
    featureSlugs: featureSlug,
    campaignIds: campaignIds.join(","),
    startedBefore,
  });
  const response = await fetchWithRetry(runsCostsUrl(baseUrl, "org", pricing, params), {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });
  if (!response.ok) {
    throw new Error(`runs-service /v1/stats/costs (fleet mature, org ${orgId}) failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(data.groups)) throw new Error("runs-service /v1/stats/costs (fleet mature) returned no groups array");
  return data.groups;
}

/** PURE. Per-org mature groups → one exact group per workflow slug, on the crossOrg (incurred) basis. */
export function mergeMatureCostGroups(groups: readonly CostGroup[], pricing: Pricing): CostGroup[] {
  const bySlug = new Map<string, { cents: string[]; runs: number }>();
  for (const g of groups) {
    const slug = g.dimensions.workflowSlug;
    if (!slug || slug === "__total__") continue;
    const entry = bySlug.get(slug) ?? { cents: [], runs: 0 };
    entry.cents.push(selectCostCentsString(g, "totalCostInUsdCents", pricing, "incurred"));
    entry.runs += Number(g.runCount ?? 1);
    bySlug.set(slug, entry);
  }
  return [...bySlug].map(([slug, v]) => ({
    dimensions: { workflowSlug: slug },
    totalCostInUsdCents: sumDecimalStrings(v.cents, "runs-service cost group totalCostInUsdCents"),
    runCount: v.runs,
    minStartedAt: null,
    maxStartedAt: null,
  }));
}

async function buildMatureCosts(featureSlug: string, legKey: string, pricing: Pricing, cutoffIso: string): Promise<MatureCostCell> {
  const campaigns = await fetchFleetLegCampaigns(featureSlug, legKey);
  const byOrg = new Map<string, string[]>();
  for (const c of campaigns) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c.campaignId]);
  const startedBefore = startedBeforeParam(cutoffIso);
  const reads = [...byOrg].flatMap(([orgId, ids]) =>
    chunk([...new Set(ids)].sort(), RUNS_CAMPAIGN_IDS_PER_REQUEST).map((c) => ({ orgId, ids: c })),
  );
  const perRead = await mapWithConcurrency(reads, MATURE_ORG_CONCURRENCY, (r) =>
    readOrgMatureCostGroups(featureSlug, r.orgId, r.ids, pricing, startedBefore),
  );
  return { value: mergeMatureCostGroups(perRead.flat(), pricing), computedAt: Date.now() };
}

async function fetchLegFleetMatureCostGroups(
  featureSlug: string,
  legKey: string,
  pricing: Pricing,
  cutoffIso: string,
): Promise<CostGroup[]> {
  const key = `${featureSlug}|${legKey}|${pricing}|${cutoffIso}`;
  const refreshCell = (): Promise<MatureCostCell> => {
    const existing = matureCostInFlight.get(key);
    if (existing) return existing;
    const p = buildMatureCosts(featureSlug, legKey, pricing, cutoffIso)
      .then((cell) => {
        matureCostCells.set(key, cell);
        // A cutoff moves once a day: an EARLIER cutoff's cell is never read again. Only earlier ones are
        // pruned — a slow build for yesterday finishing after today's cell exists must not delete it.
        const prefix = `${featureSlug}|${legKey}|${pricing}|`;
        for (const k of matureCostCells.keys()) {
          if (k.startsWith(prefix) && k.slice(prefix.length) < cutoffIso) matureCostCells.delete(k);
        }
        return cell;
      })
      .finally(() => matureCostInFlight.delete(key));
    matureCostInFlight.set(key, p);
    return p;
  };
  const cell = matureCostCells.get(key);
  const age = cell ? Date.now() - cell.computedAt : Infinity;
  if (cell && age < FRESH_MS) return cell.value;
  if (cell && age < STALE_MS) {
    refreshCell().catch((err) =>
      console.error(`[features-service] leg fleet mature costs refresh failed (${key}), keeping previous cell:`, err),
    );
    return cell.value;
  }
  return (await refreshCell()).value;
}

/** The fleet's mature evidence on one leg, per workflow slug — the crossOrg grain's mature twin. */
export interface LegFleetMatureEvidence {
  /** The cutoff both halves are cut at. */
  cutoffIso: string;
  /** Spend of runs started before the cutoff, per slug, every org's leg campaigns (incurred basis). */
  costGroups: CostGroup[];
  /** The leads those runs served (serve clock), per slug: contacted / clicked / replied positively. */
  emailStats: Map<string, Record<string, number>>;
}

/**
 * The fleet's MATURE evidence on `legKey` of `featureSlug`. `own` is the requesting pair: its live persons
 * replace its cached entry, as for every fleet person count. NULL when the cohort cannot be cut (a pair's
 * rows state no serve date) — never the flash figure under the mature name.
 */
export async function fetchLegFleetMatureEvidence(
  featureSlug: string,
  legKey: string,
  pricing: Pricing,
  cutoffIso: string,
  /** The requesting pair, read LIVE; NULL on a fleet read with no requesting brand. */
  own: { orgId: string; brandId: string; persons: readonly EnginePerson[] } | null,
  legCampaignIds: ReadonlySet<string>,
): Promise<LegFleetMatureEvidence | null> {
  // The person half first: a fleet whose population cannot be cut answers null with no spend read made.
  const emailStats = await fetchFleetMatureSlugStats(featureSlug, own, cutoffIso, legCampaignIds);
  if (!emailStats) return null;
  const costGroups = await fetchLegFleetMatureCostGroups(featureSlug, legKey, pricing, cutoffIso);
  return { cutoffIso, costGroups, emailStats };
}

/** Test seam. */
export function __resetLegFleetEvidence(): void {
  cells.clear();
  inFlight.clear();
  matureCostCells.clear();
  matureCostInFlight.clear();
}
