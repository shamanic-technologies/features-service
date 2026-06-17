import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import {
  fetchPublicCosts,
  fetchPublicEmailStats,
  fetchPublicWorkflows,
} from "../lib/public-stats-clients.js";
import { fetchSalesEconomics } from "../lib/sales-economics-client.js";
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

interface CampaignRow {
  id: string;
  workflowSlug: string;
  status: string;
  maxBudgetDailyUsd: string | null;
}

interface BudgetedCampaign {
  id: string;
  workflowSlug: string;
  dailyBudgetUsd: number;
}

interface CampaignBudgetPlan {
  dailyBudgetUsd: number | null;
  campaigns: BudgetedCampaign[];
}

interface WorkflowActivityUnit {
  outreachUsd: number | null;
  clickUsd: number | null;
  openPerOutreach: number | null;
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
    };
  };
}

const ACTIVE_CAMPAIGN_STATUSES = new Set(["active", "ongoing", "running"]);

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

function parsePositiveUsd(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
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

function getCampaignServiceHeaders(
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

async function fetchCampaignBudgetPlan(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId: string; runId: string },
): Promise<CampaignBudgetPlan> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({ brandId, featureSlug });
  const response = await fetchWithRetry(`${url}/campaigns?${params}`, {
    headers: getCampaignServiceHeaders(apiKey, { ...headers, brandId, featureSlug }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`campaign-service /campaigns failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { campaigns: CampaignRow[] };
  const active = data.campaigns.filter((campaign) => ACTIVE_CAMPAIGN_STATUSES.has(campaign.status));
  if (active.length === 0) return { dailyBudgetUsd: null, campaigns: [] };

  const campaigns: BudgetedCampaign[] = [];
  for (const campaign of active) {
    const dailyBudgetUsd = parsePositiveUsd(campaign.maxBudgetDailyUsd);
    if (dailyBudgetUsd === null) return { dailyBudgetUsd: null, campaigns: [] };
    campaigns.push({ id: campaign.id, workflowSlug: campaign.workflowSlug, dailyBudgetUsd });
  }

  return {
    dailyBudgetUsd: campaigns.reduce((sum, campaign) => sum + campaign.dailyBudgetUsd, 0),
    campaigns,
  };
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
      outreach: readStatsNumber(stats.sent, "recipientStats.sent"),
      opens: readStatsNumber(stats.opened, "recipientStats.opened"),
      clicks: readStatsNumber(stats.clicked, "recipientStats.clicked"),
    });
  }

  return result;
}

async function buildWorkflowActivityUnits(featureSlug: string): Promise<Map<string, WorkflowActivityUnit>> {
  const [workflows, costGroups, emailStats] = await Promise.all([
    fetchPublicWorkflows(featureSlug, "all"),
    fetchPublicCosts(featureSlug, "workflowSlug"),
    fetchPublicEmailStats(featureSlug, "workflowSlug"),
  ]);

  const chains = buildUpgradeChains(workflows);
  const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");
  const unitsByWorkflowSlug = new Map<string, WorkflowActivityUnit>();

  for (const [activeSlug, chainSlugs] of chains) {
    const cost = costMap.get(activeSlug);
    if (!cost) continue;
    const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
    const costUsd = cost.totalCostInUsdCents / 100;
    const outreach = outcomes.recipientsSent ?? 0;
    const opened = outcomes.recipientsOpened ?? 0;
    const clicked = outcomes.recipientsClicked ?? 0;

    const unit: WorkflowActivityUnit = {
      outreachUsd: costUsd > 0 && outreach > 0 ? costUsd / outreach : null,
      clickUsd: costUsd > 0 && clicked > 0 ? costUsd / clicked : null,
      openPerOutreach: outreach > 0 ? opened / outreach : null,
    };

    for (const slug of chainSlugs) unitsByWorkflowSlug.set(slug, unit);
    unitsByWorkflowSlug.set(activeSlug, unit);
  }

  return unitsByWorkflowSlug;
}

function sumExpected(
  campaigns: BudgetedCampaign[],
  units: Map<string, WorkflowActivityUnit>,
  project: (campaign: BudgetedCampaign, unit: WorkflowActivityUnit) => number | null,
): number | null {
  if (campaigns.length === 0) return null;

  let total = 0;
  for (const campaign of campaigns) {
    const unit = units.get(campaign.workflowSlug);
    if (!unit) return null;
    const projected = project(campaign, unit);
    if (projected === null || !Number.isFinite(projected)) return null;
    total += projected;
  }

  return total;
}

async function computeExpectedActivity(
  featureSlug: string,
  brandId: string,
  headers: { orgId: string; userId: string; runId: string },
): Promise<ExpectedActivity> {
  const [budgetPlan, units, economics] = await Promise.all([
    fetchCampaignBudgetPlan(brandId, featureSlug, headers),
    buildWorkflowActivityUnits(featureSlug),
    fetchSalesEconomics(brandId, { ...headers, featureSlug }),
  ]);

  const clickToSignupPct = economics?.visitToSignupPct ?? null;
  if (budgetPlan.dailyBudgetUsd === null) return emptyExpected(clickToSignupPct);

  const outreach = sumExpected(budgetPlan.campaigns, units, (campaign, unit) =>
    unit.outreachUsd === null ? null : campaign.dailyBudgetUsd / unit.outreachUsd,
  );
  const clicks = sumExpected(budgetPlan.campaigns, units, (campaign, unit) =>
    unit.clickUsd === null ? null : campaign.dailyBudgetUsd / unit.clickUsd,
  );
  const opens = sumExpected(budgetPlan.campaigns, units, (campaign, unit) => {
    if (unit.outreachUsd === null || unit.openPerOutreach === null) return null;
    return (campaign.dailyBudgetUsd / unit.outreachUsd) * unit.openPerOutreach;
  });

  const signups = clicks !== null && clickToSignupPct !== null ? clicks * (clickToSignupPct / 100) : null;
  const openRatePct = outreach !== null && outreach > 0 && opens !== null ? (opens / outreach) * 100 : null;

  return {
    outreach,
    opens,
    clicks,
    signups,
    dailyBudgetUsd: budgetPlan.dailyBudgetUsd,
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
