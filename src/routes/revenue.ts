import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel } from "../lib/funnel-registry.js";
import { fetchSalesEconomics } from "../lib/sales-economics-client.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchRunsCostCents } from "../lib/runs-cost-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { fetchPlatformEmailRates } from "../lib/platform-rates-client.js";
import {
  computeRevenue,
  type OrganizationRow,
  type LeadRow,
  type TimeSeriesPoint,
  type EventRow,
} from "../lib/revenue-engine.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

/**
 * Derived cost economics for the brand(+campaign), feature-scoped. Always present.
 *   - totalCostUsd:          total run cost in dollars (same source as /stats systemStats), >= 0.
 *   - costOfAcquisitionPct:  (totalCostUsd / totalPipelineUsd) * 100; null when pipeline is null OR 0.
 *   - roiMultiple:           totalPipelineUsd / totalCostUsd; null when cost is 0 OR pipeline is null.
 */
interface CostEconomics {
  totalCostUsd: number;
  costOfAcquisitionPct: number | null;
  roiMultiple: number | null;
}

function buildCostEconomics(totalCostInUsdCents: number, totalPipelineUsd: number | null): CostEconomics {
  const totalCostUsd = totalCostInUsdCents / 100;
  const costOfAcquisitionPct =
    totalPipelineUsd === null || totalPipelineUsd === 0 ? null : (totalCostUsd / totalPipelineUsd) * 100;
  const roiMultiple =
    totalCostUsd === 0 || totalPipelineUsd === null ? null : totalPipelineUsd / totalCostUsd;
  return { totalCostUsd, costOfAcquisitionPct, roiMultiple };
}

interface RevenueResponse {
  featureSlug: string;
  /** totalPipelineUsd is null when no funnel is wired or the brand has no economics saved. */
  headline: { totalPipelineUsd: number | null };
  costEconomics: CostEconomics;
  timeSeries: TimeSeriesPoint[];
  organizations: OrganizationRow[];
  leads: LeadRow[];
  events: EventRow[];
}

function emptyResult(featureSlug: string, totalPipelineUsd: number | null, totalCostInUsdCents: number): RevenueResponse {
  return {
    featureSlug,
    headline: { totalPipelineUsd },
    costEconomics: buildCostEconomics(totalCostInUsdCents, totalPipelineUsd),
    timeSeries: [],
    organizations: [],
    leads: [],
    events: [],
  };
}

// ── GET /features/:featureSlug/revenue ───────────────────────────────────────
//
// Expected pipeline revenue for a feature, scoped to a brand (optionally one campaign).
// features-service is the single source: headline pipeline, organizations + leads tables,
// the cumulative time-series and the per-event ledger.
//
// Economics + leads are fail-loud (the pipeline total must be exact). Per-event timestamps
// from email-gateway are a SECONDARY enrichment used only for the dates / time-series /
// events: if that call fails, we log and degrade to dateless output (the pipeline total,
// orgs and leads stay correct) rather than failing the whole endpoint.

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

    // Total run cost for this brand(+campaign), feature-scoped — same runs-service source as
    // /stats systemStats.totalCostInUsdCents. Required on every 200 (incl. null-pipeline paths),
    // so fetch it up front. Fail-loud: a swallowed error must not fake $0 cost / infinite ROI.
    const totalCostInUsdCents = await fetchRunsCostCents(brandId, campaignId, featureSlug, { orgId, userId, runId, featureSlug: headerFeatureSlug });

    // No funnel wired for this feature yet → null pipeline (not an error).
    const funnel = getFunnel(featureSlug);
    if (!funnel) {
      return res.json(emptyResult(featureSlug, null, totalCostInUsdCents));
    }

    traceEvent(runId, { service: "features-service", event: "feature-revenue-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaignId=${campaignId ?? "none"}` }, req.headers).catch(() => {});

    // Economics (rates + terminal LTR). Unset → revenue incomputable → null pipeline.
    const economics = await fetchSalesEconomics(brandId, { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug });
    if (!economics) {
      return res.json(emptyResult(featureSlug, null, totalCostInUsdCents));
    }

    // Platform-global email funnel rates (cached) — let a lead earn expected revenue from
    // its furthest reached stage (Contacted onward), not only from a click / positive reply.
    // Fail-loud: these are a core input to the pipeline total.
    const platformRates = await fetchPlatformEmailRates();

    const paths = funnel.resolvePaths({ economics, platformRates });
    const persons = await fetchLeadsForRevenue(brandId, campaignId, { orgId, userId, runId, featureSlug: headerFeatureSlug });

    // Secondary enrichment: per-event timestamps for dates / time-series / events.
    // Best-effort — a failure degrades to dateless output, it does NOT fail the endpoint.
    const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
    try {
      const timestamps = await fetchEventTimestamps(brandId, campaignId, emails, { orgId, userId, runId, featureSlug: headerFeatureSlug });
      for (const person of persons) {
        const dates = person.email ? timestamps.get(person.email) : undefined;
        if (dates) {
          person.signalDates = {
            contacted: dates.contacted,
            sent: dates.sent,
            delivered: dates.delivered,
            open: dates.open,
            clicked: dates.clicked,
            positiveReply: dates.positiveReply,
          };
          // `open` has no boolean in the leads overlay — a known open timestamp IS the signal.
          if (dates.open) person.signals.open = true;
        }
      }
    } catch (err) {
      console.warn(`[features-service] event-timestamp enrichment failed (degrading to dateless): ${(err as Error).message}`);
    }

    const result = computeRevenue(paths, persons);

    traceEvent(runId, { service: "features-service", event: "feature-revenue-done", detail: `featureSlug=${featureSlug}, orgs=${result.organizations.length}, pipelineUsd=${result.headline.totalPipelineUsd}` }, req.headers).catch(() => {});

    const response: RevenueResponse = {
      featureSlug,
      headline: result.headline,
      costEconomics: buildCostEconomics(totalCostInUsdCents, result.headline.totalPipelineUsd),
      timeSeries: result.timeSeries,
      organizations: result.organizations,
      leads: result.leads,
      events: result.events,
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
