import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { SALES_FUNNEL_KEYS } from "./sales-funnels.js";

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
  salesFunnels: z
    .array(z.enum(SALES_FUNNEL_KEYS as unknown as [string, ...string[]]))
    .describe(
      "WHICH SALES FUNNELS THIS FEATURE MAY BE SOLD THROUGH, in brand-service's own funnel keys. A product statement about the feature, owned by this service: the dashboard offers only valid (funnel, feature) pairs from it and campaign-service refuses to provision a pair that is not in it. ALWAYS PRESENT, so an absent answer can never be mistaken for 'all of them' — a feature that sells through no sales funnel states `[]` (every non-sales feature: PR, hiring, VC, accelerators, AI visibility, press kit, outlet discovery, expert quotes) and one that sells through every declared chain states all four keys explicitly. A shorter list is a real restriction, not a gap: the feedback-request cold email states `sales_meetings_from_conversation` alone, because its offer buys a conversation and has no website step to sell.",
    ),
  supersededBySlug: z
    .string()
    .nullable()
    .describe(
      "THE SLUG THAT REPLACED THIS ONE, or null when this slug is the current one. A retired slug is never renamed or deleted — live campaigns, live budgets and the cost ledger reference it, so this row and every per-brand and per-campaign read of it keep working exactly as before. What retirement changes is one thing only: the slug stops being PUBLISHED, so the public acquisition-channel catalogue (and the per-pair economics built from it) lists the offering once, under the current spelling. A consumer offering a customer something new should offer the successor.",
    ),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type FeatureResponse = z.infer<typeof featureResponseSchema>;
