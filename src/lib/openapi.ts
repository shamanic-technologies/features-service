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

// ── Feature response schema (matches DB row) ──────────────────────────────

const featureResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().describe("Unique machine-readable identifier, auto-generated from name (e.g. 'outlet-database-discovery')"),
  name: z.string().describe("Display name (e.g. 'Outlet Database Discovery')"),
  description: z.string(),
  icon: z.string(),
  category: z.string().describe("Feature category: 'sales', 'pr', 'discovery', etc."),
  channel: z.string().describe("Communication channel: 'email', 'phone', 'linkedin', 'database', etc."),
  audienceType: z.string().describe("Form layout type: 'cold-outreach', 'discovery', etc."),
  implemented: z.boolean(),
  displayOrder: z.number().int(),
  status: z.enum(["active", "draft", "deprecated"]),
  signature: z.string().describe("Deterministic hash of sorted input+output keys — used for idempotent upsert"),
  inputs: z.array(featureInputSchema).describe("Input fields for the campaign creation form. Each input has an extractKey that maps to brand-service's extract-fields API for AI pre-fill."),
  outputs: z.array(featureOutputSchema).describe("Output metrics displayed on the dashboard"),
  workflowColumns: z.array(workflowColumnSchema).describe("Column definitions for the workflow performance table"),
  charts: z.array(featureChartSchema).describe("Chart definitions (funnel, breakdown, etc.)"),
  resultComponent: z.string().nullable().describe("Specialized result component slug (e.g. 'discovered-outlets'), null for standard features"),
  defaultWorkflowName: z.string().nullable().describe("Default workflow name in workflow-service, null if no default"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

registry.register("Feature", featureResponseSchema);

// ── Prefill response schemas ───────────────────────────────────────────────

const prefillTextResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  brandId: z.string().uuid().describe("Brand that was used for pre-fill"),
  format: z.literal("text"),
  prefilled: z.record(z.string(), z.string().nullable()).describe(
    "Map of input key → flattened text value (or null if extraction failed). " +
    "Keys match the feature's inputs[].key. Example: { industry: 'Enterprise SaaS', angles: 'Series B funding, AI product launch', targetGeo: 'US and UK' }"
  ),
}).describe("Pre-filled values as flat strings, ready for form inputs or workflow inputMapping");

const prefillFullResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  brandId: z.string().uuid().describe("Brand that was used for pre-fill"),
  format: z.literal("full"),
  prefilled: z.record(z.string(), z.object({
    value: z.any().describe("Extracted value — can be a string, array, or object depending on the field"),
    cached: z.boolean().describe("Whether the value was served from cache (brand-service caches extractions for 30 days)"),
    sourceUrls: z.array(z.string()).nullable().describe("URLs from the brand's website that were used to extract this value"),
  })).describe(
    "Map of input key → full extraction result. " +
    "Keys match the feature's inputs[].key. Example: { industry: { value: 'Enterprise SaaS', cached: true, sourceUrls: ['https://example.com/about'] } }"
  ),
}).describe("Pre-filled values with metadata (cache status, source URLs)");

registry.register("PrefillTextResponse", prefillTextResponseSchema);
registry.register("PrefillFullResponse", prefillFullResponseSchema);

// ── Inputs response schema ────────────────────────────────────────────────

const inputsResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  name: z.string().describe("Feature display name"),
  inputs: z.array(featureInputSchema).describe(
    "Input definitions. Each input's extractKey maps to a brand-service extract-fields key. " +
    "Use these extractKeys when calling POST /brands/{brandId}/extract-fields, or call POST /features/{slug}/prefill to let the service handle extraction automatically."
  ),
});

registry.register("InputsResponse", inputsResponseSchema);

// ── PUT /features — batch upsert ──────────────────────────────────────────

registry.registerPath({
  method: "put",
  path: "/features",
  summary: "Batch upsert features (cold-start registration)",
  description:
    "Idempotent — safe to call on every cold start. " +
    "Uses a signature (hash of sorted input+output keys) to detect duplicates: " +
    "same signature → upsert metadata, same name but different signature → auto-suffix with v2, v3, etc.",
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
    409: { description: "Conflict — slug, name, or signature already exists", content: { "application/json": { schema: z.object({ error: z.string(), existingSlug: z.string().optional() }) } } },
  },
});

// ── GET /features — list ─────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features",
  summary: "List all features",
  description: "Returns all features, optionally filtered by status, category, channel, audienceType, or implemented flag.",
  tags: ["Features"],
  request: {
    query: z.object({
      status: z.string().optional().describe("Filter by status: 'active', 'draft', 'deprecated'"),
      category: z.string().optional().describe("Filter by category: 'sales', 'pr', etc."),
      channel: z.string().optional().describe("Filter by channel: 'email', 'database', etc."),
      audienceType: z.string().optional().describe("Filter by audience type: 'cold-outreach', 'discovery', etc."),
      implemented: z.enum(["true", "false"]).optional().describe("Filter by implementation status"),
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
  description:
    "Returns the full feature definition including inputs, outputs, charts, and workflow columns. " +
    "The inputs array contains extractKey fields that map to brand-service for AI-powered pre-fill.",
  tags: ["Features"],
  request: { params: z.object({ slug: z.string().describe("Feature slug, e.g. 'outlet-database-discovery'") }) },
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
  description: "Partial update — only provided fields are changed. If name changes, slug is re-generated.",
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
  description:
    "Returns the input schema for a feature. Each input has:\n" +
    "- **key**: machine-readable identifier used in prefill responses and workflow inputMapping\n" +
    "- **extractKey**: the key passed to brand-service's POST /brands/{brandId}/extract-fields for AI extraction\n" +
    "- **description**: rich context used by the LLM during extraction — describes what a good value looks like\n\n" +
    "**Workflow integration**: Use these inputs to build extract-fields requests, or call POST /features/{slug}/prefill " +
    "which handles extraction automatically and returns values keyed by input key.\n\n" +
    "**Example** for 'outlet-database-discovery':\n" +
    "```json\n" +
    "{\n" +
    '  "slug": "outlet-database-discovery",\n' +
    '  "name": "Outlet Database Discovery",\n' +
    '  "inputs": [\n' +
    '    { "key": "industry", "extractKey": "industry", "type": "text", ... },\n' +
    '    { "key": "angles", "extractKey": "suggestedAngles", "type": "text", ... },\n' +
    '    { "key": "targetGeo", "extractKey": "suggestedGeo", "type": "text", ... }\n' +
    "  ]\n" +
    "}\n" +
    "```",
  tags: ["Features"],
  request: { params: z.object({ slug: z.string().describe("Feature slug, e.g. 'outlet-database-discovery'") }) },
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
  description:
    "Takes a brandId, looks up the feature's inputs, calls brand-service to extract values via AI " +
    "(cached 30 days per field), and returns pre-filled values mapped to each input key.\n\n" +
    "**How it works internally**:\n" +
    "1. Reads the feature's inputs[].extractKey to build the extract-fields request\n" +
    "2. Calls brand-service POST /brands/{brandId}/extract-fields with those keys\n" +
    "3. Maps results back to input keys and returns a named object (not a positional array)\n\n" +
    "**format=text** (recommended for workflows): Returns `{ prefilled: { industry: 'SaaS', angles: 'Series B funding', targetGeo: 'US' } }` — " +
    "flat string values ready to pass directly as workflow inputs or form values.\n\n" +
    "**format=full** (default): Returns `{ prefilled: { industry: { value: 'SaaS', cached: true, sourceUrls: [...] } } }` — " +
    "includes cache status and source URLs for UI display.\n\n" +
    "**Workflow pattern**: In a workflow DAG, use this endpoint instead of calling brand-service extract-fields directly. " +
    "This ensures the extracted fields always match what the feature expects, with no index-based mapping fragility:\n" +
    "```\n" +
    "prefill-node → downstream-service\n" +
    "  inputMapping: { body.industry: '$ref:prefill-node.output.prefilled.industry' }\n" +
    "```",
  tags: ["Features"],
  request: {
    params: z.object({ slug: z.string().describe("Feature slug, e.g. 'outlet-database-discovery'") }),
    query: z.object({ format: z.enum(["text", "full"]).optional().describe("Response format: 'text' for flat strings (best for workflows), 'full' for values + metadata (default)") }),
    body: { content: { "application/json": { schema: prefillRequestSchema } } },
  },
  responses: {
    200: {
      description: "Pre-filled values. Response shape depends on ?format= query param.",
      content: {
        "application/json": {
          schema: z.discriminatedUnion("format", [prefillTextResponseSchema, prefillFullResponseSchema]),
        },
      },
    },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Brand-service unavailable or extraction failed", content: { "application/json": { schema: errorResponse } } },
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
    version: "1.0.0",
    description:
      "Manages feature definitions for the dashboard — inputs, outputs, charts, and metadata.\n\n" +
      "## Key Concepts\n\n" +
      "**Features** define what campaigns can do: their input form, output metrics, charts, and workflow columns. " +
      "Each feature has a unique slug (e.g. `outlet-database-discovery`) auto-generated from its name.\n\n" +
      "**Inputs** define the fields shown in the campaign creation form. Each input has an `extractKey` that maps to " +
      "brand-service's extract-fields API, enabling AI-powered pre-fill from brand data.\n\n" +
      "**Pre-fill flow** (for LLMs and workflows):\n" +
      "1. Call `GET /features/{slug}/inputs` to see what fields a feature needs and their extractKeys\n" +
      "2. Call `POST /features/{slug}/prefill` with a brandId to get AI-extracted values keyed by input key\n" +
      "3. Pass the prefilled values to downstream services (e.g. outlets-service discover endpoint)\n\n" +
      "The prefill endpoint returns **named keys** (not positional arrays), so workflows can reference fields by name " +
      "(e.g. `$ref:prefill.output.prefilled.industry`) instead of fragile index-based mapping.\n\n" +
      "## Available Features\n\n" +
      "| Slug | Category | Channel | Description |\n" +
      "|------|----------|---------|-------------|\n" +
      "| `outlet-database-discovery` | pr | database | Discover relevant press outlets via AI search + scoring |\n" +
      "| *(more via GET /features)* | | | |",
  },
  servers: [{ url: "/" }],
  security: [{ ApiKeyAuth: [] }],
});
