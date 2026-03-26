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
  name: z.string().describe("Machine name — unique, changes on fork (e.g. 'Sales Cold Email Outreach v2')"),
  displayName: z.string().describe("Human-readable display name — stable across forks (e.g. 'Sales Cold Email Outreach'). Use this for UI display."),
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
  forkedFrom: z.string().uuid().nullable().describe("If this feature was forked from another, the ID of the original."),
  upgradedTo: z.string().uuid().nullable().describe("If deprecated, the ID of the replacement feature."),
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
    "Idempotent — safe to call on every cold start. Platform-only (X-API-Key auth).\n\n" +
    "Uses a **signature** (SHA-256 hash of sorted input+output keys) to detect duplicates:\n" +
    "- Same signature → upsert metadata (labels, descriptions, charts, entities, etc.)\n" +
    "- Same name but different signature → auto-suffix name/slug with v2, v3, etc.\n" +
    "- New name and new signature → create new feature\n\n" +
    "This is the equivalent of workflow-service's `PUT /workflows/upgrade`. " +
    "The `name` field in the request body becomes the `displayName`.",
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
  description:
    "Creates a brand-new feature. Slug is auto-generated from name if not provided. " +
    "Returns 409 if a feature with the same slug, name, or signature already exists.\n\n" +
    "The `name` field becomes both the `name` (machine identifier) and `displayName` (human-readable label) " +
    "of the created feature. On future forks, `displayName` stays the same while `name` gets versioned.",
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
  description:
    "Returns features filtered by query params. Defaults to `status=active` — " +
    "deprecated features (replaced by a fork) are excluded unless explicitly requested.\n\n" +
    "Use `status=deprecated` to see the full history, or omit the status filter to see all.",
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

// ── PUT /features/:slug — fork-on-write ──────────────────────────────────

const forkResponseSchema = z.object({
  feature: featureResponseSchema,
  forkedFrom: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    status: z.enum(["active", "draft", "deprecated"]),
    upgradedTo: z.string().uuid(),
  }),
});

registry.registerPath({
  method: "put",
  path: "/features/{slug}",
  summary: "Update or fork a feature (fork-on-write)",
  description:
    "**Fork-on-write** — features are immutable. This endpoint decides automatically:\n\n" +
    "**Same signature (metadata-only change) → 200:**\n" +
    "Fields like description, icon, category, charts, entities, displayOrder can be updated in place " +
    "because they don't affect the feature's identity (inputs + outputs). Even if you send `inputs` or " +
    "`outputs` in the body, if the resulting signature is unchanged, it's treated as metadata-only.\n\n" +
    "**Different signature (inputs/outputs changed) → 201 (fork):**\n" +
    "A new feature is created with:\n" +
    "- Auto-versioned `name`/`slug` (e.g. `Sales Cold Email Outreach v2`)\n" +
    "- Same `displayName` as the original\n" +
    "- `forkedFrom` pointing to the original\n" +
    "- All other fields merged from the update body + the original\n\n" +
    "The original is deprecated (`status: deprecated`, `upgradedTo` set). " +
    "Existing campaigns/workflows referencing the old slug are **not** migrated — " +
    "stats aggregation traverses the full lineage chain automatically.\n\n" +
    "**409:**\n" +
    "Returned if the new signature already exists on a different feature.",
  tags: ["Features"],
  request: {
    params: z.object({ slug: z.string() }),
    body: { content: { "application/json": { schema: updateFeatureSchema } } },
  },
  responses: {
    200: { description: "Updated in-place (metadata only, same signature)", content: { "application/json": { schema: z.object({ feature: featureResponseSchema }) } } },
    201: { description: "Forked (new feature created, original deprecated)", content: { "application/json": { schema: forkResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
    409: { description: "A feature with the same input/output signature already exists", content: { "application/json": { schema: z.object({ error: z.string(), existingSlug: z.string().optional() }) } } },
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
    "System stats (cost, runs, campaigns, dates) are always included.\n\n" +
    "**Lineage aggregation:** Stats are automatically aggregated across the full upgrade chain " +
    "(deprecated ancestors + active descendants). If a feature was forked, querying any slug " +
    "in the chain returns the combined stats. This ensures no data is lost when features evolve.\n\n" +
    "Stats keys are either **raw** (fetched from email-gateway, runs-service, or outlets-service) " +
    "or **derived** (computed as a ratio, e.g. `replyRate = emailsReplied / emailsSent`). " +
    "Use `GET /stats/registry` to discover available keys, their labels, and types.",
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
    "Supports groupBy: featureSlug, workflowName, brandId, campaignId.\n\n" +
    "Only active features are included in the computation. " +
    "Stats from deprecated features are aggregated into their active successor via the lineage chain.",
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
      "**Features** define what campaigns can do: inputs (form), outputs (metrics), charts (funnel/breakdown), and entities (detail tabs). " +
      "Features are **global** — shared across all orgs. They are template definitions, not per-org resources.\n\n" +

      "## Feature Definition\n\n" +
      "```typescript\n" +
      "{\n" +
      '  inputs:   [{ key, label, type, ... }],           // campaign creation form\n' +
      '  outputs:  [{ key, displayOrder }],                // metrics (validated against registry)\n' +
      '  charts:   [{ type: "funnel-bar", steps: [...] }], // visualizations\n' +
      '  entities: ["leads", "companies", "emails"],       // campaign detail tabs\n' +
      "}\n" +
      "```\n\n" +

      "## Fork-on-Write (Immutability)\n\n" +
      "Features are **immutable** once created. No endpoint mutates inputs or outputs in place.\n\n" +
      "`PUT /features/{slug}` uses **fork-on-write** semantics:\n\n" +
      "| Scenario | Behavior | HTTP |\n" +
      "|----------|----------|------|\n" +
      "| Only metadata changes (description, icon, charts…) | Update in-place | `200` |\n" +
      "| Inputs or outputs change (different signature) | Create new feature (fork), deprecate original | `201` |\n" +
      "| New signature already exists elsewhere | Conflict | `409` |\n\n" +
      "On fork:\n" +
      "- The new feature gets an auto-versioned `name` and `slug` (e.g. `Sales Cold Email Outreach v2` / `sales-cold-email-outreach-v2`)\n" +
      "- The `displayName` is inherited from the original (stable across forks)\n" +
      "- `forkedFrom` on the new feature points to the original's ID\n" +
      "- `upgradedTo` on the original points to the new feature's ID\n" +
      "- The original's `status` is set to `deprecated`\n\n" +
      "This is aligned with workflow-service's fork model (`PUT /workflows/{id}`).\n\n" +

      "## displayName vs name\n\n" +
      "| Field | Purpose | Changes on fork? | Example |\n" +
      "|-------|---------|-----------------|--------|\n" +
      "| `displayName` | Human-readable label for UI | **No** — inherited | `Sales Cold Email Outreach` |\n" +
      "| `name` | Machine identifier, unique | **Yes** — auto-versioned | `Sales Cold Email Outreach v2` |\n" +
      "| `slug` | URL-safe machine identifier | **Yes** — derived from name | `sales-cold-email-outreach-v2` |\n\n" +
      "**Always use `displayName` for UI display.** The `name`/`slug` are for internal routing and deduplication.\n\n" +

      "## Lineage Chain\n\n" +
      "Each feature can have:\n" +
      "- `forkedFrom` (uuid | null) — the parent feature this was forked from\n" +
      "- `upgradedTo` (uuid | null) — if deprecated, the replacement feature\n\n" +
      "To traverse the full lineage of a feature, follow `forkedFrom` upward (ancestors) and `upgradedTo` downward (descendants). " +
      "Campaigns and workflows keep their original `featureSlug` — they are **never** migrated on fork. " +
      "This preserves full audit history of which feature version produced which results.\n\n" +

      "## Stats Aggregation Across the Chain\n\n" +
      "When you request stats for a feature (`GET /features/{slug}/stats`), the service automatically resolves the **full upgrade chain** " +
      "and aggregates stats across all ancestors and descendants. This means:\n\n" +
      "- Old campaigns/workflows still referencing a deprecated slug are included in the stats\n" +
      "- You always get the complete picture regardless of which slug in the chain you query\n" +
      "- No data is lost on fork — the chain is just extended\n\n" +
      "This matches workflow-service behavior: *\"Stats are aggregated across the full upgrade chain (deprecated predecessors included)\"*.\n\n" +

      "## Stats Registry\n\n" +
      "`GET /stats/registry` — the finite universe of known stats keys. " +
      "Each key has a label and type (count, rate, currency). Features reference these keys in outputs and charts.\n\n" +

      "## Stats Computation\n\n" +
      "Stats endpoints compute values by calling downstream services " +
      "(email-gateway, runs-service, outlets-service) and returning aggregated results. " +
      "Keys are either **raw** (fetched from a source) or **derived** (computed as a ratio of two raw keys, e.g. `replyRate = emailsReplied / emailsSent`).\n\n" +

      "## Registration (Cold Start)\n\n" +
      "`PUT /features` — idempotent batch upsert, safe to call on every boot. " +
      "Uses signature-based deduplication: same signature → update metadata, different signature → create or auto-version. " +
      "This is the equivalent of workflow-service's `PUT /workflows/upgrade`.",
  },
  servers: [{ url: "/" }],
  security: [{ ApiKeyAuth: [] }],
});
