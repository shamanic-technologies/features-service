import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { fetchBrandPersonas, fetchCurrentBrandProfile } from "../lib/brand-client.js";
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

async function fetchBestPersonaId(
  brandId: string,
  featureSlug: string,
  workflowDynastySlug: string,
  workflowSlugs: string[],
  headers: { orgId: string; userId: string; runId: string },
): Promise<{ customerProfileId: string; brandProfileId: string | null } | null> {
  const runsUrl = process.env.RUNS_SERVICE_URL;
  const runsApiKey = process.env.RUNS_SERVICE_API_KEY;
  const emailUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const emailApiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!runsUrl || !runsApiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  if (!emailUrl || !emailApiKey) throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");

  const [personas, currentProfile] = await Promise.all([
    fetchBrandPersonas(brandId, { ...headers, featureSlug }),
    fetchCurrentBrandProfile(brandId, { ...headers, featureSlug }),
  ]);
  const activePersonaIds = new Set(personas.filter((persona) => persona.status === "active").map((persona) => persona.id));
  if (activePersonaIds.size === 0) return null;

  const brandProfileId = currentProfile?.id ?? null;
  const costParams = new URLSearchParams({
    groupBy: "customerProfileId",
    brandId,
    featureSlugs: featureSlug,
    workflowDynastySlug,
    goal: FORECAST_GOAL,
  });
  const outcomeParams = new URLSearchParams({
    type: "broadcast",
    groupBy: "customerProfileId",
    brandId,
    featureSlugs: featureSlug,
    workflowSlugs: workflowSlugs.join(","),
    goal: FORECAST_GOAL,
  });
  if (brandProfileId) {
    costParams.set("brandProfileId", brandProfileId);
    outcomeParams.set("brandProfileId", brandProfileId);
  }

  const [costResponse, outcomeResponse] = await Promise.all([
    fetchWithRetry(`${runsUrl}/v1/stats/costs?${costParams}`, {
      headers: getRunsServiceHeaders(runsApiKey, { ...headers, brandId, featureSlug }),
    }),
    fetchWithRetry(`${emailUrl}/orgs/stats?${outcomeParams}`, {
      headers: getEmailGatewayHeaders(emailApiKey, { ...headers, brandId, featureSlug }),
    }),
  ]);

  if (!costResponse.ok) {
    const body = await costResponse.text();
    throw new Error(`runs-service persona costs failed (${costResponse.status}): ${body}`);
  }
  if (!outcomeResponse.ok) {
    const body = await outcomeResponse.text();
    throw new Error(`email-gateway persona stats failed (${outcomeResponse.status}): ${body}`);
  }

  const costData = (await costResponse.json()) as {
    groups?: Array<{ dimensions?: Record<string, string | null>; totalCostInUsdCents: string | number }>;
  };
  const outcomeData = (await outcomeResponse.json()) as {
    groups?: Array<{ key?: string | null; broadcast?: { recipientStats?: Record<string, number> } }>;
  };
  if (!Array.isArray(costData.groups)) throw new Error("runs-service persona costs returned no groups array");
  if (!Array.isArray(outcomeData.groups)) throw new Error("email-gateway persona stats returned no groups array");

  const costs = new Map<string, number>();
  for (const group of costData.groups) {
    const id = group.dimensions?.customerProfileId;
    if (!id || id === "__total__" || !activePersonaIds.has(id)) continue;
    const cents = parsePositiveNumber(group.totalCostInUsdCents);
    if (cents !== null) costs.set(id, cents);
  }

  let best: { customerProfileId: string; cpcCents: number } | null = null;
  for (const group of outcomeData.groups) {
    const id = group.key;
    if (!id || id === "__total__" || !activePersonaIds.has(id)) continue;
    const stats = group.broadcast?.recipientStats;
    if (!stats) throw new Error(`email-gateway persona stats missing recipientStats for customerProfileId=${id}`);
    const costCents = costs.get(id);
    const clicks = readStatsNumber(stats.clicked, "recipientStats.clicked");
    if (costCents === undefined || clicks <= 0) continue;
    const cpcCents = costCents / clicks;
    if (best === null || cpcCents < best.cpcCents) best = { customerProfileId: id, cpcCents };
  }

  return best ? { customerProfileId: best.customerProfileId, brandProfileId } : null;
}

async function fetchPersonaWorkflowRates(
  brandId: string,
  featureSlug: string,
  workflowSlugs: string[],
  persona: { customerProfileId: string; brandProfileId: string | null },
  headers: { orgId: string; userId: string; runId: string },
): Promise<ForecastRates> {
  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({
    type: "broadcast",
    brandId,
    featureSlugs: featureSlug,
    workflowSlugs: workflowSlugs.join(","),
    customerProfileId: persona.customerProfileId,
    goal: FORECAST_GOAL,
  });
  if (persona.brandProfileId) params.set("brandProfileId", persona.brandProfileId);

  const response = await fetchWithRetry(`${url}/orgs/stats?${params}`, {
    headers: getEmailGatewayHeaders(apiKey, { ...headers, brandId, featureSlug }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`email-gateway persona/workflow stats failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { broadcast?: { recipientStats?: Record<string, number> } };
  const stats = data.broadcast?.recipientStats;
  if (!stats) return { openPerOutreach: null, clickPerOutreach: null, positiveReplyPerOutreach: null };

  const contacted = readStatsNumber(stats.contacted, "recipientStats.contacted");
  const opened = readStatsNumber(stats.opened, "recipientStats.opened");
  const clicked = readStatsNumber(stats.clicked, "recipientStats.clicked");
  const repliesPositive = readStatsNumber(stats.repliesPositive, "recipientStats.repliesPositive");
  return {
    openPerOutreach: ratio(opened, contacted),
    clickPerOutreach: ratio(clicked, contacted),
    positiveReplyPerOutreach: ratio(repliesPositive, contacted),
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

  const persona = await fetchBestPersonaId(
    brandId,
    featureSlug,
    bestWorkflow.workflowDynastySlug,
    bestWorkflow.workflowSlugs,
    headers,
  );
  const rates = persona
    ? await fetchPersonaWorkflowRates(brandId, featureSlug, bestWorkflow.workflowSlugs, persona, headers)
    : { openPerOutreach: null, clickPerOutreach: null, positiveReplyPerOutreach: null };

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
