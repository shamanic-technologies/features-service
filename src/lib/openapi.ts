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
  featureDynastySlug: z.string().nullable().optional(),
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

// ── GET /stats ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats",
  summary: "Global stats across all features",
  description: "Cross-feature stats endpoint. Supports groupBy: featureSlug, featureDynastySlug, workflowSlug, workflowDynastySlug, brandId, campaignId.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    query: z.object({
      groupBy: z.string().optional(),
      brandId: z.string().optional(),
      featureSlug: z.string().optional(),
      featureDynastySlug: z.string().optional(),
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
  slug: z.string(),
  name: z.string().optional(),
  dynastyName: z.string().optional(),
  dynastySlug: z.string().optional(),
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

const rankedQueryParams = z.object({
  featureDynastySlug: z.string().describe("Feature slug (required)"),
  objective: z.string().optional().describe("Stats key to sort by (defaults to costPerRecipientPositiveReplyCents)"),
  groupBy: z.enum(["workflow", "brand"]).describe("Group results by workflow or by brand"),
  limit: z.string().optional().describe("Max results (default 3)"),
});

const bestQueryParams = z.object({
  featureDynastySlug: z.string().describe("Feature slug (required)"),
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
