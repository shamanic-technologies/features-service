/**
 * Grain-scoped evidence fetchers for GET /features/:slug/workflow-projection.
 *
 * The endpoint serves a 3-grain projection ladder per (audienceId?, workflowDynasty):
 *   - crossOrg : fleet-wide per-workflow unit costs + outcomes (feature-scoped, no brand filter) —
 *                the EXISTING /public/stats/best data path (fetchPublicCosts / fetchPublicEmailStats).
 *   - brand    : the SAME path scoped to one brandId (runs groupBy=workflowSlug + brandId, email-gateway
 *                broadcast groupBy=workflowSlug + brandId) — this module (`fetchBrandWorkflowEvidence`).
 *   - audience : per-(audience × dynasty) SEND-TAG evidence — cost (runs groupBy=audienceId,workflowSlug)
 *                + outcomes (email-gateway /orgs/stats?audienceId&groupBy=workflowSlug), both mapped
 *                slug→dynasty. Every active audience is enumerated (`fetchAudienceGrainEvidence`).
 *
 * Both brand + audience reads are ORG-SCOPED (x-org-id) and fail loud (throw → handler 502). No silent
 * fallback, no synthesized data. The dynasty rollup reuses buildWorkflowDynasties / aggregateAcrossDynasties so
 * a workflow's evidence includes its predecessor versions', identical to crossOrg.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { buildWorkflowDynasties, aggregateAcrossDynasties } from "../routes/public.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";
import { fetchActiveAudiences } from "./human-client.js";
import { mapWithConcurrency } from "./concurrency.js";
import { selectCostCents, selectCostCentsString, type Pricing } from "./pricing.js";
import { type CostBasis } from "./cost-basis.js";

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
  /** Frozen-NET twin (runs#179) — read via selectCostCents when pricing === "net". */
  netTotalCostInUsdCents?: string;
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

/** Per-workflow-dynasty aggregated evidence (cost + contacted/clicks/replies), rolled up over the upgrade funnel. */
export interface WorkflowGrainEvidence {
  totalCostInUsdCents: number;
  completedRuns: number;
  contacted: number;
  clicks: number;
  replies: number;
}

/**
 * BRAND-grain evidence per active workflow dynasty for one (brand, feature): the SAME data path as
 * crossOrg (fetchPublicCosts/fetchPublicEmailStats + aggregateAcrossDynasties) but scoped to `brandId`.
 * Keyed by active workflow slug (the dynasty's active version). A dynasty the brand never ran is absent
 * from the map → the handler omits the brand grain for that dynasty (spentUsd = 0 rule).
 */
export async function fetchBrandWorkflowEvidence(
  brandId: string,
  featureSlug: string,
  workflows: WorkflowMetadata[],
  identity: Identity,
  // NET reads runs#179's frozen net twin per group; GROSS reads the gross field → byte-identical.
  pricing: Pricing = "gross",
  // CHARGED (the default) is the customer's own money — this grain is what `workflow-projection` and
  // `/audience-stats` display and floor against, so a comped cost must be absent from it. INCURRED is
  // taken by ONE caller: the brand-observed cost-per-outreach that floors the budget→sends PROJECTION,
  // which is compared against the fleet benchmark and therefore must be read on the fleet's basis.
  basis: CostBasis = "charged",
): Promise<Map<string, WorkflowGrainEvidence>> {
  const [costGroups, emailStats] = await Promise.all([
    fetchBrandCostGroups(brandId, featureSlug, "workflowSlug", identity),
    fetchBrandEmailStats(brandId, featureSlug, identity),
  ]);
  const dynasties = buildWorkflowDynasties(workflows);
  const { costMap, aggregatedOutcomes } = aggregateAcrossDynasties(
    dynasties,
    // Select gross vs frozen-net cost per group BEFORE the dynasty rollup, so the aggregated brand-grain
    // cost is net-or-gross end to end (no post-hoc multiply).
    costGroups.map((g) => ({ dimensions: g.dimensions, totalCostInUsdCents: selectCostCentsString(g, "totalCostInUsdCents", pricing, basis), runCount: g.runCount })),
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

// ── AUDIENCE grain (send-tag, per (audience × dynasty)) ──────────────────────
//
// Per-(audience × workflow-dynasty) attributed evidence, all SEND-TAG:
//   cost    = runs groupBy=audienceId,workflowSlug (the audienceId + workflowSlug tags frozen on each
//             cost row) — post workflow-service#333 the loop-body send/gen cost carries audienceId.
//   outcome = email-gateway /orgs/stats?audienceId=<id>&groupBy=workflowSlug (the audienceId tag on each
//             broadcast send, split per workflow) — the ONLY basis that can split outcomes per workflow
//             (membership cannot; email-gateway#168/#170). Same send-tag basis as the brand grain
//             (/orgs/stats groupBy=workflowSlug) and as /audience-stats, so cost + outcome are one basis
//             end to end → cost-per-outcome coherent, and the per-dynasty rows SUM to the audience total.
// Both map the versioned workflowSlug → dynasty slug locally (slugToDynasty) and sum per dynasty, so the
// audience grain aligns with the dynasty-keyed crossOrg/brand rows. EVERY active audience is enumerated
// (an audience with no attributed couple still surfaces — the handler floors it to brand→crossOrg).

export interface AudienceGrainEvidence {
  audienceId: string;
  /**
   * Per active dynasty slug: the (audience × dynasty) send-tag cost + outcomes. A dynasty absent from the
   * map has no attributed data for this audience (the handler then floors that couple to brand→crossOrg).
   */
  byDynasty: Map<string, WorkflowGrainEvidence>;
}

function audienceIdFromDimensions(dimensions: Record<string, string | null> | undefined): string | null {
  const id = dimensions?.audienceId;
  return id && id !== "__total__" ? id : null;
}

interface DynastyCost {
  totalCostInUsdCents: number;
  completedRuns: number;
}

/**
 * Per-(audience × dynasty) cost from runs `groupBy=audienceId,workflowSlug`, mapped slug → dynasty and
 * summed per dynasty, restricted to the active-audience set.
 *
 * Deliberately groups by the RAW `workflowSlug` column (not the derived `workflowDynastySlug`): runs-service
 * resolves `workflowDynastySlug` by grouping on `workflow_slug` then merging rows with a merge key of
 * DYNASTY ALONE (`regroupByDynasty`), which DROPS the co-grouped `audienceId` dimension — every audience
 * that shares a dynasty collapses into the single highest-spend audience for that dynasty. Grouping on the
 * real `workflowSlug` column skips that lossy regroup entirely (correct per-(audience×workflow) split); we
 * map each slug → dynasty locally via the SAME workflow metadata the crossOrg/brand grains roll up through.
 * runs-service#174 tracks the producer-side regroupByDynasty secondary-dimension collapse.
 */
async function fetchAudienceDynastyCosts(
  brandId: string,
  featureSlug: string,
  activeIds: Set<string>,
  identity: Identity,
  pricing: Pricing,
  slugToDynasty: Map<string, string>,
): Promise<Map<string, Map<string, DynastyCost>>> {
  const groups = await fetchBrandCostGroups(brandId, featureSlug, "audienceId,workflowSlug", identity);
  const result = new Map<string, Map<string, DynastyCost>>();
  for (const g of groups) {
    const audienceId = audienceIdFromDimensions(g.dimensions);
    const workflowSlug = g.dimensions?.workflowSlug;
    if (!audienceId || !activeIds.has(audienceId)) continue;
    if (!workflowSlug || workflowSlug === "__total__") continue;
    const dynasty = slugToDynasty.get(workflowSlug) ?? workflowSlug;
    if (!result.has(audienceId)) result.set(audienceId, new Map());
    const byDynasty = result.get(audienceId)!;
    const prev = byDynasty.get(dynasty) ?? { totalCostInUsdCents: 0, completedRuns: 0 };
    byDynasty.set(dynasty, {
      totalCostInUsdCents: prev.totalCostInUsdCents + Math.round(selectCostCents(g, "totalCostInUsdCents", pricing)),
      completedRuns: prev.completedRuns + Number(g.runCount),
    });
  }
  return result;
}

interface DynastyOutcome {
  contacted: number;
  clicks: number;
  replies: number;
}

/**
 * Per-(audience × dynasty) SEND-TAG outcomes from email-gateway `/orgs/stats?audienceId=<id>&groupBy=
 * workflowSlug` (one call per audience, concurrency-capped), mapped slug → dynasty and summed per dynasty.
 * This is the send-tag basis (the audienceId + workflowSlug stamped on each broadcast send) — the only
 * attribution that can split an audience's engagement per workflow. Fails loud on any downstream error.
 */
async function fetchAudienceDynastyOutcomes(
  brandId: string,
  featureSlug: string,
  audienceIds: string[],
  identity: Identity,
  slugToDynasty: Map<string, string>,
): Promise<Map<string, Map<string, DynastyOutcome>>> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  if (!baseUrl) throw new Error("EMAIL_GATEWAY_SERVICE_URL not configured");
  const result = new Map<string, Map<string, DynastyOutcome>>();
  if (audienceIds.length === 0) return result;

  const perAudience = await mapWithConcurrency(audienceIds, 6, async (audienceId) => {
    const params = new URLSearchParams({
      type: "broadcast",
      groupBy: "workflowSlug",
      audienceId,
      brandId,
      featureSlugs: featureSlug,
    });
    const response = await fetchWithRetry(`${baseUrl}/orgs/stats?${params}`, { headers: emailHeaders(brandId, identity) });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`email-gateway /orgs/stats (audienceId, groupBy=workflowSlug) failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
    const byDynasty = new Map<string, DynastyOutcome>();
    if (Array.isArray(data.groups)) {
      for (const group of data.groups) {
        const workflowSlug = String(group.key ?? "__total__");
        if (workflowSlug === "__total__") continue;
        const dynasty = slugToDynasty.get(workflowSlug) ?? workflowSlug;
        const stats = extractBroadcastRecipientStats(group);
        const prev = byDynasty.get(dynasty) ?? { contacted: 0, clicks: 0, replies: 0 };
        byDynasty.set(dynasty, {
          contacted: prev.contacted + (stats.recipientsContacted ?? 0),
          clicks: prev.clicks + (stats.recipientsClicked ?? 0),
          replies: prev.replies + (stats.recipientsRepliesPositive ?? 0),
        });
      }
    }
    return { audienceId, byDynasty };
  });

  for (const { audienceId, byDynasty } of perAudience) result.set(audienceId, byDynasty);
  return result;
}

/**
 * Build the audience-grain evidence for a (brand, feature). One entry per ACTIVE human-service audience
 * (all of them — an audience with no attributed couple still surfaces with an empty `byDynasty`, and the
 * handler floors it to brand→crossOrg so every active audience appears under every active workflow). Both
 * cost and outcome are send-tag and keyed per dynasty, so the per-dynasty rows sum to the audience total
 * on the SAME basis as /audience-stats. Empty when the brand has no active audiences. Fails loud on any
 * downstream error.
 *
 * `slugToDynasty` maps each versioned `workflowSlug` → its dynasty slug — the SAME workflow metadata the
 * crossOrg/brand grains roll up through — so the audience's dynasty set aligns with the dynasty-keyed
 * crossOrg/brand rows. A slug absent from the map falls back to itself.
 *
 * `audienceIdsOverride` lets a caller that ALREADY holds the brand's audience list (e.g. /audience-stats,
 * which fetched them by requested status) supply it, skipping the duplicate human-service round-trip —
 * and, since that list may include paused/archived audiences, giving every row it will render its own
 * grain rather than the coarser brand fallback. Omitted → the active audiences are fetched here.
 */
export async function fetchAudienceGrainEvidence(
  brandId: string,
  featureSlug: string,
  identity: Identity,
  slugToDynasty: Map<string, string>,
  // NET reads runs#179's frozen net twin per audience group; GROSS reads the gross field → byte-identical.
  pricing: Pricing = "gross",
  audienceIdsOverride?: string[],
): Promise<AudienceGrainEvidence[]> {
  const audienceIds = audienceIdsOverride ?? (await fetchActiveAudiences(brandId, identity)).map((a) => a.id);
  if (audienceIds.length === 0) return [];
  const activeIds = new Set(audienceIds);

  const [costByAudience, outcomeByAudience] = await Promise.all([
    fetchAudienceDynastyCosts(brandId, featureSlug, activeIds, identity, pricing, slugToDynasty),
    fetchAudienceDynastyOutcomes(brandId, featureSlug, audienceIds, identity, slugToDynasty),
  ]);

  const result: AudienceGrainEvidence[] = [];
  for (const audienceId of audienceIds) {
    const costByDynasty = costByAudience.get(audienceId) ?? new Map<string, DynastyCost>();
    const outcomeByDynasty = outcomeByAudience.get(audienceId) ?? new Map<string, DynastyOutcome>();
    const dynasties = new Set<string>([...costByDynasty.keys(), ...outcomeByDynasty.keys()]);
    const byDynasty = new Map<string, WorkflowGrainEvidence>();
    for (const dynasty of dynasties) {
      const c = costByDynasty.get(dynasty) ?? { totalCostInUsdCents: 0, completedRuns: 0 };
      const o = outcomeByDynasty.get(dynasty) ?? { contacted: 0, clicks: 0, replies: 0 };
      byDynasty.set(dynasty, {
        totalCostInUsdCents: c.totalCostInUsdCents,
        completedRuns: c.completedRuns,
        contacted: o.contacted,
        clicks: o.clicks,
        replies: o.replies,
      });
    }
    result.push({ audienceId, byDynasty });
  }
  return result;
}
