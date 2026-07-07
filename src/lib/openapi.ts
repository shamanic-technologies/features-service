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
  title: z.string().nullable().describe("FIRMOGRAPHIC — the person's current-employer job title (lead-service currentTitle, #336). Null when unknown; never synthesized."),
  seniority: z.string().nullable().describe("FIRMOGRAPHIC — the person's Apollo seniority band (e.g. \"vp\", \"director\", \"manager\") (lead-service seniority, #327). Null when unknown; never synthesized."),
  orgIndustry: z.string().nullable().describe("FIRMOGRAPHIC — the company's industry (lead-service organization.industry, #327). Null when unknown; never synthesized."),
  orgEmployeeCount: z.number().int().nullable().describe("FIRMOGRAPHIC — the company's estimated headcount (raw number from lead-service organization.estimatedNumEmployees, #327). The consumer bands it for display (e.g. \"11-50\"); NOT pre-banded here. Null when unknown; never synthesized."),
  orgCity: z.string().nullable().describe("FIRMOGRAPHIC — the company's city (lead-service organization.city, #327). Null when unknown; never synthesized."),
  orgCountry: z.string().nullable().describe("FIRMOGRAPHIC — the company's country (lead-service organization.country, #327). Null when unknown; never synthesized."),
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
const recipientsContactedDailySchema = z.object({
  date: z.string().describe("UTC calendar day (YYYY-MM-DD) of the contacted-lead bucket."),
  count: z.number().int().describe("Number of leads first contacted on this UTC day."),
});

const recipientsContactedSchema = z.object({
  total: z.number().int().describe("Total contacted leads in scope — the Outreach stat-card count. Equals sum(daily[].count) + undatedCount."),
  daily: z.array(recipientsContactedDailySchema).describe("Per-day contacted buckets (the Outreach ACTUAL series the daily graph renders), keyed by the UTC day of each lead's contactedAt, ascending. Complete series — one entry per day with ≥1 dated contacted lead; the dashboard slices its 7-day window from it. Sums to total - undatedCount. No wall-clock dependence (buckets come only from per-lead timestamps)."),
  undatedCount: z.number().int().describe("Contacted leads with a null contactedAt (cannot be bucketed — no synthesis). Counted in total but in no daily bucket, so total = sum(daily[].count) + undatedCount."),
});

// Generic per-signal ACTUAL series (Opens / Clicks / goal outcome) — same shape + coherence
// guarantee as recipientsContacted, built from the SAME leads[] (features-service#377). Reuses the
// daily-point schema. total === sum(daily[].count) + undatedCount === count(leads with the signal).
const signalSeriesSchema = z.object({
  total: z.number().int().describe("Total leads in scope carrying the signal — the stat-card count. Equals sum(daily[].count) + undatedCount."),
  daily: z.array(recipientsContactedDailySchema).describe("Per-day buckets (the ACTUAL series the daily graph renders), keyed by the UTC day of each lead's signal date, ascending. One entry per day with ≥1 dated lead; the dashboard slices its window from it. Sums to total - undatedCount. No wall-clock dependence."),
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
  signupsCount: z.number().int().optional().describe("REAL attributed signups (lead-service conversion tracker, deduped, excludes 'ping') for the brand — the Signups tile. 0 when none. ABSENT (undefined) on a cold / pre-rollout payload when lead-service didn't serve the counts; never a fabricated 0. (features-service#455)"),
  salesMeetingsCount: z.number().int().optional().describe("REAL attributed sales meetings booked (lead-service conversion tracker) for the brand — the Sales Meetings tile. 0 when none. ABSENT on a cold / pre-rollout payload; never a fabricated 0."),
  cpsCents: z.number().nullable().optional().describe("REAL cost per signup = totalSpentCents (COMMITTED = actual + provisioned, the SAME denominator as totalCpcCents) / signupsCount, USD cents. So cpsCents × signupsCount ≈ committed spend by construction. null when signupsCount is 0 (no denominator — never a false $0). ABSENT when signupsCount is absent. REPLACES the projected cps dropped in features-service#406 with the REAL tracked computation — no projection."),
  cpsmCents: z.number().nullable().optional().describe("REAL cost per sales meeting = totalSpentCents (COMMITTED) / salesMeetingsCount, USD cents. null when salesMeetingsCount is 0. ABSENT when salesMeetingsCount is absent. Real tracked data, not a projection."),
});

const featureRevenueResponseSchema = z.object({
  featureSlug: z.string(),
  spend: spendSchema.nullable().describe("Canonical spend block for the Overview card — Total spent / Budget spent today / CPC each in three variants (total=committed, actual=billed, provisioned=holds; total = actual + provisioned), plus top sources. Present on the OVERVIEW response; null on the lensed (?lens=) response (lens pages use costPerConversionUsd); absent on grouped (?groupBy=campaignId) groups. (features-service#396, committed naming features-service#402)"),
  recipientsContacted: recipientsContactedSchema.describe("Server-computed contacted aggregates for the Overview Outreach card + daily graph, from the SAME leads[] snapshot (single source, dashboard renders only — features-service#371/#372)."),
  recipientsOpened: signalSeriesSchema.describe("Opens ACTUAL series for the Overview daily graph, server-computed from the SAME leads[] snapshot — coherent with recipientsContacted + the table (features-service#377). Replaces the pipeline-activity/instantly event-day source."),
  recipientsClicked: signalSeriesSchema.describe("Clicks ACTUAL series (website visits), server-computed from the SAME leads[] snapshot. ALSO the signup-goal's observed outcome — a downstream account signup is not tracked here, so the visit is the coherent signup-funnel actual; the dashboard scales it by visitToSignupPct for the projected signups line (forecast). features-service#377."),
  recipientsRepliesPositive: signalSeriesSchema.describe("Positive-replies ACTUAL series (email-gateway firstRepliedAt), server-computed from the SAME leads[] snapshot — coherent with the other actual series + the table. The booked-meetings lens's engagement signal (P=replyToMeeting) the meeting-goal Outcome line renders; distinct from meetingsBooked (the reply is the signal, the booked meeting its downstream outcome). features-service#390."),
  meetingsBooked: signalSeriesSchema.describe("Meeting-goal outcome ACTUAL series (instantly manual-qualification meetingBookedAt), server-computed from the SAME leads[] snapshot. features-service#377."),
  purchased: signalSeriesSchema.describe("Purchase-goal outcome ACTUAL series (instantly manual-qualification closedAt), server-computed from the SAME leads[] snapshot. features-service#377."),
  sequences: signalSeriesSchema.nullable().describe("OUTREACH ACTIVITY daily series for the Overview graph — instantly campaigns-created per day (email-gateway groupBy=day), NOT the lead snapshot. Answers 'how much outreach happened each day' (re-contacts count each day, matches 'budget spent today'), whereas recipientsContacted answers 'how many DISTINCT leads have I reached' (deduped by first-ever contact). The two grains DIFFER by design and are NOT reconciled: the Outreach card renders recipientsContacted.total (unique leads); the graph's Outreach ACTUAL bars render sequences.daily (per-day actions). undatedCount is always 0. Present on the OVERVIEW response only (same gate as spend); null on the lensed (?lens=) response and absent on grouped (?groupBy=campaignId) groups. Fail-soft: null when the email-gateway read fails. features-service#415."),
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
      lens: z.enum(["signups", "booked-meetings", "sales", "website_visits", "positive_replies"]).optional().describe("Outcome lens (overview only). Filters leads[] to the lens's engagement signal and adds conversionProbabilityPct per lead: signups=website click (P=visitToSignup), booked-meetings=positive reply (P=replyToMeeting), sales=click and/or positive reply (combined-OR paid-close), website_visits=website click SINGLE STEP (P=visitToPaidClient), positive_replies=positive reply SINGLE STEP (P=replyToPaidClient). headline.totalPipelineUsd = sum of the lensed leads' expectedRevenueUsd. Omitted → response unchanged."),
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

// 3-grain projection ladder (crossOrg → brand → audience) + a resolved pick, keyed per
// (audienceId?, workflowDynasty). Replaces the flat per-workflow row + the deleted /candidates endpoint.

const grainBlockSchema = z.object({
  evidence: z.object({
    spentUsd: z.number().describe("Spend attributed to this grain (USD). Always > 0 (a spent-0 grain is omitted from estimatesByGrain)."),
    observedContacted: z.number(),
    observedClicks: z.number(),
    observedPositiveReplies: z.number(),
  }),
  unitCosts: z.object({
    costPerClickUsd: z.number().describe("spentUsd / max(observedClicks, 1). Never null: when observedClicks = 0 the value floors to spentUsd."),
    costPerPositiveReplyUsd: z.number().describe("spentUsd / max(observedPositiveReplies, 1). Never null (floors to spentUsd at 0 replies)."),
    costPerContactedUsd: z.number().describe("spentUsd / max(observedContacted, 1). Never null (floors to spentUsd at 0 contacted)."),
  }),
  projected: z.object({
    costPerSignupUsd: z.number().nullable(),
    costPerPaidClientUsd: z.number().nullable().describe("Cost per paying client for the queried goal (single-step rate for website_visits/positive_replies, visit→form→paid for form_submissions, else the multi-step purchase funnel)."),
    costPerMeetingBookedUsd: z.number().nullable(),
    roiMultiple: z.number().nullable().describe("LTR / costPerPaidClientUsd (= 100 / cacPct). Null when economics are absent or the paid-client cost is null/0."),
    cacPct: z.number().nullable().describe("100 / roiMultiple. Null when economics are absent or the paid-client cost is null/0."),
  }).describe("All fields null ONLY when economics is null (cold start) — the floor rule makes unit costs > 0, so a zero denominator never nulls projected."),
});

const resolvedBlockSchema = z.object({
  grain: z.enum(["audience", "brand", "crossOrg"]).describe("Finest grain present with spentUsd > 0 (precedence audience > brand > crossOrg). Never null-grain: crossOrg always has spend."),
  costPerClickUsd: z.number().describe("The resolved grain's costPerClickUsd (never 0)."),
  costPerOutcomeUsd: z.number().nullable().describe("The GOAL metric at the resolved grain (cost per signup/meeting/paid-client per goal) — campaign-service ranks on THIS. Null only at cold start (no economics)."),
  costPerPaidClientUsd: z.number().nullable(),
  costPerMeetingBookedUsd: z.number().nullable(),
  roiMultiple: z.number().nullable(),
  cacPct: z.number().nullable(),
});

const workflowProjectionRowSchema = z.object({
  audienceId: z.string().nullable().describe("null = brand-level row (crossOrg + brand grains). Non-null = one row per (active audience × workflow dynasty) couple that ran (adds the audience grain)."),
  workflow: z.object({ workflowDynastySlug: z.string(), workflowDynastyName: z.string().nullable() }),
  estimatesByGrain: z.object({
    crossOrg: grainBlockSchema.optional().describe("Fleet-wide unit costs (same source as /public/stats/best). Present for any dynasty with real fleet spend."),
    brand: grainBlockSchema.optional().describe("The same path scoped to this brandId. Omitted when the brand spent 0 on the workflow."),
    audience: grainBlockSchema.optional().describe("Audience-attributed evidence (audience-WIDE, same across the audience's workflow rows — the fleet does not tag outcomes per audience×workflow). Present only on audienceId != null rows with audience spend > 0."),
  }).describe("A grain block is included ONLY when that grain has spentUsd > 0."),
  resolved: resolvedBlockSchema,
});

const workflowProjectionEconomicsSchema = z.object({
  lifetimeRevenueUsd: z.number(),
  visitToSignupPct: z.number(),
  visitToMeetingPct: z.number(),
  meetingToClosePct: z.number(),
  visitToClosePct: z.number(),
  replyToMeetingPct: z.number(),
  visitToPaidClientPct: z.number().optional().describe("Single-step visit→paid rate — present when the queried goal is website_visits."),
  replyToPaidClientPct: z.number().optional().describe("Single-step reply→paid rate — present when the queried goal is positive_replies."),
  visitToFormSubmissionPct: z.number().optional().describe("Two-step visit→form rate — present when the queried goal is form_submissions."),
  formSubmissionToPaidClientPct: z.number().optional().describe("Two-step form→paid rate — present when the queried goal is form_submissions."),
}).describe("The brand's EFFECTIVE economics, shown ONCE (same across grains). Includes the queried goal's resolved single-step / form-submission rates.");

const workflowProjectionResponseSchema = z.object({
  featureSlug: z.string(),
  objective: z.enum(["meeting-booked", "self-serve", "signup", "purchase", "website_visits", "positive_replies", "form_submissions"]).describe("Canonical SNAKE echo of the requested goal (defaults to meeting-booked). Accepts both `goal` (camel) and `objective` (snake/kebab) request params."),
  goal: z.enum(["meetingBooked", "signup", "purchase", "websiteVisit", "positiveReply", "formSubmission"]).describe("Canonical CAMEL echo (= brand-service CurrentGoal). self-serve/signup both echo signup."),
  economics: workflowProjectionEconomicsSchema.nullable().describe("Null only at cold start (no effective economics) — rows still emit with null projected."),
  rows: z.array(workflowProjectionRowSchema),
  recommendedWorkflowDynastySlug: z.string().nullable().describe("Dynasty of the row with the lowest resolved.costPerOutcomeUsd. Null when none has usable data."),
  recommendedBudgetUsd: z.number().nullable().describe("10 target outcomes/month × the recommended row's resolved.costPerOutcomeUsd. Null when there is no pick."),
});

registry.register("WorkflowProjectionResponse", workflowProjectionResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/workflow-projection",
  summary: "3-grain cost-per-outcome projection ladder per (audience?, workflow dynasty)",
  description:
    "Serves a 3-grain projection ladder (crossOrg → brand → audience) + a resolved pick, keyed per (audienceId?, workflowDynasty). " +
    "crossOrg = fleet-wide per-workflow unit costs (same source as /public/stats/best); brand = the same path scoped to this brandId; audience = audience-attributed evidence for each active human-service audience that ran the workflow (audience-WIDE — the fleet does not tag outcomes per audience×workflow). " +
    "Each grain carries its own evidence, floor-ruled unit costs (costPerXUsd = spentUsd / max(observedX,1), never null), and projected cost-per-outcome from the brand's EFFECTIVE economics. A grain is included only when it has spentUsd > 0. resolved = the finest grain present (precedence audience > brand > crossOrg); campaign-service ranks on resolved.costPerOutcomeUsd. " +
    "recommendedWorkflowDynastySlug = argmin over rows of resolved.costPerOutcomeUsd; recommendedBudgetUsd = 10 × that cost. Folds in the audience×workflow grain formerly served by the removed /candidates endpoint.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — conversion economics are brand-scoped."),
      audienceId: z.string().optional().describe("Optional audience UUID context (echoed via audience rows). Audience rows always enumerate ALL of the brand's active audiences that ran the workflow."),
      goal: z.string().optional().describe("Optimization goal. Accepts camel (websiteVisit/positiveReply/formSubmission/meetingBooked/signup/purchase), snake (website_visits/positive_replies/form_submissions), and kebab. Also accepted via `objective`. Defaults to meeting-booked."),
      objective: z.string().optional().describe("Alias of `goal` (snake/kebab spelling). Either param is accepted."),
      budgetUsd: z.string().optional().describe("Optional budget context (accepted for back-compat; the grain ladder + recommendedBudgetUsd carry the projection surface)."),
    }),
  },
  responses: {
    200: { description: "Workflow projection ladder", content: { "application/json": { schema: workflowProjectionResponseSchema } } },
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
  goal: z.enum(["signup", "meetingBooked", "purchase", "websiteVisit", "positiveReply"]),
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
      goal: z.enum(["signup", "meetingBooked", "purchase", "websiteVisit", "positiveReply"]).describe("Active optimization goal (required). signup + websiteVisit sort by CPC; meetingBooked / purchase / positiveReply sort by CPPR. snake_case single-step spellings (website_visits / positive_replies) are also accepted."),
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

// ── GET /internal/stats/send-forecast ──────────────────────────────────────────

const sendForecastDaySchema = z.object({
  date: z.string().describe("UTC calendar day (YYYY-MM-DD)."),
  isToday: z.boolean(),
  actualSent: z.number().nullable().describe("Past real emails sent that day (email-grain, follow-ups included). null on future days."),
  inFlightSent: z.number().nullable().describe("Already-scheduled follow-up sends for sequences launched before today. null on past days."),
  forecastNew: z.number().nullable().describe("Projected emails from NEW (today-onward) budget-driven sequences, D0/D3/D10 model. null on past days."),
  total: z.number().nullable().describe("Predictive total — past: actualSent; today/future: sum of present components."),
});

const sendForecastResponseSchema = z.object({
  days: z.array(sendForecastDaySchema),
  summary: z.object({
    totalDailyBudgetUsd: z.number().describe("Sum of daily budget over active brands (USD)."),
    remainingTodayUsd: z.number().describe("Sum of remaining budget today over active brands (USD)."),
    followupModel: z.string().describe("The send cadence model, e.g. 'D0/D3/D10'."),
    activeBrandCount: z.number(),
    totalNewSequencesPerDay: z.number().describe("Fleet new sequences/day at full budget (sum over brands of budget/outreachUsd)."),
  }),
});

const sendForecastResponseRef = registry.register("SendForecastResponse", sendForecastResponseSchema);

registry.registerPath({
  method: "get",
  path: "/internal/stats/send-forecast",
  summary: "Global fleet email send forecast per day (internal, api-key; staff-gated at api-service)",
  description:
    "Cross-org, fleet-wide projection of how many outreach emails will be SENT per calendar day over a past+future window. " +
    "Stacks three EMAIL-grain series: actualSent (past real email_sent events, follow-ups included, from email-gateway groupBy=day), " +
    "inFlightSent (already-scheduled follow-up sends for sequences launched before today, from the instantly sending-forecast relayed via email-gateway), " +
    "and forecastNew (new sequences the active brands' daily budgets launch from today onward, each emitting on the D0/D3/D10 cadence). " +
    "forecastNew covers cohorts started today-or-later; inFlightSent covers pre-today cohorts' follow-ups, so they never overlap. " +
    "Today's new-sequence cohort is scaled to the remaining daily budget. Values are null (not 0) when an input is absent.",
  tags: ["Internal"],
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(90).optional().describe("Future horizon in days (default 14, max 90). A 7-day past tail is always included."),
    }),
  },
  responses: {
    200: { description: "Per-day fleet send forecast + summary", content: { "application/json": { schema: sendForecastResponseRef } } },
    401: { description: "Invalid or missing API key", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Server error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /internal/stats/accounts ──────────────────────────────────────────────

const accountRowSchema = z.object({
  orgId: z.string().describe("Internal org UUID."),
  orgExternalId: z.string().nullable().describe("Clerk org id (org_...); lets the admin resolve the org display name. Null if unset."),
  ownerEmail: z.string().nullable().describe("The org owner's email (earliest-created user). Null if the org has no users."),
  brandId: z.string().describe("Brand UUID."),
  brandName: z.string().nullable(),
  brandDomain: z.string().nullable(),
  dailyBudgetUsd: z.number().nullable().describe("Brand's configured daily spend ceiling in USD. Null when unset/paused."),
  orgBalanceUsd: z.number().describe("Org spendable credit balance in USD (billing balance_cents/100; 0 if no funded wallet)."),
  status: z.enum(["active", "paused", "inactive"]).describe("Precedence paused > active > inactive: 'paused' iff campaign-service brand pause=true; else 'active' iff dailyBudgetUsd>0 && orgBalanceUsd>dailyBudgetUsd; else 'inactive'."),
});

const accountsStatsSchema = z.object({
  totalDailyBudgetUsd: z.number().describe("Sum of daily budget over ACTIVE rows only (USD; paused/inactive excluded)."),
  mrrUsd: z.number().describe("totalDailyBudgetUsd × 30."),
  arrUsd: z.number().describe("totalDailyBudgetUsd × 365."),
  activeCount: z.number().int(),
  pausedCount: z.number().int(),
  inactiveCount: z.number().int(),
  totalCount: z.number().int(),
});

const accountsResponseSchema = z.object({
  rows: z.array(accountRowSchema),
  stats: accountsStatsSchema,
  asOf: z.string().describe("ISO timestamp the audit was computed."),
});

const accountsResponseRef = registry.register("AccountsAuditResponse", accountsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/internal/stats/accounts",
  summary: "Fleet-wide cold-email customer accounts audit (internal, api-key; staff-gated at api-service)",
  description:
    "Cross-org, fleet-wide list of every cold-email customer account (org × brand) with its daily budget, the org's spendable credit balance, " +
    "and a 3-way status, plus fleet financial stats (total ACTIVE daily budget → MRR = ×30 → ARR = ×365). " +
    "Status precedence paused > active > inactive: 'paused' iff the campaign-service brand pause is set (campaigns HELD, budget kept); " +
    "else 'active' iff dailyBudgetUsd > 0 && orgBalanceUsd > dailyBudgetUsd; else 'inactive'. All rows (active + paused + inactive) are LISTED, never dropped. " +
    "Stats sum ACTIVE rows only (a paused brand is not spending). All money + the status determination are computed here; the dashboard renders only.",
  tags: ["Internal"],
  responses: {
    200: { description: "Per-account rows + fleet financial stats", content: { "application/json": { schema: accountsResponseRef } } },
    401: { description: "Invalid or missing API key", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Server error", content: { "application/json": { schema: errorResponse } } },
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
