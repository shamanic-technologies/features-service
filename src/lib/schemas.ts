import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { VALID_STATS_KEYS, VALID_ENTITY_TYPES } from "./stats-registry.js";

extendZodWithOpenApi(z);

// ── Helpers ──────────────────────────────────────────────────────────────────

const statsKeyString = z.string().min(1).refine(
  (key) => VALID_STATS_KEYS.has(key),
  (key) => ({ message: `Unknown stats key "${key}". Must be one of: ${[...VALID_STATS_KEYS].join(", ")}` }),
);

const entityTypeString = z.string().min(1).refine(
  (type) => VALID_ENTITY_TYPES.has(type),
  (type) => ({ message: `Unknown entity type "${type}". Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}` }),
);

// ── Entity (object form with optional countKey) ─────────────────────────────

export const featureEntitySchema = z.object({
  name: entityTypeString,
  countKey: statsKeyString.optional(),
});

// ── Input ───────────────────────────────────────────────────────────────────

export const featureInputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "textarea", "number", "select"]),
  placeholder: z.string().min(1),
  description: z.string().min(1),
  extractKey: z.string().min(1),
  options: z.array(z.string()).optional(),
});

// ── Output ──────────────────────────────────────────────────────────────────

export const featureOutputSchema = z.object({
  key: statsKeyString,
  displayOrder: z.number().int(),
  defaultSort: z.boolean().optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
});

// ── Charts ──────────────────────────────────────────────────────────────────

const funnelStepSchema = z.object({
  key: statsKeyString,
});

const breakdownSegmentSchema = z.object({
  key: statsKeyString,
  color: z.enum(["green", "blue", "red", "gray", "orange"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
});

const funnelBarChartSchema = z.object({
  key: z.string().min(1),
  type: z.literal("funnel-bar"),
  title: z.string().min(1),
  displayOrder: z.number().int(),
  steps: z.array(funnelStepSchema).min(2),
});

const breakdownBarChartSchema = z.object({
  key: z.string().min(1),
  type: z.literal("breakdown-bar"),
  title: z.string().min(1),
  displayOrder: z.number().int(),
  segments: z.array(breakdownSegmentSchema).min(2),
});

export const featureChartSchema = z.discriminatedUnion("type", [
  funnelBarChartSchema,
  breakdownBarChartSchema,
]);

// ── Charts validation ───────────────────────────────────────────────────────

const chartsArraySchema = z.array(featureChartSchema).min(1).refine(
  (charts) => charts.some((c) => c.type === "funnel-bar"),
  { message: "Charts must include at least one funnel-bar chart (with min 2 steps)" },
).refine(
  (charts) => charts.some((c) => c.type === "breakdown-bar"),
  { message: "Charts must include at least one breakdown-bar chart (with min 2 segments)" },
);

// ── Feature upsert ──────────────────────────────────────────────────────────

export const upsertFeatureSchema = z.object({
  // No slug — auto-generated from name
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1).describe("Lucide icon name (e.g. 'envelope', 'globe', 'megaphone')"),
  category: z.string().min(1),
  channel: z.string().min(1),
  audienceType: z.string().min(1),
  implemented: z.boolean().optional().default(true),
  displayOrder: z.number().int().optional().default(0),
  status: z.enum(["active", "draft", "deprecated"]).optional().default("active"),
  inputs: z.array(featureInputSchema).min(1),
  outputs: z.array(featureOutputSchema).min(1),
  charts: chartsArraySchema,
  entities: z.array(featureEntitySchema).min(1),
});

// ── Fork response (returned when PUT /features/:slug forks) ──────────────

export const forkResultSchema = z.object({
  feature: z.any(), // filled with featureResponseSchema at OpenAPI level
  forkedFrom: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    status: z.enum(["active", "draft", "deprecated"]),
    upgradedTo: z.string().uuid(),
  }),
});

export const batchUpsertFeaturesSchema = z.object({
  features: z.array(upsertFeatureSchema).min(1),
});

// ── Prefill request ────────────────────────────────────────────────────────

export const prefillRequestSchema = z.object({
  brandId: z.string().uuid(),
});

// ── Single feature create (dashboard) ────────────────────────────────────

export const createFeatureSchema = upsertFeatureSchema.extend({
  /** Optional slug — auto-generated from name if omitted */
  slug: z.string().min(1).optional(),
});

// ── Single feature update (dashboard) ────────────────────────────────────

export const updateFeatureSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  icon: z.string().min(1).describe("Lucide icon name (e.g. 'envelope', 'globe', 'megaphone')").optional(),
  category: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  audienceType: z.string().min(1).optional(),
  implemented: z.boolean().optional(),
  displayOrder: z.number().int().optional(),
  status: z.enum(["active", "draft", "deprecated"]).optional(),
  inputs: z.array(featureInputSchema).min(1).optional(),
  outputs: z.array(featureOutputSchema).min(1).optional(),
  charts: chartsArraySchema.optional(),
  entities: z.array(featureEntitySchema).min(1).optional(),
});

export type UpsertFeatureBody = z.infer<typeof upsertFeatureSchema>;
export type BatchUpsertFeaturesBody = z.infer<typeof batchUpsertFeaturesSchema>;
export type CreateFeatureBody = z.infer<typeof createFeatureSchema>;
export type UpdateFeatureBody = z.infer<typeof updateFeatureSchema>;
export type PrefillRequestBody = z.infer<typeof prefillRequestSchema>;
