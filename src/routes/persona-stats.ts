import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { fetchCurrentBrandProfile } from "../lib/brand-client.js";
import { fetchActiveAudiences, fetchAudienceMemberEmails, type Audience, type AudienceFilters } from "../lib/human-client.js";
import { fetchEmailOutcomes } from "../lib/email-status-client.js";
import { isGoal, type Goal } from "../lib/goals.js";

const router = Router();

type SortMetric = "cpc" | "cppr";

interface PersonaCostEvidence {
  totalCostInUsdCents: number;
  completedRuns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

interface PersonaOutcomeEvidence {
  contacted: number;
  websiteClicks: number;
  positiveReplies: number;
}

interface PersonaStatsRow {
  audienceId: string;
  brandProfileId: string | null;
  persona: {
    id: string;
    name: string;
    status: Audience["status"];
    filters: AudienceFilters | null;
  };
  evidence: PersonaCostEvidence & PersonaOutcomeEvidence;
  metrics: {
    cpcCents: number | null;
    cpprCents: number | null;
  };
}

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

function emptyCost(): PersonaCostEvidence {
  return { totalCostInUsdCents: 0, completedRuns: 0, firstRunAt: null, lastRunAt: null };
}

function emptyOutcomes(): PersonaOutcomeEvidence {
  return { contacted: 0, websiteClicks: 0, positiveReplies: 0 };
}

function ratioCents(costCents: number, denominator: number): number | null {
  return denominator > 0 ? costCents / denominator : null;
}

function readFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`Invalid persona stats number: ${field}`);
  }
  return parsed;
}

function sortMetricForGoal(goal: Goal): SortMetric {
  return goal === "signup" ? "cpc" : "cppr";
}

function compareByMetric(metric: SortMetric, a: PersonaStatsRow, b: PersonaStatsRow): number {
  const av = metric === "cpc" ? a.metrics.cpcCents : a.metrics.cpprCents;
  const bv = metric === "cpc" ? b.metrics.cpcCents : b.metrics.cpprCents;
  if (av === null && bv === null) return a.audienceId.localeCompare(b.audienceId);
  if (av === null) return 1;
  if (bv === null) return -1;
  if (av !== bv) return av - bv;
  return a.audienceId.localeCompare(b.audienceId);
}

async function fetchPersonaCosts(
  brandId: string,
  featureSlug: string,
  goal: Goal,
  brandProfileId: string | null,
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
): Promise<Map<string, PersonaCostEvidence>> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({
    groupBy: "audienceId",
    brandId,
    featureSlugs: featureSlug,
    goal,
  });
  if (brandProfileId) params.set("brandProfileId", brandProfileId);

  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, {
    headers: buildHeaders(apiKey, identity.orgId, { ...identity, brandId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service persona costs failed (${response.status}): ${text}`);
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
    throw new Error("runs-service persona costs returned no groups array");
  }

  const result = new Map<string, PersonaCostEvidence>();
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
 * outcome flags. We aggregate per audience: contacted / clicked / positiveReply member counts.
 * An email in multiple audiences contributes to each (audiences overlap; the per-audience numbers
 * rank candidates, they do NOT partition the brand total). Outcomes are recipient engagement, so
 * they are NOT scoped by goal / brand-profile (only the COST is — via runs attribution).
 */
async function fetchAudienceOutcomes(
  brandId: string,
  audiences: Audience[],
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
): Promise<Map<string, PersonaOutcomeEvidence>> {
  const perAudience = await Promise.all(
    audiences.map(async (a) => ({ audienceId: a.id, emails: await fetchAudienceMemberEmails(a.id, identity) })),
  );

  const allEmails = [...new Set(perAudience.flatMap((p) => p.emails))];
  const outcomesByEmail = await fetchEmailOutcomes(brandId, allEmails, identity);

  const result = new Map<string, PersonaOutcomeEvidence>();
  for (const { audienceId, emails } of perAudience) {
    const agg = emptyOutcomes();
    for (const email of emails) {
      const o = outcomesByEmail.get(email);
      if (!o) continue;
      if (o.contacted) agg.contacted += 1;
      if (o.clicked) agg.websiteClicks += 1;
      if (o.positiveReply) agg.positiveReplies += 1;
    }
    result.set(audienceId, agg);
  }
  return result;
}

router.get("/features/:featureSlug/persona-stats", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const goalParam = req.query.goal as string | undefined;
  const explicitBrandProfileId = req.query.brandProfileId as string | undefined;
  const limitParam = req.query.limit as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }
  if (!isGoal(goalParam)) {
    return res.status(400).json({ error: "goal query parameter is required and must be one of: signup, meetingBooked, purchase" });
  }

  let parsedLimit: number | undefined;
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({ error: "limit query parameter must be a positive integer" });
    }
    parsedLimit = parsed;
  }

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    const identity = { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug };
    const [personas, currentProfile] = await Promise.all([
      fetchActiveAudiences(brandId, identity),
      explicitBrandProfileId ? Promise.resolve(null) : fetchCurrentBrandProfile(brandId, identity),
    ]);
    const brandProfileId = explicitBrandProfileId ?? currentProfile?.id ?? null;

    const [costs, outcomes] = await Promise.all([
      fetchPersonaCosts(brandId, featureSlug, goalParam, brandProfileId, identity),
      fetchAudienceOutcomes(brandId, personas, identity),
    ]);

    const personaMap = new Map(personas.map((persona) => [persona.id, persona]));
    const ids = new Set([...costs.keys(), ...outcomes.keys()]);
    const rows: PersonaStatsRow[] = [];

    for (const audienceId of ids) {
      const persona = personaMap.get(audienceId);
      if (!persona) continue;

      const cost = costs.get(audienceId) ?? emptyCost();
      const outcome = outcomes.get(audienceId) ?? emptyOutcomes();
      rows.push({
        audienceId,
        brandProfileId,
        persona: {
          id: audienceId,
          name: persona.name,
          status: persona.status,
          filters: persona.filters,
        },
        evidence: {
          ...cost,
          ...outcome,
        },
        metrics: {
          cpcCents: ratioCents(cost.totalCostInUsdCents, outcome.websiteClicks),
          cpprCents: ratioCents(cost.totalCostInUsdCents, outcome.positiveReplies),
        },
      });
    }

    const sortMetric = sortMetricForGoal(goalParam);
    rows.sort((a, b) => compareByMetric(sortMetric, a, b));
    const personasOut = parsedLimit !== undefined ? rows.slice(0, parsedLimit) : rows;

    res.json({
      featureSlug,
      brandId,
      goal: goalParam,
      brandProfileId,
      sortMetric,
      personas: personasOut,
    });
  } catch (error) {
    console.error("[features-service] Persona stats error:", error);
    res.status(502).json({ error: "Failed to compute persona stats" });
  }
});

export default router;
