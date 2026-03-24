import { z } from "zod";

export const featureInputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "textarea", "number", "url", "select"]),
  description: z.string().min(1),
  options: z.array(z.string()).optional(),
});

export const featureOutputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["count", "percentage", "currency", "text"]),
  description: z.string().optional(),
});

export const upsertFeatureSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  status: z.enum(["active", "draft", "deprecated"]).optional().default("active"),
  inputs: z.array(featureInputSchema).min(1),
  outputs: z.array(featureOutputSchema).min(1),
  defaultWorkflowName: z.string().nullable().optional(),
});

export const batchUpsertFeaturesSchema = z.object({
  features: z.array(upsertFeatureSchema).min(1),
});

export type UpsertFeatureBody = z.infer<typeof upsertFeatureSchema>;
export type BatchUpsertFeaturesBody = z.infer<typeof batchUpsertFeaturesSchema>;
