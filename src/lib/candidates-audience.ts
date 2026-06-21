/**
 * Audience-grain candidate evidence for GET /features/:slug/candidates.
 *
 * Resolves, per ACTIVE human-service audience that has runs-attributed history, the
 * (audienceId, workflowDynastySlug) COUPLES that actually ran plus the audience's
 * attributed cost + outcome evidence. The /candidates handler emits one "persona"-grain
 * candidate row per couple, keyed on `audienceId` with `grain:"persona"`.
 *
 * Grain policy (option B — coherent single grain per row):
 *   - COST + runs are AUDIENCE-grain (runs-service groupBy=audienceId — byte-identical to
 *     the /audience-stats numerator), so cost-per-click / cost-per-reply stay self-consistent.
 *   - OUTCOMES (contacted/clicks/replies) are AUDIENCE-grain (read-time membership →
 *     email-gateway brand-scoped broadcast flags), exactly as /audience-stats resolves them.
 *   - The couple enumeration (groupBy=audienceId,workflowDynastySlug) tells us WHICH workflows
 *     ran for the audience; per-workflow OUTCOME splitting does not exist in the fleet
 *     (send/engagement is not workflow-tagged), so each of an audience's couple rows carries
 *     the same audience-scoped slice. Per-workflow cost discrimination stays available on the
 *     coarser audienceId:null rows the handler still emits.
 *
 * Reuses the /audience-stats building blocks (fetchActiveAudiences / fetchAudienceMemberEmails
 * / fetchEmailOutcomes) without touching that endpoint. Fails loud (throws → handler 502) on
 * any downstream transport / non-OK error — no silent fallback, no synthesized audiences.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { fetchActiveAudiences, fetchAudienceMemberEmails } from "./human-client.js";
import { fetchEmailOutcomes } from "./email-status-client.js";

export interface AudienceCandidateEvidence {
  audienceId: string;
  /** Workflow dynasties (by dynasty slug) that have runs-attributed couples for this audience. */
  workflowDynastySlugs: string[];
  /** Audience-grain aggregate cost (groupBy=audienceId) — same numerator as /audience-stats. */
  totalCostInUsdCents: number;
  completedRuns: number;
  /** Audience-grain outcomes from explicit membership (read-time, no send-tagging). */
  contacted: number;
  clicks: number;
  replies: number;
}

interface Identity {
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

function audienceIdFromDimensions(dimensions: Record<string, string | null> | undefined): string | null {
  const id = dimensions?.audienceId;
  return id && id !== "__total__" ? id : null;
}

interface CostGroup {
  dimensions?: Record<string, string | null>;
  totalCostInUsdCents: string;
  runCount: number;
}

async function fetchCostGroups(brandId: string, featureSlug: string, groupBy: string, identity: Identity): Promise<CostGroup[]> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  if (!baseUrl) throw new Error("RUNS_SERVICE_URL not configured");
  const params = new URLSearchParams({ groupBy, brandId, featureSlugs: featureSlug });
  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, { headers: runsHeaders(brandId, identity) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (groupBy=${groupBy}) failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(data.groups)) {
    throw new Error(`runs-service /v1/stats/costs (groupBy=${groupBy}) returned no groups array`);
  }
  return data.groups;
}

/** Audience-grain total cost (groupBy=audienceId), restricted to the active-audience set. */
async function fetchAudienceCostTotals(
  brandId: string,
  featureSlug: string,
  activeIds: Set<string>,
  identity: Identity,
): Promise<Map<string, { totalCostInUsdCents: number; completedRuns: number }>> {
  const groups = await fetchCostGroups(brandId, featureSlug, "audienceId", identity);
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
  const groups = await fetchCostGroups(brandId, featureSlug, "audienceId,workflowDynastySlug", identity);
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
 * Build the audience-grain candidate evidence for a (brand, feature). Returns one entry per
 * active audience that has runs-attributed couples; empty array when the brand has no active
 * audiences or none of them have attributed history (cold → handler falls back to coarse rows).
 */
export async function fetchAudienceCandidateEvidence(
  brandId: string,
  featureSlug: string,
  identity: Identity,
): Promise<AudienceCandidateEvidence[]> {
  const audiences = await fetchActiveAudiences(brandId, identity);
  if (audiences.length === 0) return [];
  const activeIds = new Set(audiences.map((a) => a.id));

  const [costTotals, couples] = await Promise.all([
    fetchAudienceCostTotals(brandId, featureSlug, activeIds, identity),
    fetchAudienceWorkflowCouples(brandId, featureSlug, activeIds, identity),
  ]);

  const audiencesWithCouples = [...couples.keys()];
  const outcomes = await fetchAudienceOutcomes(brandId, audiencesWithCouples, identity);

  const result: AudienceCandidateEvidence[] = [];
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
