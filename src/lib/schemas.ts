import { z } from "zod";

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
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["count", "rate", "currency", "percentage"]),
  displayOrder: z.number().int(),
  showInCampaignRow: z.boolean(),
  showInFunnel: z.boolean(),
  funnelOrder: z.number().int().optional(),
  numeratorKey: z.string().optional(),
  denominatorKey: z.string().optional(),
});

// ── Workflow columns ────────────────────────────────────────────────────────

export const workflowColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["rate", "currency", "count"]),
  numeratorKey: z.string().optional(),
  denominatorKey: z.string().optional(),
  sortDirection: z.enum(["asc", "desc"]),
  displayOrder: z.number().int(),
  defaultSort: z.boolean().optional(),
});

// ── Charts ──────────────────────────────────────────────────────────────────

const funnelStepSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  statsField: z.string().min(1),
  rateBasedOn: z.string().nullable(),
});

const breakdownSegmentSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  statsField: z.string().min(1),
  color: z.enum(["green", "blue", "red", "gray", "orange"]),
  sentiment: z.enum(["positive", "neutral", "negative"]),
});

const funnelBarChartSchema = z.object({
  key: z.string().min(1),
  type: z.literal("funnel-bar"),
  title: z.string().min(1),
  displayOrder: z.number().int(),
  steps: z.array(funnelStepSchema).min(1),
});

const breakdownBarChartSchema = z.object({
  key: z.string().min(1),
  type: z.literal("breakdown-bar"),
  title: z.string().min(1),
  displayOrder: z.number().int(),
  segments: z.array(breakdownSegmentSchema).min(1),
});

export const featureChartSchema = z.discriminatedUnion("type", [
  funnelBarChartSchema,
  breakdownBarChartSchema,
]);

// ── Feature upsert ──────────────────────────────────────────────────────────

export const upsertFeatureSchema = z.object({
  // No slug — auto-generated from name
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  category: z.string().min(1),
  channel: z.string().min(1),
  audienceType: z.string().min(1),
  implemented: z.boolean().optional().default(true),
  displayOrder: z.number().int().optional().default(0),
  status: z.enum(["active", "draft", "deprecated"]).optional().default("active"),
  inputs: z.array(featureInputSchema).min(1),
  outputs: z.array(featureOutputSchema).min(1),
  workflowColumns: z.array(workflowColumnSchema).optional().default([]),
  charts: z.array(featureChartSchema).optional().default([]),
  resultComponent: z.string().nullable().optional(),
  defaultWorkflowName: z.string().nullable().optional(),
});

export const batchUpsertFeaturesSchema = z.object({
  features: z.array(upsertFeatureSchema).min(1),
});

// ── Prefill request ────────────────────────────────────────────────────────

export const prefillRequestSchema = z.object({
  brandId: z.string().uuid(),
});

export type UpsertFeatureBody = z.infer<typeof upsertFeatureSchema>;
export type BatchUpsertFeaturesBody = z.infer<typeof batchUpsertFeaturesSchema>;
export type PrefillRequestBody = z.infer<typeof prefillRequestSchema>;
