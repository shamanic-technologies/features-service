import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchActiveAudiences, fetchAudienceMemberEmails, type Audience } from "../lib/human-client.js";
import { fetchEmailOutcomes } from "../lib/email-status-client.js";
import {
  fetchPublicCosts,
  fetchPublicEmailStats,
  fetchPublicWorkflows,
  type WorkflowMetadata,
} from "../lib/public-stats-clients.js";
import { fetchBrandWorkflowEvidence } from "../lib/workflow-projection-grains.js";
import { parsePricing, selectCostCentsString, type Pricing } from "../lib/pricing.js";
import { fetchEffectiveEconomics, economicsFingerprint, type EffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts, type SalesEconomics } from "../lib/funnel-registry.js";
import {
  fetchConversionCountsByDay,
  type ConversionCountsByDay,
} from "../lib/conversion-counts-by-day-client.js";
import { aggregateAcrossChains, buildUpgradeChains } from "./public.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { resolveOfferCampaignIds, OfferHasNoCampaignsError } from "../lib/offer-scope.js";

const router = Router();

type MetricName = "outreach" | "opens" | "clicks";

interface MetricValue {
  actual: number | null;
  expected: number | null;
}

interface SignupMetricValue extends MetricValue {
  conversionPct: number | null;
}

/**
 * Fetch the brand's REAL per-day attributed conversion counts, degrading to absent (null) on any
 * failure — mirrors the Overview's `fetchConversionCountsSoft`. The per-day OBSERVED conversion series
 * is display enrichment on top of the forecast graph, exactly like the `/conversion-counts` tiles and
 * the `sequences` series; a lead-service blip must NOT 502 the whole pipeline-activity graph, it just
 * degrades the signup/form-submission ACTUAL bars to "unknown" (never a fabricated count). Loud log,
 * never a silent swallow. The underlying client is fail-loud.
 */
function fetchConversionCountsByDaySoft(brandId: string): Promise<ConversionCountsByDay | null> {
  return fetchConversionCountsByDay(brandId).catch((err) => {
    console.warn(
      `[features-service] conversion-counts-by-day observed series failed (degrading to absent): ${(err as Error).message}`,
    );
    return null;
  });
}

interface DayBucket {
  date: string;
  isToday: boolean;
  metrics: {
    outreach: MetricValue;
    opens: MetricValue;
    clicks: MetricValue;
    // Signup daily bar. `.actual` (today + past days) = the REAL attributed per-day conversion count
    // from lead-service; `.expected` (future days) = the clicks × visit→signup projection; conversionPct
    // carries that projection rate.
    signups: SignupMetricValue;
    // Form-submission daily bar — the visit-driven sibling of signups. Same split: `.actual` = the REAL
    // per-day form-submission conversion count from lead-service; `.expected` = the clicks × visit→form
    // projection; conversionPct carries that rate.
    formSubmissions: SignupMetricValue;
  };
}

interface PipelineActivityResponse {
  /**
   * PERFORMANCE. This surface publishes no cost COLUMN, but its `expected.*` series are money-DERIVED
   * (`expected.outreach = dailyBudgetUsd / costPerOutreach`), and that divisor is read INCURRED: a
   * dollar buys the same number of sends whether or not the platform later comped it, so comping must
   * never promise a brand more sends than its budget can buy. Every `.actual` count and the daily
   * budget itself are cost-free / configuration and carry no basis. See `lib/cost-basis.ts`.
   */
  costBasis: "incurred";
  featureSlug: string;
  brandId: string;
  timezone: string;
  generatedAt: string;
  days: DayBucket[];
  summary: {
    dailyBudgetUsd: number | null;
    openRatePct: number | null;
    clickToSignupPct: number | null;
    clickToFormSubmissionPct: number | null;
    // REAL attributed conversions whose day genuinely can't be determined (received_at IS NULL — 0 in
    // practice). Counted here so they are NEVER dropped and NEVER assigned a fabricated day in `days[]`.
    // null when the observed series degraded (lead-service unavailable).
    undatedSignups: number | null;
    undatedFormSubmissions: number | null;
  };
}

interface WorkflowActivityUnit {
  workflowDynastySlug: string;
  workflowSlugs: string[];
  outreachUsd: number | null;
  clickUsd: number | null;
  costPerSignupUsd: number | null;
  openPerOutreach: number | null;
  clickPerOutreach: number | null;
}

interface ExpectedActivity {
  outreach: number | null;
  opens: number | null;
  clicks: number | null;
  signups: number | null;
  formSubmissions: number | null;
  dailyBudgetUsd: number | null;
  openRatePct: number | null;
  clickToSignupPct: number | null;
  // Brand effective visit→form-submission percent (the form-submission projection rate). Null when
  // brand economics are unavailable OR the brand does not carry the form-submission rate (non-form brand).
  clickToFormSubmissionPct: number | null;
}

interface ForecastRates {
  openPerOutreach: number | null;
  clickPerOutreach: number | null;
  positiveReplyPerOutreach: number | null;
}

interface ActualActivity {
  outreach: number;
  opens: number;
  clicks: number;
}

interface EmailGatewayDayGroup {
  key: string;
  broadcast?: {
    recipientStats?: {
      contacted?: number;
      sent?: number;
      opened?: number;
      clicked?: number;
      repliesPositive?: number;
    };
  };
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function dateInTimeZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, offset: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function parseDays(raw: unknown): number | null {
  if (raw === undefined) return 7;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePositiveNumber(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseNonNegativeNumber(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

function emptyExpected(
  clickToSignupPct: number | null = null,
  clickToFormSubmissionPct: number | null = null,
): ExpectedActivity {
  return {
    outreach: null,
    opens: null,
    clicks: null,
    signups: null,
    formSubmissions: null,
    dailyBudgetUsd: null,
    openRatePct: null,
    clickToSignupPct,
    clickToFormSubmissionPct,
  };
}

function getEmailGatewayHeaders(
  apiKey: string,
  headers: { orgId: string; userId: string; runId: string; brandId: string; featureSlug: string },
): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-user-id": headers.userId,
    "x-run-id": headers.runId,
    "x-brand-id": headers.brandId,
    "x-feature-slug": headers.featureSlug,
  };
}

// Only x-org-id is required by the billing daily-budget / runs cost reads; x-user-id / x-run-id (and
// brand/feature) are OPTIONAL context and are OMITTED when empty. This lets a platform (org-less)
// fleet caller pass just x-org-id — no faked/sentinel user identity — while the authed dashboard path
// still forwards its real user/run (truthy → included).
function getBillingServiceHeaders(
  apiKey: string,
  headers: { orgId: string; userId?: string; runId?: string; brandId?: string; featureSlug?: string },
): Record<string, string> {
  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;
  if (headers.brandId) h["x-brand-id"] = headers.brandId;
  if (headers.featureSlug) h["x-feature-slug"] = headers.featureSlug;
  return h;
}

function getRunsServiceHeaders(
  apiKey: string,
  headers: { orgId: string; userId?: string; runId?: string; brandId?: string; featureSlug?: string },
): Record<string, string> {
  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;
  if (headers.brandId) h["x-brand-id"] = headers.brandId;
  if (headers.featureSlug) h["x-feature-slug"] = headers.featureSlug;
  return h;
}

export async function fetchBrandDailyBudgetUsd(
  brandId: string,
  // Attribution only — the budget itself is funded PER BRAND and the slug never reaches the path. Pass
  // `undefined` at a grain that spans several channels: naming one of them on the wire would attribute
  // the whole read to a channel the caller did not ask about.
  featureSlug: string | undefined,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<number | null> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(`${url}/internal/brands/${encodeURIComponent(brandId)}/daily-budget`, {
    headers: getBillingServiceHeaders(apiKey, { ...headers, brandId, featureSlug }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`billing-service /internal/brands/:brandId/daily-budget failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { dailyBudgetCents: string | number | null };
  const cents = parseNonNegativeNumber(data.dailyBudgetCents);
  return cents === null ? null : cents / 100;
}

function readStatsNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`email-gateway day group missing numeric ${label}`);
}

/**
 * The day-bucketing read failed for the CALLER'S timezone specifically — the identical read with `UTC`
 * succeeds, so the brand, the feature, the identity and the whole downstream chain are healthy and the
 * one input we cannot serve is the `timezone` query parameter. Carried as its own type so the route can
 * answer 400 NAMING that parameter instead of an opaque upstream-failure status.
 *
 * This is an ATTRIBUTION, never a fallback: the UTC read is made only on the error path, its buckets are
 * discarded, and no response is ever built from a timezone the caller did not ask for. Day boundaries are
 * the whole point of the parameter, so serving UTC buckets under a `Asia/Saigon` request would be silently
 * wrong data — far worse than a loud refusal.
 */
export class TimezoneNotServableError extends Error {
  constructor(
    readonly timezone: string,
    readonly upstreamStatus: number,
    readonly upstreamBody: string,
  ) {
    super(
      `email-gateway /orgs/stats daily broadcast cannot serve timezone "${timezone}" ` +
        `(${upstreamStatus}: ${upstreamBody}); the identical read succeeds with UTC`,
    );
    this.name = "TimezoneNotServableError";
  }
}

async function fetchDailyBroadcastActivity(
  brandId: string,
  featureSlug: string,
  timezone: string,
  headers: { orgId: string; userId: string; runId: string },
  // ONE campaign of an OFFER's scope. email-gateway's `groupBy` is a single dimension and it takes no
  // campaign LIST, so an offer spanning several campaigns is read once per campaign and the day maps
  // are merged by the caller — a send is tagged to ONE campaign, so the merge cannot double-count.
  // Omitted → brand-wide, byte-identical to today.
  scopeCampaignId?: string,
): Promise<Map<string, ActualActivity>> {
  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const requestUrl = (tz: string) =>
    `${url}/orgs/stats?${new URLSearchParams({
      type: "broadcast",
      groupBy: "day",
      brandId,
      featureSlugs: featureSlug,
      timezone: tz,
      ...(scopeCampaignId ? { campaignId: scopeCampaignId } : {}),
    })}`;
  const requestHeaders = getEmailGatewayHeaders(apiKey, { ...headers, brandId, featureSlug });

  const response = await fetchWithRetry(requestUrl(timezone), { headers: requestHeaders });

  if (!response.ok) {
    const body = await response.text();
    // Which input is at fault? Re-run the SAME read with UTC — the one parameter we can always serve. If
    // that answers, the outage is not ours and not the brand's: it is this timezone spelling, and the
    // caller deserves to be told exactly that (a customer whose browser reports `Asia/Saigon` rather than
    // `Asia/Ho_Chi_Minh` spent a day looking like a generic gateway fault). If UTC fails too, the chain is
    // genuinely down and the original failure is the honest one to raise.
    if (timezone !== "UTC") {
      const probe = await fetchWithRetry(requestUrl("UTC"), { headers: requestHeaders }).catch(() => null);
      if (probe?.ok) {
        await probe.text().catch(() => "");
        throw new TimezoneNotServableError(timezone, response.status, body.slice(0, 300));
      }
    }
    throw new Error(`email-gateway /orgs/stats daily broadcast failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { groups?: EmailGatewayDayGroup[] };
  if (!Array.isArray(data.groups)) {
    throw new Error("email-gateway /orgs/stats daily broadcast returned no groups array");
  }

  const result = new Map<string, ActualActivity>();
  for (const group of data.groups) {
    const stats = group.broadcast?.recipientStats;
    if (!stats) {
      throw new Error(`email-gateway day group ${group.key} missing broadcast recipientStats`);
    }
    result.set(group.key, {
      outreach: readStatsNumber(stats.contacted, "recipientStats.contacted"),
      opens: readStatsNumber(stats.opened, "recipientStats.opened"),
      clicks: readStatsNumber(stats.clicked, "recipientStats.clicked"),
    });
  }

  return result;
}

/**
 * The day series for a read that spans SEVERAL channels: one read per member, added per day.
 *
 * Adding is safe for the same reason the per-audience send-tag figures are summed to a brand grain —
 * a broadcast send is tagged to exactly ONE campaign, and a campaign runs through exactly ONE channel,
 * so no day counts a send twice under either shape below. A single-member scope takes the ordinary
 * single read. Fail-loud on every member, like the brand-wide read: a swallowed failure would draw a
 * bar chart missing whichever member happened to be down.
 */
async function fetchOfferDailyBroadcastActivity(
  brandId: string,
  // Either one (channel × campaign) read per campaign — the OFFER grain, where the campaign is the
  // frozen link to the offer — or one BRAND-WIDE read per channel (`campaignId` omitted), which is the
  // BRAND grain: `brandId` is already the producer's filter there, so narrowing to an enumerated
  // campaign list could only drop a campaign campaign-service does not list.
  //
  // Either way the channel rides each entry rather than a comma-joined `featureSlugs` — a plural this
  // producer has not been verified to split, whose silent miss would draw an empty chart.
  reads: Array<{ featureSlug: string; campaignId?: string }>,
  timezone: string,
  headers: { orgId: string; userId: string; runId: string },
): Promise<Map<string, ActualActivity>> {
  const perCampaign = await mapWithConcurrency(reads, 4, (read) =>
    fetchDailyBroadcastActivity(brandId, read.featureSlug, timezone, headers, read.campaignId),
  );
  const merged = new Map<string, ActualActivity>();
  for (const days of perCampaign) {
    for (const [date, activity] of days) {
      const prev = merged.get(date);
      merged.set(date, {
        outreach: (prev?.outreach ?? 0) + activity.outreach,
        opens: (prev?.opens ?? 0) + activity.opens,
        clicks: (prev?.clicks ?? 0) + activity.clicks,
      });
    }
  }
  return merged;
}

function economicsToProjectionInputs(economics: SalesEconomics): {
  r2m: number;
  v2m: number;
  m2c: number;
  v2c: number;
  v2s: number;
} {
  return {
    r2m: economics.replyToMeetingPct / 100,
    v2m: economics.visitToMeetingPct / 100,
    m2c: economics.meetingToClosePct / 100,
    v2c: economics.visitToClosePct / 100,
    v2s: economics.visitToSignupPct / 100,
  };
}

interface WorkflowActivityUnits {
  units: Map<string, WorkflowActivityUnit>;
  /** The feature's fleet workflow metadata — reused for the BRAND-grain evidence read (dynasty rollup). */
  workflows: WorkflowMetadata[];
}

async function buildWorkflowActivityUnits(
  featureSlug: string,
  economics: SalesEconomics,
  // GROSS (the default) reads the gross cost field → byte-identical to today. NET reads runs#179's
  // frozen net twin, so the fleet cost-per-outreach benchmark comes out on the SAME basis as the
  // brand's own observed ratio it is compared against in `computeExpectedActivity`.
  pricing: Pricing = "gross",
): Promise<WorkflowActivityUnits> {
  const [workflows, costGroups, emailStats] = await Promise.all([
    fetchPublicWorkflows(featureSlug, "all"),
    fetchPublicCosts(featureSlug, "workflowSlug", pricing),
    fetchPublicEmailStats(featureSlug, "workflowSlug"),
  ]);

  const chains = buildUpgradeChains(workflows);
  const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");
  const workflowBySlug = new Map(workflows.map((workflow) => [workflow.workflowSlug, workflow]));
  const unitsByWorkflowSlug = new Map<string, WorkflowActivityUnit>();
  const projectionInputs = economicsToProjectionInputs(economics);

  for (const [activeSlug, chainSlugs] of chains) {
    const cost = costMap.get(activeSlug);
    if (!cost) continue;
    const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
    const costUsd = cost.totalCostInUsdCents / 100;
    const contacted = outcomes.recipientsContacted ?? 0;
    const opened = outcomes.recipientsOpened ?? 0;
    const clicked = outcomes.recipientsClicked ?? 0;
    const clickUsd = costUsd > 0 && clicked > 0 ? costUsd / clicked : null;

    const unit: WorkflowActivityUnit = {
      workflowDynastySlug: workflowBySlug.get(activeSlug)?.workflowDynastySlug ?? activeSlug,
      workflowSlugs: Array.from(new Set([...chainSlugs, activeSlug])),
      outreachUsd: costUsd > 0 && contacted > 0 ? costUsd / contacted : null,
      clickUsd,
      costPerSignupUsd: projectOutcomeCosts(projectionInputs, { clickUsd, replyUsd: null }).costPerSignupUsd,
      openPerOutreach: ratio(opened, contacted),
      clickPerOutreach: ratio(clicked, contacted),
    };

    for (const slug of chainSlugs) unitsByWorkflowSlug.set(slug, unit);
    unitsByWorkflowSlug.set(activeSlug, unit);
  }

  return { units: unitsByWorkflowSlug, workflows };
}

function chooseBestSignupWorkflow(units: Map<string, WorkflowActivityUnit>): WorkflowActivityUnit | null {
  let best: WorkflowActivityUnit | null = null;
  for (const unit of units.values()) {
    if (unit.costPerSignupUsd === null) continue;
    if (best === null || best.costPerSignupUsd === null || unit.costPerSignupUsd < best.costPerSignupUsd) {
      best = unit;
    }
  }
  return best;
}

/**
 * Feature-level cost-per-outreach (USD) of the best-signup workflow — the fleet BENCHMARK the
 * dashboard's per-brand forecast divides the daily budget by (`computeExpectedActivity`, where it is
 * additionally floored at the brand's OWN observed ratio). It is a CROSS-ORG (goal-global) figure:
 * `buildWorkflowActivityUnits` reads the PUBLIC workflow cost/email stats, so it depends only on the
 * FEATURE, not the brand — only the daily BUDGET is per-brand.
 *
 * The per-brand floor is deliberately NOT applied here: this is the ADMIN fleet send-forecast's
 * aggregate input, which is legitimately fleet-level and cross-brand. Keep this function's behaviour
 * unchanged.
 *
 * The best-signup ranking (`chooseBestSignupWorkflow`, lowest `costPerSignupUsd`) is monotonic in
 * `clickUsd` for any fixed economics, so it's economics-INVARIANT: a neutral economics picks the same
 * workflow the dashboard would for any real brand. So the global send-forecast can compute one
 * `outreachUsd` per cold-email feature and reuse it across every active brand (fleet aggregation),
 * instead of re-running the full per-brand expected-activity path. Returns null when no workflow has
 * usable cost-per-outreach economics.
 */
const NEUTRAL_ECONOMICS: SalesEconomics = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 10,
  visitToMeetingPct: 10,
  meetingToClosePct: 10,
  visitToSignupPct: 10,
  signupToPaidClientPct: 10,
  visitToClosePct: 10,
};

export async function computeFeatureOutreachUsd(featureSlug: string): Promise<number | null> {
  // GROSS on purpose: the admin fleet send-forecast is a cross-org staff surface (no per-org pricing
  // selector), so it keeps the real undiscounted cost per outreach — byte-unchanged.
  const { units } = await buildWorkflowActivityUnits(featureSlug, NEUTRAL_ECONOMICS, "gross");
  const best = chooseBestSignupWorkflow(units);
  return best?.outreachUsd ?? null;
}

/**
 * The BRAND's OWN observed cost per outreach (USD) on this feature — its committed spend divided by the
 * recipients it actually contacted, summed over every workflow dynasty it ran.
 *
 * Same BASIS as the fleet `outreachUsd` it floors (`buildWorkflowActivityUnits`): COMMITTED cost
 * (`totalCostInUsdCents`) over `recipientStats.contacted`, and INCURRED (comped spend counts — see the
 * note on the call below). Only the SCOPE differs — one brand instead of
 * the fleet — so `max(fleet, own)` compares like with like. It is a LIFETIME ratio (the whole brand ×
 * feature history), not the `days` window: `fetchDailyBroadcastActivity` only covers the requested window
 * (7 days by default), which is far too thin a denominator to price a send.
 *
 * Reuses `fetchBrandWorkflowEvidence` — the exact brand-grain read `workflow-projection` already makes,
 * on the one axis where it differs (INCURRED, not the displayed CHARGED basis) — so the
 * numerator/denominator are the ones that surface as this brand's cost-per-outcome elsewhere.
 *
 * Returns null when EITHER side is 0 (a brand that never spent, or never contacted anyone): there is no
 * own-ratio to floor with, so the caller keeps the fleet benchmark unchanged. Never a fabricated value.
 */
async function fetchBrandObservedOutreachUsd(
  brandId: string,
  featureSlug: string,
  workflows: WorkflowMetadata[],
  headers: { orgId: string; userId: string; runId: string },
  // MUST be the SAME selector the fleet benchmark is read with: `max(fleet, own)` compares two cost
  // ratios, so mixing a gross figure with a net one makes the comparison meaningless (and can pick the
  // wrong side). Threaded from the request's `?pricing=`; gross by default → byte-identical.
  pricing: Pricing = "gross",
): Promise<number | null> {
  // INCURRED, deliberately, and it is the ONE brand-scoped read on that basis. This ratio is not a
  // figure the customer is shown — it is the DIVISOR of `expected.outreach = dailyBudget / costPerOutreach`,
  // i.e. a projection of what their budget buys. A dollar buys the same number of sends whether or not
  // we later comped it, so comping must not promise a brand MORE sends than its budget can buy. It is
  // also `max()`-ed against the fleet benchmark, which is read INCURRED — mixing the two bases there
  // would compare two different currencies and could pick the wrong side.
  const evidence = await fetchBrandWorkflowEvidence(brandId, featureSlug, workflows, { ...headers, featureSlug }, pricing, "incurred");
  let costCents = 0;
  let contacted = 0;
  for (const grain of evidence.values()) {
    costCents += grain.totalCostInUsdCents;
    contacted += grain.contacted;
  }
  return costCents > 0 && contacted > 0 ? costCents / 100 / contacted : null;
}

interface AudienceOutcome {
  contacted: number;
  opened: number;
  clicked: number;
  positiveReplies: number;
}

function emptyAudienceOutcome(): AudienceOutcome {
  return { contacted: 0, opened: 0, clicked: 0, positiveReplies: 0 };
}

/**
 * Per-audience cost (USD cents), grouped by the human-service audience.id attribution
 * (runs-service #154 `x-audience-id` write-tag, read back via groupBy=audienceId). Scoped
 * to the chosen workflow dynasty so the CPC ranking is per-workflow. We do NOT filter the cost
 * NUMERATOR by goal/brandProfileId — those dimensions are not tagged on runs/cost rows today, so
 * filtering on them drops every real cost row (goal only selects the metric, not which spend
 * counts). Reads `dimensions.audienceId` only — no legacy id fallback.
 */
async function fetchAudienceCosts(
  brandId: string,
  featureSlug: string,
  workflowDynastySlug: string,
  headers: { orgId: string; userId: string; runId: string },
  // Same basis as every other cost input on this endpoint. This read only RANKS audiences (lowest CPC
  // wins), and a per-row frozen discount can differ across rows, so the argmin is not guaranteed to be
  // invariant under gross↔net — read it on the requested basis rather than assuming it cancels out.
  pricing: Pricing = "gross",
): Promise<Map<string, number>> {
  const runsUrl = process.env.RUNS_SERVICE_URL;
  const runsApiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!runsUrl || !runsApiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");

  const params = new URLSearchParams({
    groupBy: "audienceId",
    brandId,
    featureSlugs: featureSlug,
    workflowDynastySlug,
  });

  const response = await fetchWithRetry(`${runsUrl}/v1/stats/costs?${params}`, {
    headers: getRunsServiceHeaders(runsApiKey, { ...headers, brandId, featureSlug }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`runs-service audience costs failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    groups?: Array<{ dimensions?: Record<string, string | null>; totalCostInUsdCents: string | number }>;
  };
  if (!Array.isArray(data.groups)) throw new Error("runs-service audience costs returned no groups array");

  const costs = new Map<string, number>();
  for (const group of data.groups) {
    const id = group.dimensions?.audienceId;
    if (!id || id === "__total__") continue;
    // NET goes through `selectCostCentsString`, which THROWS when runs did not serve the frozen net
    // twin — a NET request must never silently fall back to the full price. GROSS keeps the existing
    // tolerant read verbatim (a group with no usable cost is skipped), so the default is byte-identical.
    const raw = pricing === "net" ? selectCostCentsString(group, "totalCostInUsdCents", pricing) : group.totalCostInUsdCents;
    const cents = parsePositiveNumber(raw);
    if (cents !== null) costs.set(id, cents);
  }
  return costs;
}

/**
 * Per-audience engagement, resolved READ-TIME from explicit membership (no send-tagging).
 *
 * For each active audience: human-service gives its canonical member emails (provenance,
 * human-service#42); email-gateway gives each email's brand-scoped broadcast outcome flags
 * (contacted / clicked / positiveReply). We tally per audience. Outcomes are recipient
 * engagement, so they are brand-scoped — NOT scoped by workflow / goal / brand-profile
 * (only the COST is, via runs attribution). Mirrors audience-stats fetchAudienceOutcomes.
 */
async function fetchAudienceOutcomes(
  brandId: string,
  audiences: Audience[],
  headers: { orgId: string; userId: string; runId: string; featureSlug: string },
): Promise<Map<string, AudienceOutcome>> {
  const perAudience = await Promise.all(
    audiences.map(async (audience) => ({
      audienceId: audience.id,
      emails: await fetchAudienceMemberEmails(audience.id, headers),
    })),
  );

  const allEmails = [...new Set(perAudience.flatMap((entry) => entry.emails))];
  const outcomesByEmail = await fetchEmailOutcomes(brandId, allEmails, headers);

  const result = new Map<string, AudienceOutcome>();
  for (const { audienceId, emails } of perAudience) {
    const agg = emptyAudienceOutcome();
    for (const email of emails) {
      const outcome = outcomesByEmail.get(email);
      if (!outcome) continue;
      if (outcome.contacted) agg.contacted += 1;
      if (outcome.opened) agg.opened += 1;
      if (outcome.clicked) agg.clicked += 1;
      if (outcome.positiveReply) agg.positiveReplies += 1;
    }
    result.set(audienceId, agg);
  }
  return result;
}

/**
 * Pick the lowest-CPC active audience for the chosen workflow and derive its forecast rates.
 *
 * Candidates come from human-service active audiences (org-scoped). Cost is per-audience from
 * runs (groupBy=audienceId); clicks are per-audience from read-time membership outcomes. CPC =
 * cost / clicked; lowest wins. Rates are derived from the SAME outcome tally (one pass, no
 * double-fetch): openPerOutreach = opened/contacted, clickPerOutreach = clicked/contacted,
 * positiveReplyPerOutreach = positiveReplies/contacted — all audience-grain from the same
 * membership tally (the caller still falls back to workflow rates when no audience qualifies).
 */
async function fetchBestAudienceForecast(
  brandId: string,
  featureSlug: string,
  workflowDynastySlug: string,
  headers: { orgId: string; userId: string; runId: string },
  pricing: Pricing = "gross",
): Promise<{ audienceId: string; brandProfileId: string | null; rates: ForecastRates } | null> {
  const audiences = await fetchActiveAudiences(brandId, { ...headers, featureSlug });
  if (audiences.length === 0) return null;

  // brand-service retired its versioned brand-profile storage; brandProfileId is now always null here
  // (no brand-profile round-trip). Kept on the shape for response-path stability with the dashboard.
  const brandProfileId = null;
  const [costs, outcomes] = await Promise.all([
    fetchAudienceCosts(brandId, featureSlug, workflowDynastySlug, headers, pricing),
    fetchAudienceOutcomes(brandId, audiences, { ...headers, featureSlug }),
  ]);

  let best: { audienceId: string; cpcCents: number; outcome: AudienceOutcome } | null = null;
  for (const audience of audiences) {
    const costCents = costs.get(audience.id);
    const outcome = outcomes.get(audience.id) ?? emptyAudienceOutcome();
    if (costCents === undefined || outcome.clicked <= 0) continue;
    const cpcCents = costCents / outcome.clicked;
    if (best === null || cpcCents < best.cpcCents) best = { audienceId: audience.id, cpcCents, outcome };
  }
  if (!best) return null;

  return {
    audienceId: best.audienceId,
    brandProfileId,
    rates: {
      openPerOutreach: ratio(best.outcome.opened, best.outcome.contacted),
      clickPerOutreach: ratio(best.outcome.clicked, best.outcome.contacted),
      positiveReplyPerOutreach: ratio(best.outcome.positiveReplies, best.outcome.contacted),
    },
  };
}

async function computeExpectedActivity(
  featureSlug: string,
  brandId: string,
  headers: { orgId: string; userId: string; runId: string },
  // Already resolved by the caller so it can fold the economics fingerprint into the cache key — reused
  // here so the request path does not fetch the same brand-service read twice.
  economicsOverride?: EffectiveEconomics,
  // GROSS (default) → byte-identical to today. NET makes EVERY cost input below read runs#179's frozen
  // net twin, so the divisor is priced at what the org actually pays. The daily BUDGET is deliberately
  // NOT touched: a configured budget is a ceiling, never a charge, so it is never discounted.
  pricing: Pricing = "gross",
): Promise<ExpectedActivity> {
  const [dailyBudgetUsd, effective] = await Promise.all([
    fetchBrandDailyBudgetUsd(brandId, featureSlug, headers),
    economicsOverride ?? fetchEffectiveEconomics(brandId, { ...headers, featureSlug }),
  ]);

  const economics = effective.economics;
  const clickToSignupPct = economics?.visitToSignupPct ?? null;
  // Visit→form-submission rate (the form-submission projection rate). Present only when the brand's
  // effective economics carry it (a form_submissions brand); a non-form brand → null → form series null.
  const clickToFormSubmissionPct = economics?.visitToFormSubmissionPct ?? null;
  if (dailyBudgetUsd === null || !economics) return emptyExpected(clickToSignupPct, clickToFormSubmissionPct);

  const { units, workflows } = await buildWorkflowActivityUnits(featureSlug, economics, pricing);
  const bestWorkflow = chooseBestSignupWorkflow(units);
  if (!bestWorkflow || bestWorkflow.outreachUsd === null) return emptyExpected(clickToSignupPct, clickToFormSubmissionPct);

  const [forecast, brandObservedOutreachUsd] = await Promise.all([
    fetchBestAudienceForecast(brandId, featureSlug, bestWorkflow.workflowDynastySlug, headers, pricing),
    fetchBrandObservedOutreachUsd(brandId, featureSlug, workflows, headers, pricing),
  ]);
  const rates = forecast?.rates ?? { openPerOutreach: null, clickPerOutreach: null, positiveReplyPerOutreach: null };

  // The forecast promises what the brand's OWN daily budget can buy, so the divisor is FLOORED at the
  // brand's own observed cost per outreach. `bestWorkflow.outreachUsd` is the CROSS-ORG cheapest-signup
  // workflow's send cost; a brand that structurally pays more than the fleet benchmark (more enrichment
  // per lead, more sequence steps) would otherwise be promised ~3x the sends its budget can pay for — and
  // the same page shows its real cost per outreach, so the two contradicted each other.
  //
  // Same floor doctrine as `audience-stats` / `cost-engine.ts`'s cascade (`max(own evidence, benchmark)`),
  // inverted in DIRECTION only because the output here is a COUNT: flooring the DIVISOR lowers the count,
  // so the graph can never over-promise. The floor releases itself the moment the brand's own ratio
  // reaches the benchmark — a brand cheaper than the fleet keeps the fleet number (a `max`, never a raise).
  // No own-ratio (fresh brand: 0 spend or 0 contacted) → the fleet figure alone, byte-identical to before.
  //
  // BOTH sides of this `max` are read on the SAME `pricing` basis (fleet via `buildWorkflowActivityUnits`,
  // own via `fetchBrandObservedOutreachUsd`). Mixing a gross ratio with a net one would compare two
  // different currencies and could pick the wrong side, so the selector is threaded, never applied after.
  const effectiveOutreachUsd =
    brandObservedOutreachUsd === null
      ? bestWorkflow.outreachUsd
      : Math.max(bestWorkflow.outreachUsd, brandObservedOutreachUsd);

  const outreach = dailyBudgetUsd / effectiveOutreachUsd;
  const openPerOutreach = rates.openPerOutreach ?? bestWorkflow.openPerOutreach;
  const clickPerOutreach = rates.clickPerOutreach ?? bestWorkflow.clickPerOutreach;
  const opens = openPerOutreach !== null ? outreach * openPerOutreach : null;
  const clicks = clickPerOutreach !== null ? outreach * clickPerOutreach : null;
  const signups = clicks !== null && clickToSignupPct !== null ? clicks * (clickToSignupPct / 100) : null;
  const formSubmissions =
    clicks !== null && clickToFormSubmissionPct !== null ? clicks * (clickToFormSubmissionPct / 100) : null;
  const openRatePct = openPerOutreach !== null ? openPerOutreach * 100 : null;

  return {
    outreach,
    opens,
    clicks,
    signups,
    formSubmissions,
    dailyBudgetUsd,
    openRatePct,
    clickToSignupPct,
    clickToFormSubmissionPct,
  };
}

function buildDayBuckets(
  dates: string[],
  today: string,
  actualByDate: Map<string, ActualActivity>,
  expected: ExpectedActivity,
  observed: ConversionCountsByDay | null,
): DayBucket[] {
  return dates.map((date) => {
    const isToday = date === today;
    const actual = actualByDate.get(date) ?? { outreach: 0, opens: 0, clicks: 0 };
    const actualMetric = (metric: MetricName): number | null => (isToday ? actual[metric] : null);
    // Signup + form-submission ACTUAL = the REAL, deduped, attributed per-day conversion count from
    // lead-service (NOT `clicks × conversionPct` — a projection must never sit in `.actual`). Populated
    // for TODAY and PAST days (date <= today, lexicographic == chronological for YYYY-MM-DD); FUTURE days
    // keep only the forecast in `.expected`. `?? 0` because lead-service omits a day key with 0
    // conversions. A per-day count never exceeds the deduped total by construction. null (renders "-",
    // never a fabricated count) when the observed series degraded (lead-service unavailable).
    const observedActual = (event: "signup" | "form_submission"): number | null => {
      if (date > today) return null;
      if (!observed) return null;
      return observed.byDay[event][date] ?? 0;
    };
    const signupActual = observedActual("signup");
    const formSubmissionActual = observedActual("form_submission");

    return {
      date,
      isToday,
      metrics: {
        outreach: { actual: actualMetric("outreach"), expected: expected.outreach },
        opens: { actual: actualMetric("opens"), expected: expected.opens },
        clicks: { actual: actualMetric("clicks"), expected: expected.clicks },
        signups: {
          actual: signupActual,
          expected: expected.signups,
          conversionPct: expected.clickToSignupPct,
        },
        formSubmissions: {
          actual: formSubmissionActual,
          expected: expected.formSubmissions,
          conversionPct: expected.clickToFormSubmissionPct,
        },
      },
    };
  });
}

/**
 * THE OFFER-GRAIN DAY CHART — the same actual series, across every channel the offer is sold through.
 *
 * Everything drawn here is an EVENT COUNT tagged to one campaign (an outreach, an open, a click), so
 * the channels ADD with nothing counted twice — and they are added by reading each channel under its
 * OWN slug and merging the day buckets, never by trusting a plural filter on a producer that has not
 * been verified to split one.
 *
 * The EXPECTED series, the daily budget and the observed conversion actuals are null for exactly the
 * reasons the per-feature offer-scoped read already states: a budget is funded per brand with no
 * per-offer ceiling to divide, and the conversion tracker is brand-keyed with no campaign on it.
 * Drawing either brand-wide beside offer-only bars would put two grains on one chart under one label.
 * The two RATES survive, because they are the brand's economics and the offer does not change them.
 *
 * A one-channel offer produces exactly the reads the per-feature offer-scoped path produces, so it
 * answers identically.
 */
export async function computeOfferPipelineActivity(
  req: { query: Record<string, unknown> },
  input: {
    offerId: string;
    brandId: string;
    pricing: Pricing;
    channels: Array<{ featureSlug: string; campaignIds: string[] }>;
    headers: { orgId: string; userId: string; runId: string };
  },
): Promise<{ ok: true; body: PipelineActivityResponse } | { ok: false; status: number; body: Record<string, unknown> }> {
  const timezone = req.query.timezone as string | undefined;
  const days = parseDays(req.query.days);
  if (!timezone) return { ok: false, status: 400, body: { error: "timezone query parameter is required" } };
  if (!isValidTimeZone(timezone)) return { ok: false, status: 400, body: { error: "timezone must be a valid IANA time zone" } };
  if (days === null) return { ok: false, status: 400, body: { error: "days must be a positive integer" } };

  const featureSlugs = input.channels.map((channel) => channel.featureSlug);
  const effectiveEconomics = await fetchEffectiveEconomics(input.brandId, {
    orgId: input.headers.orgId,
    userId: input.headers.userId,
    runId: input.headers.runId,
    // Not one of the channels: this read is about several, and naming one would attribute it to that one.
    featureSlug: undefined,
  });

  const body = await servedCached({
    view: "offer-pipeline-activity",
    // Keyed on the offer, and on the CHANNEL SET — a newly funded channel changes every bar while no
    // other key part moves.
    scopeKey: buildScopeKey(input.offerId, {
      orgId: input.headers.orgId,
      brandId: input.brandId,
      channels: featureSlugs.join("+"),
      timezone,
      days,
      pricing: input.pricing,
      econ: economicsFingerprint(effectiveEconomics),
    }),
    orgId: input.headers.orgId,
    compute: async (): Promise<PipelineActivityResponse> => {
      const today = dateInTimeZone(new Date(), timezone);
      const dates = Array.from({ length: days }, (_, index) => addDays(today, index));
      const expected = emptyExpected(
        effectiveEconomics.economics?.visitToSignupPct ?? null,
        effectiveEconomics.economics?.visitToFormSubmissionPct ?? null,
      );
      const actualByDate = await fetchOfferDailyBroadcastActivity(
        input.brandId,
        input.channels.flatMap((channel) =>
          channel.campaignIds.map((campaignId) => ({ featureSlug: channel.featureSlug, campaignId })),
        ),
        timezone,
        input.headers,
      );
      return {
        // The channels this covers ride the envelope the route builds; `featureSlug` on the body would
        // have to name one of several, so it names the offer's whole channel set instead.
        featureSlug: featureSlugs.join(","),
        brandId: input.brandId,
        timezone,
        costBasis: "incurred" as const,
        generatedAt: new Date().toISOString(),
        days: buildDayBuckets(dates, today, actualByDate, expected, null),
        summary: {
          dailyBudgetUsd: expected.dailyBudgetUsd,
          openRatePct: expected.openRatePct,
          clickToSignupPct: expected.clickToSignupPct,
          clickToFormSubmissionPct: expected.clickToFormSubmissionPct,
          undatedSignups: null,
          undatedFormSubmissions: null,
        },
      };
    },
  });
  return { ok: true, body };
}

/**
 * THE BRAND-GRAIN DAY CHART — the same actual series, across every channel the brand runs.
 *
 * The actual bars combine exactly as the offer's do, and for the same reason: every one of them is an
 * EVENT COUNT tagged to one campaign, and a campaign runs through one channel. The reads are made per
 * channel BRAND-WIDE (no campaign narrowing), so a campaign campaign-service does not list is still
 * drawn, and a brand on ONE channel issues the byte-same request its per-feature read issues today.
 *
 * What differs from the offer grain is what CAN be measured here:
 *
 *   - THE DAILY BUDGET IS THE BRAND'S. billing funds it per brand, so at this grain it is not a share
 *     of anything — it is the number itself, and it is the one the customer sees the day's spend
 *     against. Stating it here is what makes that fraction one statement instead of two grains
 *     ("$40 of one channel / $50 of every channel" was the bug).
 *   - THE OBSERVED CONVERSIONS ARE THE BRAND'S. The conversion tracker is brand-keyed and carries no
 *     campaign, so brand-wide is exactly its grain — unlike the offer read, which must null it.
 *   - THE FORECAST IS NOT COMBINABLE ACROSS CHANNELS, so with several it is null. `expected.outreach`
 *     is `dailyBudgetUsd / effectiveOutreachUsd`, and that divisor is a PROPERTY OF ONE CHANNEL (its
 *     cross-org best workflow, floored by that channel's own observed cost per outreach). Several
 *     channels have several divisors and no per-channel ceiling exists to split the budget by, so the
 *     honest answers are "the brand's budget" and "we could not project the volume it buys" — never a
 *     brand budget divided by one channel's price, which is the very pairing this grain removes. With
 *     exactly ONE channel there is nothing to combine and the ordinary forecast is computed, so a
 *     one-channel brand's chart is unchanged.
 */
export async function computeBrandPipelineActivity(
  req: { query: Record<string, unknown> },
  input: {
    brandId: string;
    pricing: Pricing;
    channels: Array<{ featureSlug: string; campaignIds: string[] }>;
    headers: { orgId: string; userId: string; runId: string };
  },
): Promise<{ ok: true; body: PipelineActivityResponse } | { ok: false; status: number; body: Record<string, unknown> }> {
  const timezone = req.query.timezone as string | undefined;
  const days = parseDays(req.query.days);
  if (!timezone) return { ok: false, status: 400, body: { error: "timezone query parameter is required" } };
  if (!isValidTimeZone(timezone)) return { ok: false, status: 400, body: { error: "timezone must be a valid IANA time zone" } };
  if (days === null) return { ok: false, status: 400, body: { error: "days must be a positive integer" } };

  const featureSlugs = input.channels.map((channel) => channel.featureSlug);
  const soleChannel = featureSlugs.length === 1 ? featureSlugs[0] : undefined;
  const effectiveEconomics = await fetchEffectiveEconomics(input.brandId, {
    orgId: input.headers.orgId,
    userId: input.headers.userId,
    runId: input.headers.runId,
    // Named only when there IS one: attributing a several-channel read to one of them would name a
    // channel the caller never asked about.
    featureSlug: soleChannel,
  });

  const body = await servedCached({
    view: "brand-pipeline-activity",
    // Keyed on the brand, and on the CHANNEL SET — a newly funded channel changes the bars while no
    // other key part moves, so without it the brand would replay its pre-funding chart.
    scopeKey: buildScopeKey(input.brandId, {
      orgId: input.headers.orgId,
      channels: featureSlugs.join("+"),
      timezone,
      days,
      pricing: input.pricing,
      econ: economicsFingerprint(effectiveEconomics),
    }),
    orgId: input.headers.orgId,
    compute: async (): Promise<PipelineActivityResponse> => {
      const today = dateInTimeZone(new Date(), timezone);
      const dates = Array.from({ length: days }, (_, index) => addDays(today, index));
      const [expected, dailyBudgetUsd, actualByDate, observed] = await Promise.all([
        soleChannel
          ? computeExpectedActivity(soleChannel, input.brandId, input.headers, effectiveEconomics, input.pricing)
          : Promise.resolve(
              emptyExpected(
                effectiveEconomics.economics?.visitToSignupPct ?? null,
                effectiveEconomics.economics?.visitToFormSubmissionPct ?? null,
              ),
            ),
        // Read on its own at this grain rather than taken off the forecast: the budget is a fact about
        // the brand and stays true whether or not the volume it buys can be projected — the forecast
        // nulls its own copy the moment it cannot price an outreach, which is exactly the case where
        // the customer still needs the ceiling their day's spend is read against.
        fetchBrandDailyBudgetUsd(input.brandId, soleChannel, input.headers),
        fetchOfferDailyBroadcastActivity(
          input.brandId,
          // Brand-wide per channel — no campaign narrowing, so nothing depends on campaign-service
          // having listed every campaign.
          input.channels.map((channel) => ({ featureSlug: channel.featureSlug })),
          timezone,
          input.headers,
        ),
        fetchConversionCountsByDaySoft(input.brandId),
      ]);
      return {
        // A body field cannot name one of several channels, so it names the whole set; the structured
        // breakdown rides the envelope the route builds.
        featureSlug: featureSlugs.join(","),
        brandId: input.brandId,
        timezone,
        costBasis: "incurred" as const,
        generatedAt: new Date().toISOString(),
        days: buildDayBuckets(dates, today, actualByDate, expected, observed),
        summary: {
          dailyBudgetUsd: expected.dailyBudgetUsd ?? dailyBudgetUsd,
          openRatePct: expected.openRatePct,
          clickToSignupPct: expected.clickToSignupPct,
          clickToFormSubmissionPct: expected.clickToFormSubmissionPct,
          undatedSignups: observed ? observed.undated.signup : null,
          undatedFormSubmissions: observed ? observed.undated.form_submission : null,
        },
      };
    },
  });
  return { ok: true, body };
}

router.get("/features/:featureSlug/pipeline-activity", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const auth = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const timezone = req.query.timezone as string | undefined;
  const days = parseDays(req.query.days);
  // `?offerId=` narrows the day series to the ONE offer a brand sells — the grain between the brand
  // and its campaigns (see lib/offer-scope.ts). Absent → byte-identical to today, key included.
  const offerId = ((req.query.offerId as string | undefined) ?? "").trim() || undefined;

  if (!brandId) return res.status(400).json({ error: "brandId query parameter is required" });
  if (!timezone) return res.status(400).json({ error: "timezone query parameter is required" });
  if (!isValidTimeZone(timezone)) return res.status(400).json({ error: "timezone must be a valid IANA time zone" });
  if (days === null) return res.status(400).json({ error: "days must be a positive integer" });

  // GROSS (default) vs NET pricing — the same selector the sibling cost-metric endpoints accept.
  // Omitted → gross → byte-identical to today. NET prices the forecast's cost divisor at what the org
  // actually pays, so a discounted org is no longer promised ~half the sends its budget really buys.
  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) {
    return res.status(400).json({ error: "pricing must be one of: gross, net" });
  }

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) return res.status(404).json({ error: "Feature not found" });

    // The projected series (signups, form submissions) are driven by the brand's economics rates, so the
    // economics are read LIVE and folded into the cache key: an economics write lands on a different
    // `scope_key` and forces a fresh compute instead of replaying a pre-write snapshot for up to the
    // hard-stale cap. The value is threaded into the compute so it is fetched once, not twice.
    const effectiveEconomics = await fetchEffectiveEconomics(brandId, {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
      featureSlug,
    });

    // Fail-loud: the partition IS the scope, so serving without it would draw the whole brand's
    // activity under one offer's name.
    const offerCampaignIds = offerId
      ? await resolveOfferCampaignIds(offerId, brandId, featureSlug, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId })
      : null;

    // Gold SWR: the ~7-read fan-out (budget, cost, audiences, membership, forecast) runs off the
    // request path ~once per TTL, keyed on the inputs that shape the body (orgId + brand + timezone +
    // days + economics). `generatedAt` is frozen to the snapshot's compute time — the as-of semantic.
    const response = await servedCached({
      view: "pipeline-activity",
      scopeKey: buildScopeKey(featureSlug, {
        orgId: auth.orgId,
        brandId,
        timezone,
        days,
        // In the key so a gross and a net request never share a cached body (the money-derived
        // expected series differ) — same rule as every other pricing-aware view.
        pricing,
        // The offer narrows the whole body, so it MUST be in the key or an offer-scoped chart and the
        // brand-wide one would share a cell. Absent → dropped by buildScopeKey → key unchanged.
        offerId,
        econ: economicsFingerprint(effectiveEconomics),
      }),
      orgId: auth.orgId,
      compute: async (): Promise<PipelineActivityResponse> => {
    const today = dateInTimeZone(new Date(), timezone);
    const dates = Array.from({ length: days }, (_, index) => addDays(today, index));
    // An OFFER-scoped chart states its ACTUAL activity and NOTHING it cannot measure at that grain.
    //
    // The FORECAST is what a daily BUDGET buys, and a budget is funded per brand (and, in billing, per
    // sales funnel) — there is no per-offer ceiling to divide, and apportioning the brand's would be a
    // number nobody set. The OBSERVED conversions come from the brand-keyed conversion tracker, which
    // carries no campaign and therefore no offer. Drawing either brand-wide beside offer-only bars
    // would put two grains on one chart under one label, so both are null here and the consumer renders
    // "we could not measure this" — never a share, never a zero. The two rates survive because they are
    // the brand's economics, which the offer does not change.
    const [expected, actualByDate, observed] = await Promise.all([
      offerCampaignIds
        ? Promise.resolve(
            emptyExpected(
              effectiveEconomics.economics?.visitToSignupPct ?? null,
              effectiveEconomics.economics?.visitToFormSubmissionPct ?? null,
            ),
          )
        : computeExpectedActivity(featureSlug, brandId, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId }, effectiveEconomics, pricing),
      offerCampaignIds
        ? fetchOfferDailyBroadcastActivity(
            brandId,
            offerCampaignIds.map((campaignId) => ({ featureSlug, campaignId })),
            timezone,
            { orgId: auth.orgId, userId: auth.userId, runId: auth.runId },
          )
        : fetchDailyBroadcastActivity(brandId, featureSlug, timezone, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId }),
      offerCampaignIds ? Promise.resolve(null) : fetchConversionCountsByDaySoft(brandId),
    ]);

    return {
      featureSlug,
      brandId,
      timezone,
      costBasis: "incurred" as const,
      generatedAt: new Date().toISOString(),
      days: buildDayBuckets(dates, today, actualByDate, expected, observed),
      summary: {
        dailyBudgetUsd: expected.dailyBudgetUsd,
        openRatePct: expected.openRatePct,
        clickToSignupPct: expected.clickToSignupPct,
        clickToFormSubmissionPct: expected.clickToFormSubmissionPct,
        undatedSignups: observed ? observed.undated.signup : null,
        undatedFormSubmissions: observed ? observed.undated.form_submission : null,
      },
    };
      },
    });

    res.json(response);
  } catch (error) {
    // An offer no campaign of this brand sells has no activity to chart — named, never the brand's
    // own series under the offer's label and never a chart of fabricated zeroes.
    if (error instanceof OfferHasNoCampaignsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_campaigns", offerId: error.offerId });
    }
    console.error("[features-service] Pipeline activity error:", error);

    // A timezone we accepted as valid but cannot actually serve is a REQUEST problem, and it is named as
    // one. Anything else is ours or an upstream's.
    if (error instanceof TimezoneNotServableError) {
      return res.status(400).json({
        error: `timezone "${error.timezone}" is a valid IANA name but cannot be served for day bucketing`,
        parameter: "timezone",
        timezone: error.timezone,
        detail: error.message,
      });
    }

    // 500, not 502, and always with a body. Cloudflare fronts this service and REPLACES an origin 502's
    // body with its own bare `error code: 502` text — so every diagnostic we wrote was destroyed in
    // transit and the caller got sixteen bytes that name neither the endpoint nor the input at fault.
    // Measured against prod: instantly-service's 500 body reaches the caller intact through the same edge,
    // our 502 body did not. A 500 with the offending parameters in it is the floor.
    res.status(500).json({
      error: "Failed to compute pipeline activity",
      detail: (error as Error).message,
      query: { brandId, days, timezone, pricing },
    });
  }
});

export default router;
