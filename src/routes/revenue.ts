import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel } from "../lib/funnel-registry.js";
import { fetchSalesEconomics } from "../lib/sales-economics-client.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { computeRevenue, type OrganizationRow, type LeadRow } from "../lib/revenue-engine.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

/** P1 payload — timeSeries + events stay empty until per-event timestamps exist (email-gateway). */
interface RevenueResponse {
  featureSlug: string;
  /** totalPipelineUsd is null when no funnel is wired or the brand has no economics saved. */
  headline: { totalPipelineUsd: number | null };
  timeSeries: Array<{ date: string; cumulativePipelineUsd: number }>;
  organizations: OrganizationRow[];
  leads: LeadRow[];
  events: Array<{
    leadId: string;
    person: string | null;
    org: string | null;
    eventType: string;
    eventDate: string;
    contributionUsd: number;
  }>;
}

function emptyResult(featureSlug: string, totalPipelineUsd: number | null): RevenueResponse {
  return {
    featureSlug,
    headline: { totalPipelineUsd },
    timeSeries: [],
    organizations: [],
    leads: [],
    events: [],
  };
}

// ── GET /features/:featureSlug/revenue ───────────────────────────────────────
//
// Expected pipeline revenue for a feature, scoped to a brand (optionally one campaign).
// features-service is the single source: it computes the headline, the organizations
// table and the leads table. timeSeries + events + the date columns are deferred until
// email-gateway exposes per-event timestamps.

router.get("/features/:featureSlug/revenue", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const campaignId = req.query.campaignId as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    // No funnel wired for this feature yet → null pipeline (not an error).
    const funnel = getFunnel(featureSlug);
    if (!funnel) {
      return res.json(emptyResult(featureSlug, null));
    }

    traceEvent(runId, { service: "features-service", event: "feature-revenue-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaignId=${campaignId ?? "none"}` }, req.headers).catch(() => {});

    // Economics (rates + terminal LTR). Unset → revenue incomputable → null pipeline.
    const economics = await fetchSalesEconomics(brandId, { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug });
    if (!economics) {
      return res.json(emptyResult(featureSlug, null));
    }

    const paths = funnel.resolvePaths(economics);
    const persons = await fetchLeadsForRevenue(brandId, campaignId, { orgId, userId, runId, featureSlug: headerFeatureSlug });

    const result = computeRevenue(paths, persons);

    traceEvent(runId, { service: "features-service", event: "feature-revenue-done", detail: `featureSlug=${featureSlug}, orgs=${result.organizations.length}, pipelineUsd=${result.headline.totalPipelineUsd}` }, req.headers).catch(() => {});

    const response: RevenueResponse = {
      featureSlug,
      headline: result.headline,
      timeSeries: [],
      organizations: result.organizations,
      leads: result.leads,
      events: [],
    };
    res.json(response);
  } catch (error) {
    console.error("[features-service] Feature revenue error:", error);
    if (runId) {
      traceEvent(runId, { service: "features-service", event: "feature-revenue-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(502).json({ error: "Failed to compute feature revenue" });
  }
});

export default router;
