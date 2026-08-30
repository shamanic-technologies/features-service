import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { featureResponseSchema } from "./schemas.js";
import { SALES_FUNNEL_KEYS } from "./sales-funnels.js";

const registry = new OpenAPIRegistry();

const errorResponse = z.object({ error: z.string() });

registry.register("Feature", featureResponseSchema);

// ── Stats response schemas ───────────────────────────────────────────────

const systemStatsSchema = z.object({
  totalCostInUsdCents: z.number().describe("COMMITTED run cost (USD cents) — billed `actual` PLUS the open `provisioned` holds. The canonical 'Total spent' and the numerator behind every cost-per-X stat on this response, so cost-per metrics reconcile with the displayed spend AND with /revenue's ROI. features-service serves EXACTLY ONE spend basis and it is COMMITTED (billed `actual` + the open `provisioned` holds). A split basis was a bug, not a tradeoff: while ROI rode billed-only and the `spend` block rode committed, one payload answered 'how much did this cost' two ways at once and a brand with a single campaign read $202 on its Overview beside $191 on its campaigns table. Do NOT reintroduce a second basis and do NOT add a parameter to pick one. (features-service#779)"),
  actualCostInUsdCents: z.number().describe("Billed-only run spend (USD cents) — excludes provisioned holds + cancelled reservations. REPORTED ONLY; no cost-per-X stat divides by it. (features-service#396, single basis features-service#779)"),
  completedRuns: z.number(),
  activeCampaigns: z.number(),
  firstRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});

/**
 * The identity a campaign's figures were totalled over: (org, brand, sales funnel, acquisition
 * channel) — campaign-service's own key, read from it, never re-derived here.
 *
 * A campaign changes workflow over time and campaign-service used to create a NEW campaign row each
 * time it did, so one real campaign arrives split across many rows (one brand: ~130). Every figure
 * keyed on a campaign is therefore reported for the whole family, and each member id resolves to the
 * same, complete campaign. `representativeId` is the LIVE campaign when there is one, so a consumer
 * renders exactly ONE line per identity while the stopped ancestors it folds in stay listed in
 * `campaignIds`. `funnelKey` is null when the campaign states no sales funnel — a real state, and
 * never inferred from its goal (two funnels answer to one goal).
 */
const campaignIdentitySchema = z.object({
  key: z.string().describe("Stable identity key. Opaque — compare it, do not parse it."),
  funnelKey: z.string().nullable().describe("The sales funnel the campaign states, or null when it states none."),
  acquisitionChannel: z.string().nullable().describe("The channel it acquires through, e.g. cold_email."),
  campaignIds: z.array(z.string()).describe("Every campaign id answering to this identity, this one included."),
  liveCampaignIds: z.array(z.string()).describe("The members still ongoing — at most one."),
  representativeId: z.string().describe("The member to render the identity's line on: the live campaign when there is one, else the most recently created member."),
});

const statsGroupSchema = z.object({
  workflowSlug: z.string().nullable().optional(),
  workflowDynastySlug: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  campaignIdentity: campaignIdentitySchema.optional().describe("Present only on groupBy=campaignId: the identity these figures were totalled over. Every member of one identity carries the SAME figures — they are one campaign."),
  featureSlug: z.string().nullable().optional(),
  systemStats: systemStatsSchema,
  stats: z.record(z.string(), z.number().nullable()),
});

const featureStatsResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
  featureSlug: z.string(),
  groupBy: z.string().optional(),
  systemStats: systemStatsSchema,
  groups: z.array(statsGroupSchema).optional(),
  stats: z.record(z.string(), z.number().nullable()).optional(),
});

const globalStatsResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
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
      offerId: z.string().optional().describe("Optional OFFER scope — the grain between the brand and its campaigns (Org > Brand > Offer > Campaign). Resolves to the campaigns selling the offer and totals every stat over exactly those, using the same group-by-campaign fold a multi-row campaign identity already uses; no producer carries an offer dimension, so this is a scope, never a downstream filter. Requires brandId (an offer belongs to a brand). Mutually exclusive with campaignId and with groupBy — all three are 400s. Omitted → byte-identical to today. An offer no campaign of this brand sells is a 404 with reason 'offer_has_no_campaigns'."),
      workflowSlug: z.string().optional(),
      workflowDynastySlug: z.string().optional(),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric in the response (cost, costPer*Cents). Omit or 'gross' → real undiscounted numbers (DEFAULT — byte-identical to today). 'net' → the org's discounted figures, sourced from runs-service's FROZEN net cost amounts (the discount is frozen at cost-declaration time; features-service does NOT recompute it); fail-loud (502) if the frozen net figures are unavailable — never a silent fallback to gross. A non-discounted org's frozen net equals gross, so net == gross for it. Non-money fields (counts, rates) are identical either way."),
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
  bounced: z.boolean().describe("True when this lead's email BOUNCED. It rides the row beside `contacted` rather than erasing it — the lead IS reached (a bounce is the proof a send happened) and is simply out of the funnel, so it appears here at expectedRevenueUsd 0. Counted in outcomes.recipientsBounced and excluded from outcomes.recipientsConvertible."),
  unsubscribed: z.boolean().describe("True when this lead UNSUBSCRIBED. Same rules as bounced: reached, out of the funnel, worth 0. A row a customer opens has to say the same thing as the counts above it, which is why the reason is stated rather than left as a contacted lead that mysteriously never progressed."),
  opened: z.boolean().describe("True when the lead opened (email-gateway). The signal the Opens daily-graph actual buckets, server-computed from this same leads[] snapshot (features-service#377)."),
  openedAt: z.string().nullable().describe("ISO timestamp of first open (email-gateway firstOpenedAt). Null when not opened, or opened with no known date. No synthesis."),
  clicked: z.boolean().describe("True when the lead clicked / visited the website (email-gateway). The signal the Clicks daily-graph actual buckets; ALSO the signup-goal's observed outcome (a downstream account signup is not tracked here) — features-service#377."),
  clickedAt: z.string().nullable().describe("ISO timestamp of first click (email-gateway firstClickedAt). Null when not clicked, or clicked with no known date. No synthesis."),
  repliedPositive: z.boolean().describe("True when the lead sent a positive reply (replied && replyClassification \"positive\" — the SAME classification the booked-meetings lens P=replyToMeeting + audience-stats positiveReplies use). The signal the positive-replies daily-graph actual buckets; the meeting-goal engagement Outcome, distinct from meetingBooked (the booked meeting is its downstream outcome). features-service#390."),
  repliedPositiveAt: z.string().nullable().describe("ISO timestamp of the first reply, surfaced ONLY when the reply is positive-classified (matches repliedPositive; date = email-gateway firstRepliedAt). Null when there is no positive reply — INCLUDING a negative/neutral-only replier (whose firstRepliedAt is deliberately NOT surfaced) — or positive with no known date. No synthesis."),
  meetingBooked: z.boolean().describe("True when a human stated the meeting was BOOKED (lead-service step statements). The meeting-goal outcome the goal daily-graph actual buckets."),
  meetingAttended: z.boolean().describe("True when a human stated the meeting was ATTENDED — the rung ABOVE booked, and the one the lead's expected revenue is priced on once reached (booked is priced through the show-up rate, attended is not). Statable by hand only: attendance happens off the client's website, so no page-load tag can observe it."),
  meetingAttendedAt: z.string().nullable().describe("ISO timestamp the meeting was attended, as stated. Null when not attended, or attended with no known date. No synthesis."),
  meetingBookedAt: z.string().nullable().describe("ISO timestamp the meeting was booked, as stated (the date the outcome HAPPENED, not when we heard about it). Null when no meeting, or no known date. No synthesis."),
  purchased: z.boolean().describe("True when the lead became a paying client / closed. Realized revenue: when the statement named an amount, THAT amount is what the lead is worth, not the brand's average lifetime revenue."),
  purchasedAt: z.string().nullable().describe("ISO timestamp of the close (instantly manual-qualification closedAt). Null when not closed, or no known date. No synthesis."),
  signup: z.boolean().describe("True when the lead reached the SIGNUP conversion — lead-service conversion tracker matched a website signup back to this lead by email (REAL producer-side attribution, the SAME matched-email join audience-stats uses). Distinct from `clicked` (the website-visit signup PROXY the funnel EV math anchors to). features-service#476."),
  signupAt: z.string().nullable().describe("ISO timestamp the signup was recorded. ALWAYS null today: lead-service exposes the matched lead (email) but NOT the conversion timestamp on any endpoint (the column exists internally — dedupe buckets by calendar-day — but is unexposed). Auto-populates when lead-service surfaces the date; no synthesis (borrowing the outreach date would be the wrong signal). features-service#476."),
  formSubmission: z.boolean().describe("True when the lead reached the FORM-SUBMISSION conversion (lead-service conversion tracker, event=form_submission — same matched-email producer attribution as `signup`). The visit-driven sibling of signup. features-service#476."),
  formSubmissionAt: z.string().nullable().describe("ISO timestamp of the form submission. ALWAYS null today (same lead-service date gap as signupAt: matched lead exposed, conversion timestamp not). Auto-populates when lead-service surfaces the date; no synthesis. features-service#476."),
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
  committedCostUsd: z.number().describe("COMMITTED run spend for the brand (+ optional campaign), feature-scoped, in dollars (>= 0) — billed `actual` PLUS the open `provisioned` holds. THE spend basis: every money figure below divides by it, and it is byte the same total the `spend` block reports as totalSpentCents, so the ROI a campaign row shows and the 'Total spent' the Overview shows can never describe different money. This is the field a consumer renders as '$ Invested'. features-service serves EXACTLY ONE spend basis and it is COMMITTED (billed `actual` + the open `provisioned` holds). A split basis was a bug, not a tradeoff: while ROI rode billed-only and the `spend` block rode committed, one payload answered 'how much did this cost' two ways at once and a brand with a single campaign read $202 on its Overview beside $191 on its campaigns table. Do NOT reintroduce a second basis and do NOT add a parameter to pick one. (features-service#779)"),
  actualCostUsd: z.number().describe("Billed-only run spend for the same scope, in dollars (>= 0) — EXCLUDES the open provisioned holds. TRANSITIONAL AND REPORTED ONLY: it is kept populated (and still honestly billed-only, because a field whose name asserts 'actual' must never start carrying a committed value) so a consumer rendering money off this field has a gap-free path onto committedCostUsd. NOTHING divides by it any more — ROI, %CAC, cost per acquisition and cost per conversion all ride committedCostUsd. (features-service#396, naming features-service#402, single basis features-service#779)"),
  costOfAcquisitionPct: z.number().nullable().describe("(committedCostUsd / totalPipelineUsd) * 100. Null when totalPipelineUsd is null or 0."),
  roiMultiple: z.number().nullable().describe("totalPipelineUsd / committedCostUsd. Null when committedCostUsd is 0 or totalPipelineUsd is null."),
  costPerAcquisitionUsd: z.number().nullable().describe("Cost of winning ONE customer, on COMMITTED spend, for the scope this body describes — present on EVERY response including the default un-lensed brand read (the brand Overview is not lensed; it is the whole brand, every funnel). = committedCostUsd / expected paying clients, where expected paying clients = totalPipelineUsd / lifetimeRevenueUsd. Equivalently (costOfAcquisitionPct / 100) x lifetimeRevenueUsd, i.e. lifetimeRevenueUsd / roiMultiple — the same statement as ROI and %CAC in a third unit, which is why it MATCHES the lensed costPerConversionUsd for the same scope rather than being a second opinion (the lens divides the same committed spend by the same expected-client count). Uses the brand\'s own declared-funnel-priced economics — the same economics that produced totalPipelineUsd. NULL, never 0, when the brand states no lifetime revenue (or it is 0), when the pipeline is null/0, or when no funnel is wired: null means \'we could not measure this\', a 0 would mean \'a customer costs nothing\'."),
  expectedConversions: z.number().optional().describe("LENS ONLY — expected conversion count = sum of per-lead conversion probability (decimal) across the lensed leads (totalPipelineUsd = expectedConversions × LTR). Present only on a lensed (?lens=) response; absent on the default/grouped responses."),
  costPerConversionUsd: z.number().nullable().optional().describe("LENS ONLY — committedCostUsd / expectedConversions. Null when expectedConversions is 0. Present only on a lensed (?lens=) response; absent on the default/grouped responses."),
});

const roiHistoryPointSchema = z.object({
  date: z.string().describe("UTC calendar day (YYYY-MM-DD) this point describes."),
  cumulativeSpendUsd: z.number().describe("COMMITTED — every dollar of committed spend (billed + open holds) from the brand's first spend up to and including this day, the SAME basis costEconomics.committedCostUsd rides, so the curve's last point reconciles with the headline ROI rather than charting a different currency. Dated by runs-service's own cost buckets (each run's started_at); nothing is spread, smoothed or amortised."),
  cumulativePipelineUsd: z.number().describe("REALIZED — every dollar of expected pipeline earned by a DATED outcome up to and including this day, from the same per-lead event timestamps the leads[] table and the daily signal series use. A day with spend but no new outcome carries the previous day's value forward, so the curve correctly dips."),
  roiMultiple: z.number().nullable().describe("cumulativePipelineUsd / cumulativeSpendUsd. NULL — never 0 — on a day whose cumulative spend is still 0 (a dated outcome before a dollar was ever spent divides by nothing): null means 'could not be measured', 0 would mean 'returned nothing'."),
});

const roiHistorySchema = z.object({
  daily: z.array(roiHistoryPointSchema).describe("One point per UTC day that has spend or a dated outcome, ascending, spanning the brand's whole life. Days with neither are absent (never fabricated). Empty when the brand has neither spend nor a dated outcome."),
  datedPipelineUsd: z.number().describe("The curve's final cumulative pipeline — the part of headline.totalPipelineUsd this curve can describe."),
  undatedPipelineUsd: z.number().describe("Pipeline counted in headline.totalPipelineUsd whose outcome carries NO timestamp, so it sits on no day. Reported rather than dropped or parked on a fabricated day: datedPipelineUsd + undatedPipelineUsd === headline.totalPipelineUsd."),
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
  actualSpentCents: z.number().int().describe("Billed-only spend (USD cents), == Σ sources[].actualSpentCents. Same source as systemStats.actualCostInUsdCents / costEconomics.actualCostUsd. REPORTED ONLY — ROI/CAC and every cost-per-outcome column ride the COMMITTED totalSpentCents beside it."),
  provisionedSpentCents: z.number().int().describe("Open PROVISIONED holds only (USD cents) = totalSpentCents − actualSpentCents, == Σ sources[].provisionedSpentCents. Money reserved for scheduled follow-up sends, not yet billed."),
  totalSpentTodayCents: z.number().int().describe("COMMITTED spend (actual + provisioned, USD cents) for runs started since 00:00 UTC today — 'Budget spent today'."),
  actualSpentTodayCents: z.number().int().describe("ACTUAL (billed) spend (USD cents) for runs started since 00:00 UTC today."),
  provisionedSpentTodayCents: z.number().int().describe("Open PROVISIONED holds (USD cents) = totalSpentTodayCents − actualSpentTodayCents, for runs started since 00:00 UTC today."),
  sources: z.array(spendSourceSchema).describe("Per cost-name committed/actual/provisioned spend + committed share-of-total, descending — the 'top cost sources' list pre-computed (the dashboard renders verbatim instead of summing the runs breakdown in the browser)."),
  totalCpcCents: z.number().nullable().describe("COMMITTED cost per website click = totalSpentCents / clicks (clicked.total). Null (renders '-'), never a false $0.00, when there are 0 clicks OR 0 committed spend."),
  actualCpcCents: z.number().nullable().describe("ACTUAL (billed) cost per website click = actualSpentCents / clicks. Null (renders '-'), never a false $0.00, when 0 clicks OR 0 actual spend."),
  provisionedCpcCents: z.number().nullable().describe("PROVISIONED cost per website click = provisionedSpentCents / clicks. Null (renders '-'), never a false $0.00, when 0 clicks OR 0 provisioned holds."),
  signupsCount: z.number().int().optional().describe("REAL attributed signups (lead-service conversion tracker, deduped, excludes 'ping') for the brand — the Signups tile. 0 when none. ABSENT (undefined) on a cold / pre-rollout payload when lead-service didn't serve the counts; never a fabricated 0. (features-service#461)"),
  salesMeetingsCount: z.number().int().optional().describe("REAL attributed sales meetings booked (lead-service conversion tracker) for the brand — the Sales Meetings tile. 0 when none. ABSENT on a cold / pre-rollout payload; never a fabricated 0."),
  formSubmissionsCount: z.number().int().optional().describe("REAL attributed form submissions (lead-service conversion tracker, event=form_submission, deduped, excludes 'ping') for the brand — the Form Submissions tile for a form_submissions brand (the visit-driven sibling of signups). 0 when none. ABSENT on a cold / pre-rollout payload when lead-service didn't serve the counts; never a fabricated 0."),
  cpsCents: z.number().nullable().optional().describe("REAL cost per signup = totalSpentCents (COMMITTED = actual + provisioned, the SAME denominator as totalCpcCents) / signupsCount, USD cents. So cpsCents × signupsCount ≈ committed spend by construction. null when signupsCount is 0 (no denominator — never a false $0). ABSENT when signupsCount is absent. REPLACES the projected cps dropped in features-service#406 with the REAL tracked computation — no projection."),
  cpsmCents: z.number().nullable().optional().describe("REAL cost per sales meeting = totalSpentCents (COMMITTED) / salesMeetingsCount, USD cents. null when salesMeetingsCount is 0. ABSENT when salesMeetingsCount is absent. Real tracked data, not a projection."),
  cpfsCents: z.number().nullable().optional().describe("REAL cost per form submission = totalSpentCents (COMMITTED, SAME denominator as cpsCents/totalCpcCents) / formSubmissionsCount, USD cents. So cpfsCents × formSubmissionsCount ≈ committed spend by construction. null when formSubmissionsCount is 0 (no denominator — never a false $0). ABSENT when formSubmissionsCount is absent. Real tracked data, not a projection."),
  salesCount: z.number().int().optional().describe("REAL attributed SALES — paying clients won (lead-service conversion tracker, event=sale, RENAMED from event=purchase, deduped, excludes 'ping') for the brand — the Sales tile's brand-level aggregate, the terminal outcome of BOTH the website-purchase goal (multi-step close) and the combined-sales goal (paying client won via either path). Equivalent to signupsCount / salesMeetingsCount / formSubmissionsCount. 0 when none; ABSENT on a cold / pre-rollout payload when lead-service didn't serve the counts; never a fabricated 0. (Renamed from purchasesCount — features-service combined-sales slice.)"),
  cpSaleCents: z.number().nullable().optional().describe("REAL cost per sale = totalSpentCents (COMMITTED, SAME denominator as cpsCents/totalCpcCents) / salesCount, USD cents. So cpSaleCents × salesCount ≈ committed spend by construction. null when salesCount is 0 (no denominator — never a false $0). ABSENT when salesCount is absent. Real tracked data, not a projection. (Renamed from cppCents — features-service combined-sales slice.)"),
  positiveRepliesCount: z.number().int().describe("REAL attributed positive replies for the brand — the single-step positive_replies goal's outcome (reply-goal sibling of signups/meetings/form-submissions), the Positive Replies tile. Deduped by lead from the SAME leads[] snapshot as recipientsRepliesPositive.total (a positive reply is an email engagement signal, NOT a lead-service conversion event), so ALWAYS present (leads are a fail-loud core input) — never absent, unlike the conversion-counts tiles. 0 when none. (features-service#482)"),
  cpprCents: z.number().nullable().describe("REAL cost per positive reply = totalSpentCents (COMMITTED = actual + provisioned, the SAME denominator as totalCpcCents/cpsCents) / positiveRepliesCount, USD cents. So cpprCents × positiveRepliesCount ≈ committed spend by construction. null when positiveRepliesCount is 0 (no denominator — never a false $0). Real tracked data, not a projection. (features-service#482)"),
});

// THE VOLUME HALF of a money answer — how much real outcome evidence the figures beside it rest on.
// Shared verbatim by every grain that answers it (the per-campaign groups, the per-workflow groups and
// the un-grouped brand read), because two grains counting people two ways would eventually disagree.
const revenueOutcomesSchema = z.object({
  recipientsContacted: z.number().describe("REACH — distinct leads this grain emailed for this brand, INCLUDING every one whose email bounced and every one who unsubscribed: we queued it, we sent it, we paid for it, so a bounce is the proof a send happened rather than a reason to forget it. The grain-level twin of the brand read's recipientsContacted.total, deduped by lead exactly as the brand read dedupes. 0 is a MEASURED count: 'this reached nobody' is an answer. This is the figure to read for 'how many unique people did we reach out to'."),
  recipientsConvertible: z.number().describe("THE PIPELINE BASE — of the leads reached, the ones still able to convert: recipientsContacted minus everyone a bounce or an unsubscribe removed from the funnel. Every expected-value figure on this grain (headline.totalPipelineUsd, costEconomics, the leads[] EV column) rests on these people and no others, so this is the figure to read for 'how many are still eligible to convert'. SERVED rather than subtracted in the browser because it is not derivable from the counts beside it: a lead can be both bounced AND unsubscribed, so contacted − bounced − unsubscribed double-subtracts it — only the per-lead set knows the union."),
  recipientsBounced: z.number().describe("Distinct leads whose email BOUNCED. Counted inside recipientsContacted (a bounce implies a send) and excluded from recipientsConvertible (a bounced mailbox can never convert)."),
  recipientsUnsubscribed: z.number().describe("Distinct leads who UNSUBSCRIBED. Counted inside recipientsContacted (we did email them) and excluded from recipientsConvertible (they asked us to stop)."),
  recipientsClicked: z.number().describe("Distinct leads that visited the site off this grain — twin of recipientsClicked.total."),
  recipientsRepliesPositive: z.number().describe("Distinct leads that replied positively — twin of recipientsRepliesPositive.total."),
  committedSpentCents: z.number().describe("COMMITTED spend attributed to this grain, in cents — costEconomics.committedCostUsd in the unit the two rates are denominated in."),
  actualSpentCents: z.number().describe("Billed-only spend for this grain, in cents. TRANSITIONAL — reported for consumer migration, divided by nowhere."),
  cpcCents: z.number().nullable().describe("Realized spend ÷ website visits, in cents. OBSERVED accounting: null when this grain bought no visit or spent nothing — 'we could not measure this', never 0 and never floored to a benchmark (projection lives on /workflow-projection)."),
  cpprCents: z.number().nullable().describe("Realized spend ÷ positive replies, in cents. Same null rule as cpcCents."),
});

// WHICH DOLLARS A FIGURE IS MADE OF. Declared once, here, because it is answered at two grains — per
// RUNG of a funnel and per FUNNEL — and one vocabulary read two ways is how two surfaces come to
// describe the same admission with different words.
const funnelCostCoverageSchema = z.enum([
  "platform_spend_only",
  "platform_and_customer_spend",
  "platform_and_partial_customer_spend",
]);

// WHAT THE CUSTOMER STATES ONE RUNG COST THEM. The platform automates the first link of a funnel and
// CHARGES for it; the customer performs the rest, and every time somebody moves a lead across an arrow
// they are asked what that step cost them. The funnel-wide total cannot answer "what does a booked
// meeting cost me?" — it covers every arrow at once — so the same statements are partitioned per rung.
const funnelStepCustomerCostSchema = z.object({
  costCents: z.number().describe("The sum of every STATED cost on this rung, in cents, for the scope being read. A crossing nobody was ever asked about contributes nothing rather than a fabricated zero."),
  statedCount: z.number().int().describe("How many statements on this rung carried a cost. A stated 0 is an answer and is counted here."),
  unstatedCount: z.number().int().describe("How many did not, because nobody was ever asked. Greater than 0 means this rung cannot be fully costed — which is what turns the coverage below to partial."),
  coverage: funnelCostCoverageSchema.describe("Which dollars this rung's figure is made of. platform_spend_only: no statement is attributable to it — the legs the platform works itself (a website visit, a positive reply) are always this, and so is a rung nobody has been asked about yet. platform_and_customer_spend: every attributable statement carries a cost. platform_and_partial_customer_spend: some crossings were never stated, so the figure is a floor rather than a total."),
  costPerReachCents: z.number().nullable().describe("The stated total ÷ recipientsReached, in cents — what ONE person crossing this rung cost the customer on average, which is the number a customer opening one arrow of their funnel is asking for. SERVED rather than divided in the browser, like every other ratio here. OBSERVED accounting, through the SAME engine costPerReachCents rides: null when nobody stated a cost, when nobody reached the rung, or when the count is unmeasured — never 0, which would say their work was free."),
});

// THE FUNNEL, WALKED STEP BY STEP — one rung at a time, in the funnel's own order: who reached it,
// what reaching it cost, and what share of the rung before it converted. Built from the SAME deduped
// leads and the SAME committed cents as `outcomes` and the money, so a step's count agrees with
// `leads[]` row for row and a rate between two rungs of one funnel is a rate rather than two scopes
// divided into each other. It is what makes a four-step reply-to-meeting funnel renderable at all:
// "Meeting attended" has a per-lead flag and had no count and no cost anywhere else on this response.
const funnelStepSchema = z.object({
  arrowKey: z.string().describe("The ARROW this rung IS — the single canonical identifier of the leg that moves a lead onto this step (the same value /public/channels publishes and /features/{featureSlug}/workflow-projection?arrow= is asked with). Performance is measured per arrow and a campaign is bought per arrow, so this is what joins a rung to the campaign that bought it and to the projection that priced it. The SAME arrow appears on every funnel containing it, which is why a funnel's figures are COMPOSED from its arrows and why two funnels' figures must never be summed."),
  step: z.string().describe("The funnel's own label for this rung, in brand-service's words (e.g. 'Positive reply', 'Meeting booked', 'Meeting attended', 'Paid client')."),
  leadField: z.enum(["clicked", "repliedPositive", "meetingBooked", "meetingAttended", "signup", "formSubmission", "purchased"]).describe("The leads[] boolean this rung counts, so a consumer can reconcile the count against the rows on the same response."),
  recipientsReached: z.number().int().nullable().describe("DISTINCT leads that reached this rung. 0 is MEASURED — 'nobody got here', which is the answer a customer asking 'is this working?' is owed. NULL is 'we could not measure this': the producer behind this rung's signal degraded on this request (the observed-step statements and the website-conversion attribution sets are each fail-soft) or was never read on this path. A null count nulls its cost and both rates that touch it."),
  costPerReachCents: z.number().nullable().describe("COMMITTED spend ÷ recipientsReached, in cents. OBSERVED accounting — null when nobody reached the rung, when nothing was spent, or when the count is unmeasured; never 0 and never floored to a benchmark (projection lives on /workflow-projection). Every rung divides the SAME committed total: the spend bought the whole funnel, not one rung of it."),
  fromStep: z.string().describe("The rung this one converts FROM — the previous step of the funnel, or 'Contacted' for the first (outreach is a step of no funnel but the base of every one)."),
  fromRecipientsReached: z.number().int().nullable().describe("Distinct leads that reached fromStep — the base of the rate below, stated here so a consumer renders '3 of 40' without looking it up. Same null rule as recipientsReached."),
  conversionFromPreviousPct: z.number().nullable().describe("recipientsReached ÷ fromRecipientsReached × 100. Null when either side is unmeasured, or when the base is 0 (no denominator — never a fabricated 0% or 100%). Served rather than divided in the browser: a client-side ratio drifts from this service the moment either side changes."),
  customerCost: funnelStepCustomerCostSchema.nullable().describe("What the CUSTOMER states THIS RUNG cost them — the legs they work themselves (they run the meeting, they close the deal), which the funnel-wide `customerCost` could only answer for the whole chain at once. Never charged, in no ledger of ours, never folded into costPerReachCents — it rides BESIDE it exactly as the funnel-wide figure rides beside costEconomics. NULL only when the statements could not be READ (the read is fail-soft) or were never fetched on this path; a rung nobody has ever been asked about reads zeros with coverage 'platform_spend_only' and a null average, because 'we have no figure' and 'it cost nothing' are different answers."),
});

const funnelStepBreakdownSchema = z.object({
  funnelKey: z.enum(SALES_FUNNEL_KEYS as unknown as [string, ...string[]]).describe("The sales funnel these rungs belong to."),
  name: z.string().describe("The funnel's own name, so a consumer renders the chain without holding the catalogue."),
  committedSpentCents: z.number().describe("COMMITTED cents behind every costPerReachCents — the one basis costEconomics rides."),
  contactedRecipients: z.number().int().describe("REACH — DISTINCT leads this scope emailed, bounced and unsubscribed INCLUDED. It is the base the FIRST rung converts from (its fromRecipientsReached, under the label 'Contacted'), and the reason that rung's rate is answerable at all. Always measured wherever the leads were read. The first rung converts from REACH and not from the smaller convertible base on purpose: a bounce is a real loss at the very first rung and it was paid for, so a rate that quietly divided by the survivors would hide the people this campaign bought and never reached. Byte-equal to outcomes.recipientsContacted for the same scope."),
  convertibleRecipients: z.number().int().describe("THE PIPELINE BASE — of those reached, the ones still able to convert (contactedRecipients minus everyone a bounce or an unsubscribe removed). Stated BESIDE the reach it is drawn from so nobody has to work out which of the two a rate divided by. Byte-equal to outcomes.recipientsConvertible for the same scope — one count, read off one deduped person set."),
  steps: z.array(funnelStepSchema).describe("The funnel's rungs in the funnel's own order, first to last — four for either meeting funnel (reply-or-visit → booked → attended → paid), three for website purchases (visit → signup → paid) and for the form magnet (visit → form filled → paid)."),
});

const featureRevenueResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
  featureSlug: z.string(),
  campaignIdentity: campaignIdentitySchema.optional().describe("Present only on a ?campaignId= read: the identity the figures were totalled over. A campaign-scoped read answers for the campaign's whole identity — its stopped ancestors included — so asking about any member returns the same, complete campaign."),
  spend: spendSchema.nullable().describe("Canonical spend block for the Overview card — Total spent / Budget spent today / CPC each in three variants (total=committed, actual=billed, provisioned=holds; total = actual + provisioned), plus top sources. Present on the OVERVIEW response; null on the lensed (?lens=) response (lens pages use costPerConversionUsd); absent on grouped (?groupBy=campaignId) groups. (features-service#396, committed naming features-service#402)"),
  recipientsContacted: recipientsContactedSchema.describe("Server-computed contacted aggregates for the Overview Outreach card + daily graph, from the SAME leads[] snapshot (single source, dashboard renders only — features-service#371/#372)."),
  recipientsOpened: signalSeriesSchema.describe("Opens ACTUAL series for the Overview daily graph, server-computed from the SAME leads[] snapshot — coherent with recipientsContacted + the table (features-service#377). Replaces the pipeline-activity/instantly event-day source."),
  recipientsClicked: signalSeriesSchema.describe("Clicks ACTUAL series (website visits), server-computed from the SAME leads[] snapshot. ALSO the signup-goal's observed outcome — a downstream account signup is not tracked here, so the visit is the coherent signup-funnel actual; the dashboard scales it by visitToSignupPct for the projected signups line (forecast). features-service#377."),
  recipientsRepliesPositive: signalSeriesSchema.describe("Positive-replies ACTUAL series (email-gateway firstRepliedAt), server-computed from the SAME leads[] snapshot — coherent with the other actual series + the table. The booked-meetings lens's engagement signal (P=replyToMeeting) the meeting-goal Outcome line renders; distinct from meetingsBooked (the reply is the signal, the booked meeting its downstream outcome). features-service#390."),
  meetingsBooked: signalSeriesSchema.describe("Meeting-goal outcome ACTUAL series, dated by when the meeting was booked, server-computed from the SAME leads[] snapshot. features-service#377."),
  purchased: signalSeriesSchema.describe("Purchase-goal outcome ACTUAL series, dated by when the deal closed, server-computed from the SAME leads[] snapshot. features-service#377."),
  signups: signalSeriesSchema.describe("Signup-goal outcome ACTUAL series (lead-service conversion tracker, attributed per lead by matched email). `total` is the REAL count of leads we can confirm signed up, but `daily` is EMPTY with `undatedCount === total`: lead-service exposes WHICH lead converted, not WHEN (the conversion timestamp exists internally but no endpoint surfaces it). The per-day trend populates automatically once lead-service exposes the conversion date. Distinct from recipientsClicked (the visit PROXY the funnel EV anchors to). features-service#476."),
  formSubmissions: signalSeriesSchema.describe("Form-submission-goal outcome ACTUAL series (lead-service conversion tracker, event=form_submission, attributed per lead by matched email). Same shape + same date-gap caveat as `signups`: `total` real, `daily` empty / `undatedCount === total` until lead-service surfaces the conversion date. features-service#476."),
  sequences: signalSeriesSchema.nullable().describe("OUTREACH ACTIVITY daily series for the Overview graph — instantly campaigns-created per day (email-gateway groupBy=day), NOT the lead snapshot. Answers 'how much outreach happened each day' (re-contacts count each day, matches 'budget spent today'), whereas recipientsContacted answers 'how many DISTINCT leads have I reached' (deduped by first-ever contact). The two grains DIFFER by design and are NOT reconciled: the Outreach card renders recipientsContacted.total (unique leads); the graph's Outreach ACTUAL bars render sequences.daily (per-day actions). undatedCount is always 0. Present on the OVERVIEW response only (same gate as spend); null on the lensed (?lens=) response and absent on grouped (?groupBy=campaignId) groups. Fail-soft: null when the email-gateway read fails. features-service#415."),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start)."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used: 'sales-economics' = the brand's own saved set; 'cross-brand-average' = the brand-service cross-brand average fallback (revenue is an ESTIMATE, not user-confirmed). Null when the pipeline is null (no funnel wired or no economics applied)."),
  }),
  costEconomics: revenueCostEconomicsSchema.describe("Derived cost economics. Always present; ratios are null per the documented null semantics."),
  timeSeries: z.array(revenueTimeSeriesPointSchema).describe("Cumulative pipeline ordered by event date, from the per-lead event timestamps (email-gateway engagement + the dates a human stated a funnel step happened). An org with no dated event is counted in the headline but absent here."),
  roiHistory: roiHistorySchema.nullable().describe("RETURN ON SPEND ACROSS THE BRAND'S WHOLE LIFE — one line a consumer charts instead of a raw cumulative signal count. BOTH legs are CUMULATIVE SINCE INCEPTION, not per-period: spend on a day buys outcomes that land days or weeks later, so a period-grain ratio oscillates and describes nothing actionable, while the cumulative form converges and its LAST roiMultiple IS costEconomics.roiMultiple for the same read (coherent by construction, not corrected). MEASURED on both legs — COMMITTED spend dated by runs-service cost buckets (the same single basis costEconomics.roiMultiple rides, which is what makes the terminal point reconcile), pipeline dated by the same per-lead event timestamps as timeSeries; nothing is modelled, spread or amortised. OVERVIEW ONLY (same gate as spend): null on the lensed (?lens=) response, absent on grouped (?groupBy=campaignId) groups. Fail-SOFT: null when the dated-spend read fails — null means 'could not be measured', never 'the return was zero'."),
  organizations: z.array(revenueOrganizationSchema),
  leads: z.array(revenueLeadSchema),
  events: z.array(revenueEventSchema).describe("One row per event. Empty until per-event timestamps exist (email-gateway)."),
  outcomes: revenueOutcomesSchema.nullable().describe("The VOLUME half of this scope's answer — how much real outcome evidence the money above rests on: outreach volume, website visits, positive replies, committed spend, and the cost of a visit and of a reply. Built from the SAME deduped leads and the SAME committed cents as the money, so the two are coherent by construction rather than by correction. NULL only when this scope's leads were never read — a feature with no funnel wired, whose money half is honestly null too; null is 'we could not count this', never 'it reached nobody' (that is 0). Null on the lensed (?lens=) response for the same reason `spend` is: a lens is a SUBSET of the brand's leads while its spend leg is the brand's whole spend."),
  funnelSteps: funnelStepBreakdownSchema.nullable().describe("THE FUNNEL, WALKED STEP BY STEP — per rung of the sales funnel being read: how many distinct leads reached it, what reaching it cost, and what share of the rung before it converted. Built from the SAME deduped leads and the SAME committed cents as `outcomes` and the money above, so a rung's count agrees with leads[] row for row and the rate between two rungs of one funnel is a rate rather than two scopes divided into each other. NULL when there is no ONE funnel to walk: no funnel is wired for the channel (the leads were never read), the lensed (?lens=) response (a SUBSET of the brand's leads beside the brand's whole spend — the same gate as `spend`), or a read priced on SEVERAL declared funnels at once, which has several chains and no single one to state. A read that NAMES its funnel (?funnel=, or GET /offers/:offerId/funnels/:funnelKey/revenue) always carries it, priced or not — 'we could not price this' and 'this reached nobody' are different statements. Each rung also carries `customerCost`: what the CUSTOMER states the leg they worked themselves cost them, and the average per person who crossed it — reported BESIDE the charged cost, never folded into it, and scoped by the same campaigns the committed cents are.")
});

const featureRevenueResponseRef = registry.register("FeatureRevenueResponse", featureRevenueResponseSchema);

// Grouped variant — returned only when ?groupBy=campaignId. One LEAN group per campaign that has
// runs for the brand+feature: campaignId + campaignIdentity + headline.totalPipelineUsd +
// costEconomics ONLY (the dashboard campaigns row needs just revenue + ROI). Each group is
// byte-equal to the standalone ?campaignId= call. The heavy per-campaign arrays
// (timeSeries/organizations/leads/events) are omitted.
//
// Figures are the campaign's IDENTITY's, so members of one identity carry identical ones — render
// the line once, on `campaignIdentity.representativeId` (the live campaign).
const revenueGroupSchema = z.object({
  campaignId: z.string(),
  campaignIdentity: campaignIdentitySchema.describe("The identity this group's figures were totalled over. Members of one identity carry identical figures — render the line once, on representativeId."),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline for this campaign. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start)."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used: 'sales-economics' = the brand's own saved set; 'cross-brand-average' = the brand-service cross-brand average fallback (ESTIMATE). Null when the pipeline is null."),
  }),
  costEconomics: revenueCostEconomicsSchema,
  outcomes: revenueOutcomesSchema.nullable().describe("The VOLUME half of this campaign's answer — how much real outcome evidence its ROI, %CAC and pipeline rest on. It exists because those three are derived from however many outcomes the campaign has produced so far: with one or two behind them they are decided by whichever one landed and swing by whole multiples on the next reply, so a consumer that cannot see the volume reads noise as a measurement. Totalled over the campaign's IDENTITY exactly as the money is — its stopped ancestors included — and deduped inside it, so a lead served under two member rows is ONE person here as it is one person to the brand, and every member of an identity carries the identical block. Across identities the counts do NOT sum to the brand (a lead worked under two campaigns is one lead to the brand and belongs to both), the same counting-people property the money half carries. NULL only when no funnel is wired for the feature and the leads were never read — never a fabricated 0."),
});

const featureRevenueGroupedResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
  featureSlug: z.string(),
  groupBy: z.literal("campaignId"),
  groups: z.array(revenueGroupSchema),
});

const featureRevenueGroupedResponseRef = registry.register("FeatureRevenueGroupedResponse", featureRevenueGroupedResponseSchema);

// Per-WORKFLOW variant — returned only when ?groupBy=workflow. One LEAN group per workflow the brand
// has run for this feature, carrying the SAME four money figures the brand read carries:
// pipeline revenue, ROI, cost of acquisition as a %, and the dollar cost per acquisition — plus, in
// `outcomes`, the volume half the brand read also answers (outreach, visits, positive replies,
// committed spend, cost per visit, cost per reply). MEASURED, never projected, and on the one
// COMMITTED spend basis the whole service serves. A workflow is a DYNASTY (its identity across versions), because that is what every
// other surface here means by "a workflow" and what the cross-org per-workflow benchmark is keyed on.
const revenueWorkflowGroupSchema = z.object({
  workflowDynastySlug: z.string().describe("The workflow's identity across its versions — the key to join a cross-org per-workflow benchmark on. A slug workflow-service does not describe is its own dynasty of one (never folded onto a neighbour, never dropped: a retired lineage is exactly the workflow a 'what burned money' question is about)."),
  workflowDynastyName: z.string().nullable().describe("Human name of the dynasty. Null when workflow-service does not describe this slug."),
  workflowSlugs: z.array(z.string()).describe("Every versioned workflow slug folded into this group, ascending. Upgrading a workflow to v2 does not make it a different workflow that earned nothing — nothing is hidden, the versions are listed."),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline for the leads this workflow served. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start) — null is 'we could not price this', never 'it returned nothing'."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used, as on the brand read. Null when the pipeline is null."),
  }),
  costEconomics: revenueCostEconomicsSchema,
  outcomes: revenueOutcomesSchema.describe("The VOLUME half of this workflow's answer — this brand's own outreach through this dynasty and what it cost, the same figures the un-grouped brand read gives for the whole brand. Every figure rides COMMITTED spend, the single basis costEconomics rides, so cpcCents × recipientsClicked ≈ committedSpentCents by construction. This block once rode billed-only spend to avoid a committed numerator beside a realized ROI; the ROI moved to committed, so that divergence would now BE the incoherence. Counts are distinct leads: a lead served under two workflows is one lead to the brand and belongs to both groups, so the groups do not sum to the brand (the same counting-people property the money half carries); a lead served under no workflow is in no group."),
});

const featureRevenueByWorkflowResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
  featureSlug: z.string(),
  groupBy: z.literal("workflow"),
  groups: z.array(revenueWorkflowGroupSchema),
});

const featureRevenueByWorkflowResponseRef = registry.register("FeatureRevenueByWorkflowResponse", featureRevenueByWorkflowResponseSchema);

// Per-OFFER variant — returned only when ?groupBy=offerId. One LEAN group per OFFER the brand sells:
// the grain BETWEEN the brand and its campaigns (Org > Brand > Offer > Campaign). An offer is one
// distinct thing the brand sells; brand-service owns the entity and a campaign carries the offer it
// sells, so an offer's scope is the campaigns that sell it and NOTHING is re-attributed — each group
// is one computation over those campaign ids, byte-equal to the standalone ?offerId= read.
const revenueOfferGroupSchema = z.object({
  offerId: z.string().describe("The offer's UUID, as brand-service exposes it and campaign-service stores it on the campaign. features-service does not validate it against brand-service: it partitions the brand's campaigns by what the producer states, and an offer no campaign sells simply has no group."),
  campaignIds: z.array(z.string()).describe("The campaigns selling this offer, ascending — the exact scope every figure in this group was computed over. Deterministic, so the same offer always lands on the same cache cell."),
  headline: z.object({
    totalPipelineUsd: z.number().nullable().describe("Org-deduped expected pipeline for the leads this offer's campaigns served. Null when no funnel is wired, or the brand has no saved economics AND no cross-brand average exists (cold start) — null is 'we could not price this', never 'it returned nothing'."),
    economicsSource: z.enum(["sales-economics", "cross-brand-average"]).nullable().describe("Provenance of the economics used, as on the brand read. Null when the pipeline is null."),
  }),
  costEconomics: revenueCostEconomicsSchema,
});

const featureRevenueByOfferResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
  featureSlug: z.string(),
  groupBy: z.literal("offerId"),
  groups: z.array(revenueOfferGroupSchema),
});

const featureRevenueByOfferResponseRef = registry.register("FeatureRevenueByOfferResponse", featureRevenueByOfferResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/revenue",
  summary: "Expected pipeline revenue for a feature",
  description:
    "Computes expected pipeline revenue for a feature, scoped to a brand (optionally one campaign). " +
    "Expected value uses MAX inside each entity (person, org) and SUM between distinct orgs. " +
    "Rates + terminal LTR come from the brand's sales economics. " +
    "timeSeries, events and the date columns are dated from the per-lead event timestamps (email-gateway + instantly manual qualifications); an outcome with no timestamp is counted in the headline but placed on no day. " +
    "roiHistory charts return on spend across the brand's whole life (cumulative on both legs, measured on both legs, spend on the same COMMITTED basis, terminating on costEconomics.roiMultiple). " +
    "totalPipelineUsd is null when no funnel is wired for the feature, or the brand has no saved economics AND no cross-brand average exists (cold start). " +
    "When a brand has no saved economics but a cross-brand average exists, revenue is computed on that average and headline.economicsSource is 'cross-brand-average' (an estimate); otherwise 'sales-economics' (the brand's own saved set), or null for a null pipeline. " +
    "costEconomics carries the total run cost (same source as /stats systemStats) plus derived cost-of-acquisition %, ROI multiple, and costPerAcquisitionUsd — the dollar cost of winning one customer, now answered on this default un-lensed brand read and equal to the lensed costPerConversionUsd for the same scope. " +
    "With ?groupBy=campaignId the response is instead one LEAN group per campaign that has runs for the brand+feature " +
    "(campaignId + campaignIdentity + headline.totalPipelineUsd + costEconomics + outcomes); each group is byte-equal to the standalone ?campaignId= call. " +
    "`outcomes` is the VOLUME half — how much real outcome evidence that row's ROI, %CAC and pipeline rest on (outreach volume, website visits, positive replies, committed spend, cost per visit, cost per reply), totalled over the campaign's identity exactly as the money is. " +
    "With ?groupBy=workflow it is one LEAN group per WORKFLOW DYNASTY the brand has run (workflowDynastySlug + workflowDynastyName + workflowSlugs + headline.totalPipelineUsd + costEconomics + outcomes), answering which of the workflows we ran for this brand made money and which burned it — and, in `outcomes`, what that money was made of: this brand's own outreach volume, website visits, positive replies, committed spend and the cost of a visit and of a reply, per workflow.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — revenue is brand-scoped."),
      campaignId: z.string().optional().describe("Optional campaign drill-down (ignored when groupBy=campaignId). Mutually exclusive with offerId — a campaign already sells exactly one offer (400)."),
      offerId: z.string().optional().describe("Optional OFFER drill-down — the grain between the brand and its campaigns (Org > Brand > Offer > Campaign). An offer is one distinct thing the brand sells; brand-service owns the entity and campaign-service stores it on the campaign, so this resolves to the campaigns selling the offer and every figure is computed over exactly those. Nothing is re-attributed: the campaign is what runs-service and lead-service froze, and the offer only decides which campaigns answer together. Omitted → the whole brand, byte-identical to today. Mutually exclusive with campaignId (400). An offer no campaign of this brand sells is a 404 with reason 'offer_has_no_campaigns' — never the brand's own numbers under the offer's label, and never a fabricated zero."),
      groupBy: z.enum(["campaignId", "workflow", "offerId"]).optional().describe("When 'offerId', return one lean group per OFFER the brand sells (offerId + campaignIds + headline.totalPipelineUsd + costEconomics), each byte-equal to the standalone ?offerId= call, so the brand Overview can rank a brand's offers by what each returns while the brand's headline stays the sum across them. A brand selling ONE offer reads the same figures at both grains; across several the groups do NOT sum to the brand, and a campaign stating no offer is in no group at all (with its spend and its leads) — the same counting-people property the per-campaign and per-workflow grains carry. When 'campaignId', return one lean group per campaign with runs for the brand+feature instead of the single overview. When 'workflow', return one lean group per WORKFLOW DYNASTY the brand has run for the feature, carrying the same four money figures (pipeline revenue, ROI, cost-of-acquisition %, $ per acquisition), on the same single COMMITTED spend basis. Both legs are attributed by the producer that froze them — runs-service's per-workflow spend and the workflowSlug lead-service froze on each served lead — never inferred from the campaign row's current workflow (a campaign switches workflow while keeping its id). A brand whose spend all sits on one workflow reads the same figures at both grains; across several workflows the groups do NOT sum to the brand, because a lead served under two workflows is one lead to the brand and belongs to both."),
      lens: z.enum(["signups", "booked-meetings", "website_purchase", "sales", "website_visits", "positive_replies"]).optional().describe("Outcome lens (overview only). Filters leads[] to the lens's engagement signal and adds conversionProbabilityPct per lead: signups=website click (P=visitToSignup), booked-meetings=positive reply (P=replyToMeeting), website_purchase=click and/or positive reply, multi-step self-serve/meeting close (RENAMED from the former `sales` lens; legacy `purchase` spelling still accepted), sales=COMBINED goal — click and/or positive reply, per-lead sale probability = probabilistic OR of visit→paid (P=visitToPaidClient) and reply→paid (P=replyToPaidClient) (a lead converts at most once; ≤1×LTR), website_visits=website click SINGLE STEP (P=visitToPaidClient), positive_replies=positive reply SINGLE STEP (P=replyToPaidClient). headline.totalPipelineUsd = sum of the lensed leads' expectedRevenueUsd. Omitted → response unchanged."),
      funnel: z.string().optional().describe("The SALES FUNNEL the spend block's cost-per-outcome columns are priced on — brand-service's vocabulary since it retired the goal, and the only one that separates a meeting bought with a positive reply (`sales_meetings_from_conversation`) from one bought with a click onto the site (`sales_meetings_from_website`). Values: sales_meetings_from_conversation, sales_meetings_from_website, website_purchases, form_magnet; the pre-retirement spellings reply_meeting / visit_meeting / visit_signup / visit_form are accepted forever. Omitted → the brand's FIRST DECLARED funnel in catalogue order (a deterministic pick over the brand's own declarations, never a default funnel); a brand that has declared nothing keeps OBSERVED columns (null at 0 outcomes), never a substituted funnel. A value the brand never declared is ignored in favour of that same pick. An unrecognised value is a 400."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric (spend block, costEconomics committedCostUsd, CAC, ROI, cps/cpsm/cpfs). Orthogonal to the ACCOUNTING basis, which is not selectable: committed, always. Omit or 'gross' → real undiscounted numbers (DEFAULT — byte-identical to today). 'net' → the org's discounted figures, sourced from runs-service's FROZEN net cost amounts (frozen at cost-declaration time; features-service does NOT recompute the discount); fail-loud (502) if the frozen net figures are unavailable — never a silent fallback to gross. A non-discounted org's frozen net equals gross, so net == gross for it. Non-money fields (counts, rates, pipeline revenue) are identical either way."),
    }),
  },
  responses: {
    200: { description: "Feature revenue (overview, or grouped when groupBy=campaignId / groupBy=workflow / groupBy=offerId; lensed when ?lens= is set)", content: { "application/json": { schema: z.union([featureRevenueResponseRef, featureRevenueGroupedResponseRef, featureRevenueByWorkflowResponseRef, featureRevenueByOfferResponseRef]) } } },
    400: { description: "Missing brandId, invalid lens, invalid funnel, invalid pricing value, or offerId sent beside campaignId", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found, or an offer no campaign of this brand sells (reason: offer_has_no_campaigns)", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/workflow-projection ─────────────────────────

// 3-grain projection ladder (crossOrg → brand → audience) + a resolved pick, keyed per
// (audienceId?, workflowDynasty). Replaces the flat per-workflow row + the deleted /candidates endpoint.

const grainBlockSchema = z.object({
  costBasis: z.enum(["charged", "incurred"]).optional().describe("Which accounting question THIS grain answers. crossOrg = \"incurred\": the fleet PERFORMANCE benchmark, where spend the platform comped counts at full value (one org being comped must not make a workflow look cheaper to everybody else). brand / audience = \"charged\": this customer's own billed money, where comped spend is absent. Stated per grain because this payload is the one place both questions sit side by side under the same words. Absent on an UNMEASURED row (estimatesByGrain is empty there)."),
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
  resolvedOutcomeCount: z.number().nullable().describe("The GOAL-RESOLVED (expected) outcome COUNT for THIS grain — the numerator this grain's cost-per-outcome is derived from, projected from the grain's OWN observed clicks/replies through the queried goal's funnel (websiteVisit/whatsapp → clicks; positiveReply → replies; signup → clicks·v2s; form_submissions → clicks·v2fs; meeting-booked → clicks·v2m + replies·r2m; website_purchase → clicks·orP(v2c,v2m·m2c) + replies·(r2m·m2c); combined sales → max(clicks·v2pc, replies·r2pc), best channel). Coherent with cost-per-outcome by construction: spentUsd / resolvedOutcomeCount == this grain's cost-per-outcome when > 0. Uses ONLY observed evidence (no cascade floor) → 0 when the grain observed 0 of the driving outcome; null ONLY at cold start (no economics). Lets a consumer Thompson-sample on (contacted = trials, this = successes, spentUsd/contacted = cost) without re-deciding the funnel metric; an absent audience grain (never-run couple) carries no block = a cold arm."),
  projected: z.object({
    costPerSignupUsd: z.number().nullable(),
    costPerPaidClientUsd: z.number().nullable().describe("Cost per paying client for the queried goal (single-step rate for website_visits/positive_replies, visit→form→paid for form_submissions, cost-per-sale = 1/((1/clickUsd)·v2pc+(1/replyUsd)·r2pc) for the combined `sales` goal, else the multi-step website_purchase close funnel). For `sales` this equals costPerOutcomeUsd (the outcome IS the paying client). Drives roiMultiple (= CLTV / this) + cacPct."),
    costPerMeetingBookedUsd: z.number().nullable(),
    roiMultiple: z.number().nullable().describe("LTR / costPerPaidClientUsd (= 100 / cacPct). Null when economics are absent or the paid-client cost is null/0."),
    cacPct: z.number().nullable().describe("100 / roiMultiple. Null when economics are absent or the paid-client cost is null/0."),
  }).describe("All fields null ONLY when economics is null (cold start) — the floor rule makes unit costs > 0, so a zero denominator never nulls projected."),
});

const resolvedBlockSchema = z.object({
  costBasis: z.enum(["charged", "incurred"]).nullable().describe("The basis the resolved NUMBERS were read on — the basis of the grain they came from (the finest grain WITH SPEND, which is not necessarily the provenance `grain` LABEL). \"charged\" = this customer's own billed money, comped spend absent; \"incurred\" = the fleet benchmark, comped spend at full value. NULL on an UNMEASURED row, where the figure is an EXPLORE ALLOWANCE rather than a measured cost."),
  grain: z.enum(["audience", "brand", "crossOrg"]).nullable().describe("PROVENANCE LABEL only (decoupled from the number source): the finest grain that actually OBSERVED the goal's outcome (precedence audience > brand > crossOrg), else crossOrg (benchmark). A grain with spend but 0 outcomes yields a FLOORED projection, not a measured result, so it is NEVER labelled brand/audience (\"this brand's own results\") — it labels crossOrg (fleet benchmark). NOTE: the resolved NUMBERS still come from the finest grain WITH SPEND (its cascade floor max(spent, parent)), so a 0-outcome grain keeps its own spend-floor number even while labelled crossOrg. NULL on an UNMEASURED row (measured=false) — nothing measured it, so there is no provenance to label, and a row priced on the EXPLORE ALLOWANCE borrows no other workflow's label."),
  costPerClickUsd: z.number().nullable().describe("costPerClickUsd of the finest grain WITH SPEND (never 0) — the cascade floor max(spent, parent), which may exceed the crossOrg value even when grain (label) = crossOrg. On an UNMEASURED row (measured=false) it carries the channel's outreach price — the explore allowance's floor. NULL only when the channel has measured nothing at all; never 0, which would say a click is free."),
  costPerOutcomeUsd: z.number().nullable().describe("The GOAL metric from the finest grain WITH SPEND (cascade floor) — campaign-service ranks on THIS. Single-step goals (websiteVisit/positiveReply) = the RAW unit cost of the outcome (CPC / CPPR); multi-step goals = cost per signup/meeting/purchase. Distinct from costPerPaidClientUsd for single-step goals (they differ by the visit/reply→paid rate). A 0-outcome grain keeps its own spend floor here (not collapsed to the fleet value), while `grain` labels it crossOrg. On an UNMEASURED row (measured=false) it carries the EXPLORE ALLOWANCE — the price of one outreach in this channel through the goal's funnel — so an active workflow with no history is RANKABLE and can earn a first run; it is a cost floor only (costPerPaidClientUsd / roiMultiple / cacPct stay null). Null at cold start (no economics) and when the channel has measured nothing at all."),
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
  }).describe("A grain block is included ONLY when that grain has spentUsd > 0. Always EMPTY on an UNMEASURED row (measured=false) — nothing is borrowed from the workflows that do have evidence."),
  resolved: resolvedBlockSchema,
  measured: z.boolean().describe("TRUE ⟺ the row rests on real evidence (≥1 grain with spend) — every row an established channel serves. FALSE marks a row for a workflow this channel has measured NOTHING for: estimatesByGrain is empty and resolved carries the EXPLORE ALLOWANCE (a cost floor, no return), so a serving consumer that ranks on resolved.costPerOutcomeUsd can REACH an active workflow with no history — which is the only way it can earn a first run — while every display / benchmark surface filters on this flag instead of probing for nulls. Unmeasured rows appear beside measured ones in an established channel (the mixed case): an active dynasty with no grain anywhere is offered here, never recommended. When the channel has measured nothing whatsoever there is no allowance to state either and every resolved figure is null."),
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

const salesFunnelKeyEnum = z.enum(["sales_meetings_from_conversation", "sales_meetings_from_website", "website_purchases", "form_magnet"]);

/** One end of an arrow, worded for a buyer — the same shape /public/channels publishes as a step. */
const arrowStepSchema = z.object({ key: z.string(), label: z.string(), description: z.string() });

const workflowProjectionResponseSchema = z.object({
  featureSlug: z.string(),
  funnelKey: salesFunnelKeyEnum.optional().describe("The SALES FUNNEL this projection was priced on — present ONLY when the request named one via `?funnel=`. It is the authoritative answer to what was priced: the two meeting funnels carry the SAME `goal`/`objective` echo and DIFFERENT numbers, which is why the goal was retired as an identity. Absent on a goal-keyed request, so an existing consumer reads a byte-identical body."),
  objective: z.enum(["meeting-booked", "self-serve", "signup", "website_purchase", "sales", "website_visits", "positive_replies", "form_submissions", "whatsapp_conversations"]).describe("Canonical SNAKE echo of the requested goal (defaults to meeting-booked). Accepts both `goal` (camel) and `objective` (snake/kebab) request params. website_purchase is the RENAMED former `purchase` goal (multi-step self-serve/meeting close; legacy `purchase` input still accepted). sales is the COMBINED goal (a paying client won via EITHER visit→paid OR reply→paid, valued at CLTV; cost-per-outcome == cost-per-sale). whatsapp_conversations is a click-outcome goal (cost-per-outcome = CPC; no paid-client/ROI economics — those read null). A present-but-unrecognised goal fails loud (400)."),
  goal: z.enum(["meetingBooked", "signup", "websitePurchase", "sales", "websiteVisit", "positiveReply", "formSubmission", "whatsappConversation"]).describe("Canonical CAMEL echo (= brand-service CurrentGoal). self-serve/signup both echo signup. websitePurchase = renamed former purchase goal; sales = combined-sales goal."),
  arrow: z.object({
    arrowKey: z.string().describe("The arrow that was asked for, echoed."),
    fromStep: arrowStepSchema.nullable().describe("The step a lead is taken out of; null on an entry arrow. Read these rather than splitting `arrowKey`."),
    toStep: arrowStepSchema.describe("The step a lead is moved to."),
    candidateFunnelKeys: z.array(salesFunnelKeyEnum).describe("Every DECLARED funnel of this brand containing the arrow — what the pick chose between. Their figures overlap on the shared arrow and must never be summed."),
    basisFunnelKey: salesFunnelKeyEnum.describe("The funnel the numbers on this body were priced through. Equals `funnelKey`, so an arrow-keyed answer and the same brand's `?funnel=` answer for that funnel are the same body."),
    basis: z.enum(["sole_declared_funnel", "best_returning_declared_funnel", "no_return_evidence"]).describe("WHY that funnel: it was the only declared one containing the arrow; it returned best per dollar; or nothing containing the arrow has a measurable return yet and the catalogue's canonical order broke the tie deterministically. Stated so a caller never assumes the answer rests on measured returns when it does not."),
    returnPerDollar: z.number().nullable().describe("The basis funnel's return per dollar — the figure the pick was made on, the IDENTICAL definition /funnel-ranking ranks on. Null under basis='no_return_evidence': nothing was measurable, and 0 would say the funnel returns nothing."),
    evidence: z.object({
      grain: z.enum(["audience", "brand", "crossOrg"]).nullable().describe("Whose results the recommendation's numbers are — crossOrg is the FLEET BENCHMARK, not this brand's own. Null when nothing measured it."),
      measured: z.boolean().describe("Whether the recommended row rests on real evidence at all."),
      resolvedOutcomeCount: z.number().nullable().describe("How many of the basis funnel's outcomes were actually observed behind the recommended workflow — HOW MUCH the recommendation rests on. A handful is noise, and the caller is owed the number rather than a verdict. Null is 'we could not count this', never 0."),
    }).describe("What the recommendation rests on, in the vocabulary the rows already use."),
  }).optional().describe("Present ⟺ the request named an ARROW (`?arrow=`), and it states which of the brand's declared funnels the arrow was priced through and what that answer rests on. Absent on every funnel- or goal-keyed request, so those bodies are byte-identical to what they have always been."),
  economics: workflowProjectionEconomicsSchema.nullable().describe("Null only at cold start (no effective economics) — rows still emit with null projected."),
  rows: z.array(workflowProjectionRowSchema),
  recommendedWorkflowDynastySlug: z.string().nullable().describe("Dynasty of the MEASURED row with the lowest resolved.costPerOutcomeUsd. An unmeasured row (explore allowance) is reachable but never recommended. Null when none has usable data."),
  recommendedBudgetUsd: z.number().nullable().describe("10 target outcomes/month × the recommended row's resolved.costPerOutcomeUsd. Null when there is no pick."),
  measured: z.boolean().describe("TRUE ⟺ at least one row rests on real evidence — every answer an established channel gives. FALSE says this acquisition channel has measured nothing for this brand yet; unmeasuredReason then names what is missing."),
  unmeasuredReason: z.enum(["no_active_audiences", "no_active_workflows", "no_spend_recorded"]).optional().describe("Present ⟺ measured=false, and it is the whole point of the field: an empty `rows` must never be read as 'this brand has nobody to contact'. `no_active_audiences` = the brand is working no audience, so there is nothing to serve through ANY channel (rows is empty). `no_active_workflows` = this feature has no active workflow (rows is empty). `no_spend_recorded` = the brand HAS active audiences and this channel HAS active workflows, it has simply never run — rows then enumerate every (active audience × active workflow) couple, all measured=false."),
});

registry.register("WorkflowProjectionResponse", workflowProjectionResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/workflow-projection",
  summary: "3-grain cost-per-outcome projection ladder per (audience?, workflow dynasty)",
  description:
    "Serves a 3-grain projection ladder (crossOrg → brand → audience) + a resolved pick, keyed per (audienceId?, workflowDynasty). " +
    "crossOrg = fleet-wide per-workflow unit costs (same source as /public/stats/best); brand = the same path scoped to this brandId; audience = audience-attributed evidence for each active human-service audience that ran the workflow (audience-WIDE — the fleet does not tag outcomes per audience×workflow). " +
    "Each grain carries its own evidence, floor-ruled unit costs (costPerXUsd = spentUsd / max(observedX,1), never null), and projected cost-per-outcome from the brand's EFFECTIVE economics. A grain is included only when it has spentUsd > 0. resolved NUMBERS come from the finest grain WITH SPEND (its cascade floor max(spent, parent), so a 0-outcome grain that outspent the fleet keeps its own higher floor, never collapsed to the fleet value); resolved.grain is a decoupled PROVENANCE LABEL = the finest grain that OBSERVED the outcome, else crossOrg (benchmark) — so a floored projection is never labelled this brand's/audience's own result. campaign-service ranks on resolved.costPerOutcomeUsd. " +
    "recommendedWorkflowDynastySlug = argmin over MEASURED rows of resolved.costPerOutcomeUsd; recommendedBudgetUsd = 10 × that cost. Folds in the audience×workflow grain formerly served by the removed /candidates endpoint. " +
    "A CHANNEL WITH NO HISTORY STILL ANSWERS WHO IT COULD BE SERVED TO: audience membership belongs to the BRAND, not to what a channel has already spent, so a feature that has never run for this brand answers measured=false / unmeasuredReason='no_spend_recorded' and enumerates every (active audience × active workflow) couple with measured=false, an empty estimatesByGrain and every resolved figure null — no cost, no return, no rank, and nothing borrowed from a channel that does have a history. AN ACTIVE WORKFLOW WITH NO HISTORY IS REACHABLE INSIDE AN ESTABLISHED CHANNEL TOO (the MIXED case): a dynasty with no grain anywhere used to produce no row at all, so a consumer picking by cost could not see it, so it never spent — the one thing that would have given it a row. Such a dynasty now gets its brand row + one row per active audience with measured=false and the EXPLORE ALLOWANCE on resolved: the price of ONE OUTREACH in this channel (brand-measured spend/contacted, else the fleet's) through the goal's funnel. It is a cost floor, not a claim: no paid-client cost, no return, no %CAC, no grain, no rank. Bounded and self-extinguishing — one run gives the workflow real spend and its own cascade floor prices it from then on. Only ACTIVE dynasties are enumerated, so a deprecated workflow stays unreachable, and a brand with no active audience enumerates nothing. Every MEASURED row is byte-unchanged.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — conversion economics are brand-scoped."),
      audienceId: z.string().optional().describe("Optional audience UUID context (echoed via audience rows). Audience rows always enumerate ALL of the brand's active audiences that ran the workflow."),
      goal: z.string().optional().describe("Optimization goal. Accepts camel (websiteVisit/positiveReply/formSubmission/meetingBooked/signup/websitePurchase/sales/whatsappConversation), snake (website_visits/positive_replies/form_submissions/website_purchase/whatsapp_conversations), kebab, the legacy `purchase` spelling (→ websitePurchase), `combinedSales` (→ sales), and the whatsapp display value ('WhatsApp conversations'). Also accepted via `objective`. Defaults to meeting-booked; a present-but-unrecognised goal fails loud (400). websitePurchase = renamed former purchase (multi-step close). sales = COMBINED goal (paying client via either visit→paid OR reply→paid, valued at CLTV). whatsapp_conversations is a click-outcome goal — cost-per-outcome = CPC, no paid-client/ROI economics."),
      objective: z.string().optional().describe("Alias of `goal` (snake/kebab spelling). Either param is accepted."),
      funnel: z.string().optional().describe("The SALES FUNNEL to price on — brand-service's vocabulary since it retired the goal, and the only one that separates a meeting bought with a positive reply (`sales_meetings_from_conversation`, priced replyUsd / replyToMeetingPct) from one bought with a click onto the site (`sales_meetings_from_website`, priced clickUsd / visitToMeetingPct). A goal cannot express that difference: both echo `meetingBooked`, and a goal-keyed request funnels from BOTH channels. Values: sales_meetings_from_conversation, sales_meetings_from_website, website_purchases (visit → signup → paid), form_magnet (visit → form → paid); the pre-retirement spellings reply_meeting / visit_meeting / visit_signup / visit_form are accepted forever and resolve to the canonical key. WINS over `goal`/`objective` when both are sent. A funnel the brand never DECLARED is a 404 (reason='funnel_not_declared') — 'we could not estimate this' and 'it costs zero' are different statements. An unrecognised value is a 400, never a silent fall back to the goal."),
      arrow: z.string().optional().describe("ONE ARROW of a sales funnel — the leg a budget is being put behind — named with its single canonical identifier (`start_to_conversation`, `conversation_to_meeting_booked`, `meeting_booked_to_meeting_attended`, `meeting_attended_to_paid_client`, `start_to_website_visit`, `website_visit_to_meeting_booked`, `website_visit_to_signup`, `signup_to_paid_client`, `website_visit_to_form_filled`, `form_filled_to_paid_client`; case and separators tolerated). NO sales funnel is named alongside it, which is the point: one arrow belongs to several funnels, so a campaign can no longer be identified by one. THE FUNNEL IS CHOSEN HERE — the brand's BEST-RETURNING declared funnel that contains the arrow, on the IDENTICAL returnPerDollar basis /funnel-ranking ranks funnels on, so an arrow yields ONE answer whichever funnel the caller had in mind and the two surfaces can never name different funnels. NOT the cheapest: a dollar buys a paying client through whichever route converts best, so the cheap leg of a funnel worth little loses to the dear leg of one worth a lot. The pick and what it rests on are stated back on `arrow`. Sending BOTH `arrow` and `funnel` is a 400 (reason='arrow_and_funnel'); an unrecognised arrow is a 400 (reason='arrow_unrecognised'); an arrow no declared funnel of this brand contains is a 404 (reason='arrow_not_declared')."),
      budgetUsd: z.string().optional().describe("Optional budget context (accepted for back-compat; the grain ladder + recommendedBudgetUsd carry the projection surface)."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric (each grain's unitCosts + projected cost-per-outcome, resolved.costPerOutcomeUsd, roiMultiple, cacPct, recommendedBudgetUsd). Omit or 'gross' → real undiscounted numbers (DEFAULT — byte-identical to today). 'net' → the discounted figures, sourced from runs-service's FROZEN net cost amounts at every grain of the crossOrg→brand→audience ladder (frozen at cost-declaration time; features-service does NOT recompute the discount); fail-loud (502) if the frozen net figures are unavailable — never a silent fallback to gross. Non-money fields (counts, rates, economics rates) are identical either way."),
    }),
  },
  responses: {
    200: { description: "Workflow projection ladder", content: { "application/json": { schema: workflowProjectionResponseSchema } } },
    400: { description: "Missing brandId, an unrecognised goal / funnel / pricing value, an unrecognised arrow (reason='arrow_unrecognised'), or an arrow sent beside a funnel (reason='arrow_and_funnel')", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found; (reason='funnel_not_declared') the requested `?funnel=` is not one this brand declared; or (reason='arrow_not_declared') no funnel this brand declared contains the requested `?arrow=` — both bodies carry `declaredFunnelKeys`", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error (reason='declared_funnels_unavailable' when the declared-funnel read could not be answered)", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/funnel-ranking ──────────────────────────────

// EVERY sales funnel the brand DECLARED, ranked by what it returns per dollar, plus the best workflow
// and per-audience evidence for the best-returning one — one answer, one request. It is a
// RECOMMENDATION a customer reads to decide where to put their money, not an instruction a scheduler
// obeys: which funnel runs is decided by what the customer FUNDS (campaign-service works every funded
// funnel, each paced on its own ceiling).

const goalEchoEnum = z.enum(["meetingBooked", "signup", "websitePurchase", "sales", "websiteVisit", "positiveReply", "formSubmission", "whatsappConversation"]);
const objectiveEnum = z.enum(["meeting-booked", "self-serve", "signup", "website_purchase", "sales", "website_visits", "positive_replies", "form_submissions", "whatsapp_conversations"]);

const rankedFunnelWorkflowSchema = z.object({ workflowDynastySlug: z.string(), workflowDynastyName: z.string().nullable() });

const rankedFunnelSchema = z.object({
  funnelKey: salesFunnelKeyEnum.describe("brand-service's key for the funnel — the SAME key billing funds and campaign-service paces on, so a customer can map a rank straight onto a budget, AND the only field that identifies what was priced. The two meeting funnels differ here and nowhere else in this shape: same goal echo, different numbers."),
  name: z.string().describe("The brand's own label for the funnel."),
  goal: goalEchoEnum.describe("LEGACY echo, derived from funnelKey. Lossy by construction — `sales_meetings_from_conversation` and `sales_meetings_from_website` both echo `meetingBooked` — so it must never be read as the identity of the row. Kept because campaign-service reads arbitration.goal in prod."),
  objective: objectiveEnum.describe("Legacy snake echo of `goal`. Same lossiness; read `funnelKey`."),
  rank: z.number().int().nullable().describe("1 for the best-returning funnel, 2 for the next, and so on. NULL when the funnel could not be ranked — it is still listed, with its reason, so the comparison is never silently short. A rank says how a funnel HAS PERFORMED, never whether it should run."),
  rankable: z.boolean().describe("True ⟺ the funnel has a defined, positive return per dollar and therefore carries a rank."),
  unrankableReason: z.enum(["no_economics", "no_workflow_evidence", "no_paid_client_path", "no_return_defined"]).nullable().describe("Why this funnel could not be ranked. `no_paid_client_path` = the funnel has NO defined path to a paying client — a leg of its OWN funnel is undeclared or sits at 0. Note a channel-scoped meeting funnel lands here whenever ITS channel has no rate, which a goal-keyed score used to hide behind the other channel's contribution. `no_workflow_evidence` = no history to compare it on yet. Null ⟺ rankable."),
  returnPerDollar: z.number().nullable().describe("lifetimeRevenueUsd / costPerPaidClientUsd of this funnel's best workflow (= the workflow-projection roiMultiple, = 100 / cacPct). THE ranking basis: the only cross-funnel-comparable number, since each funnel's own outcome is denominated differently. Null ⟺ not rankable."),
  costPerOutcomeUsd: z.number().nullable().describe("The funnel's cost per its OWN outcome on its best workflow. NOT comparable across funnels — for information only."),
  costPerPaidClientUsd: z.number().nullable(),
  grain: z.enum(["audience", "brand", "crossOrg"]).nullable().describe("Provenance label of the best row's resolved pick (crossOrg = fleet benchmark)."),
  workflow: rankedFunnelWorkflowSchema.nullable(),
  usesFunnelEconomics: z.boolean().describe("True when this funnel carries economics of its own (its own lifetime revenue and/or rates), which refined the brand's effective set for this projection. A rate the brand never declared is dropped, never read as 0."),
});

const funnelRankingResponseSchema = z.object({
  featureSlug: z.string(),
  ranking: z.array(rankedFunnelSchema).describe("EVERY sales funnel the brand declared — FUNDED OR NOT — best return per dollar first, the unrankable ones after in brand-service's own order. This is the answer the endpoint exists to give: the COMPARISON, not the winner. A funnel with no current daily ceiling is still ranked, because its history is what makes it comparable and a ranking that dropped the unfunded ones would answer 'where should I move my budget?' with only the places the budget already is. features-service never asks billing which funnels are funded."),
  recommendation: z.object({
    funnelKey: salesFunnelKeyEnum,
    name: z.string(),
    goal: goalEchoEnum,
    objective: objectiveEnum,
    returnPerDollar: z.number().describe("Always a positive finite number."),
    costPerOutcomeUsd: z.number().nullable(),
    costPerPaidClientUsd: z.number().nullable(),
    grain: z.enum(["audience", "brand", "crossOrg"]).nullable(),
    workflow: rankedFunnelWorkflowSchema,
  }).nullable().describe("The best-returning funnel — the head of `ranking`, named as what it is: advice, not an instruction. Null when nothing in `ranking` could be ranked."),
  arbitration: z.object({
    status: z.enum(["resolved", "unrankable"]).describe("`resolved` = a funnel is recommended. `unrankable` = nothing could be ranked for this brand (see reason) — distinguishable from a recommendation, and not an error."),
    funnelKey: salesFunnelKeyEnum.nullable().describe("The recommended funnel's key — the unambiguous half of this compatibility view, added beside the lossy `goal` so a consumer can migrate off it without a second endpoint. Null ⟺ status = unrankable."),
    goal: goalEchoEnum.nullable().describe("LEGACY echo of the recommended funnel's goal. Cannot distinguish the two meeting funnels; read funnelKey. Null ⟺ status = unrankable."),
    objective: objectiveEnum.nullable(),
    reason: z.enum(["no_declared_funnels", "no_rankable_funnel"]).nullable().describe("`no_declared_funnels` = there was no declared funnel to rank (a brand that never stated a set at all is a 502 reason='authorized_goals_unavailable', not this). `no_rankable_funnel` = every declared funnel is unrankable (see ranking[].unrankableReason). Null ⟺ status = resolved."),
    returnPerDollar: z.number().nullable().describe("The recommended funnel's expected revenue per dollar of spend. Always a positive finite number when status = resolved."),
    costPerOutcomeUsd: z.number().nullable(),
    costPerPaidClientUsd: z.number().nullable(),
    grain: z.enum(["audience", "brand", "crossOrg"]).nullable(),
  }).describe("COMPATIBILITY VIEW of `recommendation`, kept byte-compatible for campaign-service, which reads status/goal in prod to pace a brand that has no per-funnel funding. Derived from the same pick, so it can never name a different funnel than the head of `ranking`. New consumers should read `ranking` / `recommendation`."),
  workflow: rankedFunnelWorkflowSchema.nullable().describe("The best workflow FOR THE RECOMMENDED FUNNEL — argmin resolved.costPerOutcomeUsd over the brand-level rows, the same ungated argmin the Strategy page ranks on. Null ⟺ status = unrankable."),
  economics: workflowProjectionEconomicsSchema.nullable().describe("The brand's EFFECTIVE economics as the recommended funnel saw them (including its own per-funnel refinement). Null at cold start."),
  rows: z.array(workflowProjectionRowSchema).describe("The recommended (funnel × workflow) pairing's projection rows: the brand-level row plus EVERY active audience's row for that dynasty, in the SAME shape /workflow-projection serves (per-audience resolvedOutcomeCount successes, evidence.observedContacted trials, evidence.spentUsd cost). Empty when nothing could be ranked."),
  recommendedBudgetUsd: z.number().nullable().describe("10 target outcomes/month × the recommended pairing's resolved.costPerOutcomeUsd. Null when nothing could be ranked."),
});

registry.register("FunnelRankingResponse", funnelRankingResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/funnel-ranking",
  summary: "Rank the brand's DECLARED sales funnels by return per dollar (a recommendation, not a selection)",
  description:
    "NAMED FOR WHAT IT DOES. This endpoint was `/goal-arbitration`, back when it WAS the decision (campaign-service asked which goal to work and ran the answer). It arbitrates nothing now, and the objective is not a variable — it is always maximise return per dollar — so it ranks the funnels a brand declared it sells through. `/features/{featureSlug}/goal-arbitration` remains mounted as a DEPRECATED alias serving a byte-identical body while callers migrate; its removal is a separate change. " +
    "ONE answer per brand: EVERY sales funnel the brand DECLARED, ranked by what it returns per dollar, plus the best workflow and the per-audience evidence for the best-returning one — so a consumer never issues one request per funnel and never ranks economics itself. " +
    "IT IS ADVICE, NOT A GATE. Which funnel actually runs is decided by what the customer FUNDS: each funnel carries its own daily ceiling (billing-service) and campaign-service works every funded funnel, pacing each against its own ceiling. This endpoint answers the other question — which funnel has returned best, and how do the others compare — so a customer can decide where to move their money. The value is the COMPARISON in `ranking`; `recommendation` is simply its head. " +
    "AN UNFUNDED FUNNEL IS STILL RANKED. Ranking is about history: what a funnel has returned is what makes it comparable, and being unfunded is a decision the customer just made, not a reason to hide how it performed. features-service never asks billing which funnels are funded. " +
    "RANKING BASIS: returnPerDollar = lifetimeRevenueUsd / costPerPaidClientUsd, i.e. expected revenue per dollar of spend (the workflow-projection roiMultiple). It is the only cross-funnel-comparable number — a cost per outcome is denominated in each funnel's OWN outcome (a click, a reply, a booked meeting), so normalising through each funnel's own funnel to the same terminal unit (a paying client's lifetime revenue) is what makes them commensurable. Rankable funnels sort on returnPerDollar descending, ties broken by the canonical funnel-catalogue order, so the same evidence + the same economics always produce the same list. " +
    "Per funnel, the best workflow is argmin resolved.costPerOutcomeUsd over the brand-level rows — byte-for-byte the ungated argmin the Strategy page and the audience-stats floor parent use (equivalent to argmax return within a funnel, since the outcome→paid rate is a constant for it), so this endpoint can never crown a different workflow than those surfaces for the same brand + goal. " +
    "EACH FUNNEL IS PRICED ON ITS OWN FUNNEL, keyed on funnelKey and not on a goal. A funnel carries no goal since brand-service retired the vocabulary, and the goal could not have answered this: sales_meetings_from_conversation and sales_meetings_from_website both mapped onto `meetingBooked`, so the two were charged one blended both-channel price and a brand running the reply-driven funnel was benchmarked against clicks it never buys. The conversation funnel now prices replyUsd / replyToMeetingPct and the website one clickUsd / visitToMeetingPct, so a brand declaring both gets two different costs — and often two different best workflows. " +
    "A funnel with NO defined return is ranked LAST, never dropped: a funnel whose own legs are undeclared or sit at 0 has no path to a paying client, and a funnel with no economics / no workflow evidence / a non-positive return is likewise listed with rank=null, rankable=false and its reason. When nothing can be ranked at all the response is arbitration.status='unrankable' with a reason — distinguishable from a recommendation, never an error that hides why. " +
    "ONE ENTRY PER FUNNEL: the two meeting funnels (booked from a reply, booked from a website visit) are ranked SEPARATELY and each priced on its own channel and its own declared terms, because the customer funds them separately — a merged row could not answer 'where should I move my budget?' for either. A rate a funnel does not state falls back to the brand's effective economics, never to zero. " +
    "The DECLARED SET is brand-service's to own, read from brand-service, never accepted from the caller and never inferred (a brand no longer has an optimizationGoal at all — that column was NOT NULL with a server default, so it said 'website purchases' for brands that had chosen nothing — and the brand-wide economics row cannot stand in either, every rate of which is server-defaulted and so signals nothing). When that declaration cannot be READ — transport, a non-OK response, or an empty list, i.e. this org has never STATED what it sells through — the endpoint FAILS LOUD (502, reason='authorized_goals_unavailable') rather than substituting a default set. " +
    "Cost: two small brand-service reads (the effective economics and the declared funnels) plus the goal-INDEPENDENT evidence fan-out, which SHARES the Gold snapshot /workflow-projection already maintains — ranking N funnels adds zero IO over reading one. /workflow-projection itself is unchanged.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — the declared funnel set and the economics are brand-scoped."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric (unit costs, cost-per-outcome, cost-per-paid-client, returnPerDollar, recommendedBudgetUsd). Omit or 'gross' → real undiscounted numbers (DEFAULT). 'net' → the discounted figures from runs-service's FROZEN net cost amounts; fail-loud (502) when those are unavailable — never a silent fallback to gross."),
    }),
  },
  responses: {
    200: { description: "Every declared funnel ranked by return per dollar + the recommended funnel's best workflow and per-audience rows (or a distinguishable unrankable verdict)", content: { "application/json": { schema: funnelRankingResponseSchema } } },
    400: { description: "Missing brandId, or invalid pricing value", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error, or the brand's declared sales funnels could not be read — transport, a non-OK response, or an empty list because no set has ever been stated for this org (all reason='authorized_goals_unavailable') / a declared funnel naming a goal we cannot map (reason='authorized_goal_unrecognised')", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/pipeline-activity ───────────────────────────

const pipelineMetricSchema = z.object({
  actual: z.number().nullable().describe("Today: actual-so-far from dated broadcast email events. Future days: null."),
  expected: z.number().nullable().describe("Expected daily value from brand daily budget, recommended workflow cost/contact, and audience/workflow evidence. Null when required producer inputs are unavailable."),
});

const pipelineSignupMetricSchema = pipelineMetricSchema.extend({
  actual: z.number().nullable().describe("Signup ACTUAL: the REAL, deduped, attributed per-day conversion count from lead-service (NOT a clicks × rate projection). Populated for today + past days; null on future days (forecast only) and when the observed series degraded (lead-service unavailable)."),
  conversionPct: z.number().nullable().describe("visitToSignupPct used for the signup projection in `.expected`. Null when brand economics are unavailable."),
});

const pipelineFormSubmissionMetricSchema = pipelineMetricSchema.extend({
  actual: z.number().nullable().describe("Form-submission ACTUAL: the REAL, deduped, attributed per-day conversion count from lead-service (NOT a clicks × rate projection). Populated for today + past days; null on future days (forecast only) and when the observed series degraded (lead-service unavailable)."),
  conversionPct: z.number().nullable().describe("visitToFormSubmissionPct used for the form-submission projection in `.expected`. Null when brand economics are unavailable OR the brand does not carry a form-submission rate (non-form brand)."),
});

const pipelineActivityDaySchema = z.object({
  date: z.string().describe("Calendar date in the requested timezone (YYYY-MM-DD)."),
  isToday: z.boolean(),
  metrics: z.object({
    outreach: pipelineMetricSchema,
    opens: pipelineMetricSchema,
    clicks: pipelineMetricSchema,
    signups: pipelineSignupMetricSchema,
    formSubmissions: pipelineFormSubmissionMetricSchema.describe("Form-submission daily bar — the visit-driven sibling of signups. actual (today + past days) = the REAL per-day form-submission conversion count from lead-service; expected (future days) = expected clicks × visitToFormSubmissionPct/100."),
  }),
});

const pipelineActivityResponseSchema = z.object({
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
  featureSlug: z.string(),
  brandId: z.string(),
  timezone: z.string(),
  generatedAt: z.string().datetime(),
  days: z.array(pipelineActivityDaySchema),
  summary: z.object({
    dailyBudgetUsd: z.number().nullable().describe("Brand daily budget from billing-service. Null when no daily budget is configured for this org + brand."),
    openRatePct: z.number().nullable().describe("Observed audience + workflow broadcast open rate used for expected opens. Null when producer evidence is unavailable."),
    clickToSignupPct: z.number().nullable().describe("Brand effective visit-to-signup conversion percent. Null when brand economics are unavailable."),
    clickToFormSubmissionPct: z.number().nullable().describe("Brand effective visit-to-form-submission conversion percent (the form-submission projection rate). Null when brand economics are unavailable OR the brand does not carry a form-submission rate."),
    undatedSignups: z.number().nullable().describe("REAL attributed signup conversions whose day cannot be determined (received_at IS NULL — 0 in practice). Counted here so they are never dropped and never assigned a fabricated day in days[]. Null when the observed series degraded (lead-service unavailable)."),
    undatedFormSubmissions: z.number().nullable().describe("REAL attributed form-submission conversions whose day cannot be determined (received_at IS NULL — 0 in practice). Counted here so they are never dropped and never assigned a fabricated day in days[]. Null when the observed series degraded (lead-service unavailable)."),
  }),
});

registry.register("PipelineActivityResponse", pipelineActivityResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/pipeline-activity",
  summary: "Seven-day pipeline activity buckets for the brand overview",
  description:
    "Returns today plus future daily buckets for the dashboard grouped bar chart. Today includes actual-so-far from dated broadcast email events and the same daily expected values shown on future days. " +
    "Expected outreach uses the org-scoped brand daily budget divided by the recommended workflow's global cost per contacted recipient. Opens and clicks use observed rates for the selected active audience + workflow; the signup/form-submission EXPECTED (future days) is clicks × the brand's effective visit→signup/visit→form rate. The signup/form-submission ACTUAL (today + past days) is the REAL per-day conversion count from lead-service's conversion tracker — never a projection. Campaign status and campaign budget do not control this forecast. Missing producer inputs return null for the affected expected values.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      offerId: z.string().optional().describe("Optional OFFER scope — the grain between the brand and its campaigns (Org > Brand > Offer > Campaign). Narrows the ACTUAL day series to the campaigns selling the offer (read once per campaign and merged; a send is tagged to exactly one campaign, so no day is counted twice). The EXPECTED series and summary.dailyBudgetUsd are NULL under an offer scope, and so are the observed signup / form-submission actuals: a daily budget is funded per brand (and per sales funnel in billing) with no per-offer ceiling to divide, and the conversion tracker is brand-keyed with no campaign on it — so both would be brand-wide figures drawn beside offer-only bars, two grains on one chart. Null is 'we could not measure this at this grain', never a share and never a zero. Omitted → byte-identical to today. An offer no campaign of this brand sells is a 404 with reason 'offer_has_no_campaigns'."),
      days: z.string().optional().describe("Number of days to return. Defaults to 7."),
      timezone: z.string().describe("IANA timezone used for calendar day ordering and today's event bucket. Any spelling the runtime accepts is accepted here, aliases included (`Asia/Saigon` as well as `Asia/Ho_Chi_Minh`). A name that is valid IANA but that the day-bucketing funnel cannot actually serve comes back as a 400 naming this parameter — never an opaque upstream failure."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every COST input behind the expected series (the fleet cost-per-outreach benchmark, the brand's own observed cost per outreach it is floored at, and the per-audience cost that ranks the forecast audience). Omit or 'gross' → real undiscounted numbers (DEFAULT — byte-identical to today). 'net' → the org's discounted figures, sourced from runs-service's FROZEN net cost amounts (frozen at cost-declaration time; features-service does NOT recompute the discount), so a discounted org's forecast promises the volume its budget really buys; fail-loud (502) if the frozen net figures are unavailable — never a silent fallback to gross. A non-discounted org's frozen net equals gross, so net == gross for it. The daily BUDGET is a configuration ceiling, not a charge — it is NEVER discounted — and counts/rates are identical either way."),
    }),
  },
  responses: {
    200: { description: "Pipeline activity buckets", content: { "application/json": { schema: pipelineActivityResponseSchema } } },
    400: { description: "Missing/invalid brandId, days, timezone, or pricing — including a timezone that is a valid IANA name but that the day-bucketing funnel cannot serve (body carries `parameter: \"timezone\"`)", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Failed to compute pipeline activity — body carries the underlying failure and the query parameters it was computed with. 500 rather than 502 on purpose: the edge in front of this service replaces an origin 502's body with its own bare text, so a 502 reaches the caller with no diagnostic at all", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /features/:featureSlug/audience-stats ───────────────────────────────

const audienceStatsEvidenceSchema = z.object({
  totalCostInUsdCents: z.number().describe("Audience-scoped spend numerator from runs-service, in USD cents."),
  completedRuns: z.number().describe("Completed runs behind this audience's cost evidence."),
  firstRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  memberCount: z.number().describe("Distinct MEMBER count of the audience (people served under it — human-service membership provenance). The addressable pool size; contacted ⊆ memberCount. Remaining-to-contact = memberCount − contacted; %used = contacted / memberCount. 0 when the audience has no members."),
  contacted: z.number().describe("Audience-scoped contacted-recipient count from email-gateway broadcast stats."),
  opened: z.number().describe("Audience-scoped opened-recipient count (recipients who opened >= 1 email) from email-gateway broadcast stats."),
  websiteClicks: z.number().describe("Audience-scoped clicked-recipient count. Dashboard CPC = totalCostInUsdCents / websiteClicks."),
  positiveReplies: z.number().describe("Audience-scoped positive-reply recipient count. Dashboard CPPR = totalCostInUsdCents / positiveReplies."),
  formSubmissions: z.number().optional().describe("REAL per-audience form-submission conversions (lead-service conversion tracker), attributed by intersecting the audience's member emails with the brand's matched-lead form-submission conversion emails — the SAME membership join as clicks/replies, never a split of the brand total. Present ONLY for the form_submissions goal; ABSENT otherwise and when lead-service didn't serve the conversion emails (never a fabricated 0). Dashboard cost per form submission = totalCostInUsdCents / formSubmissions."),
  signups: z.number().optional().describe("REAL per-audience signup conversions (lead-service conversion tracker), attributed by intersecting the audience's member emails with the brand's matched-lead signup conversion emails — the SAME membership join as clicks/replies, never a split of the brand total. Present ONLY for the signup goal; ABSENT otherwise and when lead-service didn't serve the conversion emails (never a fabricated 0). Dashboard cost per signup = totalCostInUsdCents / signups."),
  sales: z.number().optional().describe("REAL per-audience SALES — paying clients won (lead-service conversion tracker, event=sale, RENAMED from event=purchase), attributed by intersecting the audience's member emails with the brand's matched-lead sale conversion emails — the SAME membership join as signups/form-submissions, never a split of the brand total. Present ONLY for the website-purchase OR combined-sales goals (both terminate in a `sale`); ABSENT otherwise and when lead-service didn't serve the conversion emails (never a fabricated 0). Dashboard cost per sale = totalCostInUsdCents / sales."),
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
    cpfsCents: z.number().nullable().describe("REAL cost per form submission (OBSERVED) = totalCostInUsdCents / formSubmissions. Null when formSubmissions is 0/absent (not the form_submissions goal, or emails not served) OR no spend is attributed — never a false $0.00. Not used in ranking (form_submissions sorts on cpc)."),
    cpsCents: z.number().nullable().describe("REAL cost per signup (OBSERVED) = totalCostInUsdCents / signups. Null when signups is 0/absent (not the signup goal, or emails not served) OR no spend is attributed — never a false $0.00. Not used in ranking (signup sorts on cpc)."),
    cpsaleCents: z.number().nullable().describe("REAL cost per sale (OBSERVED) = totalCostInUsdCents / sales. Null when sales is 0/absent (not the website-purchase / combined-sales goal, or emails not served) OR no spend is attributed — never a false $0.00. Not used in ranking (both goals sort on cppr)."),
  }),
  projection: z.object({
    basisFunnelKey: z.string().nullable().optional().describe("BRAND-LEVEL read only (neither `funnel` nor `goal` sent): WHICH of the brand's declared sales funnels this row's return was priced through — this audience's own best-returning funnel, so an audience that pays best through a different funnel than the brand's headline says so instead of being silently priced on the brand's. Absent on a single-funnel read (the caller named the funnel); null when nothing could be priced."),
    lifetimeRevenueUsd: z.number().nullable().optional().describe("The lifetime revenue this row's return was divided by — the NUMERATOR of returnPerDollar. Carried per row because on the brand-level read two audiences can legitimately be priced through two funnels the brand values differently (a $200 self-serve plan and a $20k contract), so a consumer can never pair a return with an LTR this projection did not use. Equals brandProjection.lifetimeRevenueUsd on a single-funnel read."),
    costPerPaidClientUsd: z.number().nullable().describe("PROJECTED cost to win ONE paying client from this audience — its own observed unit costs (send-tag spend against send-tag clicks/replies, on the workflow the Strategy page renders it under) pushed through the queried goal's funnel on the brand's own declared economics. The denominator of returnPerDollar. Null (never 0) when the funnel has no path to a paying client or at cold start."),
    returnPerDollar: z.number().nullable().describe("PROJECTED — dollars of lifetime revenue per dollar spent on this audience = brandProjection.lifetimeRevenueUsd / costPerPaidClientUsd. Rank a brand's audiences on THIS, not on cost per outcome: cost per outcome ranks by cheapness, so an audience that converts to nothing outranks an expensive one that pays. It is the IDENTICAL definition /features/{slug}/funnel-ranking ranks a brand's declared funnels on, so an audience's return and the brand's return are one statistic at two grains. Not the REALIZED /revenue costEconomics.roiMultiple (that divides measured pipeline by measured spend) — this is what the evidence PROJECTS. An audience with no measured grain of its own inherits brandProjection verbatim (the same brand-level fallback the derived cost columns take). Null (never 0) when unmeasurable."),
    costOfAcquisitionPct: z.number().nullable().describe("PROJECTED — what winning a customer from this audience costs as a SHARE of what that customer is worth over their lifetime, percent = 100 x costPerPaidClientUsd / brandProjection.lifetimeRevenueUsd, which is exactly 100 / returnPerDollar. Below 100 means the audience pays for itself. Served rather than left to the consumer BECAUSE it is the reciprocal of a field already on this row: a consumer dividing one of our fields into another is how two surfaces come to print two numbers for one statistic. Same statement as returnPerDollar and costPerPaidClientUsd in a third unit, so the three can never disagree, and the identical definition one grain coarser at brandProjection.costOfAcquisitionPct. PROJECTED, NOT REALIZED: do not pair it with the realized /revenue costEconomics.costOfAcquisitionPct (measured spend / measured pipeline) as if they were the same figure — this one prices what the audience's own observed unit costs imply under the brand's declared economics. An audience with no measured grain of its own inherits brandProjection verbatim (the same brand-level fallback the derived cost columns and returnPerDollar take). NULL (never 0) whenever it could not be measured — no lifetime revenue, no path to a paying client, cold start; a 0 would say winning a customer costs nothing."),
  }).describe("PROJECTED return for this audience, on the brand's own economics — three units of ONE statement (cost per paying client, return per dollar, and that cost as a share of lifetime revenue). See returnPerDollar."),
});

const audienceStatsResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
  featureSlug: z.string(),
  brandId: z.string(),
  goal: z.enum(["signup", "meetingBooked", "websitePurchase", "sales", "websiteVisit", "positiveReply", "formSubmission", "whatsappConversation"]).nullable().describe("The funnel's goal ECHO on a single-funnel read. NULL on the BRAND-LEVEL read (neither `funnel` nor `goal` sent): a brand has no goal — it sells through every funnel it declared at once — and echoing one of them there would be exactly the arbitrary pick that read exists to remove."),
  funnelCoverage: z.object({
    basis: z.literal("best_returning_declared_funnel").describe("How the money figures were combined across the brand's declared funnels: a dollar spent buys a customer through whichever funnel converts it best, so a return is the MAXIMUM over the declared set — never a blend, never a sum. Same doctrine as the combined-`sales` cost (min over channels = max over returns), and the reason this reconciles with /features/{slug}/funnel-ranking by construction: its rank-1 funnel IS this maximum, on the identical returnPerDollar definition and the identical evidence."),
    funnels: z.array(z.object({
      funnelKey: z.string(),
      name: z.string(),
      priced: z.boolean().describe("True when this funnel produced a defined, positive return that competed for the best."),
      reason: z.enum(["no_economics", "no_workflow_evidence", "no_paid_client_path", "no_return_defined"]).nullable().describe("Why the funnel could not be priced, when priced=false. Never a substituted number — the reason IS the answer. Same vocabulary /funnel-ranking reports per declared funnel."),
    })).describe("EVERY funnel the brand DECLARED, and whether it went into the figures. Listed in full, never short: a reader who cannot tell what was included cannot trust the number."),
    pricingBasisFunnelKey: z.string().nullable().describe("The funnel whose funnel every cost-per-outcome COLUMN on this payload is denominated in — the brand's best-returning declared funnel, falling back to its FIRST declared funnel in catalogue order when none could be priced. A cost per outcome is denominated in a funnel's own outcome, so unlike a return it cannot be combined across funnels; naming the one it was priced on is the honest answer."),
  }).optional().describe("Present ONLY on the BRAND-LEVEL read (neither `funnel` nor `goal` sent) — what the money figures cover."),
  brandProfileId: z.string().nullable(),
  sortMetric: z.enum(["cpc", "cppr", "returnPerDollar"]).describe("Single-funnel read: signup / websiteVisit / formSubmission / whatsappConversation sort by CPC (click-driven); meetingBooked / purchase / websitePurchase / sales / positiveReply sort by CPPR. BRAND-LEVEL read: `returnPerDollar`, DESCENDING (best return first, unmeasurable rows last) — at brand level there is no goal, and cost per outcome would rank by cheapness, putting an audience that converts to nothing above an expensive one that pays."),
  audiences: z.array(audienceStatsRowSchema).describe("Audience rows sorted by sortMetric — ascending for the cost metrics (null last), DESCENDING for returnPerDollar (null last). Rank by projection.returnPerDollar when the question is where the money should go."),
  brandProjection: z.object({
    basisFunnelKey: z.string().nullable().optional().describe("BRAND-LEVEL read only: the declared funnel the BRAND's own return was priced through — the head of /features/{slug}/funnel-ranking's ranking for the same brand at the same moment. Absent on a single-funnel read; null when nothing could be priced."),
    lifetimeRevenueUsd: z.number().nullable().describe("The brand's lifetime revenue per paying client, from the resolved (declared-funnel-priced) economics this whole payload was projected on — the numerator behind every returnPerDollar here. Surfaced so a consumer can never pair a return with an LTR this projection did not use. Null at cold start."),
    costPerPaidClientUsd: z.number().nullable().describe("PROJECTED cost per paying client for the BRAND on the goal's winning workflow — the value an audience with no measured grain of its own inherits. Null (never 0) at cold start or when the funnel has no path to a paying client."),
    returnPerDollar: z.number().nullable().describe("PROJECTED brand-level return per dollar = lifetimeRevenueUsd / costPerPaidClientUsd — the same definition as each row's, one grain coarser. Read a row's return against this ('this audience beats the brand'). Null (never 0) when unmeasurable."),
    costOfAcquisitionPct: z.number().nullable().describe("PROJECTED brand-level cost of acquisition as a share of lifetime revenue, percent = 100 / returnPerDollar — the same definition as each row's, one grain coarser, and the value a row with no measured grain inherits. Read a row's share against this ('this audience wins customers at a smaller slice of their worth than the brand does'). PROJECTED, not the realized /revenue costEconomics.costOfAcquisitionPct. Null (never 0) when unmeasurable."),
  }).describe("The BRAND-level twin of every row's projection, on the same economics and the same formula."),
});

registry.register("AudienceStatsResponse", audienceStatsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/features/{featureSlug}/audience-stats",
  summary: "Audience-level return and cost evidence for a brand + feature (optionally narrowed to one sales funnel)",
  description:
    "SEND NEITHER `funnel` NOR `goal` FOR THE BRAND-LEVEL READ. A brand runs several sales funnels at once, so at brand level there is no goal — the only thing that matters is what came back per dollar. That read prices each audience through EVERY funnel the brand DECLARED (read from brand-service, never named by the caller) and reports, per audience, `projection.returnPerDollar`, `projection.costPerPaidClientUsd` and `projection.costOfAcquisitionPct` combined as the BEST-RETURNING funnel, with `funnelCoverage` stating which funnels went in and which could not be priced, and `goal: null`. It reconciles by construction with /features/{slug}/funnel-ranking (its rank-1 funnel is this maximum) and with the per-funnel figures for the same brand at the same moment (a `?funnel=` read of the winning funnel returns the identical numbers). A brand whose declaration cannot be READ — including the empty declaration, which is a producer gap and not an answer — is a 502 with reason='declared_funnels_unavailable', never a zero return. " +
    "NAMING A FUNNEL still behaves exactly as it did: one funnel, its own cost columns, its own sort metric. " +
    "Returns ranked human-service audience rows for dashboard ranking. Each row is based on producer-side attribution of runs/outcomes to audienceId/brandProfileId/goal/workflow, never hash assignment or equal splitting of brand totals. " +
    "Rows carry raw spend and outcome evidence so the dashboard can compute CPC (spend / websiteClicks) and CPPR (spend / positiveReplies). " +
    "Rows with missing audienceId attribution are omitted. brandProfileId is echoed from the explicit query param when provided, else null (brand-service retired versioned brand-profile storage — features-service no longer reads a current profile).",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ featureSlug: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      goal: z.enum(["signup", "meetingBooked", "websitePurchase", "sales", "websiteVisit", "positiveReply", "formSubmission", "whatsappConversation"]).optional().describe("DEPRECATED — send `funnel` instead, or send NEITHER for the brand-level read. Kept working only until the dashboard migrates; a named `funnel` WINS over it, and when only a funnel is named the goal is DERIVED from it. Sending neither prices the brand across EVERY funnel it declared (see the endpoint description) — a first-class request, not a missing parameter. Legacy meaning: active optimization goal. signup + websiteVisit + formSubmission + whatsappConversation sort by CPC (click-driven); meetingBooked / purchase / websitePurchase / sales / positiveReply sort by CPPR. snake_case / kebab / display spellings are also accepted (website_visits, positive_replies, form_submissions, whatsapp_conversations, 'WhatsApp conversations'). For whatsappConversation the outcome is a click on the brand's WhatsApp link (reuses the existing click evidence — cost-per-outcome = cpcCents, outcome count = evidence.websiteClicks); null-safe when no click data exists yet."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every per-audience MONEY metric (metrics.cpcCents / cpprCents / cpfsCents + the brand-parent cascade). Omit or 'gross' → real undiscounted numbers (DEFAULT — byte-identical to today). 'net' → the org's discounted figures, sourced from runs-service's FROZEN net cost amounts (frozen at cost-declaration time; features-service does NOT recompute the discount); fail-loud (502) if the frozen net figures are unavailable — never a silent fallback to gross. A non-discounted org's frozen net equals gross, so net == gross for it. Non-money fields (evidence counts, conversion.rate) are identical either way. NOTE: campaign-service reads metrics.cpcCents byte-equal — it does NOT send pricing, so it always gets gross."),
      funnel: z.string().optional().describe("The SALES FUNNEL to price the cost columns on — brand-service's vocabulary since it retired the goal, and the only one that separates a meeting bought with a positive reply (`sales_meetings_from_conversation`) from one bought with a click onto the site (`sales_meetings_from_website`); both echo `meetingBooked`, so a goal cannot. Values: sales_meetings_from_conversation, sales_meetings_from_website, website_purchases, form_magnet; the pre-retirement spellings reply_meeting / visit_meeting / visit_signup / visit_form are accepted forever. `funnel` is the CANONICAL parameter for a SINGLE-FUNNEL read (a campaign genuinely sells one funnel): name it and nothing else. OMIT it entirely for the BRAND-LEVEL read, where the brand sells through every funnel it declared and the answer is combined over the declared set. It decides the COST basis — including the fleet-backed floor parent every per-audience cost cascades against, so this surface and /workflow-projection?funnel= stay the same number by construction. A funnel the brand never DECLARED is a 404 (reason='funnel_not_declared'); an unrecognised value is a 400, never a silent fall back to the goal."),
      brandProfileId: z.string().optional().describe("Optional brand-profile version to scope evidence, echoed back on the response. Null when omitted (brand-service retired versioned brand-profile storage — no current-profile lookup)."),
      offerId: z.string().optional().describe("Optional OFFER scope for the STATS — the grain between the brand and its campaigns (Org > Brand > Offer > Campaign). Resolves to the campaigns selling the offer and narrows every per-audience cost and engagement numerator to exactly those; the campaignId scope below is the one-member case of the same thing. AUDIENCES themselves stay brand-wide, as they do under a campaign scope: an audience is a brand-level entity several offers may address, and hiding one this offer has not reached yet would answer a question about the audience list with one about the spend. Mutually exclusive with campaignId (400). Omitted → byte-identical to today. An offer no campaign of this brand sells is a 404 with reason \'offer_has_no_campaigns\'."),
      campaignId: z.string().optional().describe("Optional single-campaign scope for the STATS. Audiences themselves stay brand-wide (they are brand-scoped entities); only the per-audience cost + outcome numerators narrow to this campaign. Absent → brand-wide numbers, byte-identical to today. Present → cost sourced from runs-service filtered by campaignId (still grouped by audienceId) and outcomes read from the email-gateway campaign scope (only this campaign's contacted/opened/clicked/replied). Powers the dashboard's per-campaign audience view."),
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
    400: { description: "Missing/invalid brandId, or an unrecognised goal / funnel / limit / statuses (omitting BOTH goal and funnel is the brand-level read, not an error)", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found, or (reason='funnel_not_declared') the requested `?funnel=` is not one this brand declared — the body carries `declaredFunnelKeys`", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error (reason='declared_funnels_unavailable' when the declared-funnel read could not be answered — including on the brand-level read, whose whole basis is the declared set)", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /offers/:offerId/* — the OFFER grain, across every channel it is sold through ──────
//
// A brand sells one OFFER through several acquisition CHANNELS at once (a channel is a feature slug),
// each funded and paced on its own money. Every read above names ONE channel in its path, so each one
// answers "what did this offer return THROUGH THIS ONE CHANNEL" — which stopped being the same question
// the day a second channel was funded, and stopped silently. These three answer at the offer grain.
//
// WHICH FIGURES COMBINE HOW, stated once here because a consumer needs it to read any of the three:
//   ADDITIVE — MONEY only. A cost row carries exactly one feature slug and one campaign, so spend adds
//     across channels with nothing counted twice (and runs-service does the adding, from its plural
//     `featureSlugs` filter). Same for run counts and any per-day SEND count.
//   NOT ADDITIVE — PEOPLE. A lead worked through two channels is ONE lead to the offer and belongs to
//     both, so the offer's recipient counts are BELOW the sum of its channels'. Never summed here: one
//     brand-scoped lead read covers every channel and the duplicate is deduped before the engine.
//   NOT ADDITIVE — PIPELINE. The engine combines a lead's paths per organisation, which is not additive
//     across partitions. Answered by ONE engine pass over the offer's whole evidence set.
//   NOT ADDITIVE — EVERY RATIO (ROI, %CAC, $CAC, cost per click / reply). A ratio of sums is neither the
//     sum nor the average of the ratios; each is recomputed from the combined numerator and denominator.
//   NOT COMBINABLE — A BENCHMARK. The cross-org best-workflow floor belongs to one channel; the
//     best-RETURNING channel's is taken whole, never blended (that would be a cross-workflow pooled
//     estimate this service does not publish).
//
// An offer sold through ONE channel answers identically to that channel's own `?offerId=` read.

const offerChannelSchema = z.object({
  featureSlug: z.string().describe("The acquisition channel — a feature slug, this fleet's only name for one."),
  campaignIds: z.array(z.string()).describe("The campaigns of this brand selling this offer through this channel, ascending."),
});

const offerRevenueChannelGroupSchema = offerChannelSchema.extend({
  headline: featureRevenueResponseSchema.shape.headline,
  costEconomics: featureRevenueResponseSchema.shape.costEconomics,
});

const offerRevenueResponseSchema = featureRevenueResponseSchema
  .omit({ featureSlug: true })
  .extend({
    offerId: z.string(),
    brandId: z.string(),
    channels: z
      .array(offerRevenueChannelGroupSchema)
      .describe(
        "The per-channel breakdown, in the SAME response as the total — so a caller states the offer's figures without naming a channel AND shows the rows beside them, without asking N times (it does not own which channels an offer sells through). Each row carries the same figures that channel's own /features/{slug}/revenue?offerId= read carries — same campaign scope, same brand pricing, same engine — though not to the cent: a row reads its spend grouped by workflow while the standalone read groups by cost name, and runs-service returns fractional cents per group, so each rounds once per its own grouping (the same sub-cent property the per-workflow grain documents). Ascending by slug. A channel this service cannot measure (no funnel wired — it measures email today) appears here with its REAL spend and a null pipeline, exactly as its own read reports it, so an unmeasured leg is visible rather than buried in the total.",
      ),
  });

const offerRevenueResponseRef = registry.register("OfferRevenueResponse", offerRevenueResponseSchema);

registry.registerPath({
  method: "get",
  path: "/offers/{offerId}/revenue",
  summary: "An offer's money, across every acquisition channel it is sold through",
  description:
    "The same realized-money answer /features/{featureSlug}/revenue gives, at the grain a customer's offer screen actually asks about: the OFFER, across every channel it sells through, in ONE request, with the per-channel breakdown beside it. " +
    "Money adds across channels; people, pipeline and every ratio do not — see the offer-grain note on the schema. Nothing is re-attributed: the campaign is what runs-service and lead-service froze, and the offer only decides which campaigns answer together. " +
    "An offer sold through ONE channel answers identically to that channel's own ?offerId= read. " +
    "No ?lens= and no ?groupBy=: a lens narrows to a subset of LEADS while its spend leg would still be the whole offer's, and the only grouping at this grain is the channel breakdown, which ships unconditionally. Both remain available per channel on /features/{featureSlug}/revenue.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ offerId: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — an offer belongs to a brand."),
      funnel: z.string().optional().describe("The SALES FUNNEL the spend block's cost-per-outcome columns are priced on, with the same vocabulary, the same default (the brand's first declared funnel) and the same fail-loud parse as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric. Omit or 'gross' → real undiscounted numbers (DEFAULT). 'net' → the org's discounted figures from runs-service's FROZEN net cost amounts; fail-loud (502) when they are unavailable, never a silent fallback to gross."),
    }),
  },
  responses: {
    200: { description: "The offer's money plus its per-channel breakdown", content: { "application/json": { schema: offerRevenueResponseRef } } },
    400: { description: "Missing brandId, or an invalid funnel / pricing value", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No campaign of this brand sells this offer through any channel (reason: offer_has_no_channels) — never the brand's own numbers under the offer's label, and never a fabricated zero", content: { "application/json": { schema: errorResponse } } },
    409: { description: "The offer is sold through channels that price on different funnels (reason: offer_channels_price_differently), so its money cannot honestly be answered as one figure", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── (OFFER x SALES FUNNEL) — the grain under the offer, and the only one at which a RETURN survives
// one-campaign-per-step ─────────────────────────────────────────────────────────────────────────
//
// The product is moving to ONE CAMPAIGN PER STEP of a funnel. A campaign then buys a single link, so it
// has a cost per step and NO return of its own: the lifetime revenue sits at the END of the funnel, and
// attributing it to whichever link happened to be last would wildly overstate that link. The funnel is
// the smallest scope spanning a whole path to a paying client, so it is the smallest scope whose money
// divides into a return.
//
// A campaign states exactly one funnel (campaign-service owns `funnelKey`; it is never inferred from a
// goal — two funnels answer to `meetingBooked`), so MONEY adds: Sigma funnels + Sigma unattributed IS the
// offer's own spend. PEOPLE do not — a lead worked through two funnels is ONE lead to the offer and is
// in both rows — so the rows do not sum on the pipeline half and the offer read stays the number to
// trust for "what did this offer do".

const customerDeclaredCostSchema = z.object({
  declaredCostUsd: z.number().describe("The sum of every STATED cost in this scope. A leg nobody was ever asked about contributes nothing rather than a fabricated zero."),
  statedCount: z.number().describe("How many statements carried a cost. A stated 0 is an answer and is counted here."),
  unstatedCount: z.number().describe("How many did not, because nobody was ever asked. Greater than 0 means this scope cannot be fully costed."),
});

const combinedCostEconomicsSchema = z.object({
  platformCommittedCostUsd: z.number().describe("What the platform CHARGED — byte-equal to costEconomics.committedCostUsd."),
  customerDeclaredCostUsd: z.number().describe("What the customer states their own legs cost them. Never billed."),
  committedCostUsd: z.number().describe("The two together — the basis the three figures below divide by."),
  costOfAcquisitionPct: z.number().nullable(),
  roiMultiple: z.number().nullable(),
  costPerAcquisitionUsd: z.number().nullable(),
});

const offerFunnelRowSchema = z.object({
  funnelKey: z.string().describe("The sales funnel, canonicalised onto this service's catalogue."),
  name: z.string().describe("The funnel's buyer-facing name."),
  steps: z.array(z.string()).describe("The funnel's steps in order, so a row renders without the consumer knowing the catalogue."),
  campaignIds: z.array(z.string()).describe("Every campaign of the offer selling through this funnel, ascending. ONE today; one per STEP as the product moves — the row is the same computation over the larger set."),
  channels: z.array(offerChannelSchema).describe("The acquisition channels carrying this funnel, ascending by slug."),
  priced: z.boolean().describe("Whether this funnel's money could be turned into a return. False leaves every money-derived figure null and names the missing ingredient below."),
  unpricedReason: z
    .enum(["no_channel_funnel", "no_economics_declared", "funnel_not_declared"])
    .nullable()
    .describe(
      "Why the return is null, checked in this order so the plain thing is said first. no_channel_funnel: no channel carrying this funnel measures anything (no funnel wired), so the leads are never read and `outcomes` is null too. no_economics_declared: the brand states no economics, or its declaration could not be read, so this funnel has no rates and no lifetime revenue of its own. funnel_not_declared: the declaration IS readable and does not contain this funnel. In all three the SPEND is real and reported — the customer paid it — and the pipeline, the return and the cost of acquisition are null, never 0 and never the brand-wide record the un-narrowed reads legitimately fall back to (pricing one funnel on a server-defaulted brand row is the fiction the retired goal produced, one grain finer).",
    ),
  headline: featureRevenueResponseSchema.shape.headline,
  costEconomics: featureRevenueResponseSchema.shape.costEconomics,
  customerCost: customerDeclaredCostSchema
    .nullable()
    .describe(
      "What the CUSTOMER states the legs they worked themselves cost them, for this funnel's campaign set. Never charged, in no ledger of ours, and it never reaches billing — it is reported BESIDE `costEconomics`, never inside it, so a consumer renders either without inferring one from the other. Null ONLY when the statements could not be read at all; a brand nobody has stated a cost for reads zeros, which is a different answer.",
    ),
  costCoverage: funnelCostCoverageSchema.describe(
    "Which dollars the figures on this ROW are made of. platform_spend_only: no statement is attributable to this funnel, so it reads exactly as it did before customer costs existed. platform_and_customer_spend: every attributable statement carries a cost. platform_and_partial_customer_spend: some legs were never stated, so the customer half is a floor — a funnel we cannot fully cost says so rather than guessing at the rest.",
  ),
  combinedCostEconomics: combinedCostEconomicsSchema
    .describe(
      "The funnel's cost of acquisition WITH the customer's own legs in it, and the return that divides by it. The byte-same three ratios costEconomics computes, off the summed basis and the SAME lifetime revenue — so with nothing declared this block is identical to the charged one, and the day a cost is stated the whole ladder moves together instead of one figure drifting from the others. Reported apart from the charged block because what we charged and what they spent are two questions with two owners, and one of them is what we bill.",
    ),
  outcomes: featureRevenueResponseSchema.shape.outcomes,
});

const offerFunnelsResponseSchema = z.object({
  offerId: z.string(),
  brandId: z.string(),
  costBasis: z.literal("charged").describe("What the customer was CHARGED — a comped cost is not in it. Same accounting basis as every other org-scoped money read."),
  costCoverage: funnelCostCoverageSchema.describe(
    "Which dollars the payload AS A WHOLE is made of — the WEAKEST coverage among its rows, because the marker is an admission: a payload holding one fully-costed funnel and one that could not be costed at all is not a fully-costed payload. The platform automates the first link of a funnel and charges for it; the customer performs the rest and states what those legs cost them, so a funnel ending in a human leg is only fully costed once every one of its statements carries a figure.",
  ),
  customerCost: customerDeclaredCostSchema
    .extend({
      unattributed: customerDeclaredCostSchema.describe(
        "Statements naming no campaign, or a campaign belonging to no funnel of this offer. They are in NO row and stated here, so a reader sees the difference rather than wondering where they went.",
      ),
    })
    .nullable()
    .describe(
      "The customer's own declared money across this offer, rows and leftovers together. NULL means the statements could not be READ; zeros mean nobody has stated one — two different things a consumer acts on differently, so they are never collapsed. None of this was charged to the organisation and none of it reaches billing.",
    ),
  funnels: z.array(offerFunnelRowSchema).describe("One LEAN row per funnel the offer sells through, in the catalogue's canonical order. Lean (headline + costEconomics + outcomes) because a table polls it: a full body per funnel would repeat the whole lead population once per row."),
  unattributedCampaignIds: z
    .array(z.string())
    .describe("Campaigns of this offer that state no funnel (or one the catalogue does not know), ascending. Their spend is in NO row and still in the offer's own total, which narrows by nothing — stated so a reader sees the difference rather than wondering why the rows do not add up to the offer."),
});

const offerFunnelsResponseRef = registry.register("OfferFunnelsResponse", offerFunnelsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/offers/{offerId}/funnels",
  summary: "What each of an offer's sales funnels cost and returned",
  description:
    "The (offer x sales funnel) grain: one row per funnel the offer is sold through, each carrying that funnel's own spend, pipeline, return per dollar and cost of acquisition. " +
    "It is the grain the product needs as it moves to ONE CAMPAIGN PER STEP — a campaign then buys a single link and has no return of its own, because the lifetime revenue sits at the end of the funnel. Correct under both shapes with no switch: the row is scoped to the funnel's CAMPAIGN SET, so a funnel served by one campaign (every funnel in production today) is byte-equal to that campaign's own answer, and a funnel served by one campaign per step is the same row over the larger set. " +
    "Each funnel's cost of acquisition is stated twice, apart: `costEconomics` is what the customer was CHARGED, `customerCost` is what they state the legs they worked themselves cost them, and `combinedCostEconomics` is the two together with the return that divides by that sum. `costCoverage` says which dollars a figure is made of, per row and for the payload, so the stated basis is always true rather than always the same. " +
    "Each funnel is priced on its OWN declared terms — its own rates and its own lifetime revenue — so a $200 self-serve funnel and a $20k contract funnel are never blended. A funnel we cannot price says which ingredient is missing (`unpricedReason`) and reports its real spend beside a null return. " +
    "The composition happens here: nothing on this response is meant to be summed in a browser, and the rows deliberately do not sum on the people half.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ offerId: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — an offer belongs to a brand."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric. Omit or 'gross' → real undiscounted numbers (DEFAULT). 'net' → the org's discounted figures from runs-service's FROZEN net cost amounts; fail-loud (502) when they are unavailable, never a silent fallback to gross."),
    }),
  },
  responses: {
    200: { description: "One row per sales funnel the offer is sold through", content: { "application/json": { schema: offerFunnelsResponseRef } } },
    400: { description: "Missing brandId, or an invalid pricing value", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No campaign of this brand sells this offer through any channel (reason: offer_has_no_channels) — never the brand's own numbers under the offer's label", content: { "application/json": { schema: errorResponse } } },
    409: { description: "A funnel is carried by channels that price on different funnels (reason: offer_channels_price_differently), so its money cannot honestly be answered as one figure", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

const offerAudienceStatsResponseSchema = audienceStatsResponseSchema.extend({
  offerId: z.string(),
  channels: z.array(offerChannelSchema).describe("The channels combined into every row below, ascending by slug."),
});
const offerAudienceStatsResponseRef = registry.register("OfferAudienceStatsResponse", offerAudienceStatsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/offers/{offerId}/audience-stats",
  summary: "An offer's per-audience economics, across every channel it is sold through",
  description:
    "The same per-audience ranking /features/{featureSlug}/audience-stats serves, for the OFFER rather than one of its channels. " +
    "Audiences are BRAND entities (human-service owns them, and several offers may address the same one), so the audience LIST is unchanged; what narrows is the money and the engagement behind each row. Both are per-audience SEND-TAG figures and a send carries exactly one campaign and one channel, so they add across channels with nothing counted twice — and each row's ratios are then recomputed from those combined numerators, never averaged. " +
    "The cross-org benchmark each column floors against is a property of ONE channel, so the BEST-RETURNING channel's is taken whole rather than blended. An offer sold through one channel answers identically to that channel's own ?offerId= read.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ offerId: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      goal: z.string().optional().describe("Same vocabulary and same meaning as the per-feature read. Omitting both goal and funnel is the brand-level read, not an error."),
      funnel: z.string().optional().describe("Same vocabulary and same meaning as the per-feature read."),
      statuses: z.string().optional().describe("Comma-separated audience statuses. Same meaning as the per-feature read."),
      limit: z.string().optional().describe("Maximum number of audience rows. Same meaning as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Same gross/net selector, same fail-loud NET rule, as the per-feature read."),
    }),
  },
  responses: {
    200: { description: "The offer's per-audience evidence and metrics", content: { "application/json": { schema: offerAudienceStatsResponseRef } } },
    400: { description: "Missing/invalid brandId, or an unrecognised goal / funnel / limit / statuses / pricing", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No campaign of this brand sells this offer through any channel (reason: offer_has_no_channels), or a channel it is sold through is not a feature this service knows", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

const offerPipelineActivityResponseSchema = pipelineActivityResponseSchema.extend({
  offerId: z.string(),
  channels: z.array(offerChannelSchema).describe("The channels merged into the day series below, ascending by slug."),
});
const offerPipelineActivityResponseRef = registry.register("OfferPipelineActivityResponse", offerPipelineActivityResponseSchema);

registry.registerPath({
  method: "get",
  path: "/offers/{offerId}/pipeline-activity",
  summary: "An offer's per-day activity, across every acquisition channel it is sold through",
  description:
    "The ACTUAL day series of /features/{featureSlug}/pipeline-activity, for the OFFER rather than one of its channels. Every series here is an EVENT count tagged to one campaign, so the channels add exactly — each is read under its OWN channel and the day buckets merged. " +
    "The EXPECTED series, summary.dailyBudgetUsd and the observed signup / form-submission actuals are NULL at this grain, for the same reasons the per-feature offer-scoped read states them null: a daily budget is funded per brand with no per-offer ceiling to divide, and the conversion tracker is brand-keyed with no campaign on it — drawing either brand-wide beside offer-only bars would put two grains on one chart. Null is 'we could not measure this at this grain', never a share and never a zero. The two conversion RATES survive, because they are the brand's economics and the offer does not change them. " +
    "`featureSlug` on the body carries the offer's whole channel set (comma-joined) rather than naming one of several; the `channels` array is the structured form.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ offerId: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      days: z.string().optional().describe("Number of days to return. Defaults to 7."),
      timezone: z.string().describe("IANA timezone used for calendar day ordering. Same acceptance and same 400-naming-the-parameter behaviour as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Accepted for parity with the sibling reads and folded into the cache key. Every series answered at this grain is an event count, so neither basis changes a number here."),
    }),
  },
  responses: {
    200: { description: "The offer's day buckets", content: { "application/json": { schema: offerPipelineActivityResponseRef } } },
    400: { description: "Missing/invalid brandId, days, timezone or pricing", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No campaign of this brand sells this offer through any channel (reason: offer_has_no_channels)", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── ONE SALES FUNNEL OF ONE OFFER — the offer's three reads, narrowed ──────────────────────────
//
// `/offers/{offerId}/funnels` answers at the grain of a TABLE: a lean row per funnel, four figures
// each. A funnel's own PAGE asks what an offer's page asks, and three of those things are simply not
// on a lean row — the spend broken down the way the cost card reads it, the return over the customer's
// whole life, and the dated series behind the activity chart. These three reads answer at the
// (offer x sales funnel) grain, and every figure on them is scoped to the funnel's OWN campaign set
// before anything is computed: no wider scope's shape is ever rendered under a narrower one's name.
//
// A campaign states exactly one offer and exactly one sales funnel, so the scope is the SAME partition
// the offer's table is built from. That is what makes this correct under BOTH product shapes with no
// switch: a funnel served by ONE campaign (every funnel in production today) issues the byte-same reads
// that campaign's own ?campaignId= read issues, and a funnel served by one campaign per STEP is the
// same read over a larger set. PARTIAL COVERAGE IS NORMAL HERE BY CONSTRUCTION — a funnel with a
// campaign on two of its four legs answers with the two it has, and says nothing about the rest.

const offerFunnelRevenueChannelGroupSchema = offerChannelSchema.extend({
  headline: featureRevenueResponseSchema.shape.headline,
  costEconomics: featureRevenueResponseSchema.shape.costEconomics,
  outcomes: featureRevenueResponseSchema.shape.outcomes,
});

const offerFunnelRevenueResponseSchema = featureRevenueResponseSchema
  .omit({ featureSlug: true })
  .extend({
    offerId: z.string(),
    brandId: z.string(),
    funnelKey: z.string().describe("The sales funnel this whole body is about, canonicalised onto this service's catalogue."),
    name: z.string().describe("The funnel's buyer-facing name."),
    steps: z.array(z.string()).describe("The funnel's steps in order, so the page renders without the consumer knowing the catalogue."),
    campaignIds: z.array(z.string()).describe("Every campaign of the offer selling through this funnel, ascending — the scope of every figure below. ONE today; one per STEP as the product moves, and the body is the same computation over the larger set."),
    costBasis: z.literal("charged").describe("What the customer was CHARGED — a comped cost is not in it. Same accounting basis as every other org-scoped money read."),
    priced: z.boolean().describe("Whether this funnel's money could be turned into a return. False leaves every money-derived figure null and names the missing ingredient below; the SPEND is real and reported either way."),
    unpricedReason: z
      .enum(["no_channel_funnel", "no_economics_declared", "funnel_not_declared"])
      .nullable()
      .describe("Why the return is null, with the byte-same meaning and the byte-same order as on /offers/{offerId}/funnels — the two are decided by one shared rule, so this page and that table can never state two prices for one funnel."),
    channels: z
      .array(offerFunnelRevenueChannelGroupSchema)
      .describe("The per-channel breakdown WITHIN the funnel — which of its legs is funded, and what each one cost and returned. LEAN (headline + costEconomics + outcomes) because a full body per leg would repeat the whole lead population for figures the body above already carries. A funnel with a campaign on only some of its legs shows only those: partial is what a funnel being sold leg by leg looks like, not a gap."),
    costCoverage: funnelCostCoverageSchema.describe("Which dollars the figures on this page are made of. platform_spend_only: no statement is attributable to this funnel, so it reads exactly as it did before customer costs existed. platform_and_customer_spend: every attributable statement carries a cost. platform_and_partial_customer_spend: some legs were never stated, so the customer half is a floor — a funnel we cannot fully cost says so rather than guessing at the rest."),
    customerCost: customerDeclaredCostSchema
      .nullable()
      .describe("What the CUSTOMER states the legs they worked themselves cost them, for this funnel's campaign set. Never charged, in no ledger of ours, and it never reaches billing — reported BESIDE costEconomics, never inside it. Null ONLY when the statements could not be read at all; a funnel nobody has stated a cost for reads zeros, which is a different answer."),
    combinedCostEconomics: combinedCostEconomicsSchema.describe("The funnel's cost of acquisition WITH the customer's own legs in it, and the return that divides by it — the byte-same three ratios costEconomics computes, off the summed basis and the SAME lifetime revenue. With nothing declared it is identical to the charged block."),
  });

const offerFunnelRevenueResponseRef = registry.register("OfferFunnelRevenueResponse", offerFunnelRevenueResponseSchema);

registry.registerPath({
  method: "get",
  path: "/offers/{offerId}/funnels/{funnelKey}/revenue",
  summary: "One sales funnel's money, in full — the offer read narrowed to one funnel",
  description:
    "The same realized-money answer /offers/{offerId}/revenue gives, at the grain a customer's funnel screen asks about: ONE sales funnel of one offer, scoped to that funnel's own campaigns. " +
    "It carries what the lean row on /offers/{offerId}/funnels cannot: the `spend` breakdown per cost source the cost card reads, `roiHistory` (the return on spend over the brand's whole life, both legs cumulative and both measured, terminating exactly on the headline ROI), and the dated ACTUAL series plus `leads[]` and the events ledger. Same engine, same COMMITTED basis, same brand pricing as the row — one statement at two levels of detail. " +
    "The funnel is priced on its OWN declared terms (its own rates, its own lifetime revenue) through the rule the table shares, so a $200 self-serve funnel and a $20k contract funnel are never blended and the two surfaces can never disagree. A funnel that cannot be priced says which ingredient is missing and reports its real spend beside a NULL return — never 0 and never the brand-wide record. " +
    "The cost of acquisition is stated twice, apart: `costEconomics` is what the customer was CHARGED, `customerCost` is what they state their own legs cost them, and `combinedCostEconomics` is the two together. " +
    "A funnel served by ONE campaign issues the byte-same downstream reads that campaign's own ?campaignId= read issues; a funnel served by one campaign per step is the same read over the larger set. Nothing on this response is meant to be summed in a browser.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({
      offerId: z.string(),
      funnelKey: z.string().describe("The sales funnel. Every canonical key and every pre-retirement spelling is accepted; a word naming no funnel is a 400, never a silent pick."),
    }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required) — an offer belongs to a brand."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric. Omit or 'gross' → real undiscounted numbers (DEFAULT). 'net' → the org's discounted figures from runs-service's FROZEN net cost amounts; fail-loud (502) when they are unavailable, never a silent fallback to gross."),
    }),
  },
  responses: {
    200: { description: "The funnel's money in full, plus the per-channel breakdown within it", content: { "application/json": { schema: offerFunnelRevenueResponseRef } } },
    400: { description: "Missing brandId, an unrecognised funnelKey, or an invalid pricing value", content: { "application/json": { schema: errorResponse } } },
    404: { description: "No campaign of this brand sells this offer through any channel (reason: offer_has_no_channels), or the offer sells through no campaign on this funnel (reason: funnel_not_sold, with soldFunnelKeys naming the ones it does) — never the offer's own numbers under a funnel's name, and never a fabricated zero", content: { "application/json": { schema: errorResponse } } },
    409: { description: "The funnel is carried by channels that price on different funnels (reason: offer_channels_price_differently), so its money cannot honestly be answered as one figure", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

const offerFunnelAudienceStatsResponseSchema = audienceStatsResponseSchema.extend({
  offerId: z.string(),
  funnelKey: z.string(),
  channels: z.array(offerChannelSchema).describe("The channels carrying this funnel's funded legs, combined into every row below, ascending by slug."),
});
const offerFunnelAudienceStatsResponseRef = registry.register("OfferFunnelAudienceStatsResponse", offerFunnelAudienceStatsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/offers/{offerId}/funnels/{funnelKey}/audience-stats",
  summary: "One sales funnel's per-audience economics",
  description:
    "The same per-audience ranking /offers/{offerId}/audience-stats serves, narrowed to ONE sales funnel of the offer. " +
    "Audiences are BRAND entities (human-service owns them, and several funnels may address the same one), so the audience LIST is unchanged; what narrows is the money and the engagement behind each row, to this funnel's campaigns. Both are per-audience SEND-TAG figures and a send carries exactly one campaign, so they add across the funnel's legs with nothing counted twice — and each row's ratios are then recomputed from those combined numerators, never averaged.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ offerId: z.string(), funnelKey: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      goal: z.string().optional().describe("Same vocabulary and same meaning as the per-feature read. Omitting both goal and funnel is the brand-level read, not an error."),
      funnel: z.string().optional().describe("The funnel the COST COLUMNS are denominated in, with the same vocabulary as the per-feature read. Distinct from the path's funnelKey, which is the SCOPE of the evidence."),
      statuses: z.string().optional().describe("Comma-separated audience statuses. Same meaning as the per-feature read."),
      limit: z.string().optional().describe("Maximum number of audience rows. Same meaning as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Same gross/net selector, same fail-loud NET rule, as the per-feature read."),
    }),
  },
  responses: {
    200: { description: "The funnel's per-audience evidence and metrics", content: { "application/json": { schema: offerFunnelAudienceStatsResponseRef } } },
    400: { description: "Missing/invalid brandId, an unrecognised funnelKey, or an unrecognised goal / funnel / limit / statuses / pricing", content: { "application/json": { schema: errorResponse } } },
    404: { description: "reason: offer_has_no_channels, or reason: funnel_not_sold", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

const offerFunnelPipelineActivityResponseSchema = pipelineActivityResponseSchema.extend({
  offerId: z.string(),
  funnelKey: z.string(),
  channels: z.array(offerChannelSchema).describe("The channels merged into the day series below, ascending by slug."),
});
const offerFunnelPipelineActivityResponseRef = registry.register("OfferFunnelPipelineActivityResponse", offerFunnelPipelineActivityResponseSchema);

registry.registerPath({
  method: "get",
  path: "/offers/{offerId}/funnels/{funnelKey}/pipeline-activity",
  summary: "One sales funnel's per-day activity",
  description:
    "The ACTUAL day series of /offers/{offerId}/pipeline-activity, narrowed to ONE sales funnel — so a funnel page draws ITS OWN chart instead of borrowing a wider scope's shape under a narrower scope's name. Every series here is an EVENT count tagged to one campaign, so the funnel's legs add exactly: each is read under its own channel and the day buckets merged. " +
    "The EXPECTED series, summary.dailyBudgetUsd and the observed signup / form-submission actuals are NULL at this grain, for the reasons the offer grain already states one level up: a daily budget is funded per brand with no per-funnel ceiling to divide, and the conversion tracker is brand-keyed with no campaign on it. Null is 'we could not measure this at this grain', never a share and never a zero. The two conversion RATES survive, because they are the brand's economics and the funnel does not change them.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ offerId: z.string(), funnelKey: z.string() }),
    query: z.object({
      brandId: z.string().describe("Brand UUID (required)."),
      days: z.string().optional().describe("Number of days to return. Defaults to 7."),
      timezone: z.string().describe("IANA timezone used for calendar day ordering. Same acceptance and same 400-naming-the-parameter behaviour as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Accepted for parity with the sibling reads and folded into the cache key. Every series answered at this grain is an event count, so neither basis changes a number here."),
    }),
  },
  responses: {
    200: { description: "The funnel's day buckets", content: { "application/json": { schema: offerFunnelPipelineActivityResponseRef } } },
    400: { description: "Missing/invalid brandId, days, timezone, funnelKey or pricing", content: { "application/json": { schema: errorResponse } } },
    404: { description: "reason: offer_has_no_channels, or reason: funnel_not_sold", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /brands/{brandId}/{revenue,audience-stats,pipeline-activity} ────
//
// THE BRAND GRAIN — the same question the offer reads answer, asked one level up.
//
// A brand holds several OFFERS and sells each of them through several CHANNELS, so neither a
// per-feature read (one channel) nor an offer read (one offer's channels) can answer for the brand,
// which is what its own Overview presents. The parts combine exactly as they do at the offer grain,
// and by the same code rather than a second implementation that could drift from it:
//
//   ADDITIVE — MONEY, and only money. A run carries exactly one feature_slug, so the channel set goes
//     to runs-service as its plural `featureSlugs` filter and the PRODUCER sums the same rows it would
//     have returned per channel. Same for run counts and any per-day send count.
//   NOT ADDITIVE — PEOPLE, PIPELINE, EVERY RATIO. One brand-scoped lead read covers every channel and
//     dedups before the engine; ONE engine pass (its per-organisation combination is not additive
//     across partitions); each ratio recomputed from the combined numerator and denominator.
//   NOT COMBINABLE — A BENCHMARK. It belongs to one channel; the best-RETURNING channel's is taken
//     whole, never blended.
//
// This is NOT the sum of the brand's offers, nor of its channels: only the additive half could be
// summed at all, and it would be assembled by a consumer that owns neither list.
//
// The scope is the CHANNEL SET, not an enumerated campaign list — brandId is already a producer filter
// — so a campaign campaign-service does not list still has its spend counted, and a brand running ONE
// channel issues the byte-same downstream requests its per-feature read issues today.

const brandChannelSchema = z.object({
  featureSlug: z.string().describe("The acquisition channel — a feature slug, this fleet's only name for one."),
  campaignIds: z.array(z.string()).describe("The brand's campaigns campaign-service states run through this channel, ascending."),
});

const brandRevenueChannelGroupSchema = brandChannelSchema.extend({
  headline: featureRevenueResponseSchema.shape.headline,
  costEconomics: featureRevenueResponseSchema.shape.costEconomics,
});

const brandRevenueResponseSchema = featureRevenueResponseSchema
  .omit({ featureSlug: true })
  .extend({
    brandId: z.string(),
    channels: z
      .array(brandRevenueChannelGroupSchema)
      .describe(
        "The per-channel breakdown, in the SAME response as the total — so a caller states the brand's figures without naming a channel AND shows the rows beside them, without asking N times (it does not own which channels a brand runs). MONEY is what the rows are comparable on and Σ rows IS the brand's spend, though not to the cent: a row reads its spend grouped by workflow while the total's spend block groups by cost name, and runs-service returns fractional cents per group, so each rounds once per its own grouping (the same sub-cent property the per-workflow and offer grains document). A row is narrowed to its channel's own campaigns so its RETURN is its own — the lead read has never been feature-scoped, so an un-narrowed row would divide the brand's whole pipeline by one channel's spend. The rows therefore do NOT sum on the people half: a lead worked through two channels is one lead to the brand and belongs to both rows. Ascending by slug. A channel this service cannot measure (no funnel wired — it measures email today) appears with its REAL spend and a null pipeline, exactly as its own read reports it.",
      ),
  });

const brandRevenueResponseRef = registry.register("BrandRevenueResponse", brandRevenueResponseSchema);

registry.registerPath({
  method: "get",
  path: "/brands/{brandId}/revenue",
  summary: "A brand's money, across every acquisition channel it runs",
  description:
    "The same realized-money answer /features/{featureSlug}/revenue gives, at the grain the brand Overview actually presents: the BRAND, across every channel it runs, in ONE request, with the per-channel breakdown beside it. " +
    "It exists because the Overview read one channel's money and paired it with billing's BRAND daily budget, making a fraction with two grains in it — both halves real, about different things, and nothing erroring. " +
    "Money adds across channels; people, pipeline and every ratio do not — see the brand-grain note on the schema. Nothing is re-attributed. " +
    "A brand running ONE channel answers identically to that channel's own read. " +
    "No ?lens= and no ?groupBy=: a lens narrows to a subset of LEADS while its spend leg would still be the whole brand's, and the only grouping at this grain is the channel breakdown, which ships unconditionally. Both remain available per channel on /features/{featureSlug}/revenue.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ brandId: z.string() }),
    query: z.object({
      funnel: z.string().optional().describe("The SALES FUNNEL the spend block's cost-per-outcome columns are priced on, with the same vocabulary, the same default (the brand's first declared funnel) and the same fail-loud parse as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric. Omit or 'gross' → real undiscounted numbers (DEFAULT). 'net' → the org's discounted figures from runs-service's FROZEN net cost amounts; fail-loud (502) when they are unavailable, never a silent fallback to gross."),
    }),
  },
  responses: {
    200: { description: "The brand's money plus its per-channel breakdown", content: { "application/json": { schema: brandRevenueResponseRef } } },
    400: { description: "An invalid funnel / pricing value", content: { "application/json": { schema: errorResponse } } },
    404: { description: "campaign-service lists no campaign for this brand, so it runs no acquisition channel (reason: brand_has_no_channels) — never a number about an unknown subset of channels", content: { "application/json": { schema: errorResponse } } },
    409: { description: "The brand runs channels that price on different funnels (reason: brand_channels_price_differently), so its money cannot honestly be answered as one figure", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /brands/{brandId}/offers — the brand broken into its OFFERS, each at the offer grain ──
//
// The brand Overview lists a brand's offers in a table, one row each. The only way to ask for that was
// /features/{featureSlug}/revenue?groupBy=offerId, which names ONE channel — so every row answered
// "what did this offer return THROUGH THIS ONE CHANNEL" while the table presented it as the offer's
// whole result, contradicting the brand cards directly above it. This answers the row at the grain the
// row claims: each one is the byte-same computation /offers/{offerId}/revenue makes for its total.

const brandOfferRowSchema = z.object({
  offerId: z.string().describe("The offer's UUID, as brand-service exposes it and campaign-service stores it on the campaign. features-service does not validate it against brand-service: it partitions the brand's campaigns by what the producer states, and an offer no campaign sells simply has no row."),
  channels: z.array(brandChannelSchema).describe("The acquisition channels THIS OFFER is sold through, ascending by slug, with the campaigns carrying each — the exact scope this row's figures were computed over, so a reader can see what a row is made of without a second call."),
  headline: featureRevenueResponseSchema.shape.headline,
  costEconomics: featureRevenueResponseSchema.shape.costEconomics,
});

const brandOffersResponseSchema = z.object({
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
  brandId: z.string(),
  offers: z
    .array(brandOfferRowSchema)
    .describe(
      "One LEAN row per offer the brand sells, ascending by offerId (the consumer sorts a table its own way). Each row is the byte-same computation GET /offers/{offerId}/revenue makes for its total — same channel set, same campaign scope, same brand pricing, one engine pass — with only the bulk dropped (no leads[], no spend block, no series), so a table can poll it. An EMPTY array is a real answer distinct from the 404: campaign-service lists campaigns for this brand but none of them states an offer yet.",
    ),
});

const brandOffersResponseRef = registry.register("BrandOffersResponse", brandOffersResponseSchema);

registry.registerPath({
  method: "get",
  path: "/brands/{brandId}/offers",
  summary: "Every offer of a brand, each with its own money combined across the channels it sells through",
  description:
    "The brand Overview's offers table, answered at the grain the table claims: one row per OFFER, each carrying that offer's pipeline revenue, ROI, cost-of-acquisition % and committed spend across EVERY acquisition channel it is sold through, in ONE request. " +
    "It exists because the only way to ask before was /features/{featureSlug}/revenue?groupBy=offerId, which names one channel — so a brand running several printed an offer's single-channel figures under the offer's name, beneath brand cards showing the whole thing. Both numbers were real and about different things. " +
    "Each row is the byte-same computation GET /offers/{offerId}/revenue makes for its total, with the bulk dropped (no leads[], no spend block, no series) so the table can poll it. " +
    "Money adds across an offer's channels; people, pipeline and every ratio do not, and none of them is added here — see the offer-grain note on OfferRevenueResponse. Nothing is re-attributed: the campaign is what runs-service and lead-service froze, and the offer only decides which campaigns answer together. " +
    "A brand selling ONE offer through every campaign that has runs reads its own figures here. Across several offers the rows do NOT sum to the brand (a lead served under two offers' campaigns is one lead to the brand and belongs to both), and a campaign stating no offer is in no row at all — with its spend and its leads. " +
    "An empty `offers` array means campaign-service lists campaigns for this brand but none states an offer yet; that is a different answer from the 404, which means it lists no campaign at all.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ brandId: z.string() }),
    query: z.object({
      funnel: z.string().optional().describe("The SALES FUNNEL each row's economics are priced on, with the same vocabulary, the same default (the brand's first declared funnel) and the same fail-loud parse as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Pricing basis for every MONEY metric. Omit or 'gross' → real undiscounted numbers (DEFAULT). 'net' → the org's discounted figures from runs-service's FROZEN net cost amounts; fail-loud (502) when they are unavailable, never a silent fallback to gross."),
    }),
  },
  responses: {
    200: { description: "One lean row per offer the brand sells", content: { "application/json": { schema: brandOffersResponseRef } } },
    400: { description: "An invalid funnel / pricing value", content: { "application/json": { schema: errorResponse } } },
    404: { description: "campaign-service lists no campaign for this brand, so it runs no acquisition channel (reason: brand_has_no_channels) — distinct from an empty offers array, which means its campaigns state no offer yet", content: { "application/json": { schema: errorResponse } } },
    409: { description: "One of the brand's offers is sold through channels that price on different funnels (reason: offer_channels_price_differently, with the offerId), so that offer's money cannot honestly be answered as one figure", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

const brandAudienceStatsResponseSchema = audienceStatsResponseSchema.extend({
  channels: z.array(brandChannelSchema).describe("The channels combined into every row below, ascending by slug."),
});
const brandAudienceStatsResponseRef = registry.register("BrandAudienceStatsResponse", brandAudienceStatsResponseSchema);

registry.registerPath({
  method: "get",
  path: "/brands/{brandId}/audience-stats",
  summary: "A brand's per-audience economics, across every acquisition channel it runs",
  description:
    "The same per-audience ranking /features/{featureSlug}/audience-stats serves, for the BRAND rather than one of its channels. " +
    "Audiences are BRAND entities (human-service owns them), so the audience LIST is unchanged; what widens is the money and the engagement behind each row. Both are per-audience SEND-TAG figures and a send carries exactly one campaign and one channel, so they add across channels with nothing counted twice — and each row's ratios are then recomputed from those combined numerators, never averaged. " +
    "The cross-org benchmark each column floors against is a property of ONE channel, so the BEST-RETURNING channel's is taken whole rather than blended. A brand running one channel answers identically to that channel's own read.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ brandId: z.string() }),
    query: z.object({
      goal: z.string().optional().describe("Same vocabulary and same meaning as the per-feature read. Omitting both goal and funnel is the brand-level read, not an error."),
      funnel: z.string().optional().describe("Same vocabulary and same meaning as the per-feature read."),
      statuses: z.string().optional().describe("Comma-separated audience statuses. Same meaning as the per-feature read."),
      limit: z.string().optional().describe("Maximum number of audience rows. Same meaning as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Same gross/net selector, same fail-loud NET rule, as the per-feature read."),
    }),
  },
  responses: {
    200: { description: "The brand's per-audience evidence and metrics", content: { "application/json": { schema: brandAudienceStatsResponseRef } } },
    400: { description: "An unrecognised goal / funnel / limit / statuses / pricing", content: { "application/json": { schema: errorResponse } } },
    404: { description: "campaign-service lists no campaign for this brand (reason: brand_has_no_channels), or a channel it runs is not a feature this service knows", content: { "application/json": { schema: errorResponse } } },
    502: { description: "Downstream service error", content: { "application/json": { schema: errorResponse } } },
  },
});

const brandPipelineActivityResponseSchema = pipelineActivityResponseSchema.extend({
  channels: z.array(brandChannelSchema).describe("The channels merged into the day series below, ascending by slug."),
});
const brandPipelineActivityResponseRef = registry.register("BrandPipelineActivityResponse", brandPipelineActivityResponseSchema);

registry.registerPath({
  method: "get",
  path: "/brands/{brandId}/pipeline-activity",
  summary: "A brand's per-day activity, across every acquisition channel it runs",
  description:
    "The day series of /features/{featureSlug}/pipeline-activity, for the BRAND rather than one of its channels. Every actual series is an EVENT count tagged to one campaign and a campaign runs through one channel, so the channels add exactly — each is read under its OWN channel, brand-wide, and the day buckets merged. " +
    "Unlike the offer grain, summary.dailyBudgetUsd and the observed signup / form-submission actuals ARE this grain's own figures — billing funds the budget per brand and the conversion tracker is brand-keyed — so both are stated rather than nulled. " +
    "The EXPECTED series is NOT combinable across channels: expected.outreach is dailyBudgetUsd / cost-per-outreach and that divisor is a property of ONE channel, with no per-channel ceiling to split the budget by. So with several channels the expected bars are null ('we could not measure this', never a share and never a zero) while the budget itself is still stated; with exactly one channel the ordinary forecast is computed, unchanged. " +
    "`featureSlug` on the body carries the brand's whole channel set (comma-joined) rather than naming one of several; the `channels` array is the structured form.",
  tags: ["Stats"],
  request: {
    headers: identityHeaders,
    params: z.object({ brandId: z.string() }),
    query: z.object({
      days: z.string().optional().describe("Number of days to return. Defaults to 7."),
      timezone: z.string().describe("IANA timezone used for calendar day ordering. Same acceptance and same 400-naming-the-parameter behaviour as the per-feature read."),
      pricing: z.enum(["gross", "net"]).optional().describe("Prices the forecast's cost divisor at what the org actually pays, exactly as on the per-feature read; folded into the cache key so a gross and a net request never share a body."),
    }),
  },
  responses: {
    200: { description: "The brand's day buckets", content: { "application/json": { schema: brandPipelineActivityResponseRef } } },
    400: { description: "Invalid days, timezone or pricing", content: { "application/json": { schema: errorResponse } } },
    404: { description: "campaign-service lists no campaign for this brand (reason: brand_has_no_channels)", content: { "application/json": { schema: errorResponse } } },
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
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
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
  costBasis: z.literal("charged").describe("ACCOUNTING — every money figure on this response is what the customer was CHARGED. Spend the platform COMPED (refunded after the fact) is absent from it: they did not pay it. This is the opposite of the CROSS-ORG PERFORMANCE benchmark (/public/stats/* and the crossOrg grain of /workflow-projection), which shares the words \"spend\" and \"cost per outcome\" but counts comped spend at full value, because what a workflow costs to produce an outcome does not depend on whether we billed it. ORTHOGONAL to ?pricing=gross|net, which is a DISCOUNT question, not a comped one."),
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
  configuredDailyBudgetUsd: z.number().describe("Every ceiling this (org, brand) configured, in USD — what the customer SET, not what can be spent today. The per-org usage discount is a charge modifier and is NEVER applied to a configuration ceiling, so two orgs with the same configured budget show the same number regardless of their discounts."),
  runningDailyBudgetUsd: z.number().describe("The part of the configured ceiling standing behind a campaign that is ONGOING right now, in USD (campaign-service joins the campaign status to billing's per-funnel rows). This is the money in play — what the active verdict and every fleet total read. Lower than configured whenever a funded funnel's campaign is stopped or was never created."),
  orgBalanceUsd: z.number().describe("Org SPENDABLE credit balance in USD (billing balance_cents/100; committed usage incl. provisioned holds subtracted; 0 if no funded wallet). Display only."),
  orgActualBalanceUsd: z.number().describe("Org ACTUAL credit balance in USD (billing actual_balance_cents/100; only ACTUALIZED usage subtracted). The figure the active verdict gates on."),
  autoTopupEnabled: z.boolean().describe("Whether the org has auto-topup enabled (billing has_auto_topup). An auto-topup org never runs dry → active regardless of momentary balance. false when absent."),
  status: z.enum(["active", "paused", "inactive"]).describe("Precedence active > paused > inactive: 'active' iff runningDailyBudgetUsd>0 && (autoTopupEnabled || orgActualBalanceUsd>runningDailyBudgetUsd); else 'paused' iff configuredDailyBudgetUsd>0 (money posted, nothing running against it); else 'inactive'. There is no brand-level pause flag in this rule: that control was removed from the product and the flag lied in both directions."),
});

const accountsStatsSchema = z.object({
  totalRunningDailyBudgetUsd: z.number().describe("Σ RUNNING daily budget over ACTIVE rows only (USD; undiscounted — a budget is a config ceiling, not a charge; paused/inactive excluded). The staff metrics-page figure: what the fleet can actually spend today."),
  totalConfiguredDailyBudgetUsd: z.number().describe("Σ CONFIGURED daily budget over the SAME ACTIVE rows (USD). What those customers posted, whatever is running against it — stated beside the running total so the two can never be mistaken for one another."),
  mrrUsd: z.number().describe("MRR = totalRunningDailyBudgetUsd × 30 (a budget projection, undiscounted)."),
  arrUsd: z.number().describe("ARR = totalRunningDailyBudgetUsd × 365 (a budget projection, undiscounted)."),
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
    "Cross-org, fleet-wide list of every cold-email customer account (org × brand) with BOTH of its daily budgets, the org's spendable credit balance, " +
    "and a 3-way status, plus fleet financial stats (total RUNNING daily budget → MRR = ×30 → ARR = ×365). " +
    "Two budgets, answering different questions: CONFIGURED is every ceiling the customer set in billing; RUNNING is the part of it standing behind a " +
    "campaign that is ongoing right now (campaign-service joins its own campaign status to billing's per-funnel ceilings — billing's brand total is " +
    "status-blind and counts money on funnels whose campaign is stopped or was never created). Everything that claims to be money in play reads RUNNING. " +
    "Status precedence active > paused > inactive: 'active' iff runningDailyBudgetUsd > 0 && (autoTopupEnabled || orgActualBalanceUsd > runningDailyBudgetUsd) " +
    "— the ACTUAL balance (actualized usage only), NOT the spendable balance (which subtracts in-flight provisioned holds); else 'paused' iff " +
    "configuredDailyBudgetUsd > 0, i.e. money posted with nothing running against it; else 'inactive'. There is NO brand-level pause flag in this rule any " +
    "more: that control was removed from the product, the flag stopped being written, and it lied in both directions. All rows (active + paused + inactive) " +
    "are LISTED, never dropped. Stats sum ACTIVE rows only (a paused brand is not spending). Neither budget carries the per-org usage discount — that is a " +
    "charge modifier, never applied to a configuration ceiling — so totalRunningDailyBudgetUsd/MRR/ARR are pure undiscounted budget projections (× 30 / × 365). " +
    "All money + the status determination are computed here; the dashboard renders only.",
  tags: ["Internal"],
  responses: {
    200: { description: "Per-account rows + fleet financial stats", content: { "application/json": { schema: accountsResponseRef } } },
    401: { description: "Invalid or missing API key", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Server error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /internal/stats/customer-health ─────────────────────────────────────────

const salesEconomicsSchema = z.object({
  lifetimeRevenueUsd: z.number(),
  replyToMeetingPct: z.number(),
  visitToMeetingPct: z.number(),
  meetingToClosePct: z.number(),
  visitToSignupPct: z.number(),
  signupToPaidClientPct: z.number(),
  visitToClosePct: z.number(),
  visitToPaidClientPct: z.number().optional(),
  replyToPaidClientPct: z.number().optional(),
  visitToFormSubmissionPct: z.number().optional(),
  formSubmissionToPaidClientPct: z.number().optional(),
}).describe("The brand's OWN saved conversion economics (all rates + LTR). null when the brand saved none.");

const customerHealthRowSchema = z.object({
  orgId: z.string().describe("Internal org UUID."),
  orgExternalId: z.string().nullable().describe("Clerk org id (org_...); lets the admin resolve the org display name. null if unset."),
  ownerEmail: z.string().nullable().describe("The org owner's email (earliest-created user). null if the org has no users."),
  brandId: z.string().describe("Brand UUID."),
  brandName: z.string().nullable(),
  brandDomain: z.string().nullable(),
  featureSlug: z.string().nullable().describe("The cold-email feature this row's economics / projection are computed for. null when the pair carries no membership."),
  firstActiveDay: z.string().nullable().describe("Earliest UTC day (`YYYY-MM-DD`) the org billed cold-email spend. null when never active."),
  lastActiveDay: z.string().nullable().describe("Latest UTC day (`YYYY-MM-DD`) the org billed cold-email spend. null when never active."),
  retentionWeeks: z.number().int().nullable().describe("Retention window in ISO weeks (inclusive span between first and last active week). null when never active."),
  activeThisWeek: z.boolean(),
  activeThisMonth: z.boolean(),
  activeDays: z.array(z.string()).describe("The de-facto active-day timeline from billed spend (distinct UTC days, ascending)."),
  status: z.enum(["active", "paused", "inactive"]).describe("Same composition as GET /internal/stats/accounts (active > paused > inactive; active needs a RUNNING budget > 0 AND funded/auto-topup; paused means money posted with nothing running)."),
  configuredDailyBudgetUsd: z.number().describe("Every ceiling this (org, brand) configured, in USD."),
  runningDailyBudgetUsd: z.number().describe("The part of it standing behind an ongoing campaign, in USD — the money in play."),
  orgBalanceUsd: z.number().describe("Org SPENDABLE balance in USD (display)."),
  orgActualBalanceUsd: z.number().describe("Org ACTUAL balance in USD (the active-verdict figure)."),
  autoTopupEnabled: z.boolean(),
  salesFunnels: z.array(salesFunnelKeyEnum).describe("The SALES FUNNELS this (org, brand) DECLARED it sells through, catalogue order. Replaces the retired optimizationGoal, which was a single NOT NULL server-defaulted column and therefore read 'website purchases' for brands that had chosen nothing. `[]` when the declaration is missing or unreadable — a producer gap surfaced, never a substituted funnel (every funnel-keyed field on the row then reads null)."),
  primarySalesFunnel: salesFunnelKeyEnum.nullable().describe("The ONE funnel the single-valued fields on this row (conversion tracker, best audience, best workflow) are computed on: the brand's first declared funnel in catalogue order. A deterministic pick over the brand's OWN declarations — not a default. null when nothing is declared."),
  conversionTracker: z.object({
    needed: z.boolean().describe("Whether the goal requires a client-site conversion tracker (signup / formSubmission / purchase → true; websiteVisit / positiveReply / meetingBooked → false)."),
    observedConversions: z.number().nullable().describe("Observed attributed conversions of the goal's kind (lead-service tracker). null for goals with no discrete conversion event (websiteVisit / positiveReply) or unknown goal."),
    firing: z.boolean().nullable().describe("INFERRED tracker health: observedConversions > 0. null when a tracker is not needed (n/a) or no count is available. A clean installed-and-verified boolean is a KNOWN GAP — this is the approximation."),
    inferred: z.literal(true).describe("Always true — `firing` is inferred from observed counts, not a real install/verify signal."),
  }),
  breakevenCacUsd: z.number().nullable().describe("Breakeven CAC (USD) = max acquisition cost before unprofitable = brand LTR. null with no own economics."),
  ltrUsd: z.number().nullable().describe("Lifetime revenue per customer (LTR / LTV), USD. Same value as breakevenCacUsd."),
  economics: salesEconomicsSchema.nullable(),
  currentEconomics: z.object({
    committedSpendUsd: z.number().nullable().describe("COMMITTED acquisition spend, USD (billed + open holds) — the single basis roiMultiple / cacPct / currentCacUsd are computed on. null when not computed (no own economics)."),
    realizedSpendUsd: z.number().nullable().describe("Billed-only acquisition spend, USD. TRANSITIONAL — reported for the staff console's migration, divided by nowhere. null when not computed (no own economics)."),
    expectedPipelineUsd: z.number().nullable().describe("Expected pipeline, USD (revenue-engine EV total). null when incomputable."),
    currentCacUsd: z.number().nullable().describe("Realized cost to acquire one paying customer, USD = (cacPct/100) × LTR. null when incomputable."),
    roiMultiple: z.number().nullable().describe("LTR / CAC = pipeline / spend. ≥ 1 ⟺ CAC below breakeven. null when spend or pipeline is 0/unknown."),
    cacPct: z.number().nullable().describe("CAC as a share of LTR, percent = spend / pipeline × 100. null when incomputable."),
  }),
  audiences: z.object({
    count: z.number().int().describe("Number of the brand's active audiences with evidence."),
    totalSize: z.number().int().describe("Total addressable members across the brand's audiences (Σ memberCount)."),
    totalRemaining: z.number().int().describe("Total remaining-to-contact (Σ max(memberCount − contacted, 0))."),
    pctUsed: z.number().nullable().describe("% of the addressable pool already contacted = Σcontacted / Σsize × 100. null when totalSize is 0."),
  }),
  bestAudience: z.object({
    audienceId: z.string(),
    name: z.string(),
    cacUsd: z.number().nullable().describe("The audience's CAC (cost per goal outcome) USD — cpc for visit-driven goals, cppr for reply-driven. null when unmeasured."),
    size: z.number().int(),
    remaining: z.number().int(),
    pctRemaining: z.number().nullable(),
  }).nullable().describe("The single best-performing audience by CAC. null when there is no goal to rank on or no audiences."),
  bestWorkflow: z.object({
    workflowDynastySlug: z.string(),
    name: z.string().nullable(),
    cacUsd: z.number().describe("Best (lowest) projected cost per outcome, USD, for the brand's goal."),
    grain: z.enum(["crossOrg", "brand", "audience"]).describe("Which grain the number comes from: crossOrg (fleet benchmark) | brand | audience."),
  }).nullable().describe("The single best workflow/model by CAC + its grain. null when no goal or no ranked workflow."),
  health: z.object({
    badge: z.enum(["green", "yellow", "red"]).describe("red = not active (paused/inactive/no budget); green = active AND ROI ≥ 1 AND audience not near-exhausted; yellow = active but ROI < 1 (or unknown) OR audience near-exhausted."),
    inputs: z.object({
      active: z.boolean(),
      hasBudget: z.boolean(),
      roiMultiple: z.number().nullable(),
      roiHealthy: z.boolean(),
      audiencePctUsed: z.number().nullable(),
      audienceNearExhausted: z.boolean(),
      audienceNearExhaustedThresholdPct: z.number().describe("The %used threshold above which an audience is 'near exhausted' (a yellow flag)."),
    }).describe("The inputs the badge was derived from (so the front can explain the badge)."),
  }),
  notTrackedYet: z.object({
    dashboardReturnFrequency: z.object({
      sessions7d: z.number().int().describe("Distinct dashboard sessions in the trailing 7 days."),
      sessions30d: z.number().int().describe("Distinct dashboard sessions in the trailing 30 days."),
      pageviews7d: z.number().int().describe("Dashboard pageviews in the trailing 7 days."),
      pageviews30d: z.number().int().describe("Dashboard pageviews in the trailing 30 days."),
      lastSeen: z.string().nullable().describe("ISO timestamp of the org's most recent dashboard pageview in the window. null when none."),
      daysSinceLastSeen: z.number().int().nullable().describe("Whole days between lastSeen and the board's asOf. null when lastSeen is null."),
    }).nullable().describe("Per-org dashboard-return frequency from PostHog (sessions 7d/30d + last-seen), keyed on the Clerk org id. null when PostHog has no data / is unreachable / is unconfigured — never fabricated."),
    budgetChangeHistory: z.array(z.object({
      dailyBudgetUsd: z.number().describe("Daily budget in USD after this change (0 = explicit pause)."),
      changedAt: z.string().describe("ISO timestamp the budget was set to this value."),
    })).nullable().describe("Daily-budget change timeline (billing-service, forward-only, oldest-first). Empty array = tracked, no changes yet; null = read failed / unconfigured — never fabricated."),
    pauseHistory: z.array(z.object({
      paused: z.boolean().describe("New pause state after this flip (true = paused, false = resumed)."),
      transitionedAt: z.string().describe("ISO timestamp of the flip."),
    })).nullable().describe("Pause on/off transition timeline (campaign-service, forward-only, oldest-first). Empty array = tracked, no flips yet; null = read failed / unconfigured — never fabricated."),
  }).describe("All three are now TRACKED upstream (dashboardReturnFrequency = PostHog; budgetChangeHistory = billing; pauseHistory = campaign). Each is null only when its producer is unreachable/unconfigured (fail-soft); an empty history array means tracked-but-nothing-yet. Never fabricated."),
});

const customerHealthStatsSchema = z.object({
  totalCustomers: z.number().int(),
  activeCount: z.number().int(),
  pausedCount: z.number().int(),
  inactiveCount: z.number().int(),
  greenCount: z.number().int(),
  yellowCount: z.number().int(),
  redCount: z.number().int(),
});

const customerHealthResponseSchema = z.object({
  customers: z.array(customerHealthRowSchema).describe("One ready-composed health row per cold-email customer (org × brand), currently-active first."),
  stats: customerHealthStatsSchema,
  asOf: z.string().describe("ISO timestamp the board was computed."),
});

const customerHealthResponseRef = registry.register("CustomerHealthResponse", customerHealthResponseSchema);

registry.registerPath({
  method: "get",
  path: "/internal/stats/customer-health",
  summary: "Fleet-wide customer-success health board (internal, api-key; staff-gated at api-service)",
  description:
    "Cross-org, fleet-wide 'Customer Success' health board — one ready-composed row per cold-email customer (org × brand), currently-active " +
    "first, with a green/yellow/red health badge. Every metric is computed + owned here; the admin dashboard renders only (no browser math, no " +
    "per-row fan-out). Each row carries: identity (org + brand, owner email, Clerk org id); recency + retention (first/last active day, retention " +
    "weeks, active-day timeline from billed spend); the brand's optimization goal; conversion-tracker context (whether a tracker is NEEDED for the " +
    "goal + an INFERRED firing flag from observed conversion counts — a clean installed/verified boolean is a known gap); breakeven CAC (= brand " +
    "LTR); full conversion economics + LTR; realized CAC / ROI / %CAC (roiMultiple = pipeline/spend = LTR/CAC; cacPct = spend/pipeline = CAC/LTR — " +
    "coherent by construction, own-economics only); an audiences rollup (total size, remaining, %used) + the single best audience by CAC; the single " +
    "best workflow by CAC + the grain it came from; and the current status (active/paused/inactive, same composition as GET /internal/stats/accounts). " +
    "Health: red = not active; green = active AND ROI ≥ 1 AND audience not near-exhausted; yellow = active but ROI < 1 (or unknown) OR audience " +
    "near-exhausted. Under notTrackedYet (all three now TRACKED upstream, null only on a fail-soft producer degrade): dashboardReturnFrequency = per-org PostHog return signal (sessions 7d/30d + last-seen); budgetChangeHistory = billing-service forward-only daily-budget change timeline; pauseHistory = campaign-service forward-only pause on/off timeline. Empty array = tracked-but-nothing-yet; never fabricated.",
  tags: ["Internal"],
  responses: {
    200: { description: "Per-customer health rows + fleet stats", content: { "application/json": { schema: customerHealthResponseRef } } },
    401: { description: "Invalid or missing API key", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Server error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /internal/stats/active-users ───────────────────────────────────────────

const activeUsersBucketSchema = z.object({
  period: z.string().describe("Bucket label — `YYYY-MM-DD` (daily), `YYYY-Www` ISO week (weekly), or `YYYY-MM` (monthly)."),
  periodStart: z.string().describe("UTC start date of the bucket (`YYYY-MM-DD`): the day, the ISO week's Monday, or the month's 1st. For charting."),
  activeUsers: z.number().int().describe("Distinct orgs that billed cold-email spend (were active) at least once in this bucket."),
  growthPct: z.number().nullable().describe("Period-over-period growth vs the previous bucket, in percent (1-decimal). null on the first bucket or when the previous bucket is 0."),
});

const activeUsersResponseSchema = z.object({
  currentTotal: z.number().int().describe("LIVE active-user count — distinct orgs with ≥1 active brand right now (the accounts-audit active verdict). Matches the accounts snapshot the admin page already renders."),
  monthly: z.array(activeUsersBucketSchema).describe("Trailing calendar-month buckets (oldest→newest)."),
  weekly: z.array(activeUsersBucketSchema).describe("Trailing ISO-week buckets (oldest→newest)."),
  daily: z.array(activeUsersBucketSchema).describe("Trailing UTC-day buckets (oldest→newest)."),
  asOf: z.string().describe("ISO timestamp the series was computed."),
});

const activeUsersResponseRef = registry.register("ActiveUsersHistoryResponse", activeUsersResponseSchema);

registry.registerPath({
  method: "get",
  path: "/internal/stats/active-users",
  summary: "Fleet-wide active-users history (internal, api-key; staff-gated at api-service)",
  description:
    "Cross-org, fleet-wide HISTORY of ACTIVE USERS (distinct orgs with an active, funded, non-paused cold-email brand) bucketed monthly, weekly, " +
    "and daily, each with a period-over-period growth rate, plus the current live total. 'Active user' = a distinct org with ≥1 active brand, " +
    "where active is the accounts-audit verdict (not paused, has a daily budget, credit funds ≥ the next day). The history is RECONSTRUCTED from " +
    "per-day ACTUALIZED cold-email spend (runs-service): a day of real billed cold-email spend implies the brand was not paused, had a budget, and " +
    "was funded — the same three conditions the live verdict checks, observed after the fact. Each bucket counts DISTINCT such orgs. currentTotal is " +
    "NOT reconstructed — it is the LIVE accounts-audit active-user count, so it stays coherent with GET /internal/stats/accounts; the last daily point " +
    "(realized spend so far today) may lag currentTotal (an org configured-active that hasn't billed yet today). Aggregate counts only — no per-org data. " +
    "Windows are trailing and end at today (UTC): daily default 90 (max 365), weekly default 26 (max 104), monthly default 12 (max 36).",
  tags: ["Internal"],
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).optional().describe("Trailing days in the daily series (default 90, max 365)."),
      weeks: z.coerce.number().int().min(1).max(104).optional().describe("Trailing ISO weeks in the weekly series (default 26, max 104)."),
      months: z.coerce.number().int().min(1).max(36).optional().describe("Trailing months in the monthly series (default 12, max 36)."),
    }),
  },
  responses: {
    200: { description: "Active-users history (monthly/weekly/daily + growth) + current total", content: { "application/json": { schema: activeUsersResponseRef } } },
    400: { description: "Invalid window parameter", content: { "application/json": { schema: errorResponse } } },
    401: { description: "Invalid or missing API key", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Server error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /internal/stats/revenue ─────────────────────────────────────────────────

const revenueBucketSchema = z.object({
  period: z.string().describe("Bucket label — `YYYY-MM-DD` (daily), `YYYY-Www` ISO week (weekly), or `YYYY-MM` (monthly)."),
  periodStart: z.string().describe("UTC start date of the bucket (`YYYY-MM-DD`): the day, the ISO week's Monday, or the month's 1st. For charting."),
  revenueUsd: z.number().describe("NET realized revenue (summed NET actual cold-email spend after per-org usage discount, all orgs) in this bucket, in USD (2-decimal)."),
  growthPct: z.number().nullable().describe("Period-over-period growth vs the previous bucket, in percent (1-decimal). null on the first bucket or when the previous bucket is 0."),
});

const committedMrrBucketSchema = z.object({
  period: z.string().describe("Bucket label — `YYYY-MM` (monthly) or `YYYY-Www` ISO week (weekly)."),
  periodStart: z.string().describe("UTC start date of the bucket (`YYYY-MM-DD`): the month's 1st or the ISO week's Monday. For charting."),
  mrrUsd: z.number().describe("Committed MRR as of this period (the last recorded snapshot in the period; the LIVE value for the current period), in USD (2-decimal). Budget projection (Σ active daily budget × 30) — UNDISCOUNTED (a budget is a config ceiling, not a charge)."),
  arrUsd: z.number().describe("Committed ARR = mrrUsd × 12, in USD (2-decimal); undiscounted budget projection."),
  growthPct: z.number().nullable().describe("Point-over-point growth vs the previous EMITTED bucket, in percent (1-decimal). null on the first bucket or when the previous point is 0."),
});

const committedMrrHistorySchema = z.object({
  currentMrrUsd: z.number().describe("LIVE committed MRR — fleet active daily budget × 30 (UNDISCOUNTED budget projection). The current-period point of monthly/weekly equals this (reconciles with GET /internal/stats/accounts mrrUsd)."),
  currentArrUsd: z.number().describe("LIVE committed ARR = currentMrrUsd × 12, in USD; undiscounted budget projection."),
  monthly: z.array(committedMrrBucketSchema).describe("Committed MRR/ARR by calendar month (oldest→newest). Past points come from real recorded daily snapshots; the current month is the live value. Periods with no recorded snapshot are omitted."),
  weekly: z.array(committedMrrBucketSchema).describe("Committed MRR/ARR by ISO week (oldest→newest). Same snapshot sourcing as monthly."),
});

const nrrBucketSchema = z.object({
  period: z.string().describe("Bucket label — `YYYY-MM` (monthly) or `YYYY-Www` ISO week (weekly)."),
  periodStart: z.string().describe("UTC start date of the bucket (`YYYY-MM-DD`): the month's 1st or the ISO week's Monday. For charting."),
  retentionPct: z
    .number()
    .nullable()
    .describe(
      "Net revenue retention for this period, in percent (1-decimal): the period's revenue from the customers who had revenue in the PREVIOUS period, " +
        "divided by those same customers' previous-period revenue. null when the rate could NOT be measured (no prior-period cohort — the first period, or a gap); " +
        "that is DISTINCT from a measured 0 (cohortSize > 0, priorRevenueUsd > 0, retainedRevenueUsd 0 = the base shrank to nothing). Never a substitute value, never carried forward.",
    ),
  cohortSize: z.number().describe("Number of orgs in the cohort FIXED AT THE START of the period (orgs with revenue in the PREVIOUS period). 0 ⇒ the rate is unmeasurable."),
  priorRevenueUsd: z.number().describe("The cohort's NET realized revenue in the PREVIOUS period (the denominator), USD 2-decimal."),
  retainedRevenueUsd: z.number().describe("The SAME cohort's NET realized revenue in THIS period (the numerator) — excludes every customer acquired during the period, USD 2-decimal."),
});

const nrrHistorySchema = z.object({
  monthly: z.array(nrrBucketSchema).describe("Net revenue retention by calendar month (oldest→newest), one point per bucket of the monthly revenue series."),
  weekly: z.array(nrrBucketSchema).describe("Net revenue retention by ISO week (oldest→newest), one point per bucket of the weekly revenue series."),
});

const revenueHistoryResponseSchema = z.object({
  totalRevenueUsd: z.number().describe("Cumulative NET realized revenue since inception (all orgs, all time; post per-org usage discount), in USD (2-decimal)."),
  currentMrrUsd: z.number().describe("LIVE committed MRR — fleet active daily budget × 30 (UNDISCOUNTED budget projection). Matches the mrrUsd the admin page renders from GET /internal/stats/accounts."),
  monthly: z.array(revenueBucketSchema).describe("Trailing calendar-month revenue buckets (oldest→newest)."),
  weekly: z.array(revenueBucketSchema).describe("Trailing ISO-week revenue buckets (oldest→newest)."),
  daily: z.array(revenueBucketSchema).describe("Trailing UTC-day revenue buckets (oldest→newest)."),
  sinceInceptionDaily: z.array(revenueBucketSchema).describe("Per-day realized-revenue line from the first billed day to today (the 'MRR over time' series)."),
  committedMrr: committedMrrHistorySchema.describe("COMMITTED MRR/ARR over time (monthly + weekly, each with growth) — the point-in-time run-rate the fleet is CONTRACTED to bill (Σ active daily budget × 30), NOT realized spend. Recorded as daily snapshots going forward (no historical backfill); the current-period point equals currentMrrUsd, ARR = MRR × 12. Additive + non-breaking to the realized series above."),
  netRevenueRetention: nrrHistorySchema.describe(
    "NET REVENUE RETENTION (NRR / NDR) over time, monthly + weekly. Standard aggregate definition: of the revenue existing customers produced in the PREVIOUS " +
      "period, how much those SAME customers produce in this one — expansion, contraction and churn among them, and NOTHING from customers acquired during the " +
      "period (the cohort is fixed at the start of the period; including new logos would turn this into a growth rate). Same NET realized cold-email revenue basis " +
      "as the series above, so the two reconcile. Aggregate method (all existing customers pooled), not a per-acquisition-cohort curve. Benchmarks: >100% the base " +
      "grows on its own, >120% is where public SaaS trades at a premium, <100% the base is shrinking. No TTM figure — the first billed day is March 2026.",
  ),
  asOf: z.string().describe("ISO timestamp the series was computed."),
});

const revenueHistoryResponseRef = registry.register("RevenueHistoryResponse", revenueHistoryResponseSchema);

registry.registerPath({
  method: "get",
  path: "/internal/stats/revenue",
  summary: "Fleet-wide realized-revenue history (internal, api-key; staff-gated at api-service)",
  description:
    "Cross-org, fleet-wide HISTORY of NET REALIZED REVENUE (summed ACTUALIZED cold-email spend after each org's usage discount, all orgs) bucketed monthly, weekly, and daily, " +
    "each with a period-over-period growth rate; plus the total since inception, a per-day-since-inception line (the 'MRR over time' series), and the " +
    "current live MRR. This is the MONEY twin of GET /internal/stats/active-users — the exact same per-day actualized cold-email spend signal, summed " +
    "in dollars instead of thresholded to a distinct-org headcount. A day of real billed cold-email spend is realized revenue that day (spend only " +
    "happens on a non-paused, budgeted, funded brand — the same conditions the accounts 'active' verdict checks, observed after the fact). currentMrrUsd " +
    "is NOT reconstructed — it is the LIVE accounts-audit MRR (fleet active daily budget × 30), the SAME number GET /internal/stats/accounts renders, so " +
    "the two tabs reconcile; the last daily point (realized spend so far today) legitimately lags currentMrrUsd. Aggregate totals only — no per-org data. " +
    "Also returns committedMrr: the COMMITTED MRR/ARR run-rate over time (monthly + weekly, each with growth) — Σ active daily budget × 30, what the fleet " +
    "is CONTRACTED to bill (distinct from realized spend). Committed MRR is a point-in-time snapshot that cannot be reconstructed from spend, so it is " +
    "persisted as a daily snapshot recorded GOING FORWARD (no historical backfill); the current-period point equals currentMrrUsd (reconciles) and ARR = MRR × 12. " +
    "Also returns netRevenueRetention: NRR/NDR over time (monthly + weekly) on the SAME realized-revenue basis — the period's revenue from the customers who had " +
    "revenue in the PREVIOUS period, over those same customers' previous-period revenue. The cohort is fixed at the start of the period, so customers acquired " +
    "during it contribute to neither leg; expansion, contraction and churn are already what the ratio measures. A period with no prior-period cohort reports " +
    "retentionPct null (unmeasurable), which is distinct from a measured 0. " +
    "Windows are trailing and end at today (UTC): daily default 90 (max 365), weekly default 26 (max 104), monthly default 12 (max 36). All amounts in USD.",
  tags: ["Internal"],
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).optional().describe("Trailing days in the daily series (default 90, max 365)."),
      weeks: z.coerce.number().int().min(1).max(104).optional().describe("Trailing ISO weeks in the weekly series (default 26, max 104)."),
      months: z.coerce.number().int().min(1).max(36).optional().describe("Trailing months in the monthly series (default 12, max 36)."),
    }),
  },
  responses: {
    200: { description: "Revenue history (monthly/weekly/daily + growth), total since inception, per-day line, and current MRR", content: { "application/json": { schema: revenueHistoryResponseRef } } },
    400: { description: "Invalid window parameter", content: { "application/json": { schema: errorResponse } } },
    401: { description: "Invalid or missing API key", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Server error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /internal/stats/active-users-by-user ───────────────────────────────────

const activeUserBrandSchema = z.object({
  brandId: z.string().describe("Brand UUID."),
  brandName: z.string().nullable(),
  brandDomain: z.string().nullable().describe("Brand domain — the admin's label fallback after Clerk org name / owner email."),
});

const activeUserRowSchema = z.object({
  orgId: z.string().describe("Internal org UUID."),
  orgExternalId: z.string().nullable().describe("Clerk org id (org_...); lets the admin resolve the org display name. null if unset."),
  ownerEmail: z.string().nullable().describe("The org owner's email (earliest-created user). null if the org has no users. Label fallback."),
  brands: z.array(activeUserBrandSchema).describe("Every cold-email brand of the org (id + name + domain). Label fallback (brand domain)."),
  firstActiveDay: z.string().describe("Earliest UTC day (`YYYY-MM-DD`) the org billed cold-email spend (inception)."),
  lastActiveDay: z.string().describe("Latest UTC day (`YYYY-MM-DD`) the org billed cold-email spend."),
  firstActiveWeek: z.string().describe("ISO-week label (`YYYY-Www`) of the first active day."),
  lastActiveWeek: z.string().describe("ISO-week label (`YYYY-Www`) of the last active day."),
  firstActiveMonth: z.string().describe("Calendar-month label (`YYYY-MM`) of the first active day."),
  lastActiveMonth: z.string().describe("Calendar-month label (`YYYY-MM`) of the last active day."),
  retentionWeeks: z.number().int().describe("Retention window in ISO weeks = inclusive span between the first and last active week ((lastWeekMonday − firstWeekMonday)/7 + 1). A user active in exactly one week → 1."),
  activeThisWeek: z.boolean().describe("Whether the org was active at least once in the current ISO week (tab count / filter)."),
  activeThisMonth: z.boolean().describe("Whether the org was active at least once in the current calendar month (tab count / filter)."),
  activeDays: z.array(z.string()).describe("Distinct active UTC days (`YYYY-MM-DD`), ascending — the day-by-day drill-down."),
  activeWeeks: z.array(z.string()).describe("Distinct active ISO weeks (`YYYY-Www`), ascending — the week-by-week drill-down."),
  activeMonths: z.array(z.string()).describe("Distinct active calendar months (`YYYY-MM`), ascending — the month-by-month drill-down."),
});

const activeUsersByUserStatsSchema = z.object({
  totalUsers: z.number().int().describe("Number of users ever active (= users.length)."),
  activeThisWeekCount: z.number().int().describe("Users active at least once in the current ISO week."),
  activeThisMonthCount: z.number().int().describe("Users active at least once in the current calendar month."),
});

const activeUsersByUserResponseSchema = z.object({
  users: z.array(activeUserRowSchema).describe("One row per user (org) EVER active (≥1 billed cold-email day), sorted most-recently-active first."),
  stats: activeUsersByUserStatsSchema,
  currentWeek: z.string().describe("Current ISO-week label (`YYYY-Www`) — the boundary the activeThisWeek flag / tab count uses."),
  currentMonth: z.string().describe("Current calendar-month label (`YYYY-MM`) — the boundary the activeThisMonth flag / tab count uses."),
  asOf: z.string().describe("ISO timestamp the breakdown was computed."),
});

const activeUsersByUserResponseRef = registry.register("ActiveUsersByUserResponse", activeUsersByUserResponseSchema);

registry.registerPath({
  method: "get",
  path: "/internal/stats/active-users-by-user",
  summary: "Fleet-wide per-user active history (internal, api-key; staff-gated at api-service)",
  description:
    "Cross-org, fleet-wide PER-USER breakdown of the active-users history — one row per USER (a distinct org with an active, funded, " +
    "non-paused cold-email brand) EVER active, carrying that user's active months / weeks / days SINCE INCEPTION plus a pre-derived summary " +
    "(first/last active month, first/last active week, retention-window-in-weeks) and current-week / current-month 'active at least once' flags " +
    "for the admin tab counts. SAME universe + SAME 'active' notion as GET /internal/stats/active-users: an active day = a day of real billed " +
    "cold-email spend (the accounts active-verdict — not paused, had a budget, funded — observed after the fact). 'Inception' goes back to each " +
    "org's earliest billed cold-email day; an org that was never active is OMITTED. PER-ORG rows are allowed because this is a staff-only admin " +
    "surface (staff-gated at api-service, like the accounts audit); each row carries identity (Clerk org id, owner email, brand name/domain) for " +
    "labelling. Does NOT change GET /internal/stats/active-users (aggregate counts) — this is an additive per-user companion. Aggregate + per-user " +
    "stay coherent (same realized-activity signal).",
  tags: ["Internal"],
  responses: {
    200: { description: "Per-user active history rows + tab-count stats + current week/month", content: { "application/json": { schema: activeUsersByUserResponseRef } } },
    401: { description: "Invalid or missing API key", content: { "application/json": { schema: errorResponse } } },
    500: { description: "Server error", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/cost-projection ─────────────────────────────────────────

const objectiveAveragesSchema = z.object({
  websiteVisit: z.number().nullable().describe("Fleet-average cost per website visit (CPC = cost per click)."),
  positiveReply: z.number().nullable().describe("Fleet-average cost per positive reply (CPPR)."),
  signup: z.number().nullable().describe("Fleet-average projected cost per self-serve signup."),
  formSubmission: z.number().nullable().describe("Fleet-average projected cost per form submission."),
  meetingBooked: z.number().nullable().describe("Fleet-average projected cost per meeting booked."),
  websitePurchase: z.number().nullable().describe("Fleet-average projected cost per website purchase (multi-step self-serve/meeting close — RENAMED from `purchase`)."),
  sales: z.number().nullable().describe("Fleet-average projected cost per SALE (combined goal — a paying client won via EITHER the visit→paid OR reply→paid path, valued at CLTV)."),
  whatsappConversation: z.number().nullable().describe("Fleet-average cost per WhatsApp conversation (CPC — the click on the brand's WhatsApp link IS the started conversation; no paid-client economics)."),
}).describe("Fleet-average cost-per-outcome per optimization objective. Each = mean across client brands of that brand's best-workflow value; null when no brand is backed for the objective.");

const publicCostProjectionResponseSchema = z.object({
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
  featureSlug: z.string(),
  avgCostPerMeetingBooked: z.number().nullable().describe("Legacy (Wave 1) alias of avgCostPerOutcomeByObjective.meetingBooked. Null when no brand has usable economics."),
  avgCostPerPurchase: z.number().nullable().describe("Legacy (Wave 1) alias of avgCostPerOutcomeByObjective.websitePurchase (renamed from purchase; the field name stays for admin back-compat). Null when no brand has usable economics."),
  avgCostPerOutcomeByObjective: objectiveAveragesSchema,
  brandCount: z.number().int().describe("Number of client brands with usable economics that contributed to the averages."),
});

const objectiveQueryParam = z
  .string()
  .describe("Optimization objective — one of websiteVisit / positiveReply / signup / formSubmission / meetingBooked / purchase (snake / camel / kebab spellings accepted; self-serve aliases signup).");

const costPerOutcomeTrendResponseSchema = z.object({
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
  featureSlug: z.string(),
  objective: z.string().describe("Canonical camelCase objective the series is for."),
  windowOutcomes: z.number().int().describe("Target number of base outcomes each trailing moving-average window spans."),
  points: z.array(z.object({
    date: z.string().describe("UTC day (YYYY-MM-DD) this moving-average point is anchored to."),
    costPerOutcomeUsd: z.number().nullable().describe("Moving-average cost-per-outcome over the trailing window ending at date. Null when the window is unbacked — never a false $0."),
    windowOutcomeCount: z.number().describe("Count of the objective's base outcomes (clicks / replies / clicks+replies) inside the window."),
    windowSpentUsd: z.number().describe("Total fleet spend (USD) over the window's days."),
    windowStartDate: z.string().describe("First UTC day included in the trailing window."),
  })).describe("Dense dated series (one point per trailing display day)."),
});

const workflowCostPerOutcomeResponseSchema = z.object({
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
  featureSlug: z.string(),
  objective: z.string().describe("Canonical camelCase objective the ratios are for."),
  windowOutcomes: z.number().int().describe("Trailing-window size (base outcomes) the per-row recentCostPerOutcomeUsd moving average targets — the SAME window semantics as /public/stats/cost-per-outcome-trend."),
  workflows: z.array(z.object({
    workflowDynastySlug: z.string(),
    workflowDynastyName: z.string(),
    spentUsd: z.number().describe("Cross-org fleet spend (USD) attributed to this workflow dynasty."),
    observedClicks: z.number(),
    observedPositiveReplies: z.number(),
    costPerOutcomeUsd: z.number().nullable().describe("LIFETIME (all-history) pooled cost-per-outcome — what the workflow has cost per outcome over ALL history. Populated cost (projected cascade floor: max(spent, fleet unit cost) when the outcome denominator is 0), so non-null whenever the workflow has spend and fleet economics exist."),
    recentCostPerOutcomeUsd: z.number().nullable().describe("RECENT going rate — the trailing-window moving-average cost-per-outcome over the workflow's most recent ~windowOutcomes base outcomes (same window semantics as /public/stats/cost-per-outcome-trend, scoped to this dynasty). Distinct from the lifetime costPerOutcomeUsd. Null (never a false $0) when the workflow has no backed recent window, no fleet economics, or the projected objective's rate is absent."),
  })).describe("One row per workflow dynasty, sorted by spend desc. Each row carries BOTH the lifetime cost-per-outcome and the recent trailing-window moving-average cost-per-outcome for the objective."),
});

const bestModelCostPerOutcomeTrendResponseSchema = z.object({
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
  featureSlug: z.string(),
  objective: z.string().describe("Canonical camelCase objective the series is for."),
  windowOutcomes: z.number().int().describe("Target number of base outcomes each trailing moving-average window spans."),
  bestWorkflowDynastySlug: z.string().nullable().describe("The single best workflow dynasty this series plots — the currently-cheapest by LIFETIME cost-per-outcome among dynasties with the objective's observed base outcome > 0 (the SAME pick /public/stats/workflow-cost-per-outcome's min makes). Null when no workflow has an observed outcome (cold start)."),
  bestWorkflowDynastyName: z.string().nullable().describe("Display name of the best workflow dynasty. Null when no best model exists."),
  bestWorkflowLifetimeCostPerOutcomeUsd: z.number().nullable().describe("The best model's LIFETIME cost-per-outcome (USD) — the headline number this trend's most-recent backed point tracks. Null when no best model exists."),
  points: z.array(z.object({
    date: z.string().describe("UTC day (YYYY-MM-DD) this moving-average point is anchored to."),
    costPerOutcomeUsd: z.number().nullable().describe("The BEST model's moving-average cost-per-outcome over the trailing window ending at date — a SINGLE workflow's cost, never pooled across workflows. Null when the window is unbacked — never a false $0."),
    windowOutcomeCount: z.number().describe("Count of the objective's base outcomes (clicks / replies / clicks+replies) inside the best model's window."),
    windowSpentUsd: z.number().describe("The best model's spend (USD) over the window's days."),
    windowStartDate: z.string().describe("First UTC day included in the trailing window."),
  })).describe("Dense dated series of the best model's cost-per-outcome (one point per trailing display day). Empty when no best model exists (cold start)."),
});

const costPerOutcomeLifetimeResponseSchema = z.object({
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
  featureSlug: z.string(),
  avgCostPerOutcomeByObjective: objectiveAveragesSchema.describe(
    "Pooled LIFETIME (all-history) cost-per-outcome per objective — total fleet spend ÷ total fleet outcomes, projected objectives through the fleet-mean economics. The window→∞ limit of cost-per-outcome-trend. Null where the objective is unbacked; never a false $0.",
  ),
  totalSpentUsd: z.number().describe("Total cross-org fleet spend (USD, committed) over all dated history."),
  totalClicks: z.number().describe("Total cross-org clicks (website visits) over all dated history — the CPC denominator."),
  totalPositiveReplies: z.number().describe("Total cross-org positive replies over all dated history — the CPPR denominator."),
  brandCount: z.number().int().describe("Number of client brands with usable economics that backed the fleet-mean projection."),
});

const costPerOutcomeDistributionResponseSchema = z.object({
  costBasis: z.literal("incurred").describe("PERFORMANCE — the CROSS-ORG FLEET BENCHMARK: what a workflow COSTS to produce an outcome. Spend the platform COMPED counts here at FULL value, because a comped brand must not read artificially cheap, drag the fleet benchmark down for every other customer, or under-price what their budget buys. This is the opposite of a customer-facing money surface (/revenue, /stats, /audience-stats), which answers the CHARGED question and drops comped spend under the same words. ORTHOGONAL to ?pricing=gross|net."),
  featureSlug: z.string(),
  objective: z.string().describe("Canonical camelCase objective the distribution is for."),
  unit: z.literal("brand").describe("Each data point is one brand's pooled all-history cost-per-outcome."),
  bucketCount: z.number().int().describe("Number of equal-width histogram bars requested (may collapse to 1 when all values are equal)."),
  brandCount: z.number().int().describe("Number of brands that contributed a usable ( > 0 ) per-brand cost-per-outcome data point."),
  buckets: z.array(z.object({
    minUsd: z.number().describe("Lower edge of the bar (USD, inclusive)."),
    maxUsd: z.number().describe("Upper edge of the bar (USD). Exclusive except on the last bar, where the max value lands."),
    count: z.number().int().describe("Number of brands whose per-brand cost-per-outcome falls in this bar."),
  })).describe("Histogram bars over [min, max]. Empty when brandCount is below the minimum to form a distribution."),
  mean: z.number().nullable().describe("Unweighted mean of the per-brand costs (the going rate across brands). Null when insufficient data — never a false $0."),
  median: z.number().nullable().describe("Median per-brand cost (50th percentile). Null when insufficient data."),
  min: z.number().nullable().describe("Cheapest brand's cost-per-outcome (the cheap tail). Null when insufficient data."),
  max: z.number().nullable().describe("Most expensive brand's cost-per-outcome (the expensive tail). Null when insufficient data."),
  p25: z.number().nullable().describe("25th percentile — lower edge of the bulk. Null when insufficient data."),
  p75: z.number().nullable().describe("75th percentile — upper edge of the bulk. Null when insufficient data."),
  stddev: z.number().nullable().describe("Population standard deviation of the per-brand costs (a scalar sense of the spread). Null when insufficient data."),
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

// ── GET /public/stats/cost-per-outcome-trend ─────────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/cost-per-outcome-trend",
  summary: "Dated moving-average cost-per-outcome series per objective (public, no auth)",
  description:
    "Cross-org (fleet-wide) trend of a feature's cost-per-outcome for ONE objective over time. Each display day anchors a trailing window that walks backward until it holds ~windowOutcomes of the objective's base outcomes; the point = that window's fleet spend ÷ outcomes (projected objectives push the window unit costs through the fleet-mean economics). Joins runs-service dated fleet spend against email-gateway dated outcomes. Cost points are null where the window is unbacked — never a false $0.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      objective: objectiveQueryParam,
      days: z.string().optional().describe("Number of trailing display days to emit (default 30, max 180)."),
      windowOutcomes: z.string().optional().describe("Target outcomes per moving-average window (default 100)."),
    }),
  },
  responses: {
    200: { description: "Dated moving-average cost-per-outcome series", content: { "application/json": { schema: costPerOutcomeTrendResponseSchema } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/workflow-cost-per-outcome ──────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/workflow-cost-per-outcome",
  summary: "Per-workflow cross-org cost-per-outcome for an objective (public, no auth)",
  description:
    "Cross-org (fleet-wide) per-workflow-dynasty cost-per-outcome for ONE objective. Each row carries TWO cost-per-outcome rates: (1) costPerOutcomeUsd — the LIFETIME all-history pooled rate (guaranteed to populate when the workflow has spend: unit costs run through the projected cost-engine, flooring to max(spent, fleet unit cost) when the outcome denominator is 0), and (2) recentCostPerOutcomeUsd — the RECENT trailing-window moving average over the workflow's most recent ~windowOutcomes base outcomes (same window semantics as /public/stats/cost-per-outcome-trend, scoped to the single dynasty; null when the dynasty has no backed recent window). Same crossOrg dynasty rollup as /public/stats/best. Sorted by spend desc.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      objective: objectiveQueryParam,
      windowOutcomes: z.string().optional().describe("Trailing-window size (base outcomes) for recentCostPerOutcomeUsd. Default 100, clamped to 100000 — same default/clamp as /public/stats/cost-per-outcome-trend."),
    }),
  },
  responses: {
    200: { description: "Per-workflow cross-org cost-per-outcome", content: { "application/json": { schema: workflowCostPerOutcomeResponseSchema } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/best-model-cost-per-outcome-trend ──────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/best-model-cost-per-outcome-trend",
  summary: "Dated cost-per-outcome trend of the single BEST cross-org workflow model (public, no auth)",
  description:
    "Cross-org (fleet-wide) dated moving-average cost-per-outcome series of the SINGLE BEST workflow model for ONE objective — the drop-in replacement for the pooled /public/stats/cost-per-outcome-trend, made coherent with the 'best model' headline (min cost-per-outcome across workflows from /public/stats/workflow-cost-per-outcome). The best model is picked ONCE (cheapest LIFETIME cost-per-outcome among dynasties with the objective's observed base outcome > 0 — the SAME pick the headline makes), then its OWN dated trailing-window moving average is plotted: every point is a SINGLE workflow's cost, NEVER pooled/blended across workflows. The most-recent backed point tracks the best-model headline number (bestWorkflowLifetimeCostPerOutcomeUsd). Cost points null where the best model's window is unbacked — never a false $0.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      objective: objectiveQueryParam,
      days: z.string().optional().describe("Number of trailing display days to emit (default 30, max 180)."),
      windowOutcomes: z.string().optional().describe("Target outcomes per moving-average window (default 100)."),
    }),
  },
  responses: {
    200: { description: "Dated best-model cost-per-outcome series", content: { "application/json": { schema: bestModelCostPerOutcomeTrendResponseSchema } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── The public acquisition-channel catalogue ─────────────────────────────

const channelTermsSchema = z.object({
  dailyOperatingCostCents: z.number().int().describe("What operating this channel costs for a DAY regardless of volume, in whole cents. A phone channel carries the person on the line; an ad platform carries its own daily floor; a specialist-run channel carries that salary. A commercial figure we set, never a measured one."),
  minimumCommitmentDays: z.number().int().describe("The shortest booking we sell, in days."),
  maxDaysToFirstProduction: z.number().int().describe("UPPER BOUND on how many days after booking the channel starts producing — a promise, not an estimate. A channel we are slower to deliver says so HERE; there is deliberately no availability or coming-soon flag anywhere on this payload."),
});

const channelStepSchema = z.object({
  key: z.enum([
    "conversation",
    "website_visit",
    "meeting_booked",
    "meeting_attended",
    "signup",
    "form_filled",
    "paid_client",
    "in_ad_form_submission",
    "in_ad_booked_meeting",
  ]),
  label: z.string(),
  description: z.string(),
});

const funnelArrowSchema = registry.register(
  "FunnelArrow",
  z.object({
    arrowKey: z.string().describe("The arrow's single canonical identifier — minted and owned here, and a PUBLISHED CONTRACT: the fleet keys campaigns and budgets on it. Join it against this catalogue; never parse it back into its parts."),
    fromStep: channelStepSchema.nullable().describe("The step a lead is taken OUT of. NULL is 'from nothing' — this arrow STARTS a funnel. That is the special case in the DATA only: the identifier is as ordinary as any other, so a caller never spells an entry arrow differently."),
    toStep: channelStepSchema.describe("The step a lead is moved TO."),
    funnelKeys: z.array(salesFunnelKeyEnum).describe("EVERY declared sales funnel this arrow is a leg of, in catalogue order. Usually several — an ENTRY arrow feeds every funnel that contains it AT ONCE, since nobody can buy traffic that travels down only one of them. Their figures therefore overlap and must never be summed."),
  }),
);

const channelStepTransitionSchema = z.object({
  arrowKey: z.string().describe("The ONE canonical identifier of the ARROW this leg is (e.g. `start_to_conversation`, `meeting_booked_to_meeting_attended`) — minted and owned by features-service, and the value the fleet keys a campaign and a budget on. Performance is measured per ARROW; a sales funnel is a way of READING arrows, because one arrow belongs to several funnels at once. Name a leg with this alone: the two steps ride BESIDE it as `from`/`to`, so a consumer READS them and NEVER splits the string. An arrow that STARTS a funnel carries an ordinary identifier like every other — `from: null` is the special case in the data, never in the vocabulary."),
  from: channelStepSchema.nullable().describe("The step this channel takes a lead OUT of. NULL is 'from nothing' — the lead was not on the funnel at all until this channel produced its first step, which is the SPECIAL case rather than the rule."),
  to: channelStepSchema.describe("The step this channel moves the lead TO."),
});

const publicChannelSchema = registry.register(
  "PublicAcquisitionChannel",
  z.object({
    slug: z.string().describe("The feature slug. A channel IS a feature slug in this fleet; there is no separate channel entity."),
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    displayOrder: z.number().int(),
    family: z.enum(["outbound_one_to_one", "paid_reach", "earned", "conversion"]),
    operatedBy: z.enum(["platform", "customer"]).describe("WHO puts the hours in. `platform` is us, and the daily operating cost is what that costs. `customer` is their own founder or team, so the platform spends nothing and the daily operating cost is 0 — a stated fact, not a blank. What such a leg costs THEM is declared per lead against lead-service; this catalogue never guesses at it."),
    terms: channelTermsSchema,
    stepTransitions: z.array(channelStepTransitionSchema).describe("Every LEG this channel performs: which step it moves a lead FROM and which step it moves it TO. A funnel is sold leg by leg, not only end to end — booking a meeting, getting it held, and closing it are three separate things to buy. `from: null` means the channel moves a lead from nothing onto the funnel's first step."),
    producibleSteps: z.array(channelStepSchema).describe("The steps this channel produces FROM NOTHING — DERIVED as the `to` of its `from: null` legs, and unchanged in meaning from before a channel could state an internal leg. A channel that only performs internal legs of a funnel legitimately produces none."),
    salesFunnels: z.array(z.object({ key: z.string(), name: z.string(), steps: z.array(z.string()) })).describe("The sales funnels this channel may be SOLD THROUGH — DERIVED as every declared funnel containing one of its `stepTransitions` as a leg, so it can never drift from them. An empty list is a real statement (no deployed funnel takes any step this channel performs), not a gap."),
  }),
);

const channelCatalogueResponseSchema = registry.register(
  "ChannelCatalogueResponse",
  z.object({
    channels: z.array(publicChannelSchema),
    arrows: z.array(funnelArrowSchema).describe("The ARROW vocabulary — every arrow of every declared sales funnel, each with its single canonical identifier, the two steps it connects, and the funnels it is a leg of. Published so a consumer never derives an arrow from a pair of steps and never hardcodes the list. An arrow usually belongs to SEVERAL funnels (a booked meeting becomes an attended meeting in both meeting funnels), which is exactly why a campaign is bought per ARROW rather than per funnel — and why two funnels' figures OVERLAP on their shared arrows and must never be summed."),
    steps: z.array(channelStepSchema).describe("The step vocabulary itself, published so a consumer never hardcodes it to join a channel's legs against a funnel's. It spans EVERY step of every funnel, not only the ones a funnel can start from — a channel performing an internal leg names the step it moves a lead OUT of, and that step is never one a funnel starts at."),
  }),
);

registry.registerPath({
  method: "get",
  path: "/public/channels",
  summary: "Every acquisition channel, its commercial terms and what it can produce (public, no auth)",
  description:
    "The published acquisition-channel catalogue: every channel a customer can book, the commercial terms they commit to before anything is measured (daily operating cost whatever the volume, minimum commitment in days, upper bound on how long until it starts producing), which LEG of a funnel it performs (the step it moves a lead FROM and the step it moves it TO), who operates it, and the sales funnels that follow from those legs. A funnel is sellable LEG BY LEG rather than only end to end, so the catalogue publishes channels for the internal steps a human performs — the ones a specialist of ours runs and the ones the customer runs themselves. A channel the CUSTOMER operates spends none of the platform's money, so its daily operating cost is 0 and `operatedBy` is what makes that zero legible. NO customer identity anywhere in the path — the marketing site is generated from this and must never be able to drift from what we actually charge. Every published channel is BOOKABLE: there is no availability or coming-soon flag to consult, and a channel we are slower to deliver says so through its own terms. Each offering appears EXACTLY ONCE, under the slug that is current: a feature whose slug has been RETIRED (it names its successor in `supersededBySlug` on the authenticated feature row) is not listed here and returns no pair on /public/channel-funnel-economics, while every authenticated per-brand and per-campaign read of it keeps working unchanged.",
  tags: ["Public"],
  responses: {
    200: { description: "The acquisition-channel catalogue", content: { "application/json": { schema: channelCatalogueResponseSchema } } },
  },
});

// ── GET /public/channel-funnel-economics ─────────────────────────────────

const pricedStepSchema = z.object({
  step: z.string().describe("The step, worded exactly as brand-service words it in the funnel."),
  milestone: z.boolean().describe("True for the step the funnel is NAMED after — its MILESTONE."),
  costPerStepUsd: z.number().nullable().describe("What reaching this step costs through this pair. NULL when it cannot be priced — never 0, which would read as 'this step is free'."),
  unpricedReason: z.enum(["rate_not_declared", "rate_is_zero"]).nullable().describe("Present exactly when `costPerStepUsd` is null."),
});

const pairEconomicsSchema = z.object({
  steps: z.array(pricedStepSchema),
  costPerSaleUsd: z.number().nullable().describe("What one SALE costs through this pair — the terminal step's own price."),
  costPerSaleUnpricedReason: z.enum(["rate_not_declared", "rate_is_zero"]).nullable(),
  returnPerDollar: z.number().nullable().describe("lifetimeRevenueUsd / costPerSaleUsd — the identical definition /features/{slug}/funnel-ranking ranks a brand's declared funnels on. Null, never 0, when either half is missing."),
  lifetimeRevenueUsd: z.number().nullable(),
  evidence: z.object({
    totalSpentUsd: z.number(),
    conversationsProduced: z.number(),
    websiteVisitsProduced: z.number(),
    brandCount: z.number().int(),
  }),
});

const channelFunnelPairSchema = registry.register(
  "ChannelFunnelPair",
  z.object({
    channelSlug: z.string(),
    channelName: z.string(),
    funnelKey: z.string(),
    funnelName: z.string(),
    funnelSteps: z.array(z.string()),
    result: z.union([
      z.object({ measured: z.literal(true), economics: pairEconomicsSchema }),
      z.object({
        measured: z.literal(false),
        reason: z.enum(["no_spend_recorded", "no_entry_step_produced", "no_economics_declared"]).describe("Which INGREDIENT is missing. A pair we have not measured enough SAYS SO rather than returning a figure or an empty value a consumer would have to interpret."),
      }),
    ]),
  }),
);

const channelFunnelEconomicsResponseSchema = registry.register(
  "ChannelFunnelEconomicsResponse",
  z.object({
    channelSlug: z.string().nullable().describe("The channel this read was narrowed to, or null for the whole catalogue."),
    pairs: z.array(channelFunnelPairSchema),
  }),
);

registry.registerPath({
  method: "get",
  path: "/public/channel-funnel-economics",
  summary: "Measured economics per (sales funnel, acquisition channel) pair, or an explicit not-enough-data (public, no auth)",
  description:
    "One row per (sales funnel, acquisition channel) PAIR: either the pair's MEASURED economics — cost per each STEP of that funnel, cost per SALE, and return per dollar — or an explicit statement that there is not enough data, naming which ingredient is missing. A customer buys a PAIR, and the same funnel costs a very different amount through a phone channel than through paid search, so neither a brand-level nor a channel-level aggregate can answer this. Evidence is the SAME cross-org per-brand dataset every other public cost surface reads, and a funnel is priced through its OWN channel (the conversation funnel on replies, the click-driven funnels on visits), so a public per-pair figure and a customer's own dashboard can never print two prices for one funnel. Nothing is fabricated: a pair with no spend, no produced entry step, or no declared economics returns `measured: false` with its reason.",
  tags: ["Public"],
  request: {
    query: z.object({
      channelSlug: z.string().optional().describe("Narrow to one channel. Omitted returns every pair in the catalogue. An unknown slug is a 404, never an empty pair list."),
    }),
  },
  responses: {
    200: { description: "Per-pair economics", content: { "application/json": { schema: channelFunnelEconomicsResponseSchema } } },
    404: { description: "Acquisition channel not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/cost-per-outcome-lifetime ──────────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/cost-per-outcome-lifetime",
  summary: "Lifetime (all-history) cross-org average cost-per-outcome per objective (public, no auth)",
  description:
    "Cross-org (fleet-wide) LIFETIME pooled average cost-per-outcome for EVERY optimization objective in one call: total all-history fleet spend ÷ total all-history fleet outcomes, projected objectives pushed through the fleet-mean economics. This is the window→∞ limit of /public/stats/cost-per-outcome-trend (same runs-service dated spend + email-gateway dated outcomes, summed over all days), so each objective's all-time average is exactly where its trend line converges. A true lifetime average cannot be recovered from the moving-average windows (avg-of-windows ≠ lifetime avg), so it is a backend-owned field. Null per objective when its denominator is 0 or its rate is absent — never a false $0.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
    }),
  },
  responses: {
    200: { description: "Lifetime cross-org average cost-per-outcome per objective", content: { "application/json": { schema: costPerOutcomeLifetimeResponseSchema } } },
    400: { description: "Missing parameters", content: { "application/json": { schema: errorResponse } } },
    404: { description: "Feature not found", content: { "application/json": { schema: errorResponse } } },
  },
});

// ── GET /public/stats/cost-per-outcome-distribution ──────────────────────

registry.registerPath({
  method: "get",
  path: "/public/stats/cost-per-outcome-distribution",
  summary: "Cross-org distribution (histogram) of cost-per-outcome across brands for an objective (public, no auth)",
  description:
    "Cross-org (fleet-wide) DISTRIBUTION of a feature's cost-per-outcome for ONE objective — the spread ACROSS the brands the fleet runs, so a consumer can draw a histogram (equal-width bars + counts) plus the central tendency (mean, median) and the spread (min / p25 / p75 / max / stddev). The unit is the BRAND: each brand contributes one data point = its pooled all-history cost-per-outcome, goal-bucketed exactly like /public/stats/cost-per-outcome-trend and -lifetime. The payload carries only aggregate buckets + summary stats (no per-brand value or id). Returned empty/soft (buckets: [], scalars null) when fewer than 2 brands have a usable cost — never a false $0. NOTE the mean/median here are the UNWEIGHTED per-brand going rate, which legitimately differs from -lifetime's spend-weighted pooled average.",
  tags: ["Public"],
  request: {
    query: z.object({
      featureSlug: z.string().describe("Feature slug (required)."),
      objective: objectiveQueryParam,
      buckets: z.string().optional().describe("Number of equal-width histogram bars (default 10, max 50)."),
    }),
  },
  responses: {
    200: { description: "Cross-org distribution of cost-per-outcome across brands", content: { "application/json": { schema: costPerOutcomeDistributionResponseSchema } } },
    400: { description: "Missing or invalid parameters", content: { "application/json": { schema: errorResponse } } },
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
