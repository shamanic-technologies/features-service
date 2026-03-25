import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  featureInputSchema,
  featureOutputSchema,
  workflowColumnSchema,
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
registry.register("WorkflowColumn", workflowColumnSchema);
registry.register("FeatureChart", featureChartSchema);
registry.register("UpsertFeature", upsertFeatureSchema);
registry.register("CreateFeature", createFeatureSchema);
registry.register("UpdateFeature", updateFeatureSchema);

const errorResponse = z.object({ error: z.string() });

// PUT /features — batch upsert
registry.registerPath({
  method: "put",
  path: "/features",
  summary: "Batch upsert features (cold-start registration)",
  tags: ["Features"],
  request: { body: { content: { "application/json": { schema: batchUpsertFeaturesSchema } } } },
  responses: {
    200: { description: "Upserted features", content: { "application/json": { schema: z.object({ features: z.array(z.any()) }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorResponse } } },
  },
});

// POST /features — create single
registry.registerPath({
  method: "post",
  path: "/features",
  summary: "Create a single feature",
  tags: ["Features"],
  request: { body: { content: { "application/json": { schema: createFeatureSchema } } } },
  responses: {
    201: { description: "Created feature", content: { "application/json": { schema: z.object({ feature: z.any() }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorResponse } } },
    409: { description: "Conflict — slug, name, or signature already exists", content: { "application/json": { schema: z.object({ error: z.string(), existingSlug: z.string().optional() }) } } },
  },
});

// GET /features — list
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
    200: { description: "Feature list", content: { "application/json": { schema: z.object({ features: z.array(z.any()) }) } } },
  },
});

// GET /features/:slug
registry.registerPath({
  method: "get",
  path: "/features/{slug}",
  summary: "Get a single feature by slug",
  tags: ["Features"],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: "Feature details", content: { "application/json": { schema: z.object({ feature: z.any() }) } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// PUT /features/:slug — update single
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
    200: { description: "Updated feature", content: { "application/json": { schema: z.object({ feature: z.any() }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
    409: { description: "Conflict", content: { "application/json": { schema: z.object({ error: z.string(), existingSlug: z.string().optional() }) } } },
  },
});

// GET /features/:slug/inputs
registry.registerPath({
  method: "get",
  path: "/features/{slug}/inputs",
  summary: "Get input definitions for a feature",
  tags: ["Features"],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: { description: "Feature inputs", content: { "application/json": { schema: z.object({ slug: z.string(), name: z.string(), inputs: z.array(featureInputSchema) }) } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// POST /features/:slug/prefill
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
    200: { description: "Pre-filled values", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: "3.0.3",
  info: {
    title: "Features Service API",
    version: "1.0.0",
    description: "Manages feature definitions for the dashboard — inputs, outputs, charts, and metadata.",
  },
  servers: [{ url: "/" }],
  security: [{ ApiKeyAuth: [] }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
    },
  },
});
