import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { featureResponseSchema } from "./schemas.js";

const registry = new OpenAPIRegistry();

const errorResponse = z.object({ error: z.string() });

registry.register("Feature", featureResponseSchema);

// ── Stats response schemas ───────────────────────────────────────────────

const systemStatsSchema = z.object({
  totalCostInUsdCents: z.number().describe("Total committed run cost (USD cents) — includes provisioned holds. Back-compat; for displayed spend use actualCostInUsdCents."),
  actualCostInUsdCents: z.number().describe("ACTUAL run spend (USD cents) — only `actual` counts as billable spend (excludes provisioned holds + cancelled reservations). The canonical 'Total spent' and the numerator behind every cost-per-X stat, so cost-per metrics reconcile with the displayed spend. (features-service#396)"),
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
  featureSlug: z.string().nullable().optional(),
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
    sortDirection: z.enum(["asc", "desc"]).optional(),
  })),
});

registry.register("SystemStats", systemStatsSchema);
registry.register("StatsGroup", statsGroupSchema);
registry.register("FeatureStatsResponse", featureStatsResponseSchema);
registry.register("GlobalStatsResponse", globalStatsResponseSchema);
registry.register("RegistryResponse", registryResponseSchema);

// ── Entity registry schema ──────────────────────────────────────────────

const entityTypeDefSchema = z.object({
  label: z.string(),
  icon: z.string(),
  pathSuffix: z.string(),
  description: z.string(),
});

const entityRegistryResponseSchema = z.object({
  registry: z.record(z.string(), entityTypeDefSchema),
});

registry.register("EntityTypeDef", entityTypeDefSchema);
registry.register("EntityRegistryResponse", entityRegistryResponseSchema);

// ── Required identity headers (all authenticated endpoints) ────────────────

const identityHeaders = z.object({
  "x-org-id": z.string().uuid().describe("Internal org UUID from client-service"),
  "x-user-id": z.string().uuid().describe("Internal user UUID from client-service"),
  "x-run-id": z.string().uuid().describe("Run ID for tracking and billing"),
  "x-brand-id": z.string().optional().describe("Brand UUID(s), comma-separated"),
});

// ── GET /features — list ─────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features",
  summary: "List all features",
  description: "Returns features filtered by status. Defaults to `status=active`.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    query: z.object({ status: z.string().optional() }),
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
  description: "Returns a feature by its exact slug. Returns 404 if not found.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: { description: "Feature details", content: { "application/json": { schema: z.object({ feature: featureResponseSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/inputs ─────────────────────────────────────

const featureInputsResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  inputs: z.array(z.any()),
});

registry.register("FeatureInputsResponse", featureInputsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/inputs",
  summary: "Get inputs for a feature",
  description: "Returns the input field definitions for a feature by its slug.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
  },
  responses: {
    200: { description: "Feature inputs", content: { "application/json": { schema: featureInputsResponseSchema } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── POST /features/:featureSlug/prefill ──────────────────────────────────

const prefillResponseSchema = z.object({
  slug: z.string(),
  brandId: z.string(),
  format: z.enum(["text", "full"]),
  prefilled: z.record(z.string(), z.any()),
});

registry.register("PrefillResponse", prefillResponseSchema);

registry.registerPath({
  method: "post",
  path: "/features/{featureSlug}/prefill",
  summary: "Pre-fill feature inputs from brand data",
  description: "Calls brand-service to extract field values for the feature's inputs. Returns pre-filled values keyed by input key. Requires x-brand-id header. Use ?format=text for flattened strings, ?format=full for structured values with per-brand breakdown.",
  tags: ["Features"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      format: z.enum(["text", "full"]).optional().describe("Response format: 'text' returns flattened strings, 'full' returns structured values with per-brand breakdown. Defaults to 'full'."),
    }),
  },
  responses: {
    200: { description: "Pre-filled input values", content: { "application/json": { schema: prefillResponseSchema } } },
    400: { description: "Missing x-brand-id or invalid format", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Brand service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats/registry ──────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats/registry",
  summary: "Get the stats key registry",
  description: "Returns all known stats keys with their label and type.",
  tags: ["Stats"],
  request: { headers: identityHeaders },
  responses: {
    200: { description: "Stats registry", content: { "application/json": { schema: registryResponseSchema } } },
  },
});

// ── GET /entities/registry ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/entities/registry",
  summary: "Get the entity type registry",
  description: "Returns all known entity types with display metadata.",
  tags: ["Entities"],
  request: { headers: identityHeaders },
  responses: {
    200: { description: "Entity type registry", content: { "application/json": { schema: entityRegistryResponseSchema } } },
  },
});

// ── GET /features/:featureSlug/stats ─────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/stats",
  summary: "Get computed stats for a feature",
  description: "Returns computed stats for a feature slug. Optionally grouped by workflowSlug, brandId, or campaignId.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      groupBy: z.enum(["workflowSlug", "workflowDynastySlug", "brandId", "campaignId"]).optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowSlug: z.string().optional(),
      workflowDynastySlug: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Feature stats", content: { "application/json": { schema: featureStatsResponseSchema } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/revenue ────────────────────────────────────

const topPersonSchema = z.object({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
});

const revenueOrganizationSchema = z.object({
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  orgLogoUrl: z.string().nullable(),
  orgDomain: z.string().nullable().describe("Company domain (no protocol, e.g. \"acme.com\") for building a logo.dev URL. Null when no domain is known for the org."),
  topPerson: topPersonSchema,
  tags: z.array(z.string()),
  expectedRevenueUsd: z.number(),
  mostAdvancedDate: z.string().nullable().describe("Most-advanced event date. Null until per-event timestamps exist (email-gateway)."),
});

const revenueLeadSchema = z.object({
  leadId: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  orgName: z.string().nullable(),
  orgLogoUrl: z.string().nullable(),
  orgDomain: z.string().nullable().describe("Company domain (no protocol, e.g. \"acme.com\") for building a logo.dev URL. Null when no domain is known for the org."),
  tags: z.array(z.string()),
  expectedRevenueUsd: z.number().describe("Expected revenue for this lead. On a lensed (?lens=) response this is the lens's expected revenue = (conversionProbabilityPct/100) × LTR; otherwise the engine's furthest-stage EV."),
  date: z.string().nullable().describe("Most-advanced event date. Null until per-event timestamps exist (email-gateway); always null on a lensed response (Wave B dates are skipped)."),
  contacted: z.boolean().describe("True when the lead has been contacted (email-gateway delivery evidence). The same signal the Outreach stat card + pipeline-activity daily graph should count, so all three Overview surfaces agree on \"contacted\" from one snapshot (features-service#371)."),
  contactedAt: z.string().nullable().describe("ISO timestamp of first contact (email-gateway firstContactedAt). Null when not yet contacted, or contacted with no known date. The real per-lead timestamp the daily graph buckets by — no synthesis."),
  opened: z.boolean().describe("True when the lead opened (email-gateway). The signal the Opens daily-graph actual buckets, server-computed from this same leads[] snapshot (features-service#377)."),
  openedAt: z.string().nullable().describe("ISO timestamp of first open (email-gateway firstOpenedAt). Null when not opened, or opened with no known date. No synthesis."),
  clicked: z.boolean().describe("True when the lead clicked / visited the website (email-gateway). The signal the Clicks daily-graph actual buckets; ALSO the signup-goal's observed outcome (a downstream account signup is not tracked here) — features-service#377."),
  clickedAt: z.string().nullable().describe("ISO timestamp of first click (email-gateway firstClickedAt). Null when not clicked, or clicked with no known date. No synthesis."),
  repliedPositive: z.boolean().describe("True when the lead sent a positive reply (replied && replyClassification \"positive\" — the SAME classification the booked-meetings lens P=replyToMeeting + audience-stats positiveReplies use). The signal the positive-replies daily-graph actual buckets; the meeting-goal engagement Outcome, distinct from meetingBooked (the booked meeting is its downstream outcome). features-service#390."),
  repliedPositiveAt: z.string().nullable().describe("ISO timestamp of first positive reply (email-gateway firstRepliedAt). Null when no positive reply, or replied with no known date. No synthesis."),
  meetingBooked: z.boolean().describe("True when a meeting was booked (instantly manual qualification). The meeting-goal outcome the goal daily-graph actual buckets (features-service#377)."),
  meetingBookedAt: z.string().nullable().describe("ISO timestamp the meeting was booked (instantly manual-qualification meetingBookedAt). Null when no meeting, or no known date. No synthesis."),
  purchased: z.boolean().describe("True when the lead became a paying client / closed (instantly manual qualification). The purchase-goal outcome (features-service#377)."),
  purchasedAt: z.string().nullable().describe("ISO timestamp of the close (instantly manual-qualification closedAt). Null when not closed, or no known date. No synthesis."),
  conversionProbabilityPct: z.number().optional().describe("LENS ONLY — the lead's conversion probability (0–100) for the requested ?lens=. Present only on a lensed response; absent on the default/grouped responses."),
});

const revenueTimeSeriesPointSchema = z.object({
  date: z.string(),
  cumulativePipelineUsd: z.number(),
});

const revenueEventSchema = z.object({
  leadId: z.string(),
  person: z.string().nullable(),
  org: z.string().nullable(),
  eventType: z.string(),
  eventDate: z.string(),
  contributionUsd: z.number(),
});

const revenueCostEconomicsSchema = z.object({
  actualCostUsd: z.number().describe("ACTUAL (billed) run spend for the brand (+ optional campaign), feature-scoped, in dollars (>= 0). ROI/CAC ride REALIZED spend, so this is the billed amount ONLY — it EXCLUDES the provisioned holds that the `spend` block's committed total… figures include. Named `actualCostUsd` (renamed from the ambiguous `totalCostUsd`) to be unambiguously distinct from those committed total… figures. Same source as /stats systemStats.actualCostInUsdCents and spend.actualSpentCents. (features-service#396, naming features-service#402)"),
  costOfAcquisitionPct: z.number().nullable().describe("(actualCostUsd / totalPipelineUsd) * 100. Null when totalPipelineUsd is null or 0."),
  roiMultiple: z.number().nullable().describe("totalPipelineUsd / actualCostUsd. Null when actualCostUsd is 0 or totalPipelineUsd is null."),
  expectedConversions: z.number().optional().describe("LENS ONLY — expected conversion count = sum of per-lead conversion probability (decimal) across the lensed leads (totalPipelineUsd = expectedConversions × LTR). Present only on a lensed (?lens=) response; absent on the default/grouped responses."),
  costPerConversionUsd: z.number().nullable().optional().describe("LENS ONLY — actualCostUsd / expectedConversions. Null when expectedConversions is 0. Present only on a lensed (?lens=) response; absent on the default/grouped responses."),
});

// Server-computed "contacted" aggregates for the Overview's Outreach surfaces (stat card + 7-day
// graph), derived from the SAME leads[] this response returns. Coherent by construction:
// total === sum(daily[].count) + undatedCount === count(leads with contacted === true).
const outreachContactedDailySchema = z.object({
  date: z.string().describe("UTC calendar day (YYYY-MM-DD) of the contacted-lead bucket."),
  count: z.number().int().describe("Number of leads first contacted on this UTC day."),
});

const outreachContactedSchema = z.object({
  total: z.number().int().describe("Total contacted leads in scope — the Outreach stat-card count. Equals sum(daily[].count) + undatedCount."),
  daily: z.array(outreachContactedDailySchema).describe("Per-day contacted buckets (the Outreach ACTUAL series the daily graph renders), keyed by the UTC day of each lead's contactedAt, ascending. Complete series — one entry per day with ≥1 dated contacted lead; the dashboard slices its 7-day window from it. Sums to total - undatedCount. No wall-clock dependence (buckets come only from per-lead timestamps)."),
  undatedCount: z.number().int().describe("Contacted leads with a null contactedAt (cannot be bucketed — no synthesis). Counted in total but in no daily bucket, so total = sum(daily[].count) + undatedCount."),
});

// Generic per-signal ACTUAL series (Opens / Clicks / goal outcome) — same shape + coherence
// guarantee as outreachContacted, built from the SAME leads[] (features-service#377). Reuses the
// daily-point schema. total === sum(daily[].count) + undatedCount === count(leads with the signal).
const signalSeriesSchema = z.object({
  total: z.number().int().describe("Total leads in scope carrying the signal — the stat-card count. Equals sum(daily[].count) + undatedCount."),
  daily: z.array(outreachContactedDailySchema).describe("Per-day buckets (the ACTUAL series the daily graph renders), keyed by the UTC day of each lead's signal date, ascending. One entry per day with ≥1 dated lead; the dashboard slices its window from it. Sums to total - undatedCount. No wall-clock dependence."),
  undatedCount: z.number().int().describe("Leads carrying the signal with a null signal date (cannot be bucketed — no synthesis). Counted in total but in no daily bucket, so total = sum(daily[].count) + undatedCount."),
});

// Canonical spend block for the Overview "Outreach & Conversions" card — every number rendered
// verbatim (no client arithmetic). NAMING CONVENTION total/actual/provisioned: total… = COMMITTED
// (actual + provisioned holds, the displayed "Total spent" / "Budget spent today" / "CPC"); actual…
// = billed only; provisioned… = open holds only (= total − actual). Reconciled by construction:
// each total/actual/provisioned == Σ sources of the same accounting; each …CpcCents = the matching
// spend / clicks (clicked.total on the same response). The committed total… legitimately DIPS when a
// hold releases (a follow-up actualizes net-zero; a cancelled hold drops it).
const spendSourceSchema = z.object({
  source: z.string().describe("runs-service cost name (billable line item, e.g. 'apollo people-search', 'email-send-step-1')."),
  totalSpentCents: z.number().int().describe("COMMITTED spend attributed to this source (actual + provisioned holds), USD cents. Σ over sources == spend.totalSpentCents."),
  actualSpentCents: z.number().int().describe("ACTUAL (billed) spend attributed to this source, USD cents. Σ over sources == spend.actualSpentCents."),
  provisionedSpentCents: z.number().int().describe("Open PROVISIONED holds attributed to this source (= totalSpentCents − actualSpentCents), USD cents. Σ over sources == spend.provisionedSpentCents."),
  sharePct: z.number().describe("This source's share of the COMMITTED total (spend.totalSpentCents), percent (0–100). 0 when the committed total is 0."),
});

const spendSchema = z.object({
  totalSpentCents: z.number().int().describe("'Total spent' (COMMITTED, USD cents) = ACTUAL + PROVISIONED holds for the brand(+campaign)+feature, == Σ sources[].totalSpentCents. The reserved money the customer sees; dips when a hold releases. Reconciles with totalCpcCents by construction."),
  actualSpentCents: z.number().int().describe("ACTUAL (billed) spend only (USD cents), == Σ sources[].actualSpentCents. Same source as systemStats.actualCostInUsdCents / costEconomics.actualCostUsd (the realized spend ROI/CAC ride)."),
  provisionedSpentCents: z.number().int().describe("Open PROVISIONED holds only (USD cents) = totalSpentCents − actualSpentCents, == Σ sources[].provisionedSpentCents. Money reserved for scheduled follow-up sends, not yet billed."),
  totalSpentTodayCents: z.number().int().describe("COMMITTED spend (actual + provisioned, USD cents) for runs started since 00:00 UTC today — 'Budget spent today'."),
  actualSpentTodayCents: z.number().int().describe("ACTUAL (billed) spend (USD cents) for runs started since 00:00 UTC today."),
  provisionedSpentTodayCents: z.number().int().describe("Open PROVISIONED holds (USD cents) = totalSpentTodayCents − actualSpentTodayCents, for runs started since 00:00 UTC today."),
  sources: z.array(spendSourceSchema).describe("Per cost-name committed/actual/provisioned spend + committed share-of-total, descending — the 'top cost sources' list pre-computed (the dashboard renders verbatim instead of summing the runs breakdown in the browser)."),
  totalCpcCents: z.number().nullable().describe("COMMITTED cost per website click = totalSpentCents / clicks (clicked.total). Null (renders '-'), never a false $0.00, when there are 0 clicks OR 0 committed spend."),
  actualCpcCents: z.number().nullable().describe("ACTUAL (billed) cost per website click = actualSpentCents / clicks. Null (renders '-'), never a false $0.00, when 0 clicks OR 0 actual spend."),
  provisionedCpcCents: z.number().nullable().describe("PROVISIONED cost per website click = provisionedSpentCents / clicks. Null (renders '-'), never a false $0.00, when 0 clicks OR 0 provisioned holds."),
});

const featureRevenueResponseSchema = z.object({
  featureSlug: z.string(),
  spend: spendSchema.nullable().describe("Canonical spend block for the Overview card — Total spent / Budget spent today / CPC each in three variants (total=committed, actual=billed, provisioned=holds; total = actual + provisioned), plus top sources. Present on the OVERVIEW response; null on the lensed (?lens=) response (lens pages use costPerConversionUsd); absent on grouped (?groupBy=campaignId) groups. (features-service#396, committed naming features-service#402)"),
  outreachContacted: outreachContactedSchema.describe("Server-computed contacted aggregates for the Overview Outreach card + daily graph, from the SAME leads[] snapshot (single source, dashboard renders only — features-service#371/#372)."),
  opened: signalSeriesSchema.describe("Opens ACTUAL series for the Overview daily graph, server-computed from the SAME leads[] snapshot — coherent with outreachContacted + the table (features-service#377). Replaces the pipeline-activity/instantly event-day source."),
  clicked: signalSeriesSchema.describe("Clicks ACTUAL series (website visits), server-computed from the SAME leads[] snapshot. ALSO the signup-goal's observed outcome — a downstream account signup is not tracked here, so the visit is the coherent signup-funnel actual; the dashboard scales it by visitToSignupPct for the projected signups line (forecast). features-service#377."),
  repliedPositive: signalSeriesSchema.describe("Positive-replies ACTUAL series (email-gateway firstRepliedAt), server-computed from the SAME leads[] snapshot — coherent with the other actual series + the table. The booked-meetings lens's engagement signal (P=replyToMeeting) the meeting-goal Outcome line renders; distinct from meetingsBooked (the reply is the signal, the booked meeting its downstream outcome). features-service#390."),
  meetingsBooked: signalSeriesSchema.describe("Meeting-goal outcome ACTUAL series (instantly manual-qualification meetingBookedAt), server-computed from the SAME leads[] snapshot. features-service#377."),
  purchased: signalSeriesSchema.describe("Purchase-goal outcome ACTUAL series (instantly manual-qualification closedAt), server-computed from the SAME leads[] snapshot. features-service#377."),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start)."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used: 'sales-economics' = the brand's own saved set; 'cross-brand-average' = the brand-service cross-brand average fallback (revenue is an ESTIMATE, not user-confirmed). Null when the pipeline is null (no funnel wired or no economics applied)."),
  }),
  costEconomics: revenueCostEconomicsSchema.describe("Derived cost economics. Always present; ratios are null per the documented null semantics."),
  timeSeries: z.array(revenueTimeSeriesPointSchema).describe("Cumulative pipeline ordered by event date. Empty until per-event timestamps exist (email-gateway)."),
  organizations: z.array(revenueOrganizationSchema),
  leads: z.array(revenueLeadSchema),
  events: z.array(revenueEventSchema).describe("One row per event. Empty until per-event timestamps exist (email-gateway)."),
});

const featureRevenueResponseRef = registry.register("FeatureRevenueResponse", featureRevenueResponseSchema);

// Grouped variant — returned only when ?groupBy=campaignId. One LEAN group per campaign that has
// runs for the brand+feature: campaignId + headline.totalPipelineUsd + costEconomics ONLY (the
// dashboard campaigns row needs just revenue + ROI). Each group is byte-equal to the standalone
// ?campaignId= call. The heavy per-campaign arrays (timeSeries/organizations/leads/events) are omitted.
const revenueGroupSchema = z.object({
  campaignId: z.string(),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline for this campaign. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start)."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used: 'sales-economics' = the brand's own saved set; 'cross-brand-average' = the brand-service cross-brand average fallback (ESTIMATE). Null when the pipeline is null."),
  }),
  costEconomics: revenueCostEconomicsSchema,
});

const featureRevenueGroupedResponseSchema = z.object({
  featureSlug: z.string(),
  groupBy: z.literal("campaignId"),
  groups: z.array(revenueGroupSchema),
});

const featureRevenueGroupedResponseRef = registry.register("FeatureRevenueGroupedResponse", featureRevenueGroupedResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/revenue",
  summary: "Expected pipeline revenue for a feature",
  description:
    "Computes expected pipeline revenue for a feature, scoped to a brand (optionally one campaign). " +
    "Expected value uses MAX inside each entity (person, org) and SUM between distinct orgs. " +
    "Rates + terminal LTR come from the brand's sales economics. " +
    "timeSeries, events, and the date columns are deferred until email-gateway exposes per-event timestamps. " +
    "totalPipelineUsd is null when no funnel is wired for the feature, or the brand has no saved economics AND no cross-brand average exists (cold start). " +
    "When a brand has no saved economics but a cross-brand average exists, revenue is computed on that average and headline.economicsSource is 'cross-brand-average' (an estimate); otherwise 'sales-economics' (the brand's own saved set), or null for a null pipeline. " +
    "costEconomics carries the total run cost (same source as /stats systemStats) plus derived cost-of-acquisition % and ROI multiple. " +
    "With ?groupBy=campaignId the response is instead one LEAN group per campaign that has runs for the brand+feature " +
    "(campaignId + headline.totalPipelineUsd + costEconomics only); each group is byte-equal to the standalone ?campaignId= call.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — revenue is brand-scoped."),
      campaignId: z.string().optional().describe("Optional campaign drill-down (ignored when groupBy=campaignId)."),
      groupBy: z.enum(["campaignId"]).optional().describe("When 'campaignId', return one lean group per campaign with runs for the brand+feature instead of the single overview."),
      lens: z.enum(["signups", "booked-meetings", "sales"]).optional().describe("Outcome lens (overview only). Filters leads[] to the lens's engagement signal and adds conversionProbabilityPct per lead: signups=website click (P=visitToSignup), booked-meetings=positive reply (P=replyToMeeting), sales=click and/or positive reply (combined-OR paid-close). headline.totalPipelineUsd = sum of the lensed leads' expectedRevenueUsd. Omitted → response unchanged."),
    }),
  },
  responses: {
    200: { description: "Feature revenue (overview, or grouped when groupBy=campaignId; lensed when ?lens= is set)", content: { "application/json": { schema: z.union([featureRevenueResponseRef, featureRevenueGroupedResponseRef]) } } },
    400: { description: "Missing brandId or invalid lens value", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/workflow-projection ─────────────────────────

const workflowProjectionDetailSchema = z.object({
  contactedLeads: z.number().nullable().describe("Expected unique leads contacted from the budget. Null when the workflow has no usable contacted-lead denominator."),
  replies: z.number().nullable().describe("Expected positive replies from the budget. Null when the workflow has no reply cost."),
  visits: z.number().nullable().describe("Expected clicks/visits from the budget. Null when the workflow has no click cost."),
  signups: z.number().nullable().describe("Expected signups from the budget (visits × visitToSignupPct). Null when the workflow has no click cost."),
  meetings: z.number().nullable().describe("Expected meetings booked (from both the reply and click routes)."),
  closes: z.number().nullable().describe("Expected closes from the budget."),
  revenue: z.number().nullable().describe("closes × LTR (lifetime revenue per close)."),
  cacPct: z.number().nullable().describe("(budget / revenue) × 100. Null when revenue is 0."),
  cacAbs: z.number().nullable().describe("budget / closes (absolute cost per close). Null when closes is 0."),
});

const workflowProjectionItemSchema = z.object({
  workflowDynastySlug: z.string(),
  workflowDynastyName: z.string().nullable(),
  contactedUsd: z.number().nullable().describe("Cost per unique lead contacted (USD). Null when the contacted-lead denominator is absent or zero."),
  replyUsd: z.number().nullable().describe("Cost per positive reply (USD). Null when the metric is absent or zero."),
  clickUsd: z.number().nullable().describe("Cost per click (USD). Null when the metric is absent or zero."),
  costPerSignupUsd: z.number().nullable().describe("Budget required per signup for this workflow. Null when there is no usable click/conversion data."),
  costPerCloseUsd: z.number().nullable().describe("Budget required per close for this workflow. Null when there is no usable cost/conversion data."),
  costPerMeetingBookedUsd: z.number().nullable().describe("Budget required per booked meeting for this workflow. Null when there is no usable cost/conversion data."),
  roiMultiple: z.number().nullable().describe("Lifetime ROI multiple = LTR / costPerCloseUsd (revenue per acquisition dollar; budget-independent, = 100 / cacPct). Rendered verbatim instead of inverting cacPct client-side. Null when economics are absent or costPerCloseUsd is null/0. (features-service#396)"),
  projection: workflowProjectionDetailSchema.nullable().describe("Null when budgetUsd is absent/≤0 or the workflow has no usable data."),
});

const workflowProjectionResponseSchema = z.object({
  featureSlug: z.string(),
  objective: z.enum(["meeting-booked", "self-serve", "signup", "purchase"]).describe("Echo of the requested objective (defaults to meeting-booked). Controls which cost metric sizes recommendedBudgetUsd. self-serve is a signup alias."),
  workflows: z.array(workflowProjectionItemSchema),
  recommendedWorkflowDynastySlug: z.string().nullable().describe("Workflow with the lowest cost metric for the requested objective. Null when none has usable data."),
  recommendedBudgetUsd: z.number().nullable().describe("10 target outcomes/month × the best cost metric for the requested objective. meeting-booked uses costPerMeetingBookedUsd; self-serve/signup use costPerSignupUsd; purchase uses costPerCloseUsd. Null when there is no pick."),
});

registry.register("WorkflowProjectionResponse", workflowProjectionResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/workflow-projection",
  summary: "Rank workflows by cost-per-outcome and project a budget",
  description:
    "Ranks a brand's workflows by the requested objective's cost-per-outcome (the reply + click engagement routes funded by one budget) and — when budgetUsd is given — projects that budget through the funnel. " +
    "Per-workflow unit costs (cost per positive reply / per click) are global cross-org workflow efficiency (same source as /public/stats/best), aggregated over each workflow's upgrade chain. " +
    "Conversion rates + LTR come from the brand's EFFECTIVE sales-economics (its own saved set, or the cross-brand-average when unset — null only at cold start). " +
    "recommendedWorkflowDynastySlug is the workflow with the lowest objective metric; recommendedBudgetUsd = 10 × that cost.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — conversion economics are brand-scoped."),
      objective: z.enum(["meeting-booked", "self-serve", "signup", "purchase"]).optional().describe("Controls which cost metric sizes recommendedBudgetUsd. self-serve is a signup alias. Defaults to meeting-booked."),
      budgetUsd: z.string().optional().describe("Optional budget (USD) to project through the funnel."),
    }),
  },
  responses: {
    200: { description: "Workflow projection", content: { "application/json": { schema: workflowProjectionResponseSchema } } },
    400: { description: "Missing brandId", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/pipeline-activity ───────────────────────────

const pipelineMetricSchema = z.object({
  actual: z.number().nullable().describe("Today: actual-so-far from dated broadcast email events. Future days: null."),
  expected: z.number().nullable().describe("Expected daily value from brand daily budget, recommended workflow cost/contact, and audience/workflow evidence. Null when required producer inputs are unavailable."),
});

const pipelineSignupMetricSchema = pipelineMetricSchema.extend({
  conversionPct: z.number().nullable().describe("visitToSignupPct used for signup projection. Null when brand economics are unavailable."),
});

const pipelineActivityDaySchema = z.object({
  date: z.string().describe("Calendar date in the requested timezone (YYYY-MM-DD)."),
  isToday: z.boolean(),
  metrics: z.object({
    outreach: pipelineMetricSchema,
    opens: pipelineMetricSchema,
    clicks: pipelineMetricSchema,
    signups: pipelineSignupMetricSchema,
  }),
});

const pipelineActivityResponseSchema = z.object({
  featureSlug: z.string(),
  brandId: z.string(),
  timezone: z.string(),
  generatedAt: z.string().datetime(),
  days: z.array(pipelineActivityDaySchema),
  summary: z.object({
    dailyBudgetUsd: z.number().nullable().describe("Brand daily budget from billing-service. Null when no daily budget is configured for this org + brand."),
    openRatePct: z.number().nullable().describe("Observed audience + workflow broadcast open rate used for expected opens. Null when producer evidence is unavailable."),
    clickToSignupPct: z.number().nullable().describe("Brand effective visit-to-signup conversion percent. Null when brand economics are unavailable."),
  }),
});

registry.register("PipelineActivityResponse", pipelineActivityResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/pipeline-activity",
  summary: "Seven-day pipeline activity buckets for the brand overview",
  description:
    "Returns today plus future daily buckets for the dashboard grouped bar chart. Today includes actual-so-far from dated broadcast email events and the same daily expected values shown on future days. " +
    "Expected outreach uses the org-scoped brand daily budget divided by the recommended workflow's global cost per contacted recipient. Opens and clicks use observed rates for the selected active audience + workflow; signups are clicks × the brand's effective visitToSignupPct / 100. Campaign status and campaign budget do not control this forecast. Missing producer inputs return null for the affected expected values.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      days: z.string().optional().describe("Number of days to return. Defaults to 7."),
      timezone: z.string().describe("IANA timezone used for calendar day ordering and today's event bucket."),
    }),
  },
  responses: {
    200: { description: "Pipeline activity buckets", content: { "application/json": { schema: pipelineActivityResponseSchema } } },
    400: { description: "Missing/invalid brandId, days, or timezone", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/candidates ──────────────────────────────────

const candidateConversionSchema = z.object({
  rate: z.number().nullable().describe("P(goal-outcome | engaged click) from the brand's effective sales-economics. Null at cold start (no economics)."),
  grain: z.enum(["brand-goal", "goal-global"]).nullable().describe("Provenance of the conversion rate: brand-goal = the brand's own saved economics; goal-global = the cross-org average fallback; null = cold start."),
  sampleSize: z.null().describe("Always null: the conversion rate comes from the brand's saved sales-economics, which carry no per-grain observation count (brand-service#242). The empirical sample behind a candidate lives ENTIRELY on the cost side (cost.sampleSize, at cost.grain) — do NOT read the cost sample as the conversion sample."),
});

const candidateCostSampleSizeSchema = z.object({
  runs: z.number().describe("Completed runs behind the cost evidence (chain-aggregated for goal-global, audience-scoped for audience)."),
  contacted: z.number(),
  clicks: z.number(),
  replies: z.number(),
});

const candidateCostSchema = z.object({
  costPerLeadUsd: z.number().nullable().describe("Cost per contacted lead (USD). Null when there is no contacted-lead denominator."),
  clickUsd: z.number().nullable().describe("Cost per click (USD). Null when absent/zero."),
  replyUsd: z.number().nullable().describe("Cost per positive reply (USD). Null when absent/zero."),
  grain: z.enum(["goal-global", "audience"]).describe("Cost-evidence grain: 'goal-global' = cross-org workflow unit costs (same source as /public/stats/best); 'audience' = audience-attributed cost (same source as /audience-stats)."),
  sampleSize: candidateCostSampleSizeSchema.describe("The sample behind THIS cost evidence, at the cost grain above. On coarse rows grain='goal-global' → this is the CROSS-ORG cost population (NOT the brand's own activity); on audience rows grain='audience' → the audience's own attributed slice. Lives here (not at the candidate top level) so a fresh brand's cross-org cost sample is never mis-read as that brand's own evidence."),
});

const candidateSchema = z.object({
  audienceId: z.string().nullable().describe("Audience lever — non-null with grain='audience' for couples that have audience-attributed runs/outcomes (active human-service audience × runs-attributed workflow). Null on the coarser brand-goal/goal-global fallback rows when there is no audience-level evidence."),
  workflow: z.object({ workflowDynastySlug: z.string(), workflowDynastyName: z.string().nullable() }),
  goal: z.enum(["signup", "meetingBooked", "purchase"]),
  grain: z.enum(["audience", "brand-goal", "goal-global"]).describe("SUMMARY label: the finest grain reached ACROSS this candidate's evidence components (audience > brand-goal > goal-global). Does NOT describe the sample, and the components can resolve at different grains — read conversion.grain for the conversion rate's provenance and cost.grain + cost.sampleSize for the cost evidence's provenance and size. On a coarse row this can read 'brand-goal' (brand-own economics) while cost.grain is 'goal-global' (cross-org cost sample)."),
  costPerOutcomeUsd: z.number().nullable().describe("The goal metric: cost per goal-outcome (USD). Null when economics are absent (cold start)."),
  conversion: candidateConversionSchema,
  cost: candidateCostSchema,
});

const candidatesResponseSchema = z.object({
  featureSlug: z.string(),
  brandId: z.string(),
  goal: z.enum(["signup", "meetingBooked", "purchase"]),
  brandProfileId: z.string().nullable().describe("Brand-profile-version context echoed back."),
  candidates: z.array(candidateSchema),
});

registry.register("CandidatesResponse", candidatesResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/candidates",
  summary: "Serve the (audienceId, workflow) candidate set with per-candidate evidence + sample size",
  description:
    "Runtime per-lead selection evidence: returns the candidate SET — one per active workflow — each with its OWN cost-per-outcome for the goal, CONVERSION and COST evidence kept separate (each labelled with its own grain), and the SAMPLE SIZE living WITH the cost evidence it describes (cost.sampleSize at cost.grain) so a coarse row's cross-org cost sample is never mis-read as the brand's own activity (the conversion rate carries provenance but no count). The top-level grain is a summary label = the finest grain across components. Deliberately does NOT collapse to a single best: the consumer owns the uncertainty-aware selection policy (Thompson-style). " +
    "Fallback grain ladder (finest→coarsest): audience (brandId×goal×audienceId) → brand-goal (brandId×goal) → goal-global (cross-org workflow evidence). The audience rung is LIVE: for active human-service audiences with runs-attributed couples this endpoint emits one audience-grain candidate per couple (audienceId non-null, grain='audience'); couples with no audience-level evidence fall through to the coarser rungs with audienceId null. " +
    "Reuses the workflow-projection data path: global per-workflow unit costs aggregated over the upgrade chain + the brand's EFFECTIVE sales-economics. Additive — does not change workflow-projection / stats/ranked.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — conversion economics are brand-scoped."),
      goal: z.enum(["signup", "meetingBooked", "purchase"]).describe("Optimization target (required). Maps to the projected cost-per-outcome."),
      brandProfileId: z.string().optional().describe("Brand-profile-version context (optional, echoed)."),
    }),
  },
  responses: {
    200: { description: "Candidate evidence set", content: { "application/json": { schema: candidatesResponseSchema } } },
    400: { description: "Missing brandId or invalid goal", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/audience-stats ───────────────────────────────

const audienceStatsEvidenceSchema = z.object({
  totalCostInUsdCents: z.number().describe("Audience-scoped spend numerator from runs-service, in USD cents."),
  completedRuns: z.number().describe("Completed runs behind this audience's cost evidence."),
  firstRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  contacted: z.number().describe("Audience-scoped contacted-recipient count from email-gateway broadcast stats."),
  opened: z.number().describe("Audience-scoped opened-recipient count (recipients who opened >= 1 email) from email-gateway broadcast stats."),
  websiteClicks: z.number().describe("Audience-scoped clicked-recipient count. Dashboard CPC = totalCostInUsdCents / websiteClicks."),
  positiveReplies: z.number().describe("Audience-scoped positive-reply recipient count. Dashboard CPPR = totalCostInUsdCents / positiveReplies."),
});

const audienceStatsRowSchema = z.object({
  audienceId: z.string().describe("Audience ID (human-service audience.id) the row's evidence is attributed to. Rows are emitted only for real attributed producer groups."),
  brandProfileId: z.string().nullable().describe("Brand-profile version used to filter producer evidence, when known."),
  audience: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["active", "paused", "archived"]),
    filters: z
      .object({
        titles: z.array(z.string()).optional(),
        seniorities: z.array(z.string()).optional(),
        functions: z.array(z.string()).optional(),
        locationCountries: z.array(z.string()).optional(),
        locationStates: z.array(z.string()).optional(),
        locationCities: z.array(z.string()).optional(),
        companyNames: z.array(z.string()).optional(),
        companyDomains: z.array(z.string()).optional(),
        industries: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
        employeeMin: z.number().optional(),
        employeeMax: z.number().optional(),
        companySizes: z.array(z.string()).optional(),
        revenueRanges: z.array(z.string()).optional(),
        fundingStages: z.array(z.string()).optional(),
        technologies: z.array(z.string()).optional(),
      })
      .nullable()
      .describe("Targeting filter-set, sourced from the human-service audience."),
  }),
  evidence: audienceStatsEvidenceSchema,
  metrics: z.object({
    cpcCents: z.number().nullable().describe("totalCostInUsdCents / websiteClicks. Null when websiteClicks is zero OR no spend is attributed (totalCostInUsdCents is zero) — never a false $0.00."),
    cpprCents: z.number().nullable().describe("totalCostInUsdCents / positiveReplies. Null when positiveReplies is zero OR no spend is attributed (totalCostInUsdCents is zero) — never a false $0.00."),
  }),
});

const audienceStatsResponseSchema = z.object({
  featureSlug: z.string(),
  brandId: z.string(),
  goal: z.enum(["signup", "meetingBooked", "purchase"]),
  brandProfileId: z.string().nullable(),
  sortMetric: z.enum(["cpc", "cppr"]).describe("signup sorts by CPC; meetingBooked and purchase sort by CPPR."),
  audiences: z.array(audienceStatsRowSchema).describe("Audience rows sorted ascending by sortMetric, with null metric values last."),
});

registry.register("AudienceStatsResponse", audienceStatsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/audience-stats",
  summary: "Audience-level cost and outcome evidence for a brand + feature + goal",
  description:
    "Returns ranked human-service audience rows for dashboard ranking. Each row is based on producer-side attribution of runs/outcomes to audienceId/brandProfileId/goal/workflow, never hash assignment or equal splitting of brand totals. " +
    "Rows carry raw spend and outcome evidence so the dashboard can compute CPC (spend / websiteClicks) and CPPR (spend / positiveReplies). " +
    "Rows with missing audienceId attribution are omitted. If brandProfileId is omitted, features-service reads the brand's current profile from brand-service and filters producer evidence to that profile when available.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      goal: z.enum(["signup", "meetingBooked", "purchase"]).describe("Active optimization goal (required). signup sorts by CPC; other goals sort by CPPR."),
      brandProfileId: z.string().optional().describe("Optional brand-profile version to scope evidence. Defaults to brand-service current profile when omitted."),
      limit: z.string().optional().describe("Optional positive integer row limit after sorting."),
      statuses: z
        .string()
        .optional()
        .describe(
          "Optional comma-separated subset of audience lifecycle statuses to include: active, paused, archived. " +
            "Absent → active only (preserves the active-only ranking used by the Top-audiences card). " +
            "When present, returns evidence rows for audiences in any of the given statuses (e.g. statuses=active,paused,archived surfaces archived audiences' historical outreach). " +
            "Any token outside {active, paused, archived} (e.g. suggested, deprecated) is rejected with 400.",
        ),
    }),
  },
  responses: {
    200: { description: "Audience cost/outcome evidence", content: { "application/json": { schema: audienceStatsResponseSchema } } },
    400: { description: "Missing/invalid brandId, goal, limit, or statuses", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /stats ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats",
  summary: "Global stats across all features",
  description: "Cross-feature stats endpoint. Supports groupBy: featureSlug, workflowSlug, workflowDynastySlug, brandId, campaignId.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    query: z.object({
      groupBy: z.string().optional(),
      brandId: z.string().optional(),
      featureSlug: z.string().optional(),
      workflowSlug: z.string().optional(),
      workflowDynastySlug: z.string().optional(),
      campaignId: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Global stats", content: { "application/json": { schema: globalStatsResponseSchema } } },
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (no auth)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /public/features ──────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/features",
  summary: "List active features (public, no auth)",
  description: "Returns all active features. No API key required.",
  tags: ["Public"],
  responses: {
    200: { description: "Active features", content: { "application/json": { schema: z.object({ features: z.array(featureResponseSchema) }) } } },
  },
});

// ── Ranked / Best schemas ────────────────────────────────────────────────

const rankedWorkflowSchema = z.object({
  id: z.string().uuid().optional(),
  workflowSlug: z.string(),
  workflowName: z.string().optional(),
  workflowDynastyName: z.string().optional(),
  workflowDynastySlug: z.string().optional(),
  version: z.number().int().optional(),
  featureSlug: z.string().optional(),
  createdForBrandId: z.string().nullable().optional(),
});

const rankedBrandSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
});

const rankedStatsSchema = z.record(z.string(), z.number().nullable());

const rankedResultSchema = z.object({
  workflow: rankedWorkflowSchema.optional(),
  brand: rankedBrandSchema.optional(),
  stats: rankedStatsSchema,
});

const rankedResponseSchema = z.object({
  objective: z.string(),
  sortDirection: z.enum(["asc", "desc"]),
  results: z.array(rankedResultSchema),
});

const publicEngagementLatencyMetricSchema = z.object({
  averageMs: z.number().nullable().describe("Average elapsed time in milliseconds. Null when sampleSize is 0."),
  medianMs: z.number().nullable().describe("Median elapsed time in milliseconds. Null when sampleSize is 0."),
  sampleSize: z.number().int().describe("Number of recipients included in this metric."),
});

const publicWorkflowEngagementLatencyResultSchema = z.object({
  workflow: rankedWorkflowSchema,
  timeToFirstLinkClick: publicEngagementLatencyMetricSchema,
  timeToFirstPositiveReply: publicEngagementLatencyMetricSchema,
});

const publicWorkflowEngagementLatencyResponseSchema = z.object({
  featureSlug: z.string(),
  groupBy: z.literal("workflow"),
  results: z.array(publicWorkflowEngagementLatencyResultSchema),
});

const rankedQueryParams = z.object({
  featureSlug: z.string().describe("Feature slug (required)"),
  objective: z.string().optional().describe("Stats key to sort by (defaults to costPerRecipientPositiveReplyCents)"),
  groupBy: z.enum(["workflow", "brand"]).describe("Group results by workflow or by brand"),
  limit: z.string().optional().describe("Max results (default 3)"),
});

const bestQueryParams = z.object({
  featureSlug: z.string().describe("Feature slug (required)"),
  groupBy: z.enum(["workflow", "brand"]).describe("Group results by workflow or by brand"),
});

const bestEntryWorkflowSchema = z.object({
  workflowSlug: z.string(),
  workflowName: z.string(),
  createdForBrandId: z.string().nullable(),
  value: z.number(),
});

// ── GET /public/stats/ranked ──────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/ranked",
  summary: "Top workflows or brands ranked by output metric (public, no auth)",
  description: "Returns top workflows or brands ranked by an output metric for a feature.",
  tags: ["Public"],
  request: { query: rankedQueryParams },
  responses: {
    200: { description: "Ranked results", content: { "application/json": { schema: rankedResponseSchema } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/best ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/best",
  summary: "Best cost-per-outcome per metric (public, no auth)",
  description: "Returns the best (lowest cost-per-outcome) workflow or brand for each count-type metric.",
  tags: ["Public"],
  request: { query: bestQueryParams },
  responses: {
    200: { description: "Best records per metric", content: { "application/json": { schema: z.object({ best: z.record(z.string(), bestEntryWorkflowSchema.nullable()) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/revenue ─────────────────────────────────────────────

const publicRevenueResultSchema = z.object({
  brand: rankedBrandSchema,
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Cross-org expected pipeline for the brand (sum over the orgs it appears in). Null when no saved economics anywhere."),
  }),
  costEconomics: revenueCostEconomicsSchema,
  timeline: z.array(revenueTimeSeriesPointSchema).optional().describe("Public-safe cumulative expected-pipeline timeline for this brand. Omitted when no dated revenue events exist."),
});

const publicRevenueResponseSchema = z.object({
  featureSlug: z.string(),
  groupBy: z.literal("brand"),
  results: z.array(publicRevenueResultSchema),
});

const publicRevenueRollupSchema = z.object({
  featureSlug: z.string(),
  totalPipelineUsd: z.number().nullable().describe("Feature-wide sum of every brand's expected pipeline (null when no brand has saved economics). Returned when rollup=true — no per-brand results/timelines."),
});

const publicRevenueResponseRef = registry.register("PublicRevenueResponse", publicRevenueResponseSchema);
const publicRevenueRollupRef = registry.register("PublicRevenueRollup", publicRevenueRollupSchema);

registry.registerPath({
  method: "get",
  path: "/public/stats/revenue",
  summary: "Cross-org expected pipeline revenue + CAC + ROI per brand (public, no auth)",
  description:
    "Per-brand expected pipeline revenue, cost-of-acquisition % and ROI multiple for a feature, aggregated cross-org. " +
    "Runs the same expected-pipeline engine as GET /features/{featureSlug}/revenue once per (org, brand) that has leads for the feature, and sums each brand across the orgs it appears in (leads are disjoint per org, so no double-count). " +
    "costEconomics is byte-identical to the dashboard's (buildCostEconomics). Only groupBy=brand is supported today — per-workflow revenue is a follow-up. " +
    "Pass rollup=true to get only the feature-wide totalPipelineUsd (no per-brand timelines, ~1 KB instead of ~1.9 MB).",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      groupBy: z.literal("brand").describe("Group results by brand (only supported value)."),
      rollup: z.literal("true").optional().describe("If 'true', return only { featureSlug, totalPipelineUsd } — the slim feature-wide rollup."),
    }),
  },
  responses: {
    200: { description: "Per-brand cross-org revenue, or the slim rollup when rollup=true", content: { "application/json": { schema: z.union([publicRevenueResponseRef, publicRevenueRollupRef]) } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/cost-projection ─────────────────────────────────────────

const publicCostProjectionResponseSchema = z.object({
  featureSlug: z.string(),
  avgCostPerMeetingBooked: z.number().nullable().describe("Feature-wide average EXPECTED USD cost per meeting booked (mean across client brands of each brand's best-workflow projection). Null when no brand has usable economics."),
  avgCostPerPurchase: z.number().nullable().describe("Feature-wide average EXPECTED USD cost per purchase/close. Null when no brand has usable economics."),
  brandCount: z.number().int().describe("Number of client brands with usable economics that contributed to the averages."),
});

registry.registerPath({
  method: "get",
  path: "/public/stats/cost-projection",
  summary: "Feature-wide expected cost per meeting-booked and per purchase (public, no auth)",
  description:
    "Cross-org EXPECTED (projected, not tracked) average cost to produce one meeting booked and one purchase for a feature. " +
    "Uses the same EV funnel as the revenue engine / workflow-projection: each workflow's global unit costs (cost per click / per positive reply) pushed through each brand's effective conversion economics. " +
    "Per brand the best workflow is picked for each metric independently, then averaged (unweighted) across all client brands. Null only when no brand has usable economics.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
    }),
  },
  responses: {
    200: { description: "Feature-wide expected cost-per-outcome", content: { "application/json": { schema: publicCostProjectionResponseSchema } } },
    400: { description: "Missing parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/workflow-engagement-latency ────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/workflow-engagement-latency",
  summary: "Average and median time-to-engagement per workflow (public, no auth)",
  description:
    "Returns public-safe workflow-level average and median elapsed time to first link click and first positive reply for a feature. " +
    "The duration math is computed by the email stats producer from dated activity; features-service enriches only with public workflow identity. " +
    "Only groupBy=workflow is supported.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      groupBy: z.literal("workflow").describe("Group results by workflow (only supported value)."),
    }),
  },
  responses: {
    200: { description: "Per-workflow engagement latency metrics", content: { "application/json": { schema: publicWorkflowEngagementLatencyResponseSchema } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── Authenticated ranked/best ────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/stats/ranked",
  summary: "Top workflows or brands ranked by output metric (authenticated)",
  description: "Authenticated version of GET /public/stats/ranked.",
  tags: ["Stats"],
  request: { headers: identityHeaders, query: rankedQueryParams },
  responses: {
    200: { description: "Ranked results", content: { "application/json": { schema: rankedResponseSchema } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/stats/best",
  summary: "Best cost-per-outcome per metric (authenticated)",
  description: "Authenticated version of GET /public/stats/best.",
  tags: ["Stats"],
  request: { headers: identityHeaders, query: bestQueryParams },
  responses: {
    200: { description: "Best records per metric", content: { "application/json": { schema: z.object({ best: z.record(z.string(), bestEntryWorkflowSchema.nullable()) }) } } },
    400: { description: "Missing required parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── Security scheme ──────────────────────────────────────────────────────

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
    version: "4.0.0",
    description:
      "Manages feature definitions and computes output stats.\n\n" +
      "Features are a minimal lookup table: id, slug, name, description, status.\n" +
      "Stats are computed by calling downstream services and aggregating results.",
  },
  servers: [{ url: "/" }],
  security: [{ ApiKeyAuth: [] }],
});
