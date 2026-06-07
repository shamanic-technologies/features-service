import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel, type EconomicsSource, type SalesEconomics } from "../lib/funnel-registry.js";
import { fetchSalesEconomics, fetchCrossBrandAverage } from "../lib/sales-economics-client.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchRunsCostCents, fetchCampaignIdsWithRuns } from "../lib/runs-cost-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { fetchQualifications } from "../lib/qualifications-client.js";
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
export interface CostEconomics {
  totalCostUsd: number;
  costOfAcquisitionPct: number | null;
  roiMultiple: number | null;
}

export function buildCostEconomics(totalCostInUsdCents: number, totalPipelineUsd: number | null): CostEconomics {
  const totalCostUsd = totalCostInUsdCents / 100;
  const costOfAcquisitionPct =
    totalPipelineUsd === null || totalPipelineUsd === 0 ? null : (totalCostUsd / totalPipelineUsd) * 100;
  const roiMultiple =
    totalCostUsd === 0 || totalPipelineUsd === null ? null : totalPipelineUsd / totalCostUsd;
  return { totalCostUsd, costOfAcquisitionPct, roiMultiple };
}

interface RevenueResponse {
  featureSlug: string;
  /**
   * totalPipelineUsd is null when no funnel is wired, or the brand has no saved economics AND no
   * cross-brand average exists yet (cold start). economicsSource tags the provenance of the economics
   * used: "sales-economics" = the brand's own saved set; "cross-brand-average" = the fallback average
   * (revenue is an ESTIMATE, not user-confirmed). Null when the pipeline is null (no source applied).
   */
  headline: { totalPipelineUsd: number | null; economicsSource: EconomicsSource | null };
  costEconomics: CostEconomics;
  timeSeries: TimeSeriesPoint[];
  organizations: OrganizationRow[];
  leads: LeadRow[];
  events: EventRow[];
}

/** The revenue response body for one (brand, campaign?) scope — everything but the featureSlug. */
export type RevenueBody = Omit<RevenueResponse, "featureSlug">;

export type DownstreamHeaders = { orgId: string; userId: string; runId: string; featureSlug?: string };

function emptyBody(totalPipelineUsd: number | null, totalCostInUsdCents: number): RevenueBody {
  return {
    headline: { totalPipelineUsd, economicsSource: null },
    costEconomics: buildCostEconomics(totalCostInUsdCents, totalPipelineUsd),
    timeSeries: [],
    organizations: [],
    leads: [],
    events: [],
  };
}

/**
 * Compute the full expected-pipeline revenue body for ONE (brand, campaign?) scope.
 *
 * Single source of truth for both the overview (no groupBy) and the per-campaign groups
 * (groupBy=campaignId) — calling it per enumerated campaign makes each group byte-equal to the
 * standalone ?campaignId= call. `funnel` is resolved once by the caller (same for every campaign).
 *
 * Economics + leads + cost are fail-loud (the pipeline total must be exact). Per-event timestamps
 * (email-gateway) and manual-qualification dates (instantly-service) are SECONDARY enrichment used
 * for dates / time-series / events / post-engagement decay / close-win: if a call fails we log and
 * degrade (the pipeline total, orgs and leads stay correct) rather than failing the whole endpoint.
 */
export async function computeFeatureRevenue(
  featureSlug: string,
  brandId: string,
  campaignId: string | undefined,
  funnel: ReturnType<typeof getFunnel>,
  headers: DownstreamHeaders,
): Promise<RevenueBody> {
  // Total run cost for this brand(+campaign), feature-scoped — same runs-service source as
  // /stats systemStats.totalCostInUsdCents. Required on every body (incl. null-pipeline paths),
  // so fetch it up front. Fail-loud: a swallowed error must not fake $0 cost / infinite ROI.
  const totalCostInUsdCents = await fetchRunsCostCents(brandId, campaignId, featureSlug, headers);

  // No funnel wired for this feature yet → null pipeline (not an error).
  if (!funnel) {
    return emptyBody(null, totalCostInUsdCents);
  }

  // Economics (rates + terminal LTR). A brand that saved its own set computes on it ("sales-economics").
  // A brand that never saved economics falls back to the CROSS-BRAND AVERAGE so revenue stays computable
  // ("cross-brand-average") — tagged so the dashboard can badge it ESTIMATED, never as a user-confirmed
  // number. If the average is ALSO null (no brand has saved economics yet — cold start) revenue is
  // genuinely incomputable → null pipeline.
  const savedEconomics = await fetchSalesEconomics(brandId, { ...headers, campaignId });
  let economics: SalesEconomics;
  let economicsSource: EconomicsSource;
  if (savedEconomics) {
    economics = savedEconomics;
    economicsSource = "sales-economics";
  } else {
    const averageEconomics = await fetchCrossBrandAverage({ ...headers, campaignId });
    if (!averageEconomics) {
      return emptyBody(null, totalCostInUsdCents);
    }
    economics = averageEconomics;
    economicsSource = "cross-brand-average";
  }

  // Platform-global email funnel rates (cached) — let a lead earn expected revenue from
  // its furthest reached stage (Contacted onward), not only from a click / positive reply.
  // Fail-loud: these are a core input to the pipeline total.
  const platformRates = await fetchPlatformEmailRates();

  const paths = funnel.resolvePaths({ economics, platformRates });
  const persons = await fetchLeadsForRevenue(brandId, campaignId, headers);

  // Secondary enrichment: per-event timestamps for dates / time-series / events.
  // Best-effort — a failure degrades to dateless output, it does NOT fail the endpoint.
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  try {
    const timestamps = await fetchEventTimestamps(brandId, campaignId, emails, headers);
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

  // Secondary enrichment #2: per-lead manual-qualification timestamps (meeting booked / closed).
  // These drive the Phase 2 post-engagement decay (reply → meeting → close) + close-win as
  // realized revenue. Best-effort — a failure degrades to no meeting/close dates (Phase 1 decay
  // + pipeline stay correct), it does NOT fail the endpoint. A known timestamp IS the signal
  // (mirrors how `open` was derived from firstOpenedAt).
  try {
    const quals = await fetchQualifications(brandId, campaignId, emails, headers);
    for (const person of persons) {
      const q = person.email ? quals.get(person.email) : undefined;
      if (!q) continue;
      person.signalDates = person.signalDates ?? {};
      if (q.meetingBookedAt) {
        person.signals.meeting = true;
        person.signalDates.meeting = q.meetingBookedAt;
      }
      if (q.closedAt) {
        person.signals.closeWin = true;
        person.signalDates.closeWin = q.closedAt;
      }
    }
  } catch (err) {
    console.warn(`[features-service] qualification enrichment failed (degrading to no meeting/close dates): ${(err as Error).message}`);
  }

  // closeValueUsd = LTR — the per-lead cap for combining independent engagement routes (click +
  // reply) as independent probabilities of one close (`undefined` keeps the wall-clock `now`).
  const result = computeRevenue(paths, persons, undefined, economics.lifetimeRevenueUsd);

  return {
    headline: { ...result.headline, economicsSource },
    costEconomics: buildCostEconomics(totalCostInUsdCents, result.headline.totalPipelineUsd),
    timeSeries: result.timeSeries,
    organizations: result.organizations,
    leads: result.leads,
    events: result.events,
  };
}

// ── GET /features/:featureSlug/revenue ───────────────────────────────────────
//
// Expected pipeline revenue for a feature, scoped to a brand (optionally one campaign).
// features-service is the single source: headline pipeline, organizations + leads tables,
// the cumulative time-series and the per-event ledger.
//
// With ?groupBy=campaignId the response collapses to one LEAN group per campaign that has runs
// for the brand+feature — { campaignId, headline.totalPipelineUsd, costEconomics } only — so the
// dashboard campaigns list gets every campaign's revenue + ROI in ONE call instead of N. Each
// group's values are byte-equal to the standalone ?campaignId= call (same per-campaign compute).

router.get("/features/:featureSlug/revenue", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const campaignId = req.query.campaignId as string | undefined;
  const groupBy = req.query.groupBy as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    const headers: DownstreamHeaders = { orgId, userId, runId, featureSlug: headerFeatureSlug };
    // Resolved once and shared across every campaign — null when no funnel is wired for the feature.
    const funnel = getFunnel(featureSlug);

    // ── Grouped: one lean group per campaign (dashboard campaigns list) ──────────
    if (groupBy === "campaignId") {
      const campaignIds = await fetchCampaignIdsWithRuns(brandId, featureSlug, headers);

      traceEvent(runId, { service: "features-service", event: "feature-revenue-grouped-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaigns=${campaignIds.length}` }, req.headers).catch(() => {});

      const groups = await Promise.all(
        campaignIds.map(async (cid) => {
          const body = await computeFeatureRevenue(featureSlug, brandId, cid, funnel, headers);
          return { campaignId: cid, headline: body.headline, costEconomics: body.costEconomics };
        }),
      );

      traceEvent(runId, { service: "features-service", event: "feature-revenue-grouped-done", detail: `featureSlug=${featureSlug}, groupCount=${groups.length}` }, req.headers).catch(() => {});

      return res.json({ featureSlug, groupBy: "campaignId", groups });
    }

    // ── Overview: single brand-scoped (optionally one-campaign) response (unchanged) ──
    traceEvent(runId, { service: "features-service", event: "feature-revenue-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaignId=${campaignId ?? "none"}` }, req.headers).catch(() => {});

    const body = await computeFeatureRevenue(featureSlug, brandId, campaignId, funnel, headers);

    traceEvent(runId, { service: "features-service", event: "feature-revenue-done", detail: `featureSlug=${featureSlug}, orgs=${body.organizations.length}, pipelineUsd=${body.headline.totalPipelineUsd}` }, req.headers).catch(() => {});

    res.json({ featureSlug, ...body });
  } catch (error) {
    console.error("[features-service] Feature revenue error:", error);
    if (runId) {
      traceEvent(runId, { service: "features-service", event: "feature-revenue-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(502).json({ error: "Failed to compute feature revenue" });
  }
});

export default router;
