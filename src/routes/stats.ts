import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { STATS_REGISTRY, getPublicRegistry, getEntityRegistry, type StatsKeyDef, type RunFilter } from "../lib/stats-registry.js";
import { traceEvent } from "../lib/trace-event.js";

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL!;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY!;
const EMAIL_GATEWAY_SERVICE_URL = process.env.EMAIL_GATEWAY_SERVICE_URL!;
const EMAIL_GATEWAY_SERVICE_API_KEY = process.env.EMAIL_GATEWAY_SERVICE_API_KEY!;
const OUTLETS_SERVICE_URL = process.env.OUTLETS_SERVICE_URL!;
const OUTLETS_SERVICE_API_KEY = process.env.OUTLETS_SERVICE_API_KEY!;
function getJournalistsServiceUrl(): string { return process.env.JOURNALISTS_SERVICE_URL!; }
function getJournalistsServiceApiKey(): string { return process.env.JOURNALISTS_SERVICE_API_KEY!; }
function getLeadServiceUrl(): string { return process.env.LEAD_SERVICE_URL!; }
function getLeadServiceApiKey(): string { return process.env.LEAD_SERVICE_API_KEY!; }
function getPressKitsServiceUrl(): string { return process.env.PRESS_KITS_SERVICE_URL!; }
function getPressKitsServiceApiKey(): string { return process.env.PRESS_KITS_SERVICE_API_KEY!; }
function getJournalistsQuotesServiceUrl(): string | undefined { return process.env.JOURNALISTS_QUOTES_SERVICE_URL; }
function getJournalistsQuotesServiceApiKey(): string | undefined { return process.env.JOURNALISTS_QUOTES_SERVICE_API_KEY; }
function getAiVisibilityServiceUrl(): string | undefined { return process.env.AI_VISIBILITY_SERVICE_URL; }
function getAiVisibilityServiceApiKey(): string | undefined { return process.env.AI_VISIBILITY_SERVICE_API_KEY; }

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

interface Identity {
  userId: string;
  runId: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
}

function buildDownstreamHeaders(
  apiKey: string,
  orgId: string,
  identity: Identity,
): Record<string, string> {
  const h: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (identity.brandId) h["x-brand-id"] = identity.brandId;
  if (identity.campaignId) h["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) h["x-feature-slug"] = identity.featureSlug;
  return h;
}

interface SystemStats {
  totalCostInUsdCents: number;
  completedRuns: number;
  activeCampaigns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

interface StatsGroup {
  workflowSlug?: string | null;
  workflowDynastySlug?: string | null;
  brandId?: string | null;
  campaignId?: string | null;
  featureSlug?: string | null;
  systemStats: SystemStats;
  stats: Record<string, number | null>;
}

interface RunsStatsEntry {
  totalCostInUsdCents: number;
  completedRuns: number;
  minStartedAt: string | null;
  maxStartedAt: string | null;
}

type GroupByDimension = "workflowSlug" | "workflowDynastySlug" | "brandId" | "campaignId" | "featureSlug";

const VALID_GROUP_BY: Set<string> = new Set([
  "workflowSlug", "workflowDynastySlug", "brandId", "campaignId", "featureSlug",
]);

// ── All stats keys ──────────────────────────────────────────────────────────

const ALL_STATS_KEYS = new Set(Object.keys(STATS_REGISTRY));

function computeAllDerivedStats(rawStats: Record<string, number>): Record<string, number | null> {
  const result: Record<string, number | null> = {};

  for (const [key, def] of Object.entries(STATS_REGISTRY)) {
    if (def.kind === "raw") {
      result[key] = rawStats[key] ?? null;
    } else if (def.kind === "derived") {
      const num = rawStats[def.numerator];
      const den = rawStats[def.denominator];
      if (num != null && den != null && den > 0) {
        result[key] = num / den;
      } else {
        result[key] = null;
      }
    }
  }

  return result;
}

// ── Downstream fetch functions ──────────────────────────────────────────────

async function fetchEmailStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  if (groupBy) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlugs", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureSlug) params.set("featureSlugs", filters.featureSlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${EMAIL_GATEWAY_SERVICE_URL}/orgs/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(EMAIL_GATEWAY_SERVICE_API_KEY, orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] email-gateway /orgs/stats failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as Record<string, unknown>;
    const result = new Map<string, Record<string, number>>();

    if (data.groups && Array.isArray(data.groups)) {
      for (const group of data.groups as Array<Record<string, unknown>>) {
        const groupKey = String(group.key ?? "__total__");
        result.set(groupKey, mergeEmailChannels(group));
      }
    } else {
      result.set("__total__", mergeEmailChannels(data));
    }

    return result;
  } catch (error) {
    console.error(`[features-service] email-gateway /orgs/stats network error:`, (error as Error).message);
    return new Map();
  }
}

function mergeEmailChannels(data: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  const broadcast = data.broadcast as Record<string, unknown> | undefined;
  if (!broadcast) return result;

  const recipientStats = broadcast.recipientStats as Record<string, number> | undefined;
  if (!recipientStats) return result;

  result.recipientsContacted = recipientStats.contacted;
  result.recipientsSent = recipientStats.sent;
  result.recipientsDelivered = recipientStats.delivered;
  result.recipientsOpened = recipientStats.opened;
  result.recipientsClicked = recipientStats.clicked;
  result.recipientsBounced = recipientStats.bounced;
  result.recipientsRepliesPositive = recipientStats.repliesPositive;
  result.recipientsRepliesNegative = recipientStats.repliesNegative;
  result.recipientsRepliesNeutral = recipientStats.repliesNeutral;
  result.recipientsRepliesAutoReply = recipientStats.repliesAutoReply;

  return result;
}

async function fetchRunsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlugs: string[] | undefined,
  identity: Identity,
): Promise<Map<string, RunsStatsEntry>> {
  const slugsToQuery = featureSlugs ?? (filters.featureSlug ? [filters.featureSlug] : []);

  if (slugsToQuery.length === 0) {
    return fetchRunsStatsForSlug(orgId, groupBy, filters, undefined, identity);
  }

  const maps = await Promise.all(
    slugsToQuery.map((slug) => fetchRunsStatsForSlug(orgId, groupBy, filters, slug, identity)),
  );

  const merged = new Map<string, RunsStatsEntry>();
  for (const map of maps) {
    for (const [key, data] of map) {
      const existing = merged.get(key);
      if (existing) {
        existing.totalCostInUsdCents += data.totalCostInUsdCents;
        existing.completedRuns += data.completedRuns;
        if (data.minStartedAt && (!existing.minStartedAt || data.minStartedAt < existing.minStartedAt)) {
          existing.minStartedAt = data.minStartedAt;
        }
        if (data.maxStartedAt && (!existing.maxStartedAt || data.maxStartedAt > existing.maxStartedAt)) {
          existing.maxStartedAt = data.maxStartedAt;
        }
      } else {
        merged.set(key, { ...data });
      }
    }
  }

  return merged;
}

async function fetchRunsStatsForSlug(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlug: string | undefined,
  identity: Identity,
): Promise<Map<string, RunsStatsEntry>> {
  const runsGroupBy = groupBy ?? "workflowSlug";
  const params = new URLSearchParams({ groupBy: runsGroupBy });
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureSlug) params.set("featureSlug", filters.featureSlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (featureSlug) params.set("featureSlug", featureSlug);

  const url = `${RUNS_SERVICE_URL}/v1/stats/costs?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(RUNS_SERVICE_API_KEY, orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] runs-service /v1/stats/costs failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as {
      groups: Array<{
        dimensions: Record<string, string | null>;
        totalCostInUsdCents: string;
        runCount: number;
        minStartedAt: string | null;
        maxStartedAt: string | null;
      }>;
    };

    const result = new Map<string, RunsStatsEntry>();

    if (!groupBy) {
      let totalCost = 0;
      let totalRuns = 0;
      let minStartedAt: string | null = null;
      let maxStartedAt: string | null = null;
      for (const group of data.groups) {
        totalCost += Math.round(Number(group.totalCostInUsdCents));
        totalRuns += group.runCount;
        if (group.minStartedAt && (!minStartedAt || group.minStartedAt < minStartedAt)) {
          minStartedAt = group.minStartedAt;
        }
        if (group.maxStartedAt && (!maxStartedAt || group.maxStartedAt > maxStartedAt)) {
          maxStartedAt = group.maxStartedAt;
        }
      }
      if (data.groups.length > 0) {
        result.set("__total__", { totalCostInUsdCents: totalCost, completedRuns: totalRuns, minStartedAt, maxStartedAt });
      }
    } else {
      for (const group of data.groups) {
        const key = group.dimensions[runsGroupBy] ?? "__total__";
        result.set(key, {
          totalCostInUsdCents: Math.round(Number(group.totalCostInUsdCents)),
          completedRuns: group.runCount,
          minStartedAt: group.minStartedAt ?? null,
          maxStartedAt: group.maxStartedAt ?? null,
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`[features-service] runs-service /v1/stats/costs network error:`, (error as Error).message);
    return new Map();
  }
}

async function fetchOutletsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  if (groupBy) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureSlug) params.set("featureSlug", filters.featureSlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${OUTLETS_SERVICE_URL}/orgs/outlets/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(OUTLETS_SERVICE_API_KEY, orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] outlets-service /orgs/outlets/stats failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as Record<string, unknown>;
    const result = new Map<string, Record<string, number>>();

    if (data.groups && Array.isArray(data.groups)) {
      for (const group of data.groups as Array<Record<string, unknown>>) {
        const groupKey = String(group.key ?? "__total__");
        result.set(groupKey, {
          outletsDiscovered: Number(group.outletsDiscovered ?? 0),
          avgRelevanceScore: Number(group.avgRelevanceScore ?? 0),
          searchQueriesUsed: Number(group.searchQueriesUsed ?? 0),
        });
      }
    } else {
      result.set("__total__", {
        outletsDiscovered: Number(data.outletsDiscovered ?? 0),
        avgRelevanceScore: Number(data.avgRelevanceScore ?? 0),
        searchQueriesUsed: Number(data.searchQueriesUsed ?? 0),
      });
    }

    return result;
  } catch (error) {
    console.error(`[features-service] outlets-service /orgs/outlets/stats network error:`, (error as Error).message);
    return new Map();
  }
}

async function fetchJournalistsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  const supportedGroupBy = new Set(["featureSlug", "workflowSlug", "workflowDynastySlug"]);
  if (groupBy && supportedGroupBy.has(groupBy)) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureSlug) params.set("featureSlug", filters.featureSlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${getJournalistsServiceUrl()}/orgs/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(getJournalistsServiceApiKey(), orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] journalists-service /orgs/stats failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as {
      totalJournalists: number;
      byOutreachStatus: Record<string, number>;
      groupedBy?: Record<string, { totalJournalists: number; byOutreachStatus: Record<string, number> }>;
    };

    const result = new Map<string, Record<string, number>>();

    if (data.groupedBy && groupBy && supportedGroupBy.has(groupBy)) {
      for (const [key, group] of Object.entries(data.groupedBy)) {
        result.set(key, {
          journalistsFound: group.totalJournalists,
          journalistsContacted: group.byOutreachStatus.contacted ?? 0,
        });
      }
    } else {
      result.set("__total__", {
        journalistsFound: data.totalJournalists,
        journalistsContacted: data.byOutreachStatus.contacted ?? 0,
      });
    }

    return result;
  } catch (error) {
    console.error(`[features-service] journalists-service /orgs/stats network error:`, (error as Error).message);
    return new Map();
  }
}

interface LeadByOutreachStatus {
  contacted: number;
  sent: number;
  delivered: number;
  opened: number;
  bounced: number;
  clicked: number;
  unsubscribed: number;
  repliesPositive: number;
  repliesNegative: number;
  repliesNeutral: number;
  repliesAutoReply: number;
}

interface LeadByOutreachStatusCompanies {
  served: number;
  contacted: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  repliesPositive: number;
  repliesNegative: number;
  repliesNeutral: number;
}

interface LeadRepliesDetail {
  interested: number;
  meetingBooked: number;
  closed: number;
  notInterested: number;
  wrongPerson: number;
  unsubscribe: number;
  neutral: number;
  autoReply: number;
  outOfOffice: number;
}

interface LeadStatsBlock {
  totalLeads: number;
  byOutreachStatus: LeadByOutreachStatus;
  // Optional during the lead-service rollout window. Once lead-service ships
  // distinct-organization counts (see features-service issue #176), every
  // /orgs/stats response carries this block.
  byOutreachStatusCompanies?: LeadByOutreachStatusCompanies;
  repliesDetail: LeadRepliesDetail;
  buffered: number;
  skipped: number;
  claimed: number;
}

function mapLeadStatsBlock(block: LeadStatsBlock): Record<string, number> {
  const o = block.byOutreachStatus;
  const r = block.repliesDetail;
  const c = block.byOutreachStatusCompanies;
  return {
    leadsServed: block.totalLeads,
    leadsContacted: o.contacted,
    leadsSent: o.sent,
    leadsDelivered: o.delivered,
    leadsOpened: o.opened,
    leadsClicked: o.clicked,
    leadsBounced: o.bounced,
    leadsUnsubscribed: o.unsubscribed,
    leadsRepliesPositive: o.repliesPositive,
    leadsRepliesNegative: o.repliesNegative,
    leadsRepliesNeutral: o.repliesNeutral,
    leadsRepliesAutoReply: o.repliesAutoReply,
    leadsRepliesInterested: r.interested,
    leadsRepliesMeetingBooked: r.meetingBooked,
    leadsRepliesClosed: r.closed,
    leadsRepliesNotInterested: r.notInterested,
    leadsRepliesWrongPerson: r.wrongPerson,
    leadsRepliesUnsubscribeDetail: r.unsubscribe,
    leadsRepliesNeutralDetail: r.neutral,
    leadsRepliesAutoReplyDetail: r.autoReply,
    leadsRepliesOutOfOffice: r.outOfOffice,
    leadsBuffered: block.buffered,
    leadsSkipped: block.skipped,
    leadsClaimed: block.claimed,
    // Company-scoped distinct counts. 0 fallback covers the lead-service
    // rollout window; remove once that PR is deployed everywhere.
    companiesServed:          c?.served          ?? 0,
    companiesContacted:       c?.contacted       ?? 0,
    companiesSent:            c?.sent            ?? 0,
    companiesDelivered:       c?.delivered       ?? 0,
    companiesOpened:          c?.opened          ?? 0,
    companiesClicked:         c?.clicked         ?? 0,
    companiesBounced:         c?.bounced         ?? 0,
    companiesRepliesPositive: c?.repliesPositive ?? 0,
    companiesRepliesNegative: c?.repliesNegative ?? 0,
    companiesRepliesNeutral:  c?.repliesNeutral  ?? 0,
  };
}

async function fetchLeadsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams();
  const supportedGroupBy = new Set(["featureSlug", "workflowSlug", "workflowDynastySlug", "campaignId", "brandId"]);
  if (groupBy && supportedGroupBy.has(groupBy)) params.set("groupBy", groupBy);
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureSlug) params.set("featureSlug", filters.featureSlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  const url = `${getLeadServiceUrl()}/orgs/stats?${params}`;
  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(getLeadServiceApiKey(), orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] lead-service /orgs/stats failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as
      | (LeadStatsBlock & { groups?: undefined })
      | { groups: Array<LeadStatsBlock & { key: string }> };

    const result = new Map<string, Record<string, number>>();

    if ("groups" in data && data.groups) {
      for (const group of data.groups) {
        result.set(group.key, mapLeadStatsBlock(group));
      }
    } else if ("totalLeads" in data) {
      result.set("__total__", mapLeadStatsBlock(data));
    }

    return result;
  } catch (error) {
    console.error(`[features-service] lead-service /orgs/stats network error:`, (error as Error).message);
    return new Map();
  }
}

async function fetchPressKitsStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const headers = buildDownstreamHeaders(getPressKitsServiceApiKey(), orgId, identity);
  const supportedGroupBy = new Set(["brandId", "campaignId", "featureSlug", "workflowSlug", "workflowDynastySlug"]);

  function applyFilters(params: URLSearchParams): void {
    if (filters.brandId) params.set("brandId", filters.brandId);
    if (filters.campaignId) params.set("campaignId", filters.campaignId);
    if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
    if (filters.featureSlug) params.set("featureSlug", filters.featureSlug);
  }

  const viewsParams = new URLSearchParams();
  applyFilters(viewsParams);
  if (groupBy && supportedGroupBy.has(groupBy)) viewsParams.set("groupBy", groupBy);

  const costsParams = new URLSearchParams();
  applyFilters(costsParams);
  if (groupBy && supportedGroupBy.has(groupBy)) costsParams.set("groupBy", groupBy);

  try {
    const [viewsRes, costsRes] = await Promise.all([
      fetch(`${getPressKitsServiceUrl()}/media-kits/stats/views?${viewsParams}`, { headers }),
      fetch(`${getPressKitsServiceUrl()}/media-kits/stats/costs?${costsParams}`, { headers }),
    ]);

    const viewsByGroup = new Map<string, { views: number; unique: number }>();

    if (viewsRes.ok) {
      const viewsData = await viewsRes.json() as Record<string, unknown>;
      if (viewsData.groups && Array.isArray(viewsData.groups)) {
        for (const g of viewsData.groups as Array<Record<string, unknown>>) {
          const key = String(g.key ?? "__total__");
          viewsByGroup.set(key, { views: Number(g.totalViews ?? 0), unique: Number(g.uniqueVisitors ?? 0) });
        }
      } else {
        viewsByGroup.set("__total__", { views: Number((viewsData as any).totalViews ?? 0), unique: Number((viewsData as any).uniqueVisitors ?? 0) });
      }
    } else {
      console.error(`[features-service] press-kits-service /media-kits/stats/views failed: ${viewsRes.status}`);
    }

    const costsByGroup = new Map<string, number>();

    if (costsRes.ok) {
      const costsData = await costsRes.json() as { groups: Array<{ dimensions: Record<string, string | null>; runCount: number }> };
      if (!groupBy || !supportedGroupBy.has(groupBy)) {
        let total = 0;
        for (const g of costsData.groups) total += g.runCount;
        if (costsData.groups.length > 0) costsByGroup.set("__total__", total);
      } else {
        for (const g of costsData.groups) {
          const key = g.dimensions[groupBy] ?? "__total__";
          costsByGroup.set(key, (costsByGroup.get(key) ?? 0) + g.runCount);
        }
      }
    } else {
      console.error(`[features-service] press-kits-service /media-kits/stats/costs failed: ${costsRes.status}`);
    }

    const result = new Map<string, Record<string, number>>();
    const allKeys = new Set([...viewsByGroup.keys(), ...costsByGroup.keys()]);

    for (const key of allKeys) {
      const stats: Record<string, number> = {};
      const v = viewsByGroup.get(key);
      if (v) { stats.pressKitViews = v.views; stats.pressKitUniqueVisitors = v.unique; }
      const c = costsByGroup.get(key);
      if (c != null) stats.pressKitsGenerated = c;
      if (Object.keys(stats).length > 0) result.set(key, stats);
    }

    return result;
  } catch (error) {
    console.error(`[features-service] press-kits-service stats network error:`, (error as Error).message);
    return new Map();
  }
}

async function fetchJournalistsQuotesStats(
  orgId: string,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const baseUrl = getJournalistsQuotesServiceUrl();
  const apiKey = getJournalistsQuotesServiceApiKey();
  if (!baseUrl || !apiKey) return new Map();

  // journalists-quotes /orgs/quote-requests/stats only supports campaign_id scoping.
  // Without a campaignId there's nothing meaningful to aggregate at this layer.
  const campaignId = filters.campaignId;
  if (!campaignId) return new Map();

  const params = new URLSearchParams({ campaign_id: campaignId });
  const url = `${baseUrl}/orgs/quote-requests/stats?${params}`;

  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(apiKey, orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] journalists-quotes-service /orgs/quote-requests/stats failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as {
      totalRequests: number;
      totalPitched: number;
      totalSelected: number;
      totalPublished: number;
      totalNotSelected: number;
    };

    const stats: Record<string, number> = {
      quoteRequestsFound: data.totalRequests,
      quotePitchesSubmitted: data.totalPitched,
      quotesSelected: data.totalSelected,
      quotesPublished: data.totalPublished,
      quotesNotSelected: data.totalNotSelected,
    };

    const result = new Map<string, Record<string, number>>();
    result.set("__total__", stats);
    return result;
  } catch (error) {
    console.error(`[features-service] journalists-quotes-service /orgs/quote-requests/stats network error:`, (error as Error).message);
    return new Map();
  }
}

async function resolveBrandIdFromCampaign(
  orgId: string,
  campaignId: string,
  identity: Identity,
): Promise<string | null> {
  const campaignUrl = process.env.CAMPAIGN_SERVICE_URL;
  const campaignKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!campaignUrl || !campaignKey) return null;

  try {
    const response = await fetch(`${campaignUrl}/campaigns/${encodeURIComponent(campaignId)}`, {
      headers: buildDownstreamHeaders(campaignKey, orgId, identity),
    });
    if (!response.ok) {
      console.error(`[features-service] campaign-service /campaigns/${campaignId} failed: ${response.status}`);
      return null;
    }
    const data = await response.json() as { campaign?: { brandIds?: string[] | null } };
    const brandIds = data.campaign?.brandIds;
    if (!brandIds || brandIds.length === 0) return null;
    return brandIds[0];
  } catch (error) {
    console.error(`[features-service] campaign-service /campaigns/:id network error:`, (error as Error).message);
    return null;
  }
}

async function fetchAiVisibilityStats(
  orgId: string,
  filters: Record<string, string>,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const baseUrl = getAiVisibilityServiceUrl();
  const apiKey = getAiVisibilityServiceApiKey();
  if (!baseUrl || !apiKey) return new Map();

  // ai-visibility-score-service is brand-scoped. Use header brandId if present,
  // else resolve from campaignId via campaign-service.
  let brandId: string | null = filters.brandId ?? null;
  if (!brandId && filters.campaignId) {
    brandId = await resolveBrandIdFromCampaign(orgId, filters.campaignId, identity);
  }
  if (!brandId) return new Map();

  const params = new URLSearchParams({ brandId, limit: "1" });
  const url = `${baseUrl}/orgs/visibility-score-runs?${params}`;

  try {
    const response = await fetch(url, {
      headers: buildDownstreamHeaders(apiKey, orgId, identity),
    });

    if (!response.ok) {
      console.error(`[features-service] ai-visibility-score-service /orgs/visibility-score-runs failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as {
      runs: Array<{
        visibilityScore: string | null;
        brandMentionRate: string | null;
        shareOfVoice: string | null;
        netSentiment: string | null;
        citationRate: string | null;
        avgPosition: string | null;
      }>;
    };

    const latest = data.runs?.[0];
    if (!latest) return new Map();

    const parse = (v: string | null): number | undefined => {
      if (v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const stats: Record<string, number> = {};
    const visibilityScore = parse(latest.visibilityScore);
    const brandMentionRate = parse(latest.brandMentionRate);
    const shareOfVoice = parse(latest.shareOfVoice);
    const citationRate = parse(latest.citationRate);
    const netSentiment = parse(latest.netSentiment);
    const avgPosition = parse(latest.avgPosition);
    if (visibilityScore !== undefined) stats.visibilityScore = visibilityScore;
    if (brandMentionRate !== undefined) stats.brandMentionRate = brandMentionRate;
    if (shareOfVoice !== undefined) stats.shareOfVoice = shareOfVoice;
    if (citationRate !== undefined) stats.citationRate = citationRate;
    if (netSentiment !== undefined) stats.netSentiment = netSentiment;
    if (avgPosition !== undefined) stats.avgPosition = avgPosition;

    const result = new Map<string, Record<string, number>>();
    if (Object.keys(stats).length > 0) result.set("__total__", stats);
    return result;
  } catch (error) {
    console.error(`[features-service] ai-visibility-score-service /orgs/visibility-score-runs network error:`, (error as Error).message);
    return new Map();
  }
}

async function fetchPipelineStats(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlugs: string[] | undefined,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  // Collect pipeline keys from registry
  const pipelineKeys = new Map<string, RunFilter>();
  for (const [key, def] of Object.entries(STATS_REGISTRY)) {
    if (def.kind === "raw" && def.runFilter) {
      pipelineKeys.set(key, def.runFilter);
    }
  }
  if (pipelineKeys.size === 0) return new Map();

  const filterToKeys = new Map<string, { filter: RunFilter; keys: string[] }>();
  for (const [key, filter] of pipelineKeys) {
    const filterKey = `${filter.serviceName}:${filter.taskName}`;
    const entry = filterToKeys.get(filterKey);
    if (entry) { entry.keys.push(key); } else { filterToKeys.set(filterKey, { filter, keys: [key] }); }
  }

  const entries = [...filterToKeys.values()];
  const results = await Promise.all(
    entries.map(async ({ filter, keys }) => {
      const slugsToQuery = featureSlugs ?? (filters.featureSlug ? [filters.featureSlug] : []);
      const maps = await Promise.all(
        (slugsToQuery.length > 0 ? slugsToQuery : [undefined]).map((slug) =>
          fetchPipelineStatsForFilter(orgId, groupBy, filters, slug, filter, identity),
        ),
      );
      const merged = new Map<string, number>();
      for (const map of maps) { for (const [groupKey, count] of map) { merged.set(groupKey, (merged.get(groupKey) ?? 0) + count); } }
      return { keys, counts: merged };
    }),
  );

  const output = new Map<string, Record<string, number>>();
  for (const { keys, counts } of results) {
    for (const [groupKey, count] of counts) {
      const existing = output.get(groupKey) ?? {};
      for (const key of keys) existing[key] = count;
      output.set(groupKey, existing);
    }
  }

  return output;
}

async function fetchPipelineStatsForFilter(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlug: string | undefined,
  runFilter: RunFilter,
  identity: Identity,
): Promise<Map<string, number>> {
  const runsGroupBy = groupBy ?? "workflowSlug";
  const params = new URLSearchParams({ groupBy: runsGroupBy, serviceName: runFilter.serviceName, taskName: runFilter.taskName });
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.featureSlug) params.set("featureSlug", filters.featureSlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (featureSlug) params.set("featureSlug", featureSlug);

  const url = `${RUNS_SERVICE_URL}/v1/stats/costs?${params}`;
  try {
    const response = await fetch(url, { headers: buildDownstreamHeaders(RUNS_SERVICE_API_KEY, orgId, identity) });
    if (!response.ok) { console.error(`[features-service] runs-service pipeline stats failed: ${response.status}`); return new Map(); }

    const data = await response.json() as { groups: Array<{ dimensions: Record<string, string | null>; runCount: number }> };
    const result = new Map<string, number>();
    if (!groupBy) {
      let total = 0;
      for (const group of data.groups) total += group.runCount;
      if (data.groups.length > 0) result.set("__total__", total);
    } else {
      for (const group of data.groups) {
        const key = group.dimensions[runsGroupBy] ?? "__total__";
        result.set(key, (result.get(key) ?? 0) + group.runCount);
      }
    }
    return result;
  } catch (error) {
    console.error(`[features-service] runs-service pipeline stats network error:`, (error as Error).message);
    return new Map();
  }
}

async function fetchActiveCampaigns(orgId: string, filters: Record<string, string>, identity: Identity): Promise<number> {
  const campaignUrl = process.env.CAMPAIGN_SERVICE_URL;
  const campaignKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!campaignUrl || !campaignKey) return 0;

  const params = new URLSearchParams({ orgId });
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  try {
    const response = await fetch(`${campaignUrl}/stats?${params}`, { headers: buildDownstreamHeaders(campaignKey, orgId, identity) });
    if (!response.ok) { console.error(`[features-service] campaign-service /stats failed: ${response.status}`); return 0; }
    const data = await response.json() as { stats: { byStatus: Record<string, number> } };
    return data.stats.byStatus?.active ?? data.stats.byStatus?.running ?? 0;
  } catch (error) {
    console.error(`[features-service] campaign-service /stats network error:`, (error as Error).message);
    return 0;
  }
}

function buildSystemStats(runsData: RunsStatsEntry | undefined, activeCampaigns = 0): SystemStats {
  return {
    totalCostInUsdCents: runsData?.totalCostInUsdCents ?? 0,
    completedRuns: runsData?.completedRuns ?? 0,
    activeCampaigns,
    firstRunAt: runsData?.minStartedAt ?? null,
    lastRunAt: runsData?.maxStartedAt ?? null,
  };
}

function aggregateRunsTotals(runsStatsMap: Map<string, RunsStatsEntry>): RunsStatsEntry {
  let totalCost = 0, totalRuns = 0;
  let minStartedAt: string | null = null, maxStartedAt: string | null = null;
  for (const entry of runsStatsMap.values()) {
    totalCost += entry.totalCostInUsdCents;
    totalRuns += entry.completedRuns;
    if (entry.minStartedAt && (!minStartedAt || entry.minStartedAt < minStartedAt)) minStartedAt = entry.minStartedAt;
    if (entry.maxStartedAt && (!maxStartedAt || entry.maxStartedAt > maxStartedAt)) maxStartedAt = entry.maxStartedAt;
  }
  return { totalCostInUsdCents: totalCost, completedRuns: totalRuns, minStartedAt, maxStartedAt };
}

// ── GET /stats/registry ──────────────────────────────────────────────────────

router.get("/stats/registry", apiKeyAuth, async (_req, res) => {
  res.json({ registry: getPublicRegistry() });
});

// ── GET /entities/registry ──────────────────────────────────────────────────

router.get("/entities/registry", apiKeyAuth, async (_req, res) => {
  res.json({ registry: getEntityRegistry() });
});

// ── GET /features/:featureSlug/stats ─────────────────────────────────────────

router.get("/features/:featureSlug/stats", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;
    const { orgId, userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;

    const feature = await db.query.features.findFirst({
      where: eq(features.slug, featureSlug),
    });

    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    const groupByParam = req.query.groupBy as string | undefined;
    const groupBy = (groupByParam && VALID_GROUP_BY.has(groupByParam) ? groupByParam : null) as GroupByDimension | null;

    const filters: Record<string, string> = {};
    if (req.query.brandId) filters.brandId = req.query.brandId as string;
    if (req.query.campaignId) filters.campaignId = req.query.campaignId as string;
    if (req.query.workflowSlug) filters.workflowSlug = req.query.workflowSlug as string;
    if (req.query.workflowDynastySlug) filters.workflowDynastySlug = req.query.workflowDynastySlug as string;

    // Scope downstream calls to this feature
    filters.featureSlug = featureSlug;

    traceEvent(runId, { service: "features-service", event: "feature-stats-start", detail: `featureSlug=${featureSlug}, groupBy=${groupByParam ?? "none"}, filters=${JSON.stringify(filters)}` }, req.headers).catch(() => {});

    const identity: Identity = { userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug };
    const [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, pressKitsStatsMap, journalistsQuotesStatsMap, aiVisibilityStatsMap, activeCampaigns] = await Promise.all([
      fetchEmailStats(orgId, groupBy, filters, identity),
      fetchRunsStats(orgId, groupBy, filters, [featureSlug], identity),
      fetchOutletsStats(orgId, groupBy, filters, identity),
      fetchJournalistsStats(orgId, groupBy, filters, identity),
      fetchLeadsStats(orgId, groupBy, filters, identity),
      fetchPipelineStats(orgId, groupBy, filters, [featureSlug], identity),
      fetchPressKitsStats(orgId, groupBy, filters, identity),
      fetchJournalistsQuotesStats(orgId, filters, identity),
      fetchAiVisibilityStats(orgId, filters, identity),
      fetchActiveCampaigns(orgId, filters, identity),
    ]);

    if (!groupBy) {
      const rawStats: Record<string, number> = {
        ...(emailStatsMap.get("__total__") ?? {}),
        ...(outletsStatsMap.get("__total__") ?? {}),
        ...(journalistsStatsMap.get("__total__") ?? {}),
        ...(leadsStatsMap.get("__total__") ?? {}),
        ...(pipelineStatsMap.get("__total__") ?? {}),
        ...(pressKitsStatsMap.get("__total__") ?? {}),
        ...(journalistsQuotesStatsMap.get("__total__") ?? {}),
        ...(aiVisibilityStatsMap.get("__total__") ?? {}),
        totalCostInUsdCents: runsStatsMap.get("__total__")?.totalCostInUsdCents ?? 0,
        completedRuns: runsStatsMap.get("__total__")?.completedRuns ?? 0,
      };

      return res.json({
        featureSlug,
        systemStats: buildSystemStats(runsStatsMap.get("__total__"), activeCampaigns),
        stats: computeAllDerivedStats(rawStats),
      });
    }

    const allGroupKeys = new Set<string>();
    for (const m of [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, pressKitsStatsMap]) {
      for (const key of m.keys()) if (key !== "__total__") allGroupKeys.add(key);
    }

    const totals = aggregateRunsTotals(runsStatsMap);
    const groups: StatsGroup[] = [];

    for (const groupKey of allGroupKeys) {
      const rawStats: Record<string, number> = {
        ...(emailStatsMap.get(groupKey) ?? {}),
        ...(outletsStatsMap.get(groupKey) ?? {}),
        ...(journalistsStatsMap.get(groupKey) ?? {}),
        ...(leadsStatsMap.get(groupKey) ?? {}),
        ...(pipelineStatsMap.get(groupKey) ?? {}),
        ...(pressKitsStatsMap.get(groupKey) ?? {}),
        totalCostInUsdCents: (runsStatsMap.get(groupKey) as RunsStatsEntry | undefined)?.totalCostInUsdCents ?? 0,
        completedRuns: (runsStatsMap.get(groupKey) as RunsStatsEntry | undefined)?.completedRuns ?? 0,
      };

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStatsMap.get(groupKey) as RunsStatsEntry | undefined, activeCampaigns),
        stats: computeAllDerivedStats(rawStats),
      };

      if (groupBy === "workflowSlug") group.workflowSlug = groupKey;
      if (groupBy === "workflowDynastySlug") group.workflowDynastySlug = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;
      if (groupBy === "campaignId") group.campaignId = groupKey;

      groups.push(group);
    }

    traceEvent(runId, { service: "features-service", event: "feature-stats-done", detail: `featureSlug=${featureSlug}, groupCount=${groups.length}` }, req.headers).catch(() => {});

    res.json({ featureSlug, groupBy, systemStats: buildSystemStats(totals, activeCampaigns), groups });
  } catch (error) {
    console.error("[features-service] Feature stats error:", error);
    const auth = req as AuthenticatedRequest;
    if (auth.runId) {
      traceEvent(auth.runId, { service: "features-service", event: "feature-stats-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /stats ──────────────────────────────────────────────────────────────

router.get("/stats", apiKeyAuth, async (req, res) => {
  try {
    const { orgId, userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;

    const groupByParam = req.query.groupBy as string | undefined;
    const filters: Record<string, string> = {};
    if (req.query.brandId) filters.brandId = req.query.brandId as string;
    if (req.query.workflowSlug) filters.workflowSlug = req.query.workflowSlug as string;
    if (req.query.workflowDynastySlug) filters.workflowDynastySlug = req.query.workflowDynastySlug as string;
    if (req.query.featureSlug) filters.featureSlug = req.query.featureSlug as string;
    if (req.query.campaignId) filters.campaignId = req.query.campaignId as string;

    const groupBy = (groupByParam?.split(",")[0] ?? null) as GroupByDimension | null;
    const identity: Identity = { userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug };

    const [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, journalistsQuotesStatsMap, aiVisibilityStatsMap, activeCampaigns] = await Promise.all([
      fetchEmailStats(orgId, groupBy, filters, identity),
      fetchRunsStats(orgId, groupBy, filters, undefined, identity),
      fetchOutletsStats(orgId, groupBy, filters, identity),
      fetchJournalistsStats(orgId, groupBy, filters, identity),
      fetchLeadsStats(orgId, groupBy, filters, identity),
      fetchPipelineStats(orgId, groupBy, filters, undefined, identity),
      fetchJournalistsQuotesStats(orgId, filters, identity),
      fetchAiVisibilityStats(orgId, filters, identity),
      fetchActiveCampaigns(orgId, filters, identity),
    ]);

    if (!groupBy) {
      const rawStats: Record<string, number> = {
        ...(emailStatsMap.get("__total__") ?? {}),
        ...(outletsStatsMap.get("__total__") ?? {}),
        ...(journalistsStatsMap.get("__total__") ?? {}),
        ...(leadsStatsMap.get("__total__") ?? {}),
        ...(pipelineStatsMap.get("__total__") ?? {}),
        ...(journalistsQuotesStatsMap.get("__total__") ?? {}),
        ...(aiVisibilityStatsMap.get("__total__") ?? {}),
        totalCostInUsdCents: runsStatsMap.get("__total__")?.totalCostInUsdCents ?? 0,
        completedRuns: runsStatsMap.get("__total__")?.completedRuns ?? 0,
      };

      return res.json({
        systemStats: buildSystemStats(runsStatsMap.get("__total__"), activeCampaigns),
        stats: computeAllDerivedStats(rawStats),
      });
    }

    const allGroupKeys = new Set<string>();
    for (const m of [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap]) {
      for (const key of m.keys()) if (key !== "__total__") allGroupKeys.add(key);
    }

    const totals = aggregateRunsTotals(runsStatsMap);
    const groups: StatsGroup[] = [];

    for (const groupKey of allGroupKeys) {
      const rawStats: Record<string, number> = {
        ...(emailStatsMap.get(groupKey) ?? {}),
        ...(outletsStatsMap.get(groupKey) ?? {}),
        ...(journalistsStatsMap.get(groupKey) ?? {}),
        ...(leadsStatsMap.get(groupKey) ?? {}),
        ...(pipelineStatsMap.get(groupKey) ?? {}),
        totalCostInUsdCents: (runsStatsMap.get(groupKey) as RunsStatsEntry | undefined)?.totalCostInUsdCents ?? 0,
        completedRuns: (runsStatsMap.get(groupKey) as RunsStatsEntry | undefined)?.completedRuns ?? 0,
      };

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStatsMap.get(groupKey) as RunsStatsEntry | undefined, activeCampaigns),
        stats: computeAllDerivedStats(rawStats),
      };

      if (groupBy === "workflowSlug") group.workflowSlug = groupKey;
      if (groupBy === "workflowDynastySlug") group.workflowDynastySlug = groupKey;
      if (groupBy === "featureSlug") group.featureSlug = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;
      if (groupBy === "campaignId") group.campaignId = groupKey;

      groups.push(group);
    }

    res.json({ groupBy: groupByParam, systemStats: buildSystemStats(totals, activeCampaigns), groups });
  } catch (error) {
    console.error("[features-service] Global stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /stats/ranked — Authenticated version ───────────────────────────────

import { handleRanked, handleBest } from "./public.js";

router.get("/stats/ranked", apiKeyAuth, async (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitParam) && limitParam >= 1 ? limitParam : 10;
    await handleRanked(req.query.featureSlug as string | undefined, req.query.objective as string | undefined, req.query.groupBy as string | undefined, limit, res);
  } catch (error) {
    console.error("[features-service] Stats ranked error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/stats/best", apiKeyAuth, async (req, res) => {
  try {
    await handleBest(req.query.featureSlug as string | undefined, req.query.groupBy as string | undefined, res);
  } catch (error) {
    console.error("[features-service] Stats best error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
