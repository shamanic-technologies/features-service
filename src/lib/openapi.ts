import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { featureResponseSchema } from "./schemas.js";

const registry = new OpenAPIRegistry();

const errorResponse = z.object({ error: z.string() });

registry.register("Feature", featureResponseSchema);

// ── Stats response schemas ───────────────────────────────────────────────

const systemStatsSchema = z.object({
  totalCostInUsdCents: z.number(),
  completedRuns: z.number(),
  activeCampaigns: z.number(),
  firstRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});

const statsGroupSchema = z.object({
  workflowSlug: z.string().nullable().optional(),
  workflowDynastySlug: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  featureSlug: z.string().nullable().optional(),
  systemStats: systemStatsSchema,
  stats: z.record(z.string(), z.number().nullable()),
});

const featureStatsResponseSchema = z.object({
  featureSlug: z.string(),
  groupBy: z.string().optional(),
  systemStats: systemStatsSchema,
  groups: z.array(statsGroupSchema).optional(),
  stats: z.record(z.string(), z.number().nullable()).optional(),
});

const globalStatsResponseSchema = z.object({
  groupBy: z.string().optional(),
  systemStats: systemStatsSchema,
  groups: z.array(statsGroupSchema).optional(),
  stats: z.record(z.string(), z.number().nullable()).optional(),
});

const registryResponseSchema = z.object({
  registry: z.record(z.string(), z.object({
    type: z.string(),
    label: z.string(),
    sortDirection: z.enum(["asc", "desc"]).optional(),
  })),
});

registry.register("SystemStats", systemStatsSchema);
registry.register("StatsGroup", statsGroupSchema);
registry.register("FeatureStatsResponse", featureStatsResponseSchema);
registry.register("GlobalStatsResponse", globalStatsResponseSchema);
registry.register("RegistryResponse", registryResponseSchema);

// ── Entity registry schema ──────────────────────────────────────────────

const entityTypeDefSchema = z.object({
  label: z.string(),
  icon: z.string(),
  pathSuffix: z.string(),
  description: z.string(),
});

const entityRegistryResponseSchema = z.object({
  registry: z.record(z.string(), entityTypeDefSchema),
});

registry.register("EntityTypeDef", entityTypeDefSchema);
registry.register("EntityRegistryResponse", entityRegistryResponseSchema);

// ── Required identity headers (all authenticated endpoints) ────────────────

const identityHeaders = z.object({
  "x-org-id": z.string().uuid().describe("Internal org UUID from client-service"),
  "x-user-id": z.string().uuid().describe("Internal user UUID from client-service"),
  "x-run-id": z.string().uuid().describe("Run ID for tracking and billing"),
  "x-brand-id": z.string().optional().describe("Brand UUID(s), comma-separated"),
});

// ── GET /features — list ─────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features",
  summary: "List all features",
  description: "Returns features filtered by status. Defaults to `status=active`.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    query: z.object({ status: z.string().optional() }),
  },
  responses: {
    200: { description: "Feature list", content: { "application/json": { schema: z.object({ features: z.array(featureResponseSchema) }) } } },
  },
});

// ── GET /features/:slug ──────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/{slug}",
  summary: "Get a single feature by slug",
  description: "Returns a feature by its exact slug. Returns 404 if not found.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: { description: "Feature details", content: { "application/json": { schema: z.object({ feature: featureResponseSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/inputs ─────────────────────────────────────

const featureInputsResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  inputs: z.array(z.any()),
});

registry.register("FeatureInputsResponse", featureInputsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/inputs",
  summary: "Get inputs for a feature",
  description: "Returns the input field definitions for a feature by its slug.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
  },
  responses: {
    200: { description: "Feature inputs", content: { "application/json": { schema: featureInputsResponseSchema } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── POST /features/:featureSlug/prefill ──────────────────────────────────

const prefillResponseSchema = z.object({
  slug: z.string(),
  brandId: z.string(),
  format: z.enum(["text", "full"]),
  prefilled: z.record(z.string(), z.any()),
});

registry.register("PrefillResponse", prefillResponseSchema);

registry.registerPath({
  method: "post",
  path: "/features/{featureSlug}/prefill",
  summary: "Pre-fill feature inputs from brand data",
  description: "Calls brand-service to extract field values for the feature's inputs. Returns pre-filled values keyed by input key. Requires x-brand-id header. Use ?format=text for flattened strings, ?format=full for structured values with per-brand breakdown.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      format: z.enum(["text", "full"]).optional().describe("Response format: 'text' returns flattened strings, 'full' returns structured values with per-brand breakdown. Defaults to 'full'."),
    }),
  },
  responses: {
    200: { description: "Pre-filled input values", content: { "application/json": { schema: prefillResponseSchema } } },
    400: { description: "Missing x-brand-id or invalid format", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Brand service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats/registry ──────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats/registry",
  summary: "Get the stats key registry",
  description: "Returns all known stats keys with their label and type.",
  tags: ["Stats"],
  request: { headers: identityHeaders },
  responses: {
    200: { description: "Stats registry", content: { "application/json": { schema: registryResponseSchema } } },
  },
});

// ── GET /entities/registry ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/entities/registry",
  summary: "Get the entity type registry",
  description: "Returns all known entity types with display metadata.",
  tags: ["Entities"],
  request: { headers: identityHeaders },
  responses: {
    200: { description: "Entity type registry", content: { "application/json": { schema: entityRegistryResponseSchema } } },
  },
});

// ── GET /features/:featureSlug/stats ─────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/stats",
  summary: "Get computed stats for a feature",
  description: "Returns computed stats for a feature slug. Optionally grouped by workflowSlug, brandId, or campaignId.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      groupBy: z.enum(["workflowSlug", "workflowDynastySlug", "brandId", "campaignId"]).optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowSlug: z.string().optional(),
      workflowDynastySlug: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Feature stats", content: { "application/json": { schema: featureStatsResponseSchema } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/revenue ────────────────────────────────────

const topPersonSchema = z.object({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
});

const revenueOrganizationSchema = z.object({
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  orgLogoUrl: z.string().nullable(),
  orgDomain: z.string().nullable().describe("Company domain (no protocol, e.g. \"acme.com\") for building a logo.dev URL. Null when no domain is known for the org."),
  topPerson: topPersonSchema,
  tags: z.array(z.string()),
  expectedRevenueUsd: z.number(),
  mostAdvancedDate: z.string().nullable().describe("Most-advanced event date. Null until per-event timestamps exist (email-gateway)."),
});

const revenueLeadSchema = z.object({
  leadId: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  orgName: z.string().nullable(),
  orgLogoUrl: z.string().nullable(),
  orgDomain: z.string().nullable().describe("Company domain (no protocol, e.g. \"acme.com\") for building a logo.dev URL. Null when no domain is known for the org."),
  tags: z.array(z.string()),
  expectedRevenueUsd: z.number(),
  date: z.string().nullable().describe("Most-advanced event date. Null until per-event timestamps exist (email-gateway)."),
});

const revenueTimeSeriesPointSchema = z.object({
  date: z.string(),
  cumulativePipelineUsd: z.number(),
});

const revenueEventSchema = z.object({
  leadId: z.string(),
  person: z.string().nullable(),
  org: z.string().nullable(),
  eventType: z.string(),
  eventDate: z.string(),
  contributionUsd: z.number(),
});

const revenueCostEconomicsSchema = z.object({
  totalCostUsd: z.number().describe("Total run cost for the brand (+ optional campaign), feature-scoped, in dollars (>= 0). Same source as /stats systemStats.totalCostInUsdCents."),
  costOfAcquisitionPct: z.number().nullable().describe("(totalCostUsd / totalPipelineUsd) * 100. Null when totalPipelineUsd is null or 0."),
  roiMultiple: z.number().nullable().describe("totalPipelineUsd / totalCostUsd. Null when totalCostUsd is 0 or totalPipelineUsd is null."),
});

const featureRevenueResponseSchema = z.object({
  featureSlug: z.string(),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start)."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used: 'sales-economics' = the brand's own saved set; 'cross-brand-average' = the brand-service cross-brand average fallback (revenue is an ESTIMATE, not user-confirmed). Null when the pipeline is null (no funnel wired or no economics applied)."),
  }),
  costEconomics: revenueCostEconomicsSchema.describe("Derived cost economics. Always present; ratios are null per the documented null semantics."),
  timeSeries: z.array(revenueTimeSeriesPointSchema).describe("Cumulative pipeline ordered by event date. Empty until per-event timestamps exist (email-gateway)."),
  organizations: z.array(revenueOrganizationSchema),
  leads: z.array(revenueLeadSchema),
  events: z.array(revenueEventSchema).describe("One row per event. Empty until per-event timestamps exist (email-gateway)."),
});

const featureRevenueResponseRef = registry.register("FeatureRevenueResponse", featureRevenueResponseSchema);

// Grouped variant — returned only when ?groupBy=campaignId. One LEAN group per campaign that has
// runs for the brand+feature: campaignId + headline.totalPipelineUsd + costEconomics ONLY (the
// dashboard campaigns row needs just revenue + ROI). Each group is byte-equal to the standalone
// ?campaignId= call. The heavy per-campaign arrays (timeSeries/organizations/leads/events) are omitted.
const revenueGroupSchema = z.object({
  campaignId: z.string(),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline for this campaign. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start)."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used: 'sales-economics' = the brand's own saved set; 'cross-brand-average' = the brand-service cross-brand average fallback (ESTIMATE). Null when the pipeline is null."),
  }),
  costEconomics: revenueCostEconomicsSchema,
});

const featureRevenueGroupedResponseSchema = z.object({
  featureSlug: z.string(),
  groupBy: z.literal("campaignId"),
  groups: z.array(revenueGroupSchema),
});

const featureRevenueGroupedResponseRef = registry.register("FeatureRevenueGroupedResponse", featureRevenueGroupedResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/revenue",
  summary: "Expected pipeline revenue for a feature",
  description:
    "Computes expected pipeline revenue for a feature, scoped to a brand (optionally one campaign). " +
    "Expected value uses MAX inside each entity (person, org) and SUM between distinct orgs. " +
    "Rates + terminal LTR come from the brand's sales economics. " +
    "timeSeries, events, and the date columns are deferred until email-gateway exposes per-event timestamps. " +
    "totalPipelineUsd is null when no funnel is wired for the feature, or the brand has no saved economics AND no cross-brand average exists (cold start). " +
    "When a brand has no saved economics but a cross-brand average exists, revenue is computed on that average and headline.economicsSource is 'cross-brand-average' (an estimate); otherwise 'sales-economics' (the brand's own saved set), or null for a null pipeline. " +
    "costEconomics carries the total run cost (same source as /stats systemStats) plus derived cost-of-acquisition % and ROI multiple. " +
    "With ?groupBy=campaignId the response is instead one LEAN group per campaign that has runs for the brand+feature " +
    "(campaignId + headline.totalPipelineUsd + costEconomics only); each group is byte-equal to the standalone ?campaignId= call.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — revenue is brand-scoped."),
      campaignId: z.string().optional().describe("Optional campaign drill-down (ignored when groupBy=campaignId)."),
      groupBy: z.enum(["campaignId"]).optional().describe("When 'campaignId', return one lean group per campaign with runs for the brand+feature instead of the single overview."),
    }),
  },
  responses: {
    200: { description: "Feature revenue (overview, or grouped when groupBy=campaignId)", content: { "application/json": { schema: z.union([featureRevenueResponseRef, featureRevenueGroupedResponseRef]) } } },
    400: { description: "Missing brandId", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/workflow-projection ─────────────────────────

const workflowProjectionDetailSchema = z.object({
  contactedLeads: z.number().nullable().describe("Expected unique leads contacted from the budget. Null when the workflow has no usable contacted-lead denominator."),
  replies: z.number().nullable().describe("Expected positive replies from the budget. Null when the workflow has no reply cost."),
  visits: z.number().nullable().describe("Expected clicks/visits from the budget. Null when the workflow has no click cost."),
  meetings: z.number().nullable().describe("Expected meetings booked (from both the reply and click routes)."),
  closes: z.number().nullable().describe("Expected closes from the budget."),
  revenue: z.number().nullable().describe("closes × LTR (lifetime revenue per close)."),
  cacPct: z.number().nullable().describe("(budget / revenue) × 100. Null when revenue is 0."),
  cacAbs: z.number().nullable().describe("budget / closes (absolute cost per close). Null when closes is 0."),
});

const workflowProjectionItemSchema = z.object({
  workflowDynastySlug: z.string(),
  workflowDynastyName: z.string().nullable(),
  contactedUsd: z.number().nullable().describe("Cost per unique lead contacted (USD). Null when the contacted-lead denominator is absent or zero."),
  replyUsd: z.number().nullable().describe("Cost per positive reply (USD). Null when the metric is absent or zero."),
  clickUsd: z.number().nullable().describe("Cost per click (USD). Null when the metric is absent or zero."),
  costPerCloseUsd: z.number().nullable().describe("Budget required per close for this workflow. Null when there is no usable cost/conversion data."),
  projection: workflowProjectionDetailSchema.nullable().describe("Null when budgetUsd is absent/≤0 or the workflow has no usable data."),
});

const workflowProjectionResponseSchema = z.object({
  featureSlug: z.string(),
  objective: z.enum(["meeting-booked", "self-serve"]).describe("Echo of the requested objective (defaults to meeting-booked). Deprecated — no longer affects the ranking, which is objective-agnostic."),
  workflows: z.array(workflowProjectionItemSchema),
  recommendedWorkflowDynastySlug: z.string().nullable().describe("Workflow with the lowest costPerCloseUsd. Null when none has usable data."),
  recommendedBudgetUsd: z.number().nullable().describe("10 (target closes/month) × the best costPerCloseUsd. Null when there is no pick."),
});

registry.register("WorkflowProjectionResponse", workflowProjectionResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/workflow-projection",
  summary: "Rank workflows by cost-per-close and project a budget",
  description:
    "Ranks a brand's workflows by combined cost-per-close (the reply + click engagement routes funded by one budget) and — when budgetUsd is given — projects that budget through the funnel. Objective-agnostic: every non-zero conversion path counts, so the ranking does not depend on the campaign objective. " +
    "Per-workflow unit costs (cost per positive reply / per click) are global cross-org workflow efficiency (same source as /public/stats/best), aggregated over each workflow's upgrade chain. " +
    "Conversion rates + LTR come from the brand's saved sales-economics. " +
    "recommendedWorkflowDynastySlug is the workflow with the lowest costPerCloseUsd; recommendedBudgetUsd = 10 × that cost.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — conversion economics are brand-scoped."),
      objective: z.enum(["meeting-booked", "self-serve"]).optional().describe("Deprecated — no longer affects the ranking (objective-agnostic: every non-zero conversion path counts). Accepted + echoed for back-compat; defaults to meeting-booked."),
      budgetUsd: z.string().optional().describe("Optional budget (USD) to project through the funnel."),
    }),
  },
  responses: {
    200: { description: "Workflow projection", content: { "application/json": { schema: workflowProjectionResponseSchema } } },
    400: { description: "Missing brandId", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats",
  summary: "Global stats across all features",
  description: "Cross-feature stats endpoint. Supports groupBy: featureSlug, workflowSlug, workflowDynastySlug, brandId, campaignId.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    query: z.object({
      groupBy: z.string().optional(),
      brandId: z.string().optional(),
      featureSlug: z.string().optional(),
      workflowSlug: z.string().optional(),
      workflowDynastySlug: z.string().optional(),
      campaignId: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Global stats", content: { "application/json": { schema: globalStatsResponseSchema } } },
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (no auth)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /public/features ──────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/features",
  summary: "List active features (public, no auth)",
  description: "Returns all active features. No API key required.",
  tags: ["Public"],
  responses: {
    200: { description: "Active features", content: { "application/json": { schema: z.object({ features: z.array(featureResponseSchema) }) } } },
  },
});

// ── Ranked / Best schemas ────────────────────────────────────────────────

const rankedWorkflowSchema = z.object({
  id: z.string().uuid().optional(),
  workflowSlug: z.string(),
  workflowName: z.string().optional(),
  workflowDynastyName: z.string().optional(),
  workflowDynastySlug: z.string().optional(),
  version: z.number().int().optional(),
  featureSlug: z.string().optional(),
  createdForBrandId: z.string().nullable().optional(),
});

const rankedBrandSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
});

const rankedStatsSchema = z.record(z.string(), z.number().nullable());

const rankedResultSchema = z.object({
  workflow: rankedWorkflowSchema.optional(),
  brand: rankedBrandSchema.optional(),
  stats: rankedStatsSchema,
});

const rankedResponseSchema = z.object({
  objective: z.string(),
  sortDirection: z.enum(["asc", "desc"]),
  results: z.array(rankedResultSchema),
});

const publicEngagementLatencyMetricSchema = z.object({
  averageMs: z.number().nullable().describe("Average elapsed time in milliseconds. Null when sampleSize is 0."),
  medianMs: z.number().nullable().describe("Median elapsed time in milliseconds. Null when sampleSize is 0."),
  sampleSize: z.number().int().describe("Number of recipients included in this metric."),
});

const publicWorkflowEngagementLatencyResultSchema = z.object({
  workflow: rankedWorkflowSchema,
  timeToFirstLinkClick: publicEngagementLatencyMetricSchema,
  timeToFirstPositiveReply: publicEngagementLatencyMetricSchema,
});

const publicWorkflowEngagementLatencyResponseSchema = z.object({
  featureSlug: z.string(),
  groupBy: z.literal("workflow"),
  results: z.array(publicWorkflowEngagementLatencyResultSchema),
});

const rankedQueryParams = z.object({
  featureSlug: z.string().describe("Feature slug (required)"),
  objective: z.string().optional().describe("Stats key to sort by (defaults to costPerRecipientPositiveReplyCents)"),
  groupBy: z.enum(["workflow", "brand"]).describe("Group results by workflow or by brand"),
  limit: z.string().optional().describe("Max results (default 3)"),
});

const bestQueryParams = z.object({
  featureSlug: z.string().describe("Feature slug (required)"),
  groupBy: z.enum(["workflow", "brand"]).describe("Group results by workflow or by brand"),
});

const bestEntryWorkflowSchema = z.object({
  workflowSlug: z.string(),
  workflowName: z.string(),
  createdForBrandId: z.string().nullable(),
  value: z.number(),
});

// ── GET /public/stats/ranked ──────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/ranked",
  summary: "Top workflows or brands ranked by output metric (public, no auth)",
  description: "Returns top workflows or brands ranked by an output metric for a feature.",
  tags: ["Public"],
  request: { query: rankedQueryParams },
  responses: {
    200: { description: "Ranked results", content: { "application/json": { schema: rankedResponseSchema } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/best ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/best",
  summary: "Best cost-per-outcome per metric (public, no auth)",
  description: "Returns the best (lowest cost-per-outcome) workflow or brand for each count-type metric.",
  tags: ["Public"],
  request: { query: bestQueryParams },
  responses: {
    200: { description: "Best records per metric", content: { "application/json": { schema: z.object({ best: z.record(z.string(), bestEntryWorkflowSchema.nullable()) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/revenue ─────────────────────────────────────────────

const publicRevenueResultSchema = z.object({
  brand: rankedBrandSchema,
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Cross-org expected pipeline for the brand (sum over the orgs it appears in). Null when no saved economics anywhere."),
  }),
  costEconomics: revenueCostEconomicsSchema,
});

const publicRevenueResponseSchema = z.object({
  featureSlug: z.string(),
  groupBy: z.literal("brand"),
  results: z.array(publicRevenueResultSchema),
});

registry.registerPath({
  method: "get",
  path: "/public/stats/revenue",
  summary: "Cross-org expected pipeline revenue + CAC + ROI per brand (public, no auth)",
  description:
    "Per-brand expected pipeline revenue, cost-of-acquisition % and ROI multiple for a feature, aggregated cross-org. " +
    "Runs the same expected-pipeline engine as GET /features/{featureSlug}/revenue once per (org, brand) that has leads for the feature, and sums each brand across the orgs it appears in (leads are disjoint per org, so no double-count). " +
    "costEconomics is byte-identical to the dashboard's (buildCostEconomics). Only groupBy=brand is supported today — per-workflow revenue is a follow-up.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      groupBy: z.literal("brand").describe("Group results by brand (only supported value)."),
    }),
  },
  responses: {
    200: { description: "Per-brand cross-org revenue", content: { "application/json": { schema: publicRevenueResponseSchema } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/workflow-engagement-latency ────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/workflow-engagement-latency",
  summary: "Average and median time-to-engagement per workflow (public, no auth)",
  description:
    "Returns public-safe workflow-level average and median elapsed time to first link click and first positive reply for a feature. " +
    "The duration math is computed by the email stats producer from dated activity; features-service enriches only with public workflow identity. " +
    "Only groupBy=workflow is supported.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      groupBy: z.literal("workflow").describe("Group results by workflow (only supported value)."),
    }),
  },
  responses: {
    200: { description: "Per-workflow engagement latency metrics", content: { "application/json": { schema: publicWorkflowEngagementLatencyResponseSchema } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── Authenticated ranked/best ────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats/ranked",
  summary: "Top workflows or brands ranked by output metric (authenticated)",
  description: "Authenticated version of GET /public/stats/ranked.",
  tags: ["Stats"],
  request: { headers: identityHeaders, query: rankedQueryParams },
  responses: {
    200: { description: "Ranked results", content: { "application/json": { schema: rankedResponseSchema } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/stats/best",
  summary: "Best cost-per-outcome per metric (authenticated)",
  description: "Authenticated version of GET /public/stats/best.",
  tags: ["Stats"],
  request: { headers: identityHeaders, query: bestQueryParams },
  responses: {
    200: { description: "Best records per metric", content: { "application/json": { schema: z.object({ best: z.record(z.string(), bestEntryWorkflowSchema.nullable()) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── Security scheme ──────────────────────────────────────────────────────

registry.registerComponent("securitySchemes", "ApiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
});

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: "3.0.3",
  info: {
    title: "Features Service API",
    version: "4.0.0",
    description:
      "Manages feature definitions and computes output stats.\n\n" +
      "Features are a minimal lookup table: id, slug, name, description, status.\n" +
      "Stats are computed by calling downstream services and aggregating results.",
  },
  servers: [{ url: "/" }],
  security: [{ ApiKeyAuth: [] }],
});
