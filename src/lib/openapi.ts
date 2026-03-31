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
  slug: z.string().describe("Globally unique versioned slug (e.g. 'sales-cold-email-sophia-v2'). Composed: dynasty_slug + version suffix."),
  name: z.string().describe("Globally unique versioned name (e.g. 'Sales Cold Email Sophia v2'). Composed: dynasty_name + version suffix."),
  dynastyName: z.string().describe("Stable name across all versions of this dynasty (e.g. 'Sales Cold Email Sophia'). Use for UI display."),
  dynastySlug: z.string().describe("Stable slug across all versions of this dynasty (e.g. 'sales-cold-email-sophia')."),
  version: z.number().int().describe("Version number within the dynasty (1-based). v1 has no suffix in name/slug."),
  description: z.string(),
  icon: z.string().describe("Lucide icon name (e.g. 'envelope', 'globe', 'megaphone'). Use as <LucideIcon name={icon} /> or look up at lucide.dev/icons."),
  category: z.string().describe("Feature category: 'sales', 'pr', 'discovery', etc."),
  channel: z.string().describe("Communication channel: 'email', 'phone', 'linkedin', 'database', etc."),
  audienceType: z.string().describe("Form layout type: 'cold-outreach', 'discovery', etc."),
  implemented: z.boolean(),
  displayOrder: z.number().int(),
  status: z.enum(["active", "draft", "deprecated"]),
  signature: z.string().describe("Deterministic hash of sorted input+output keys — used for idempotent upsert and convergence detection"),
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

// ── Prefill response schemas ───────────────────────────────────────────────

const prefillTextResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  brandId: z.string().describe("Brand UUID(s) used for pre-fill (CSV string from x-brand-id header)"),
  format: z.literal("text"),
  prefilled: z.record(z.string(), z.string().nullable()).describe(
    "Map of input key → flattened text value (or null if extraction failed)."
  ),
}).describe("Pre-filled values as flat strings, ready for form inputs or workflow inputMapping");

const prefillFullResponseSchema = z.object({
  slug: z.string().describe("Feature slug"),
  brandId: z.string().describe("Brand UUID(s) used for pre-fill (CSV string from x-brand-id header)"),
  format: z.literal("full"),
  prefilled: z.record(z.string(), z.object({
    value: z.any().describe("Extracted value — can be a string, array, or object depending on the field"),
    byBrand: z.record(z.string(), z.object({
      value: z.any().describe("Extracted value for this brand"),
      cached: z.boolean().describe("Whether the value was served from cache"),
      extractedAt: z.string().describe("ISO timestamp of extraction"),
      expiresAt: z.string().nullable().describe("ISO timestamp when cache expires"),
      sourceUrls: z.array(z.string()).nullable().describe("URLs used to extract this value"),
    })).describe("Per-brand extraction details keyed by brand domain"),
  })).describe(
    "Map of input key → full extraction result."
  ),
}).describe("Pre-filled values with per-brand breakdown");

const inputsResponseSchema = z.object({
  slug: z.string().describe("Resolved versioned slug (e.g. 'sales-cold-email-v2')"),
  dynastySlug: z.string().describe("Dynasty slug used in the request (e.g. 'sales-cold-email')"),
  name: z.string().describe("Dynasty display name"),
  inputs: z.array(featureInputSchema).describe("Input definitions."),
});

registry.register("PrefillTextResponse", prefillTextResponseSchema);
registry.register("PrefillFullResponse", prefillFullResponseSchema);
registry.register("InputsResponse", inputsResponseSchema);

// ── Required identity headers (all authenticated endpoints) ────────────────

const identityHeaders = z.object({
  "x-org-id": z.string().uuid().describe("Internal org UUID from client-service"),
  "x-user-id": z.string().uuid().describe("Internal user UUID from client-service"),
  "x-run-id": z.string().uuid().describe("Run ID for tracking and billing"),
  "x-brand-id": z.string().optional().describe("Brand UUID(s), comma-separated for multi-brand campaigns (e.g. 'uuid1,uuid2,uuid3'). Required for prefill."),
});

// ── PUT /features — batch upsert ──────────────────────────────────────────

registry.registerPath({
  method: "put",
  path: "/features",
  summary: "Batch upsert features (cold-start registration)",
  description:
    "Idempotent — safe to call on every cold start. Platform-only (X-API-Key auth).\n\n" +
    "Uses a **signature** (SHA-256 hash of sorted input+output keys) to detect duplicates:\n" +
    "- **Same signature** → upsert metadata in-place (labels, descriptions, charts, entities). No version/dynasty change.\n" +
    "- **Same dynasty, different signature** → upgrade: deprecate old feature, create new version in the same dynasty (same `dynastyName`/`dynastySlug`, incremented `version`).\n" +
    "- **New name** → create new dynasty (`version: 1`, no version suffix in slug/name).\n\n" +
    "The `name` field in the request body becomes the `dynastyName` (stable across versions). " +
    "The versioned `name` and `slug` are auto-computed from `dynastyName` + `version`.\n\n" +
    "**Example upgrade chain:**\n" +
    "```\n" +
    "Boot 1: name='Sales Cold Email', inputs=[a,b] → creates 'sales-cold-email' v1\n" +
    "Boot 2: name='Sales Cold Email', inputs=[a,b] → same signature, metadata update only\n" +
    "Boot 3: name='Sales Cold Email', inputs=[a,b,c] → new signature, creates 'sales-cold-email-v2', deprecates v1\n" +
    "```\n\n" +
    "This is the equivalent of workflow-service's `PUT /workflows/upgrade`.",
  tags: ["Features"],
  request: { headers: identityHeaders, body: { content: { "application/json": { schema: batchUpsertFeaturesSchema } } } },
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
    "Creates a brand-new feature and a new dynasty. Slug is auto-generated from name if not provided. " +
    "Returns 409 if a feature with the same signature already exists.\n\n" +
    "The `name` field becomes the `dynastyName`. If a dynasty with the same name already exists, " +
    "a codename is auto-generated to create a unique dynasty (e.g. 'Sales Cold Email' → 'Sales Cold Email Sophia').\n\n" +
    "**Example response (new dynasty, no collision):**\n" +
    "```json\n" +
    "{ \"feature\": { \"dynastyName\": \"Sales Cold Email\", \"dynastySlug\": \"sales-cold-email\", \"version\": 1, \"slug\": \"sales-cold-email\", \"name\": \"Sales Cold Email\" } }\n" +
    "```\n\n" +
    "**Example response (name collision, auto-generated codename):**\n" +
    "```json\n" +
    "{ \"feature\": { \"dynastyName\": \"Sales Cold Email Sophia\", \"dynastySlug\": \"sales-cold-email-sophia\", \"version\": 1, \"slug\": \"sales-cold-email-sophia\", \"name\": \"Sales Cold Email Sophia\" } }\n" +
    "```",
  tags: ["Features"],
  request: { headers: identityHeaders, body: { content: { "application/json": { schema: createFeatureSchema } } } },
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
    headers: identityHeaders,
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

// ── GET /features/by-dynasty/:dynastySlug ─────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/by-dynasty/{dynastySlug}",
  summary: "Get the active feature by dynasty slug",
  description:
    "Returns the **active version** of a feature dynasty. " +
    "The path param must be a **dynasty slug** (e.g. `sales-cold-email`), NOT a versioned slug.\n\n" +
    "Returns 404 if no active feature exists for this dynasty slug.\n\n" +
    "Use this when you have a dynasty slug and need the full feature definition (inputs, outputs, charts, entities). " +
    "For the versioned slug variant, use `GET /features/{slug}`.\n\n" +
    "**Example:** `GET /features/by-dynasty/sales-cold-email`\n" +
    "```json\n" +
    "{\n" +
    "  \"feature\": {\n" +
    "    \"slug\": \"sales-cold-email-v2\",\n" +
    "    \"dynastySlug\": \"sales-cold-email\",\n" +
    "    \"dynastyName\": \"Sales Cold Email\",\n" +
    "    \"version\": 2,\n" +
    "    \"status\": \"active\",\n" +
    "    \"inputs\": [...],\n" +
    "    \"outputs\": [...],\n" +
    "    \"charts\": [...],\n" +
    "    \"entities\": [...]\n" +
    "  }\n" +
    "}\n" +
    "```",
  tags: ["Features"],
  request: { headers: identityHeaders, params: z.object({ dynastySlug: z.string().describe("Dynasty slug (e.g. 'sales-cold-email'). Must be a dynasty slug — versioned slugs will 404.") }) },
  responses: {
    200: { description: "Active feature in this dynasty", content: { "application/json": { schema: z.object({ feature: featureResponseSchema }) } } },
    404: { description: "No active feature for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:slug ──────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/{slug}",
  summary: "Get a single feature by exact versioned slug",
  description:
    "Returns a feature by its **exact versioned slug** (e.g. `sales-cold-email-v2`). " +
    "Returns 404 if no feature has this exact slug.\n\n" +
    "**This does NOT accept dynasty slugs.** To look up by dynasty slug, " +
    "use `GET /features/by-dynasty/{dynastySlug}`.\n\n" +
    "**Example:** `GET /features/sales-cold-email-v2` → `{ \"feature\": { \"slug\": \"sales-cold-email-v2\", \"dynastySlug\": \"sales-cold-email\", \"version\": 2, ... } }`",
  tags: ["Features"],
  request: { headers: identityHeaders, params: z.object({ slug: z.string().describe("Exact versioned slug (e.g. 'sales-cold-email-v2'). NOT a dynasty slug.") }) },
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
    "A **new dynasty** is created with an auto-generated codename:\n" +
    "- New `dynastyName` = original's base name + codename (e.g. `Sales Cold Email Sophia`)\n" +
    "- `version: 1`, `forkedFrom` pointing to the original\n" +
    "- All other fields merged from the update body + the original\n\n" +
    "The original is deprecated (`status: deprecated`, `upgradedTo` set). " +
    "Existing campaigns/workflows referencing the old slug are **not** migrated — " +
    "stats aggregation traverses the full lineage chain automatically.\n\n" +
    "**Convergence (different signature matches an existing feature) → 200:**\n" +
    "If the new signature already exists on another feature, no new record is created. " +
    "The current feature is deprecated and its `upgradedTo` points to the existing feature with that signature. " +
    "Both lineages converge on a single active feature. Stats BFS traverses all predecessor branches.\n\n" +
    "**Example fork:**\n" +
    "```\n" +
    "PUT /features/sales-cold-email { inputs: [changed] }\n" +
    "→ 201: new feature 'Sales Cold Email Sophia' (slug: sales-cold-email-sophia)\n" +
    "  original 'sales-cold-email' → deprecated, upgradedTo → sophia\n" +
    "```\n\n" +
    "**Example convergence:**\n" +
    "```\n" +
    "Dynasty A: v1 (sig:abc) → v2 (sig:DEF, active)\n" +
    "Dynasty B: v1 (sig:xyz) → PUT with new inputs → sig:DEF already exists!\n" +
    "→ B v1 deprecated, upgradedTo → A v2. Both lineages converge.\n" +
    "```",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
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

// ── GET /features/:dynastySlug/inputs ────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/{dynastySlug}/inputs",
  summary: "Get input definitions by dynasty slug",
  description:
    "Returns the input field definitions for the **active version** of a dynasty. " +
    "The path param must be a **dynasty slug** (e.g. `sales-cold-email`), NOT a versioned slug.\n\n" +
    "Returns 404 if no active feature exists for this dynasty slug.\n\n" +
    "The response includes both the resolved `slug` (versioned) and the `dynastySlug` for clarity.\n\n" +
    "**Example:** `GET /features/sales-cold-email/inputs`\n" +
    "```json\n" +
    "{\n" +
    "  \"slug\": \"sales-cold-email-v2\",\n" +
    "  \"dynastySlug\": \"sales-cold-email\",\n" +
    "  \"name\": \"Sales Cold Email\",\n" +
    "  \"inputs\": [\n" +
    "    { \"key\": \"targetAudience\", \"label\": \"Target Audience\", \"type\": \"textarea\", \"placeholder\": \"Describe your ideal customer...\", \"description\": \"...\", \"extractKey\": \"target_audience\" },\n" +
    "    { \"key\": \"valueProposition\", \"label\": \"Value Proposition\", \"type\": \"textarea\", \"placeholder\": \"What makes your offering unique?\", \"description\": \"...\", \"extractKey\": \"value_proposition\" }\n" +
    "  ]\n" +
    "}\n" +
    "```",
  tags: ["Features"],
  request: { headers: identityHeaders, params: z.object({ dynastySlug: z.string().describe("Dynasty slug (e.g. 'sales-cold-email'). Must be a dynasty slug — versioned slugs will 404.") }) },
  responses: {
    200: { description: "Feature inputs", content: { "application/json": { schema: inputsResponseSchema } } },
    404: { description: "No active feature for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/dynasty ────────────────────────────────────────────────

const dynastyResponseSchema = z.object({
  feature_dynasty_name: z.string().describe("Stable dynasty name (unversioned), e.g. 'Sales Cold Email Sophia'"),
  feature_dynasty_slug: z.string().describe("Stable dynasty slug (unversioned), e.g. 'sales-cold-email-sophia'"),
});

registry.register("DynastyResponse", dynastyResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/dynasty",
  summary: "Resolve dynasty identity from a versioned feature slug",
  description:
    "Returns the stable, unversioned dynasty identifiers for a given feature slug. " +
    "Used by workflow-service to compose workflow names.\n\n" +
    "Example: `?slug=sales-cold-email-sophia-v2` → " +
    "`{ feature_dynasty_name: 'Sales Cold Email Sophia', feature_dynasty_slug: 'sales-cold-email-sophia' }`\n\n" +
    "Works for both active and deprecated features.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    query: z.object({
      slug: z.string().describe("The versioned feature slug to resolve"),
    }),
  },
  responses: {
    200: { description: "Dynasty identity", content: { "application/json": { schema: dynastyResponseSchema } } },
    400: { description: "Missing slug parameter", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/dynasty/slugs ────────────────────────────────────────────

const dynastySlugsResponseSchema = z.object({
  slugs: z.array(z.string()).describe("All versioned slugs in the dynasty, sorted by version ascending"),
});

registry.register("DynastySlugsResponse", dynastySlugsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/dynasty/slugs",
  summary: "List all versioned slugs for a dynasty",
  description:
    "Returns all feature slugs (active + deprecated) belonging to the given dynasty slug. " +
    "Useful for downstream services that store versioned feature slugs and need to aggregate stats " +
    "across all versions of a dynasty (e.g. `WHERE feature_slug IN (...)`).\n\n" +
    "Example: `?dynastySlug=sales-cold-email-sophia` → " +
    "`{ slugs: ['sales-cold-email-sophia', 'sales-cold-email-sophia-v2', 'sales-cold-email-sophia-v3'] }`",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    query: z.object({
      dynastySlug: z.string().describe("The stable dynasty slug (unversioned)"),
    }),
  },
  responses: {
    200: { description: "Dynasty slugs", content: { "application/json": { schema: dynastySlugsResponseSchema } } },
    400: { description: "Missing dynastySlug parameter", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No features found for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/dynasties ────────────────────────────────────────────────

const dynastyEntrySchema = z.object({
  dynastySlug: z.string().describe("Stable dynasty slug (unversioned)"),
  slugs: z.array(z.string()).describe("All versioned slugs in this dynasty, sorted by version ascending"),
});

const dynastiesResponseSchema = z.object({
  dynasties: z.array(dynastyEntrySchema).describe("All dynasties sorted alphabetically by dynastySlug"),
});

registry.register("DynastyEntry", dynastyEntrySchema);
registry.register("DynastiesResponse", dynastiesResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/dynasties",
  summary: "List all dynasties with their versioned slugs",
  description:
    "Returns every dynasty and all its versioned slugs (active + deprecated). " +
    "Designed for downstream services that need to build a reverse map from versioned slug → dynasty slug. " +
    "Dynasties change infrequently — callers should cache the response.\n\n" +
    "Example response:\n" +
    "```json\n" +
    "{ \"dynasties\": [\n" +
    "  { \"dynastySlug\": \"lead-scoring-basic\", \"slugs\": [\"lead-scoring-basic\", \"lead-scoring-basic-v2\"] },\n" +
    "  { \"dynastySlug\": \"sales-cold-email-sophia\", \"slugs\": [\"sales-cold-email-sophia\", \"sales-cold-email-sophia-v2\"] }\n" +
    "] }\n" +
    "```",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
  },
  responses: {
    200: { description: "All dynasties", content: { "application/json": { schema: dynastiesResponseSchema } } },
  },
});

// ── POST /features/:dynastySlug/prefill ──────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/features/{dynastySlug}/prefill",
  summary: "Pre-fill input values by dynasty slug",
  description:
    "Pre-fills input values by extracting brand data via brand-service. " +
    "The path param must be a **dynasty slug** (e.g. `sales-cold-email`), NOT a versioned slug.\n\n" +
    "Resolves to the **active version** of the dynasty. Returns 404 if no active feature exists.\n\n" +
    "**Brand IDs are read from the `x-brand-id` header** (comma-separated UUIDs for multi-brand campaigns).\n\n" +
    "The response includes the resolved `slug` (versioned) for reference.\n\n" +
    "**Example:** `POST /features/sales-cold-email/prefill?format=text` with header `x-brand-id: uuid1,uuid2`\n" +
    "```json\n" +
    "{\n" +
    "  \"slug\": \"sales-cold-email-v2\",\n" +
    "  \"brandId\": \"uuid1,uuid2\",\n" +
    "  \"format\": \"text\",\n" +
    "  \"prefilled\": {\n" +
    "    \"targetAudience\": \"Enterprise SaaS CTOs in North America\",\n" +
    "    \"valueProposition\": \"AI-powered workflow automation reducing manual ops by 80%\"\n" +
    "  }\n" +
    "}\n" +
    "```\n\n" +
    "With `format=full`, each value includes per-brand metadata:\n" +
    "```json\n" +
    "{ \"targetAudience\": { \"value\": \"Enterprise SaaS CTOs...\", \"byBrand\": { \"acme.com\": { \"value\": \"Enterprise SaaS CTOs...\", \"cached\": true, \"extractedAt\": \"2026-03-15T10:00:00Z\", \"expiresAt\": \"2026-04-14T10:00:00Z\", \"sourceUrls\": [\"https://acme.com/about\"] } } } }\n" +
    "```",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    params: z.object({ dynastySlug: z.string().describe("Dynasty slug (e.g. 'sales-cold-email'). Must be a dynasty slug — versioned slugs will 404.") }),
    query: z.object({ format: z.enum(["text", "full"]).optional() }),
    // No body required — brand IDs come from x-brand-id header
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
  description:
    "Returns the complete dictionary of known stats keys with their label and type. " +
    "Used by the front-end to format and label output columns dynamically.\n\n" +
    "**Example response:**\n" +
    "```json\n" +
    "{\n" +
    "  \"registry\": {\n" +
    "    \"emailsSent\": { \"type\": \"count\", \"label\": \"Emails Sent\" },\n" +
    "    \"emailsReplied\": { \"type\": \"count\", \"label\": \"Emails Replied\" },\n" +
    "    \"replyRate\": { \"type\": \"rate\", \"label\": \"Reply Rate\" },\n" +
    "    \"totalCostInUsdCents\": { \"type\": \"currency\", \"label\": \"Total Cost\" }\n" +
    "  }\n" +
    "}\n" +
    "```",
  tags: ["Stats"],
  request: { headers: identityHeaders },
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
    "Returns computed stats for a **single exact versioned slug** — no lineage traversal. " +
    "Optionally grouped by workflowSlug, brandId, or campaignId. " +
    "System stats (cost, runs, campaigns, dates) are always included.\n\n" +
    "**This endpoint requires an exact versioned slug** (e.g. `sales-cold-email-v2`). NOT a dynasty slug. " +
    "For dynasty-wide aggregated stats, use `GET /stats/dynasty?dynastySlug=...`.\n\n" +
    "Stats keys are either **raw** (fetched from email-gateway, runs-service, or outlets-service) " +
    "or **derived** (computed as a ratio, e.g. `replyRate = emailsReplied / emailsSent`). " +
    "Use `GET /stats/registry` to discover available keys, their labels, and types.\n\n" +
    "**Example:** `GET /features/sales-cold-email-v2/stats?brandId=b123`\n" +
    "```json\n" +
    "{\n" +
    "  \"featureSlug\": \"sales-cold-email-v2\",\n" +
    "  \"systemStats\": { \"totalCostInUsdCents\": 4200, \"completedRuns\": 15, \"activeCampaigns\": 3, \"firstRunAt\": \"2026-01-10T...\", \"lastRunAt\": \"2026-03-28T...\" },\n" +
    "  \"stats\": { \"emailsSent\": 1200, \"emailsReplied\": 48, \"replyRate\": 0.04 }\n" +
    "}\n" +
    "```\n\n" +
    "**Example with groupBy:** `GET /features/sales-cold-email-v2/stats?groupBy=campaignId`\n" +
    "```json\n" +
    "{\n" +
    "  \"featureSlug\": \"sales-cold-email-v2\",\n" +
    "  \"groupBy\": \"campaignId\",\n" +
    "  \"systemStats\": { ... },\n" +
    "  \"groups\": [\n" +
    "    { \"campaignId\": \"camp-1\", \"systemStats\": { ... }, \"stats\": { \"emailsSent\": 600, \"replyRate\": 0.05 } },\n" +
    "    { \"campaignId\": \"camp-2\", \"systemStats\": { ... }, \"stats\": { \"emailsSent\": 600, \"replyRate\": 0.03 } }\n" +
    "  ]\n" +
    "}\n" +
    "```",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string().describe("Exact versioned feature slug (e.g. 'sales-cold-email-v2'). NOT a dynasty slug.") }),
    query: z.object({
      groupBy: z.enum(["workflowSlug", "workflowDynastySlug", "brandId", "campaignId"]).optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowSlug: z.string().optional().describe("Filter by exact workflow slug"),
      workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug — passed through to downstream services for resolution"),
    }),
  },
  responses: {
    200: { description: "Feature stats", content: { "application/json": { schema: featureStatsResponseSchema } } },
    400: { description: "Missing required identity headers", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats/dynasty ─────────────────────────────────────────────────

const dynastyStatsResponseSchema = z.object({
  dynastySlug: z.string(),
  groupBy: z.string().optional(),
  systemStats: systemStatsSchema,
  groups: z.array(statsGroupSchema).optional(),
  stats: z.record(z.string(), z.number().nullable()).optional(),
});

registry.register("DynastyStatsResponse", dynastyStatsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/stats/dynasty",
  summary: "Aggregated stats across all versions of a dynasty",
  description:
    "Returns stats aggregated across the **full upgrade chain** of a dynasty using BFS lineage traversal. " +
    "This handles linear chains (v1 → v2 → v3) and convergence (two dynasties producing the same signature).\n\n" +
    "Use this endpoint when you need dynasty-wide stats. For stats on a single specific slug, use `GET /features/{featureSlug}/stats`.\n\n" +
    "Supports the same groupBy and filter params as the per-feature stats endpoint.\n\n" +
    "**Example:** `GET /stats/dynasty?dynastySlug=sales-cold-email`\n" +
    "```json\n" +
    "{\n" +
    "  \"dynastySlug\": \"sales-cold-email\",\n" +
    "  \"systemStats\": { \"totalCostInUsdCents\": 12000, \"completedRuns\": 45, \"activeCampaigns\": 5, \"firstRunAt\": \"2025-11-01T...\", \"lastRunAt\": \"2026-03-28T...\" },\n" +
    "  \"stats\": { \"emailsSent\": 5400, \"emailsReplied\": 216, \"replyRate\": 0.04 }\n" +
    "}\n" +
    "```\n\n" +
    "This aggregates data from all versions (v1, v2, ...) and any converged dynasties.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    query: z.object({
      dynastySlug: z.string().describe("The stable dynasty slug (unversioned)"),
      groupBy: z.enum(["workflowSlug", "workflowDynastySlug", "brandId", "campaignId"]).optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowSlug: z.string().optional().describe("Filter by exact workflow slug"),
      workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug — passed through to downstream services for resolution"),
    }),
  },
  responses: {
    200: { description: "Dynasty stats", content: { "application/json": { schema: dynastyStatsResponseSchema } } },
    400: { description: "Missing dynastySlug parameter", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No features found for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats",
  summary: "Global stats across all features",
  description:
    "Cross-feature stats endpoint for performance dashboards and org overview. " +
    "Supports groupBy: featureSlug, featureDynastySlug, workflowSlug, workflowDynastySlug, brandId, campaignId.\n\n" +
    "Only active features are included in the computation. " +
    "Stats from deprecated features are aggregated into their active successor via the lineage chain.\n\n" +
    "**Example:** `GET /stats?groupBy=featureDynastySlug`\n" +
    "```json\n" +
    "{\n" +
    "  \"groupBy\": \"featureDynastySlug\",\n" +
    "  \"systemStats\": { \"totalCostInUsdCents\": 25000, \"completedRuns\": 120, \"activeCampaigns\": 8, ... },\n" +
    "  \"groups\": [\n" +
    "    { \"featureDynastySlug\": \"sales-cold-email\", \"systemStats\": { ... }, \"stats\": { \"emailsSent\": 5400, ... } },\n" +
    "    { \"featureDynastySlug\": \"pr-journalist-outreach\", \"systemStats\": { ... }, \"stats\": { \"journalistsContacted\": 320, ... } }\n" +
    "  ]\n" +
    "}\n" +
    "```\n\n" +
    "**Example with filter:** `GET /stats?brandId=b123&groupBy=campaignId` — stats for a specific brand, grouped by campaign.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    query: z.object({
      groupBy: z.string().optional().describe("Dimension: featureSlug, featureDynastySlug, workflowSlug, workflowDynastySlug, brandId, campaignId"),
      brandId: z.string().optional(),
      featureSlug: z.string().optional().describe("Filter by exact feature slug"),
      featureDynastySlug: z.string().optional().describe("Filter by feature dynasty slug — passed through to downstream services for resolution"),
      workflowSlug: z.string().optional().describe("Filter by exact workflow slug"),
      workflowDynastySlug: z.string().optional().describe("Filter by workflow dynasty slug — passed through to downstream services for resolution"),
      campaignId: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Global stats", content: { "application/json": { schema: globalStatsResponseSchema } } },
    400: { description: "Missing required identity headers", content: { "application/json": { schema: errorResponse } } },
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (no auth)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /public/features ──────────────────────────────────────────────────

const publicFeatureSchema = z.object({
  dynastyName: z.string().describe("Stable dynasty display name"),
  dynastySlug: z.string().describe("Stable dynasty slug (unversioned)"),
  description: z.string(),
  icon: z.string().describe("Lucide icon name"),
  category: z.string(),
  channel: z.string(),
  audienceType: z.string(),
  displayOrder: z.number().int(),
});

registry.register("PublicFeature", publicFeatureSchema);

registry.registerPath({
  method: "get",
  path: "/public/features",
  summary: "List active features (public, no auth)",
  description:
    "Returns all active features with display-safe fields only. " +
    "Designed for landing pages and public-facing UIs. " +
    "No API key or identity headers required.\n\n" +
    "Sorted by `displayOrder` ascending.",
  tags: ["Public"],
  responses: {
    200: {
      description: "Active features",
      content: { "application/json": { schema: z.object({ features: z.array(publicFeatureSchema) }) } },
    },
  },
});

// ── GET /public/features/dynasty/slugs ────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/features/dynasty/slugs",
  summary: "List all versioned slugs for a dynasty (public, no auth)",
  description:
    "Public mirror of `GET /features/dynasty/slugs`. Returns all feature slugs " +
    "(active + deprecated) belonging to the given dynasty slug.\n\n" +
    "Example: `?dynastySlug=sales-cold-email-sophia` → " +
    "`{ slugs: ['sales-cold-email-sophia', 'sales-cold-email-sophia-v2'] }`",
  tags: ["Public"],
  request: {
    query: z.object({
      dynastySlug: z.string().describe("The stable dynasty slug (unversioned)"),
    }),
  },
  responses: {
    200: { description: "Dynasty slugs", content: { "application/json": { schema: dynastySlugsResponseSchema } } },
    400: { description: "Missing dynastySlug parameter", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No features found for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/ranked ──────────────────────────────────────────────

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
registry.register("RankedWorkflow", rankedWorkflowSchema);

const rankedBrandSchema = z.object({
  brandId: z.string(),
});
registry.register("RankedBrand", rankedBrandSchema);

const rankedStatsSchema = z.object({
  totalCostInUsdCents: z.number().describe("Total cost in USD cents"),
  totalOutcomes: z.number().describe("Total outcome count for the objective metric"),
  costPerOutcome: z.number().nullable().describe("Cost per outcome (null if no outcomes)"),
  completedRuns: z.number().describe("Number of completed runs"),
});
registry.register("RankedStats", rankedStatsSchema);

const rankedResultSchema = z.object({
  workflow: rankedWorkflowSchema.optional(),
  brand: rankedBrandSchema.optional(),
  stats: rankedStatsSchema,
});
registry.register("RankedResult", rankedResultSchema);

const rankedQueryParams = z.object({
  featureDynastySlug: z.string().describe("Feature dynasty slug (required)"),
  objective: z.string().describe("Stats key to rank by (e.g. 'emailsReplied')"),
  brandId: z.string().optional().describe("Filter by brand ID"),
  groupBy: z.enum(["workflow", "brand"]).describe("Group results by workflow or by brand"),
  limit: z.string().optional().describe("Max results (default 10, max 100)"),
});

registry.registerPath({
  method: "get",
  path: "/public/stats/ranked",
  summary: "Ranked workflows by cost-per-outcome (public, no auth)",
  description:
    "Returns workflows ranked by cost-per-outcome for a single objective metric. " +
    "Stats are aggregated across the full workflow upgrade chain.\n\n" +
    "Use `groupBy=brand` to aggregate by brand instead of workflow.",
  tags: ["Public"],
  request: { query: rankedQueryParams },
  responses: {
    200: { description: "Ranked results", content: { "application/json": { schema: z.object({ results: z.array(rankedResultSchema) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No features found for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/stats/ranked",
  summary: "Ranked workflows by cost-per-outcome (authenticated)",
  description:
    "Authenticated version of `GET /public/stats/ranked`. Same logic, same params, same response. " +
    "Requires x-api-key and identity headers.",
  tags: ["Stats"],
  security: [{ ApiKeyAuth: [] }],
  request: { headers: identityHeaders, query: rankedQueryParams },
  responses: {
    200: { description: "Ranked results", content: { "application/json": { schema: z.object({ results: z.array(rankedResultSchema) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No features found for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/best ───────────────────────────────────────────────

const bestEntryWorkflowSchema = z.object({
  workflowSlug: z.string(),
  workflowName: z.string(),
  createdForBrandId: z.string().nullable(),
  value: z.number().describe("Best (lowest) cost-per-outcome in USD cents"),
});
registry.register("BestEntryWorkflow", bestEntryWorkflowSchema);

const bestEntryBrandSchema = z.object({
  brandId: z.string(),
  value: z.number().describe("Best (lowest) cost-per-outcome in USD cents"),
});
registry.register("BestEntryBrand", bestEntryBrandSchema);

const bestQueryParams = z.object({
  featureDynastySlug: z.string().describe("Feature dynasty slug (required)"),
  brandId: z.string().optional().describe("Filter by brand ID"),
  by: z.enum(["workflow", "brand"]).describe("Best per workflow or best per brand"),
});

registry.registerPath({
  method: "get",
  path: "/public/stats/best",
  summary: "Best cost-per-outcome per metric (public, no auth)",
  description:
    "Returns the single best (lowest cost-per-outcome) workflow or brand for each of the feature's " +
    "declared count-type output metrics. Stats are aggregated across upgrade chains.\n\n" +
    "Use `by=brand` to find the best brand instead of the best workflow.",
  tags: ["Public"],
  request: { query: bestQueryParams },
  responses: {
    200: { description: "Best records per metric", content: { "application/json": { schema: z.object({ best: z.record(z.string(), bestEntryWorkflowSchema.nullable()) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No features found for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/stats/best",
  summary: "Best cost-per-outcome per metric (authenticated)",
  description:
    "Authenticated version of `GET /public/stats/best`. Same logic, same params, same response. " +
    "Requires x-api-key and identity headers.",
  tags: ["Stats"],
  security: [{ ApiKeyAuth: [] }],
  request: { headers: identityHeaders, query: bestQueryParams },
  responses: {
    200: { description: "Best records per metric", content: { "application/json": { schema: z.object({ best: z.record(z.string(), bestEntryWorkflowSchema.nullable()) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No features found for this dynasty slug", content: { "application/json": { schema: errorResponse } } },
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
    version: "3.0.0",
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
      "- A new **dynasty** is created with an auto-generated codename (e.g. `Sales Cold Email` → `Sales Cold Email Sophia`)\n" +
      "- `dynastyName`/`dynastySlug` are new and unique, `version` resets to 1\n" +
      "- `forkedFrom` on the new feature points to the original's ID\n" +
      "- `upgradedTo` on the original points to the new feature's ID\n" +
      "- The original's `status` is set to `deprecated`\n\n" +
      "On upgrade (same dynasty, signature changed via `PUT /features` batch upsert):\n" +
      "- `dynastyName`/`dynastySlug` are preserved, `version` is incremented\n" +
      "- `name` gets version suffix (e.g. `Sales Cold Email v2`), `slug` gets `-v2`\n\n" +
      "This is aligned with workflow-service's dynasty model.\n\n" +

      "## Dynasty Model\n\n" +
      "Features use a **dynasty model** for versioning, aligned with workflow-service:\n\n" +
      "| Field | Purpose | Changes on upgrade? | Changes on fork? | Example |\n" +
      "|-------|---------|--------------------|-----------------|---------|\n" +
      "| `dynastyName` | Stable dynasty name for UI | **No** | **Yes** — new codename | `Sales Cold Email Sophia` |\n" +
      "| `dynastySlug` | Stable dynasty slug | **No** | **Yes** | `sales-cold-email-sophia` |\n" +
      "| `version` | Version within dynasty | **Yes** — incremented | Reset to 1 | `2` |\n" +
      "| `name` | Versioned unique name | **Yes** | **Yes** | `Sales Cold Email Sophia v2` |\n" +
      "| `slug` | Versioned unique slug | **Yes** | **Yes** | `sales-cold-email-sophia-v2` |\n\n" +
      "**Always use `dynastyName` for UI display.** The `name`/`slug` are for internal routing.\n\n" +
      "On fork, a **codename** is auto-generated (e.g. 'Sophia', 'Berlin') to create a unique dynasty name.\n\n" +
      "Use `GET /features/dynasty?slug=...` to resolve the stable dynasty identity from any versioned slug.\n\n" +

      "## Lineage Chain\n\n" +
      "Each feature can have:\n" +
      "- `forkedFrom` (uuid | null) — the parent feature this was forked from\n" +
      "- `upgradedTo` (uuid | null) — if deprecated, the replacement feature\n\n" +
      "To traverse the full lineage of a feature, follow `forkedFrom` upward (ancestors) and `upgradedTo` downward (descendants). " +
      "Campaigns and workflows keep their original `featureSlug` — they are **never** migrated on fork. " +
      "This preserves full audit history of which feature version produced which results.\n\n" +

      "## Stats Aggregation Across the Chain\n\n" +
      "When you request stats for a feature (`GET /features/{slug}/stats`), the service automatically resolves the **full upgrade chain** " +
      "using BFS (breadth-first search) on a predecessor map. This handles:\n\n" +
      "- **Linear chains:** A v1 → A v2 → A v3 (simple upgrade sequence)\n" +
      "- **Convergence:** Two dynasties independently produce the same signature — both lineages converge on one active feature. BFS traverses all predecessor branches.\n\n" +
      "```\n" +
      "Dynasty A: v1 (deprecated) → A v2 (active, sig:DEF)\n" +
      "                                    ↑\n" +
      "Dynasty B: v1 (deprecated) ─────────┘  (B upgraded to same sig:DEF)\n" +
      "```\n" +
      "Querying stats for A v2 aggregates data from A v1, B v1, and A v2.\n\n" +
      "This means:\n" +
      "- Old campaigns/workflows still referencing a deprecated slug are included\n" +
      "- You always get the complete picture regardless of which slug in the chain you query\n" +
      "- No data is lost on fork or convergence\n\n" +

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
