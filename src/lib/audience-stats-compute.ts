import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchCurrentBrandProfile } from "./brand-client.js";
import { fetchAudiencesByStatuses, fetchAudienceMemberEmails, type Audience, type AudienceFilters, type AudienceStatus } from "./human-client.js";
import { fetchEmailOutcomes } from "./email-status-client.js";
import { observedCostPerOutcome, projectedCostPerOutcome } from "./cost-engine.js";
import { isGoal, matchSingleStepGoal, matchFormSubmissionGoal, type Goal } from "./goals.js";

export type SortMetric = "cpc" | "cppr";

interface AudienceCostEvidence {
  totalCostInUsdCents: number;
  completedRuns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

interface AudienceOutcomeEvidence {
  contacted: number;
  opened: number;
  websiteClicks: number;
  positiveReplies: number;
}

/**
 * Row shape for the audience-stats endpoint: ranked human-service audiences with their
 * attributed cost + outcome evidence and the derived CPC/CPPR metrics.
 */
export interface AudienceStatsRow {
  audienceId: string;
  brandProfileId: string | null;
  audience: {
    id: string;
    name: string;
    status: Audience["status"];
    filters: AudienceFilters | null;
  };
  evidence: AudienceCostEvidence & AudienceOutcomeEvidence;
  metrics: {
    cpcCents: number | null;
    cpprCents: number | null;
  };
}

export interface AudienceStatsEnvelope {
  featureSlug: string;
  brandId: string;
  goal: Goal;
  brandProfileId: string | null;
  sortMetric: SortMetric;
  audiences: AudienceStatsRow[];
}

export type ComputeResult =
  | { ok: false; status: number; error: string }
  | { ok: true; envelope: AudienceStatsEnvelope };

function buildHeaders(
  apiKey: string,
  orgId: string,
  identity: { userId?: string; runId?: string; brandId?: string; campaignId?: string; featureSlug?: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  return headers;
}

function audienceIdFromDimensions(dimensions: Record<string, string | null> | undefined): string | null {
  const id = dimensions?.audienceId;
  return id && id !== "__total__" ? id : null;
}

function emptyCost(): AudienceCostEvidence {
  return { totalCostInUsdCents: 0, completedRuns: 0, firstRunAt: null, lastRunAt: null };
}

function emptyOutcomes(): AudienceOutcomeEvidence {
  return { contacted: 0, opened: 0, websiteClicks: 0, positiveReplies: 0 };
}

function readFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`Invalid audience stats number: ${field}`);
  }
  return parsed;
}

function sortMetricForGoal(goal: Goal): SortMetric {
  // signup + websiteVisit + formSubmission rank on cost-per-click/visit (the visit is the outcome
  // proxy — all three are visit-driven); meetingBooked / purchase / positiveReply rank on
  // cost-per-positive-reply.
  return goal === "signup" || goal === "websiteVisit" || goal === "formSubmission" ? "cpc" : "cppr";
}

const VALID_STATUSES: readonly AudienceStatus[] = ["active", "paused", "archived"];

/**
 * Parse the optional `statuses` query param (comma-separated subset of
 * active,paused,archived). Absent → ["active"] (preserves the historical active-only
 * behavior for every existing caller, incl. the brand-overview Top-audiences card).
 * Any token outside the valid set (e.g. suggested/deprecated) → 400.
 */
function parseStatuses(raw: string | undefined): { ok: true; statuses: AudienceStatus[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, statuses: ["active"] };
  }
  const tokens = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length === 0) {
    return { ok: false, error: "statuses query parameter must be a non-empty comma-separated subset of: active, paused, archived" };
  }
  const seen = new Set<AudienceStatus>();
  for (const token of tokens) {
    if (!VALID_STATUSES.includes(token as AudienceStatus)) {
      return { ok: false, error: "statuses query parameter must be a comma-separated subset of: active, paused, archived" };
    }
    seen.add(token as AudienceStatus);
  }
  return { ok: true, statuses: [...seen] };
}

function compareByMetric(metric: SortMetric, a: AudienceStatsRow, b: AudienceStatsRow): number {
  const av = metric === "cpc" ? a.metrics.cpcCents : a.metrics.cpprCents;
  const bv = metric === "cpc" ? b.metrics.cpcCents : b.metrics.cpprCents;
  if (av === null && bv === null) return a.audienceId.localeCompare(b.audienceId);
  if (av === null) return 1;
  if (bv === null) return -1;
  if (av !== bv) return av - bv;
  return a.audienceId.localeCompare(b.audienceId);
}

async function fetchAudienceCosts(
  brandId: string,
  featureSlug: string,
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
): Promise<Map<string, AudienceCostEvidence>> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  // Cost is EXACT via the audienceId write-tag (one workflow execution = one priority audience).
  // We do NOT filter the cost NUMERATOR by goal/brandProfileId: a campaign's spend to reach an
  // audience is not partitioned by goal (goal only selects the DENOMINATOR/sort-metric — clicks vs
  // replies), and runs/cost rows are not tagged with goal/brandProfileId today, so filtering on
  // them would drop every real cost row → false $0.00 CPC.
  const params = new URLSearchParams({
    groupBy: "audienceId",
    brandId,
    featureSlugs: featureSlug,
  });

  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, {
    headers: buildHeaders(apiKey, identity.orgId, { ...identity, brandId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service audience costs failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    groups?: Array<{
      dimensions?: Record<string, string | null>;
      totalCostInUsdCents: string;
      runCount: number;
      minStartedAt: string | null;
      maxStartedAt: string | null;
    }>;
  };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service audience costs returned no groups array");
  }

  const result = new Map<string, AudienceCostEvidence>();
  for (const group of data.groups) {
    const audienceId = audienceIdFromDimensions(group.dimensions);
    if (!audienceId) continue;
    result.set(audienceId, {
      totalCostInUsdCents: Math.round(readFiniteNumber(group.totalCostInUsdCents, "totalCostInUsdCents")),
      completedRuns: readFiniteNumber(group.runCount, "runCount"),
      firstRunAt: group.minStartedAt ?? null,
      lastRunAt: group.maxStartedAt ?? null,
    });
  }
  return result;
}

/**
 * Per-audience outcome evidence, resolved READ-TIME from explicit membership (no send-tagging).
 *
 * For each active audience: human-service gives its canonical member emails (people served under
 * it — provenance, human-service#42); email-gateway gives each email's brand-scoped broadcast
 * outcome flags. We aggregate per audience: contacted / opened / clicked / positiveReply member counts.
 * An email in multiple audiences contributes to each (audiences overlap; the per-audience numbers
 * rank candidates, they do NOT partition the brand total). Outcomes are recipient engagement, so
 * they are NOT scoped by goal / brand-profile (only the COST is — via runs attribution).
 */
async function fetchAudienceOutcomes(
  brandId: string,
  audiences: Audience[],
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
): Promise<{ perAudience: Map<string, AudienceOutcomeEvidence>; brandGrain: AudienceOutcomeEvidence }> {
  const perAudience = await Promise.all(
    audiences.map(async (a) => ({ audienceId: a.id, emails: await fetchAudienceMemberEmails(a.id, identity) })),
  );

  const allEmails = [...new Set(perAudience.flatMap((p) => p.emails))];
  const outcomesByEmail = await fetchEmailOutcomes(brandId, allEmails, identity);

  const result = new Map<string, AudienceOutcomeEvidence>();
  for (const { audienceId, emails } of perAudience) {
    const agg = emptyOutcomes();
    for (const email of emails) {
      const o = outcomesByEmail.get(email);
      if (!o) continue;
      if (o.contacted) agg.contacted += 1;
      if (o.opened) agg.opened += 1;
      if (o.clicked) agg.websiteClicks += 1;
      if (o.positiveReply) agg.positiveReplies += 1;
    }
    result.set(audienceId, agg);
  }

  // Brand-grain aggregate = DISTINCT union members (allEmails is already deduped), SAME membership-based
  // definition as the per-audience counts (no grain mix). Serves as the PARENT for the projected cascade:
  // an audience with 0 observed outcomes floors to the brand's cost-per-outcome (audience → brand).
  const brandGrain = emptyOutcomes();
  for (const email of allEmails) {
    const o = outcomesByEmail.get(email);
    if (!o) continue;
    if (o.contacted) brandGrain.contacted += 1;
    if (o.opened) brandGrain.opened += 1;
    if (o.clicked) brandGrain.websiteClicks += 1;
    if (o.positiveReply) brandGrain.positiveReplies += 1;
  }

  return { perAudience: result, brandGrain };
}

/**
 * Compute for the audience-stats endpoint.
 * Validates the request (400s as `ok:false`), looks up the feature (404 as `ok:false`), and
 * fans out to runs-service (cost) + human-service/email-gateway (outcomes) to build ranked rows.
 * Downstream failures THROW — the route maps them to 502.
 */
export async function computeAudienceStats(req: Request): Promise<ComputeResult> {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const goalParam = req.query.goal as string | undefined;
  const explicitBrandProfileId = req.query.brandProfileId as string | undefined;
  const limitParam = req.query.limit as string | undefined;
  const statusesParam = req.query.statuses as string | undefined;

  if (!brandId) {
    return { ok: false, status: 400, error: "brandId query parameter is required" };
  }
  // Normalise the single-step + form-submission goal fleet spellings (snake/kebab → canonical camel)
  // before validating.
  const normalizedGoal = goalParam
    ? (matchSingleStepGoal(goalParam) ?? matchFormSubmissionGoal(goalParam) ?? goalParam)
    : undefined;
  if (!isGoal(normalizedGoal)) {
    return { ok: false, status: 400, error: "goal query parameter is required and must be one of: signup, meetingBooked, purchase, websiteVisit, positiveReply, formSubmission" };
  }

  const parsedStatuses = parseStatuses(statusesParam);
  if (!parsedStatuses.ok) {
    return { ok: false, status: 400, error: parsedStatuses.error };
  }

  let parsedLimit: number | undefined;
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, status: 400, error: "limit query parameter must be a positive integer" };
    }
    parsedLimit = parsed;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    return { ok: false, status: 404, error: "Feature not found" };
  }

  const identity = { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug };
  const [audiences, currentProfile] = await Promise.all([
    fetchAudiencesByStatuses(brandId, parsedStatuses.statuses, identity),
    explicitBrandProfileId ? Promise.resolve(null) : fetchCurrentBrandProfile(brandId, identity),
  ]);
  const brandProfileId = explicitBrandProfileId ?? currentProfile?.id ?? null;

  const [costs, outcomesResult] = await Promise.all([
    fetchAudienceCosts(brandId, featureSlug, identity),
    fetchAudienceOutcomes(brandId, audiences, identity),
  ]);
  const outcomes = outcomesResult.perAudience;

  // Brand-grain PARENT cost-per-outcome for the projected cascade (audience → brand). Numerator = the
  // brand's total audience-tagged cost (runs are tagged to ONE audience, so summing does not double-count);
  // denominator = the brand-grain DISTINCT-union outcome counts. observed (real ratio, null when the brand
  // has no clicks/replies → then the audience metric falls back to observed null, never a false $0).
  const brandTotalCostCents = [...costs.values()].reduce((sum, c) => sum + c.totalCostInUsdCents, 0);
  const brandParentCpc = observedCostPerOutcome(brandTotalCostCents, outcomesResult.brandGrain.websiteClicks);
  const brandParentCppr = observedCostPerOutcome(brandTotalCostCents, outcomesResult.brandGrain.positiveReplies);

  const audienceMap = new Map(audiences.map((audience) => [audience.id, audience]));
  const ids = new Set([...costs.keys(), ...outcomes.keys()]);
  const rows: AudienceStatsRow[] = [];

  for (const audienceId of ids) {
    const audience = audienceMap.get(audienceId);
    if (!audience) continue;

    const cost = costs.get(audienceId) ?? emptyCost();
    const outcome = outcomes.get(audienceId) ?? emptyOutcomes();
    rows.push({
      audienceId,
      brandProfileId,
      audience: {
        id: audienceId,
        name: audience.name,
        status: audience.status,
        filters: audience.filters,
      },
      evidence: {
        ...cost,
        ...outcome,
      },
      // PROJECTED engine (default): a real ratio when the audience has outcomes; else the cascade floor
      // max(audience cost, brand parent). When the brand has no parent (0 brand clicks/replies) → observed
      // (null, sorts last) rather than a false $0. An audience with outcomes is unchanged (parent ignored).
      metrics: {
        cpcCents:
          brandParentCpc != null
            ? projectedCostPerOutcome(cost.totalCostInUsdCents, outcome.websiteClicks, brandParentCpc)
            : observedCostPerOutcome(cost.totalCostInUsdCents, outcome.websiteClicks),
        cpprCents:
          brandParentCppr != null
            ? projectedCostPerOutcome(cost.totalCostInUsdCents, outcome.positiveReplies, brandParentCppr)
            : observedCostPerOutcome(cost.totalCostInUsdCents, outcome.positiveReplies),
      },
    });
  }

  const sortMetric = sortMetricForGoal(normalizedGoal);
  rows.sort((a, b) => compareByMetric(sortMetric, a, b));
  const audiencesOut = parsedLimit !== undefined ? rows.slice(0, parsedLimit) : rows;

  return {
    ok: true,
    envelope: {
      featureSlug,
      brandId,
      goal: normalizedGoal,
      brandProfileId,
      sortMetric,
      audiences: audiencesOut,
    },
  };
}
