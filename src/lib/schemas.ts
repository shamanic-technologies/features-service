import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// ── Feature response (matches DB row) ──────────────────────────────────────

export const featureResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  implemented: z.boolean(),
  displayOrder: z.number().int(),
  status: z.enum(["active", "deprecated"]),
  inputs: z.array(z.any()),
  outputs: z.array(z.any()),
  charts: z.array(z.any()),
  entities: z.array(z.any()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type FeatureResponse = z.infer<typeof featureResponseSchema>;
