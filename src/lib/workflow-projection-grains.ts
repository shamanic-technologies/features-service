/**
 * Grain-scoped evidence fetchers for GET /features/:slug/workflow-projection.
 *
 * The endpoint serves a 3-grain projection ladder per (audienceId?, workflowDynasty):
 *   - crossOrg : fleet-wide per-workflow unit costs + outcomes (feature-scoped, no brand filter) —
 *                the EXISTING /public/stats/best data path (fetchPublicCosts / fetchPublicEmailStats).
 *   - brand    : the SAME path scoped to one brandId (runs groupBy=workflowSlug + brandId, email-gateway
 *                broadcast groupBy=workflowSlug + brandId) — this module (`fetchBrandWorkflowEvidence`).
 *   - audience : audience-WIDE attributed evidence (runs groupBy=audienceId — byte-identical to
 *                /audience-stats — + read-time membership outcomes), plus the (audienceId ×
 *                workflowDynastySlug) couples that ran (`fetchAudienceGrainEvidence`).
 *
 * Both brand + audience reads are ORG-SCOPED (x-org-id) and fail loud (throw → handler 502). No silent
 * fallback, no synthesized data. The dynasty rollup reuses buildUpgradeChains / aggregateAcrossChains so
 * a workflow's evidence includes its predecessor versions', identical to crossOrg.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { buildUpgradeChains, aggregateAcrossChains } from "../routes/public.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";
import { fetchActiveAudiences, fetchAudienceMemberEmails } from "./human-client.js";
import { fetchEmailOutcomes } from "./email-status-client.js";

export interface Identity {
  orgId: string;
  userId?: string;
  runId?: string;
  featureSlug?: string;
}

function runsHeaders(brandId: string, identity: Identity): Record<string, string> {
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!apiKey) throw new Error("RUNS_SERVICE_API_KEY not configured");
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  return headers;
}

function emailHeaders(brandId: string, identity: Identity): Record<string, string> {
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!apiKey) throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  return headers;
}

interface CostGroup {
  dimensions: Record<string, string | null>;
  totalCostInUsdCents: string;
  runCount: number;
}

/** Brand-scoped runs cost groups (org-scoped, groupBy=workflowSlug, filtered by brandId + feature). */
async function fetchBrandCostGroups(
  brandId: string,
  featureSlug: string,
  groupBy: string,
  identity: Identity,
): Promise<CostGroup[]> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  if (!baseUrl) throw new Error("RUNS_SERVICE_URL not configured");
  const params = new URLSearchParams({ groupBy, brandId, featureSlugs: featureSlug });
  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, { headers: runsHeaders(brandId, identity) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (groupBy=${groupBy}, brandId) failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(data.groups)) {
    throw new Error(`runs-service /v1/stats/costs (groupBy=${groupBy}, brandId) returned no groups array`);
  }
  return data.groups;
}

/** Brand-scoped broadcast email stats (org-scoped, groupBy=workflowSlug, filtered by brandId + feature). */
async function fetchBrandEmailStats(
  brandId: string,
  featureSlug: string,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  if (!baseUrl) throw new Error("EMAIL_GATEWAY_SERVICE_URL not configured");
  const params = new URLSearchParams({ type: "broadcast", groupBy: "workflowSlug", brandId, featureSlugs: featureSlug });
  const response = await fetchWithRetry(`${baseUrl}/orgs/stats?${params}`, { headers: emailHeaders(brandId, identity) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /orgs/stats (groupBy=workflowSlug, brandId) failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
  const result = new Map<string, Record<string, number>>();
  if (Array.isArray(data.groups)) {
    for (const group of data.groups) {
      const key = String(group.key ?? "__total__");
      result.set(key, extractBroadcastRecipientStats(group));
    }
  }
  return result;
}

function extractBroadcastRecipientStats(group: Record<string, unknown>): Record<string, number> {
  const broadcast = group.broadcast as Record<string, unknown> | undefined;
  const recipientStats = broadcast?.recipientStats as Record<string, number> | undefined;
  if (!recipientStats) return {};
  return {
    recipientsContacted: recipientStats.contacted,
    recipientsClicked: recipientStats.clicked,
    recipientsRepliesPositive: recipientStats.repliesPositive,
  };
}

/** Per-workflow-dynasty aggregated evidence (cost + contacted/clicks/replies), rolled up over the upgrade chain. */
export interface WorkflowGrainEvidence {
  totalCostInUsdCents: number;
  completedRuns: number;
  contacted: number;
  clicks: number;
  replies: number;
}

/**
 * BRAND-grain evidence per active workflow dynasty for one (brand, feature): the SAME data path as
 * crossOrg (fetchPublicCosts/fetchPublicEmailStats + aggregateAcrossChains) but scoped to `brandId`.
 * Keyed by active workflow slug (the dynasty's active version). A dynasty the brand never ran is absent
 * from the map → the handler omits the brand grain for that dynasty (spentUsd = 0 rule).
 */
export async function fetchBrandWorkflowEvidence(
  brandId: string,
  featureSlug: string,
  workflows: WorkflowMetadata[],
  identity: Identity,
): Promise<Map<string, WorkflowGrainEvidence>> {
  const [costGroups, emailStats] = await Promise.all([
    fetchBrandCostGroups(brandId, featureSlug, "workflowSlug", identity),
    fetchBrandEmailStats(brandId, featureSlug, identity),
  ]);
  const chains = buildUpgradeChains(workflows);
  const { costMap, aggregatedOutcomes } = aggregateAcrossChains(
    chains,
    costGroups.map((g) => ({ dimensions: g.dimensions, totalCostInUsdCents: g.totalCostInUsdCents, runCount: g.runCount })),
    emailStats,
    "workflowSlug",
  );

  const result = new Map<string, WorkflowGrainEvidence>();
  for (const [activeSlug, cost] of costMap) {
    const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
    result.set(activeSlug, {
      totalCostInUsdCents: cost.totalCostInUsdCents,
      completedRuns: cost.completedRuns,
      contacted: outcomes.recipientsContacted ?? 0,
      clicks: outcomes.recipientsClicked ?? 0,
      replies: outcomes.recipientsRepliesPositive ?? 0,
    });
  }
  return result;
}

// ── AUDIENCE grain ──────────────────────────────────────────────────────────
//
// Audience-WIDE attributed evidence (runs groupBy=audienceId — byte-identical to /audience-stats — +
// read-time membership outcomes) plus the (audienceId × workflowDynastySlug) couples that ran. The
// audience grain is audience-WIDE, NOT per-workflow (the fleet does not tag outcomes per
// (audience×workflow); documented gap #366/#367), so an audience's grain block is the SAME across that
// audience's workflow rows. Couple enumeration only tells us WHICH dynasties ran for the audience.

export interface AudienceGrainEvidence {
  audienceId: string;
  /** Workflow dynasties (by dynasty slug) with runs-attributed couples for this audience. */
  workflowDynastySlugs: string[];
  /** Audience-grain aggregate (groupBy=audienceId) — same numerator as /audience-stats. */
  totalCostInUsdCents: number;
  completedRuns: number;
  /** Audience-grain outcomes from explicit membership (read-time, no send-tagging). */
  contacted: number;
  clicks: number;
  replies: number;
}

function audienceIdFromDimensions(dimensions: Record<string, string | null> | undefined): string | null {
  const id = dimensions?.audienceId;
  return id && id !== "__total__" ? id : null;
}

/** Audience-grain total cost (groupBy=audienceId), restricted to the active-audience set. */
async function fetchAudienceCostTotals(
  brandId: string,
  featureSlug: string,
  activeIds: Set<string>,
  identity: Identity,
): Promise<Map<string, { totalCostInUsdCents: number; completedRuns: number }>> {
  const groups = await fetchBrandCostGroups(brandId, featureSlug, "audienceId", identity);
  const result = new Map<string, { totalCostInUsdCents: number; completedRuns: number }>();
  for (const g of groups) {
    const audienceId = audienceIdFromDimensions(g.dimensions);
    if (!audienceId || !activeIds.has(audienceId)) continue;
    result.set(audienceId, {
      totalCostInUsdCents: Math.round(Number(g.totalCostInUsdCents)),
      completedRuns: Number(g.runCount),
    });
  }
  return result;
}

/** (audienceId × workflowDynastySlug) couples that ran, restricted to the active-audience set. */
async function fetchAudienceWorkflowCouples(
  brandId: string,
  featureSlug: string,
  activeIds: Set<string>,
  identity: Identity,
): Promise<Map<string, Set<string>>> {
  const groups = await fetchBrandCostGroups(brandId, featureSlug, "audienceId,workflowDynastySlug", identity);
  const result = new Map<string, Set<string>>();
  for (const g of groups) {
    const audienceId = audienceIdFromDimensions(g.dimensions);
    const dynastySlug = g.dimensions?.workflowDynastySlug;
    if (!audienceId || !activeIds.has(audienceId)) continue;
    if (!dynastySlug || dynastySlug === "__total__") continue;
    if (!result.has(audienceId)) result.set(audienceId, new Set());
    result.get(audienceId)!.add(dynastySlug);
  }
  return result;
}

/** Audience-grain outcomes via explicit membership → email-gateway broadcast flags. */
async function fetchAudienceOutcomes(
  brandId: string,
  audienceIds: string[],
  identity: Identity,
): Promise<Map<string, { contacted: number; clicks: number; replies: number }>> {
  const result = new Map<string, { contacted: number; clicks: number; replies: number }>();
  if (audienceIds.length === 0) return result;

  const perAudience = await Promise.all(
    audienceIds.map(async (audienceId) => ({ audienceId, emails: await fetchAudienceMemberEmails(audienceId, identity) })),
  );
  const allEmails = [...new Set(perAudience.flatMap((p) => p.emails))];
  const outcomesByEmail = await fetchEmailOutcomes(brandId, allEmails, identity);

  for (const { audienceId, emails } of perAudience) {
    let contacted = 0;
    let clicks = 0;
    let replies = 0;
    for (const email of emails) {
      const o = outcomesByEmail.get(email);
      if (!o) continue;
      if (o.contacted) contacted += 1;
      if (o.clicked) clicks += 1;
      if (o.positiveReply) replies += 1;
    }
    result.set(audienceId, { contacted, clicks, replies });
  }
  return result;
}

/**
 * Build the audience-grain evidence for a (brand, feature). One entry per active human-service audience
 * that has runs-attributed couples; empty when the brand has no active audiences or none has attributed
 * history (the handler then emits only brand-level rows). Fails loud on any downstream error.
 */
export async function fetchAudienceGrainEvidence(
  brandId: string,
  featureSlug: string,
  identity: Identity,
): Promise<AudienceGrainEvidence[]> {
  const audiences = await fetchActiveAudiences(brandId, identity);
  if (audiences.length === 0) return [];
  const activeIds = new Set(audiences.map((a) => a.id));

  const [costTotals, couples] = await Promise.all([
    fetchAudienceCostTotals(brandId, featureSlug, activeIds, identity),
    fetchAudienceWorkflowCouples(brandId, featureSlug, activeIds, identity),
  ]);

  const audiencesWithCouples = [...couples.keys()];
  const outcomes = await fetchAudienceOutcomes(brandId, audiencesWithCouples, identity);

  const result: AudienceGrainEvidence[] = [];
  for (const audienceId of audiencesWithCouples) {
    const cost = costTotals.get(audienceId) ?? { totalCostInUsdCents: 0, completedRuns: 0 };
    const out = outcomes.get(audienceId) ?? { contacted: 0, clicks: 0, replies: 0 };
    result.push({
      audienceId,
      workflowDynastySlugs: [...couples.get(audienceId)!],
      totalCostInUsdCents: cost.totalCostInUsdCents,
      completedRuns: cost.completedRuns,
      contacted: out.contacted,
      clicks: out.clicks,
      replies: out.replies,
    });
  }
  return result;
}
