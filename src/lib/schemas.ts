import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

// ── Feature response (matches DB row) ──────────────────────────────────────

export const featureResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["active", "deprecated"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type FeatureResponse = z.infer<typeof featureResponseSchema>;
