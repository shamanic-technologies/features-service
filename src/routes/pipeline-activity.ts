import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { fetchCurrentBrandProfile } from "../lib/brand-client.js";
import { fetchActiveAudiences, fetchAudienceMemberEmails, type Audience } from "../lib/human-client.js";
import { fetchEmailOutcomes } from "../lib/email-status-client.js";
import {
  fetchPublicCosts,
  fetchPublicEmailStats,
  fetchPublicWorkflows,
} from "../lib/public-stats-clients.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts, type SalesEconomics } from "../lib/funnel-registry.js";
import { aggregateAcrossChains, buildUpgradeChains } from "./public.js";

const router = Router();

type MetricName = "outreach" | "opens" | "clicks";

interface MetricValue {
  actual: number | null;
  expected: number | null;
}

interface SignupMetricValue extends MetricValue {
  conversionPct: number | null;
}

interface DayBucket {
  date: string;
  isToday: boolean;
  metrics: {
    outreach: MetricValue;
    opens: MetricValue;
    clicks: MetricValue;
    signups: SignupMetricValue;
  };
}

interface PipelineActivityResponse {
  featureSlug: string;
  brandId: string;
  timezone: string;
  generatedAt: string;
  days: DayBucket[];
  summary: {
    dailyBudgetUsd: number | null;
    openRatePct: number | null;
    clickToSignupPct: number | null;
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
  dailyBudgetUsd: number | null;
  openRatePct: number | null;
  clickToSignupPct: number | null;
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

type Goal = "signup" | "meetingBooked" | "purchase";
const FORECAST_GOAL: Goal = "signup";

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

function emptyExpected(clickToSignupPct: number | null = null): ExpectedActivity {
  return {
    outreach: null,
    opens: null,
    clicks: null,
    signups: null,
    dailyBudgetUsd: null,
    openRatePct: null,
    clickToSignupPct,
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

function getBillingServiceHeaders(
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

function getRunsServiceHeaders(
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

async function fetchBrandDailyBudgetUsd(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId: string; runId: string },
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

async function fetchDailyBroadcastActivity(
  brandId: string,
  featureSlug: string,
  timezone: string,
  headers: { orgId: string; userId: string; runId: string },
): Promise<Map<string, ActualActivity>> {
  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({
    type: "broadcast",
    groupBy: "day",
    brandId,
    featureSlugs: featureSlug,
    timezone,
  });
  const response = await fetchWithRetry(`${url}/orgs/stats?${params}`, {
    headers: getEmailGatewayHeaders(apiKey, { ...headers, brandId, featureSlug }),
  });

  if (!response.ok) {
    const body = await response.text();
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

async function buildWorkflowActivityUnits(
  featureSlug: string,
  economics: SalesEconomics,
): Promise<Map<string, WorkflowActivityUnit>> {
  const [workflows, costGroups, emailStats] = await Promise.all([
    fetchPublicWorkflows(featureSlug, "all"),
    fetchPublicCosts(featureSlug, "workflowSlug"),
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

  return unitsByWorkflowSlug;
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
 * to the chosen workflow dynasty + goal (+ brand profile when known) so the CPC ranking is
 * per-workflow. Reads `dimensions.audienceId` only — no legacy id fallback.
 */
async function fetchAudienceCosts(
  brandId: string,
  featureSlug: string,
  workflowDynastySlug: string,
  brandProfileId: string | null,
  headers: { orgId: string; userId: string; runId: string },
): Promise<Map<string, number>> {
  const runsUrl = process.env.RUNS_SERVICE_URL;
  const runsApiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!runsUrl || !runsApiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");

  const params = new URLSearchParams({
    groupBy: "audienceId",
    brandId,
    featureSlugs: featureSlug,
    workflowDynastySlug,
    goal: FORECAST_GOAL,
  });
  if (brandProfileId) params.set("brandProfileId", brandProfileId);

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
    const cents = parsePositiveNumber(group.totalCostInUsdCents);
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
): Promise<{ audienceId: string; brandProfileId: string | null; rates: ForecastRates } | null> {
  const [audiences, currentProfile] = await Promise.all([
    fetchActiveAudiences(brandId, { ...headers, featureSlug }),
    fetchCurrentBrandProfile(brandId, { ...headers, featureSlug }),
  ]);
  if (audiences.length === 0) return null;

  const brandProfileId = currentProfile?.id ?? null;
  const [costs, outcomes] = await Promise.all([
    fetchAudienceCosts(brandId, featureSlug, workflowDynastySlug, brandProfileId, headers),
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
): Promise<ExpectedActivity> {
  const [dailyBudgetUsd, effective] = await Promise.all([
    fetchBrandDailyBudgetUsd(brandId, featureSlug, headers),
    fetchEffectiveEconomics(brandId, { ...headers, featureSlug }),
  ]);

  const economics = effective.economics;
  const clickToSignupPct = economics?.visitToSignupPct ?? null;
  if (dailyBudgetUsd === null || !economics) return emptyExpected(clickToSignupPct);

  const units = await buildWorkflowActivityUnits(featureSlug, economics);
  const bestWorkflow = chooseBestSignupWorkflow(units);
  if (!bestWorkflow || bestWorkflow.outreachUsd === null) return emptyExpected(clickToSignupPct);

  const forecast = await fetchBestAudienceForecast(
    brandId,
    featureSlug,
    bestWorkflow.workflowDynastySlug,
    headers,
  );
  const rates = forecast?.rates ?? { openPerOutreach: null, clickPerOutreach: null, positiveReplyPerOutreach: null };

  const outreach = dailyBudgetUsd / bestWorkflow.outreachUsd;
  const openPerOutreach = rates.openPerOutreach ?? bestWorkflow.openPerOutreach;
  const clickPerOutreach = rates.clickPerOutreach ?? bestWorkflow.clickPerOutreach;
  const opens = openPerOutreach !== null ? outreach * openPerOutreach : null;
  const clicks = clickPerOutreach !== null ? outreach * clickPerOutreach : null;
  const signups = clicks !== null && clickToSignupPct !== null ? clicks * (clickToSignupPct / 100) : null;
  const openRatePct = openPerOutreach !== null ? openPerOutreach * 100 : null;

  return {
    outreach,
    opens,
    clicks,
    signups,
    dailyBudgetUsd,
    openRatePct,
    clickToSignupPct,
  };
}

function buildDayBuckets(
  dates: string[],
  today: string,
  actualByDate: Map<string, ActualActivity>,
  expected: ExpectedActivity,
): DayBucket[] {
  return dates.map((date) => {
    const isToday = date === today;
    const actual = actualByDate.get(date) ?? { outreach: 0, opens: 0, clicks: 0 };
    const actualMetric = (metric: MetricName): number | null => (isToday ? actual[metric] : null);
    const signupActual =
      isToday && expected.clickToSignupPct !== null ? actual.clicks * (expected.clickToSignupPct / 100) : null;

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
      },
    };
  });
}

router.get("/features/:featureSlug/pipeline-activity", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const auth = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const timezone = req.query.timezone as string | undefined;
  const days = parseDays(req.query.days);

  if (!brandId) return res.status(400).json({ error: "brandId query parameter is required" });
  if (!timezone) return res.status(400).json({ error: "timezone query parameter is required" });
  if (!isValidTimeZone(timezone)) return res.status(400).json({ error: "timezone must be a valid IANA time zone" });
  if (days === null) return res.status(400).json({ error: "days must be a positive integer" });

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) return res.status(404).json({ error: "Feature not found" });

    const today = dateInTimeZone(new Date(), timezone);
    const dates = Array.from({ length: days }, (_, index) => addDays(today, index));
    const [expected, actualByDate] = await Promise.all([
      computeExpectedActivity(featureSlug, brandId, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId }),
      fetchDailyBroadcastActivity(brandId, featureSlug, timezone, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId }),
    ]);

    const response: PipelineActivityResponse = {
      featureSlug,
      brandId,
      timezone,
      generatedAt: new Date().toISOString(),
      days: buildDayBuckets(dates, today, actualByDate, expected),
      summary: {
        dailyBudgetUsd: expected.dailyBudgetUsd,
        openRatePct: expected.openRatePct,
        clickToSignupPct: expected.clickToSignupPct,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("[features-service] Pipeline activity error:", error);
    res.status(502).json({ error: "Failed to compute pipeline activity" });
  }
});

export default router;
