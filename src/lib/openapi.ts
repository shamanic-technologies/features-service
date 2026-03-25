import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  featureInputSchema,
  featureOutputSchema,
  featureChartSchema,
  upsertFeatureSchema,
  batchUpsertFeaturesSchema,
  createFeatureSchema,
  updateFeatureSchema,
  prefillRequestSchema,
} from "./schemas.js";

const registry = new OpenAPIRegistry();

// Register component schemas
registry.register("FeatureInput", featureInputSchema);
registry.register("FeatureOutput", featureOutputSchema);
registry.register("FeatureChart", featureChartSchema);
registry.register("UpsertFeature", upsertFeatureSchema);
registry.register("CreateFeature", createFeatureSchema);
registry.register("UpdateFeature", updateFeatureSchema);

const errorResponse = z.object({ error: z.string() });

// ── Feature response schema (matches DB row) ──────────────────────────────

const featureResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().describe("Unique machine-readable identifier, auto-generated from name (e.g. 'outlet-database-discovery')"),
  name: z.string().describe("Display name (e.g. 'Outlet Database Discovery')"),
  description: z.string(),
  icon: z.string().describe("Lucide icon name (e.g. 'envelope', 'globe', 'megaphone'). Use as <LucideIcon name={icon} /> or look up at lucide.dev/icons."),
  category: z.string().describe("Feature category: 'sales', 'pr', 'discovery', etc."),
  channel: z.string().describe("Communication channel: 'email', 'phone', 'linkedin', 'database', etc."),
  audienceType: z.string().describe("Form layout type: 'cold-outreach', 'discovery', etc."),
  implemented: z.boolean(),
  displayOrder: z.number().int(),
  status: z.enum(["active", "draft", "deprecated"]),
  signature: z.string().describe("Deterministic hash of sorted input+output keys — used for idempotent upsert"),
  inputs: z.array(featureInputSchema).describe("Input fields for the campaign creation form."),
  outputs: z.array(featureOutputSchema).describe("Output metrics — stats keys from the registry with display config. Use GET /stats/registry for labels and types."),
  charts: z.array(featureChartSchema).describe("Chart definitions (funnel-bar, breakdown-bar). At least one of each required."),
  entities: z.array(z.string()).describe("Entity types shown in campaign detail sidebar (e.g. ['leads', 'companies', 'emails'])"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

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
  workflowName: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
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

// ── Prefill response schemas ───────────────────────────────────────────────

const prefillTextResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  brandId: z.string().uuid().describe("Brand that was used for pre-fill"),
  format: z.literal("text"),
  prefilled: z.record(z.string(), z.string().nullable()).describe(
    "Map of input key → flattened text value (or null if extraction failed)."
  ),
}).describe("Pre-filled values as flat strings, ready for form inputs or workflow inputMapping");

const prefillFullResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  brandId: z.string().uuid().describe("Brand that was used for pre-fill"),
  format: z.literal("full"),
  prefilled: z.record(z.string(), z.object({
    value: z.any().describe("Extracted value — can be a string, array, or object depending on the field"),
    cached: z.boolean().describe("Whether the value was served from cache"),
    sourceUrls: z.array(z.string()).nullable().describe("URLs from the brand's website used to extract this value"),
  })).describe(
    "Map of input key → full extraction result."
  ),
}).describe("Pre-filled values with metadata (cache status, source URLs)");

const inputsResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  name: z.string().describe("Feature display name"),
  inputs: z.array(featureInputSchema).describe("Input definitions."),
});

registry.register("PrefillTextResponse", prefillTextResponseSchema);
registry.register("PrefillFullResponse", prefillFullResponseSchema);
registry.register("InputsResponse", inputsResponseSchema);

// ── PUT /features — batch upsert ──────────────────────────────────────────

registry.registerPath({
  method: "put",
  path: "/features",
  summary: "Batch upsert features (cold-start registration)",
  description:
    "Idempotent — safe to call on every cold start. " +
    "Uses a signature (hash of sorted input+output keys) to detect duplicates.",
  tags: ["Features"],
  request: { body: { content: { "application/json": { schema: batchUpsertFeaturesSchema } } } },
  responses: {
    200: { description: "Upserted features", content: { "application/json": { schema: z.object({ features: z.array(featureResponseSchema) }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── POST /features — create single ───────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/features",
  summary: "Create a single feature",
  tags: ["Features"],
  request: { body: { content: { "application/json": { schema: createFeatureSchema } } } },
  responses: {
    201: { description: "Created feature", content: { "application/json": { schema: z.object({ feature: featureResponseSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorResponse } } },
    409: { description: "Conflict", content: { "application/json": { schema: z.object({ error: z.string(), existingSlug: z.string().optional() }) } } },
  },
});

// ── GET /features — list ─────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features",
  summary: "List all features",
  tags: ["Features"],
  request: {
    query: z.object({
      status: z.string().optional(),
      category: z.string().optional(),
      channel: z.string().optional(),
      audienceType: z.string().optional(),
      implemented: z.enum(["true", "false"]).optional(),
    }),
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
  tags: ["Features"],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: "Feature details", content: { "application/json": { schema: z.object({ feature: featureResponseSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── PUT /features/:slug — update single ──────────────────────────────────

registry.registerPath({
  method: "put",
  path: "/features/{slug}",
  summary: "Update a single feature by slug",
  tags: ["Features"],
  request: {
    params: z.object({ slug: z.string() }),
    body: { content: { "application/json": { schema: updateFeatureSchema } } },
  },
  responses: {
    200: { description: "Updated feature", content: { "application/json": { schema: z.object({ feature: featureResponseSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
    409: { description: "Conflict", content: { "application/json": { schema: z.object({ error: z.string(), existingSlug: z.string().optional() }) } } },
  },
});

// ── GET /features/:slug/inputs ───────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/{slug}/inputs",
  summary: "Get input definitions for a feature",
  tags: ["Features"],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: "Feature inputs", content: { "application/json": { schema: inputsResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── POST /features/:slug/prefill ─────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/features/{slug}/prefill",
  summary: "Pre-fill input values for a feature from brand data",
  tags: ["Features"],
  request: {
    params: z.object({ slug: z.string() }),
    query: z.object({ format: z.enum(["text", "full"]).optional() }),
    body: { content: { "application/json": { schema: prefillRequestSchema } } },
  },
  responses: {
    200: {
      description: "Pre-filled values",
      content: {
        "application/json": {
          schema: z.discriminatedUnion("format", [prefillTextResponseSchema, prefillFullResponseSchema]),
        },
      },
    },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Brand-service unavailable", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats/registry ──────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats/registry",
  summary: "Get the stats key registry",
  description: "Returns the complete dictionary of known stats keys with their label and type. Used by the front-end to format and label output columns dynamically.",
  tags: ["Stats"],
  responses: {
    200: { description: "Stats registry", content: { "application/json": { schema: registryResponseSchema } } },
  },
});

// ── GET /features/:featureSlug/stats ─────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/stats",
  summary: "Get computed stats for a feature",
  description:
    "Returns computed stats for a feature's outputs and charts. " +
    "Optionally grouped by workflowName, brandId, or campaignId. " +
    "System stats (cost, runs, campaigns, dates) are always included.",
  tags: ["Stats"],
  request: {
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      groupBy: z.enum(["workflowName", "brandId", "campaignId"]).optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowName: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Feature stats", content: { "application/json": { schema: featureStatsResponseSchema } } },
    400: { description: "Missing org ID", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats",
  summary: "Global stats across all features",
  description:
    "Cross-feature stats endpoint for performance dashboards and org overview. " +
    "Supports groupBy: featureSlug, workflowName, brandId, campaignId.",
  tags: ["Stats"],
  request: {
    query: z.object({
      groupBy: z.string().optional().describe("Comma-separated dimensions: featureSlug, workflowName, brandId, campaignId"),
      brandId: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Global stats", content: { "application/json": { schema: globalStatsResponseSchema } } },
    400: { description: "Missing org ID", content: { "application/json": { schema: errorResponse } } },
  },
});

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
    version: "2.0.0",
    description:
      "Manages feature definitions and computes output stats.\n\n" +
      "## Key Concepts\n\n" +
      "**Features** define what campaigns can do: inputs (form), outputs (metrics), charts (funnel/breakdown), and entities (detail tabs).\n\n" +
      "**Stats Registry** (`GET /stats/registry`) — the finite universe of known stats keys. " +
      "Each key has a label and type (count, rate, currency). Features reference these keys in outputs and charts.\n\n" +
      "**Stats Endpoints** — features-service computes stats by calling downstream services " +
      "(email-gateway, runs-service, outlets-service) and returns computed values.\n\n" +
      "## Feature Definition\n\n" +
      "```typescript\n" +
      "{\n" +
      '  inputs:   [{ key, label, type, ... }],           // campaign form\n' +
      '  outputs:  [{ key, displayOrder }],                // metrics (validated against registry)\n' +
      '  charts:   [{ type: "funnel-bar", steps: [...] }], // visualizations\n' +
      '  entities: ["leads", "companies", "emails"],       // campaign detail tabs\n' +
      "}\n" +
      "```",
  },
  servers: [{ url: "/" }],
  security: [{ ApiKeyAuth: [] }],
});
