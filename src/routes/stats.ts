import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { STATS_REGISTRY, getPublicRegistry, getEntityRegistry, requiredStatsSources, type StatsKeyDef, type RunFilter } from "../lib/stats-registry.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing, selectCostCents, type Pricing } from "../lib/pricing.js";
import { traceEvent } from "../lib/trace-event.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import {
  fetchEngagementSnapshotCounts,
  fetchEngagementSnapshotByIdentity,
  SNAPSHOT_ENGAGEMENT_KEYS,
  UNOWNED_ENGAGEMENT_KEY,
  ZERO_ENGAGEMENT_COUNTS,
} from "../lib/engagement-snapshot.js";
import { observedCostPerOutcome } from "../lib/cost-engine.js";
import { fetchCampaignFamiliesSoft } from "../lib/campaign-identity-client.js";
import { resolveOfferCampaignIds, OfferHasNoCampaignsError } from "../lib/offer-scope.js";
import { describeIdentity, EMPTY_CAMPAIGN_FAMILIES, type CampaignIdentityView } from "../lib/campaign-identity.js";

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
  /**
   * COMMITTED run spend (USD cents) — billed `actual` PLUS the open `provisioned` holds. THE single
   * spend basis of this service: the "Total spent" the dashboard renders AND the numerator behind
   * every cost-per-X metric, so CPC / $/outlet reconcile both with the displayed spend and with
   * /revenue's ROI. Do NOT repoint those numerators at the billed-only twin — a second basis is what
   * made one brand read $202 on its Overview and $191 on its campaigns table.
   * (features-service#396, single basis features-service#779)
   */
  totalCostInUsdCents: number;
  /** Billed-only run spend (USD cents). REPORTED for consumer migration; divided by nowhere. */
  actualCostInUsdCents: number;
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
  /**
   * The identity this group's figures were totalled over — present only on `groupBy=campaignId`.
   * Every member of one family carries the SAME figures (they are one campaign), so a consumer
   * renders the line once, on `representativeId` (the live campaign when there is one).
   */
  campaignIdentity?: CampaignIdentityView;
  featureSlug?: string | null;
  systemStats: SystemStats;
  stats: Record<string, number | null>;
}

interface RunsStatsEntry {
  totalCostInUsdCents: number;
  actualCostInUsdCents: number;
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
      if (def.type === "currency") {
        // cost-per-outcome via the shared engine. /stats is a top-grain (brand) surface with no coarser
        // grain fetched → OBSERVED (real ratio, null on 0 — never a false $0, incl. the 0-cost / >0-outcome
        // case the old `num/den` guard returned as $0.00). A projected fleet-parent floor is a follow-up.
        result[key] = num != null && den != null ? observedCostPerOutcome(num, den) : null;
      } else if (num != null && den != null && den > 0) {
        result[key] = num / den;
      } else {
        result[key] = null;
      }
    }
  }

  return result;
}

/**
 * Deep-collect every `key` string nested anywhere in a feature's `outputs` / `charts` JSON
 * (output items, funnel steps, breakdown segments, …). Unknown keys (chart ids, non-stat
 * props) are filtered out downstream by `requiredStatsSources`, so over-collection is safe.
 */
function collectStatKeys(node: unknown, acc: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectStatKeys(item, acc);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "key" && typeof v === "string") acc.add(v);
      else collectStatKeys(v, acc);
    }
  }
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
    const response = await fetchWithRetry(url, {
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
  // NET pricing: read runs#179's FROZEN net cost cents (net twins) instead of the gross fields (no
  // read-time multiply). GROSS (the default) reads the gross fields → byte-identical. Every derived
  // costPer*Cents figure comes out net by construction.
  pricing: Pricing = "gross",
): Promise<Map<string, RunsStatsEntry>> {
  const runsGroupBy = groupBy ?? "workflowSlug";
  const params = new URLSearchParams({ groupBy: runsGroupBy });
  if (filters.workflowSlug) params.set("workflowSlug", filters.workflowSlug);
  if (filters.workflowDynastySlug) params.set("workflowDynastySlug", filters.workflowDynastySlug);
  if (filters.brandId) params.set("brandId", filters.brandId);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);

  // Caller-resolved feature lineage in one call. CSV `featureSlugs` is the batch
  // form; single `featureSlug` is the legacy single-slug form for /stats callers
  // that don't pre-resolve lineage.
  const slugs = featureSlugs ?? (filters.featureSlug ? [filters.featureSlug] : []);
  if (slugs.length > 0) {
    params.set("featureSlugs", slugs.join(","));
  }

  const url = `${RUNS_SERVICE_URL}/v1/stats/costs?${params}`;
  try {
    const response = await fetchWithRetry(url, {
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
        actualCostInUsdCents: string;
        // Frozen-NET twins (runs#179) — read via selectCostCents when pricing === "net".
        netTotalCostInUsdCents?: string;
        netActualCostInUsdCents?: string;
        runCount: number;
        minStartedAt: string | null;
        maxStartedAt: string | null;
      }>;
    };

    const result = new Map<string, RunsStatsEntry>();

    if (!groupBy) {
      let totalCost = 0;
      let actualCost = 0;
      let totalRuns = 0;
      let minStartedAt: string | null = null;
      let maxStartedAt: string | null = null;
      for (const group of data.groups) {
        totalCost += Math.round(selectCostCents(group, "totalCostInUsdCents", pricing));
        actualCost += Math.round(selectCostCents(group, "actualCostInUsdCents", pricing));
        totalRuns += group.runCount;
        if (group.minStartedAt && (!minStartedAt || group.minStartedAt < minStartedAt)) {
          minStartedAt = group.minStartedAt;
        }
        if (group.maxStartedAt && (!maxStartedAt || group.maxStartedAt > maxStartedAt)) {
          maxStartedAt = group.maxStartedAt;
        }
      }
      if (data.groups.length > 0) {
        result.set("__total__", { totalCostInUsdCents: totalCost, actualCostInUsdCents: actualCost, completedRuns: totalRuns, minStartedAt, maxStartedAt });
      }
    } else {
      for (const group of data.groups) {
        const key = group.dimensions[runsGroupBy] ?? "__total__";
        result.set(key, {
          totalCostInUsdCents: Math.round(selectCostCents(group, "totalCostInUsdCents", pricing)),
          actualCostInUsdCents: Math.round(selectCostCents(group, "actualCostInUsdCents", pricing)),
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
    const response = await fetchWithRetry(url, {
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
    const response = await fetchWithRetry(url, {
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
    const response = await fetchWithRetry(url, {
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
      fetchWithRetry(`${getPressKitsServiceUrl()}/media-kits/stats/views?${viewsParams}`, { headers }),
      fetchWithRetry(`${getPressKitsServiceUrl()}/media-kits/stats/costs?${costsParams}`, { headers }),
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
    const response = await fetchWithRetry(url, {
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
    const response = await fetchWithRetry(`${campaignUrl}/campaigns/${encodeURIComponent(campaignId)}`, {
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
    const response = await fetchWithRetry(url, {
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
    if (entry) entry.keys.push(key);
    else filterToKeys.set(filterKey, { filter, keys: [key] });
  }
  const entries = [...filterToKeys.values()];

  // POST batch endpoint does NOT accept workflowDynastySlug (neither as filter
  // nor as groupBy). When the caller's scope involves dynasty resolution, fall
  // back to per-tuple GETs so callers keep dynasty filtering for free.
  if (filters.workflowDynastySlug || groupBy === "workflowDynastySlug") {
    return fetchPipelineStatsLegacy(orgId, groupBy, filters, featureSlugs, identity, entries);
  }

  const runsGroupBy = groupBy ?? "workflowSlug";
  const body: Record<string, unknown> = {
    groupBy: runsGroupBy,
    serviceTasks: entries.map(({ filter }) => ({
      serviceName: filter.serviceName,
      taskName: filter.taskName,
    })),
  };
  if (filters.workflowSlug) body.workflowSlug = filters.workflowSlug;
  if (filters.brandId) body.brandId = filters.brandId;
  if (filters.campaignId) body.campaignId = filters.campaignId;

  const slugs = featureSlugs ?? (filters.featureSlug ? [filters.featureSlug] : []);
  if (slugs.length > 0) body.featureSlugs = slugs;

  const url = `${RUNS_SERVICE_URL}/v1/stats/costs`;
  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        ...buildDownstreamHeaders(RUNS_SERVICE_API_KEY, orgId, identity),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[features-service] runs-service POST /v1/stats/costs failed: ${response.status}`);
      return new Map();
    }

    const data = await response.json() as {
      buckets: Array<{
        serviceName: string;
        taskName: string;
        groups: Array<{ dimensions: Record<string, string | null>; runCount: number }>;
      }>;
    };

    const output = new Map<string, Record<string, number>>();
    // Buckets returned in input order per spec — index lookup is safe.
    for (let i = 0; i < data.buckets.length; i++) {
      const bucket = data.buckets[i];
      const keys = entries[i].keys;
      const counts = new Map<string, number>();

      if (!groupBy) {
        let total = 0;
        for (const group of bucket.groups) total += group.runCount;
        if (bucket.groups.length > 0) counts.set("__total__", total);
      } else {
        for (const group of bucket.groups) {
          const key = group.dimensions[runsGroupBy] ?? "__total__";
          counts.set(key, (counts.get(key) ?? 0) + group.runCount);
        }
      }

      for (const [groupKey, count] of counts) {
        const existing = output.get(groupKey) ?? {};
        for (const k of keys) existing[k] = count;
        output.set(groupKey, existing);
      }
    }
    return output;
  } catch (error) {
    console.error(`[features-service] runs-service POST /v1/stats/costs network error:`, (error as Error).message);
    return new Map();
  }
}

// Per-tuple GET fallback for the dynasty path (POST endpoint can't filter or
// group by workflowDynastySlug). Hits N×K calls — only used when callers
// explicitly scope by dynasty.
async function fetchPipelineStatsLegacy(
  orgId: string,
  groupBy: GroupByDimension | null,
  filters: Record<string, string>,
  featureSlugs: string[] | undefined,
  identity: Identity,
  entries: Array<{ filter: RunFilter; keys: string[] }>,
): Promise<Map<string, Record<string, number>>> {
  const results = await Promise.all(
    entries.map(async ({ filter, keys }) => {
      const slugsToQuery = featureSlugs ?? (filters.featureSlug ? [filters.featureSlug] : []);
      const maps = await Promise.all(
        (slugsToQuery.length > 0 ? slugsToQuery : [undefined]).map((slug) =>
          fetchPipelineStatsForFilter(orgId, groupBy, filters, slug, filter, identity),
        ),
      );
      const merged = new Map<string, number>();
      for (const map of maps) for (const [k, c] of map) merged.set(k, (merged.get(k) ?? 0) + c);
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
    const response = await fetchWithRetry(url, { headers: buildDownstreamHeaders(RUNS_SERVICE_API_KEY, orgId, identity) });
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
    const response = await fetchWithRetry(`${campaignUrl}/stats?${params}`, { headers: buildDownstreamHeaders(campaignKey, orgId, identity) });
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
    actualCostInUsdCents: runsData?.actualCostInUsdCents ?? 0,
    completedRuns: runsData?.completedRuns ?? 0,
    activeCampaigns,
    firstRunAt: runsData?.minStartedAt ?? null,
    lastRunAt: runsData?.maxStartedAt ?? null,
  };
}

function aggregateRunsTotals(runsStatsMap: Map<string, RunsStatsEntry>): RunsStatsEntry {
  let totalCost = 0, actualCost = 0, totalRuns = 0;
  let minStartedAt: string | null = null, maxStartedAt: string | null = null;
  for (const entry of runsStatsMap.values()) {
    totalCost += entry.totalCostInUsdCents;
    actualCost += entry.actualCostInUsdCents;
    totalRuns += entry.completedRuns;
    if (entry.minStartedAt && (!minStartedAt || entry.minStartedAt < minStartedAt)) minStartedAt = entry.minStartedAt;
    if (entry.maxStartedAt && (!maxStartedAt || entry.maxStartedAt > maxStartedAt)) maxStartedAt = entry.maxStartedAt;
  }
  return { totalCostInUsdCents: totalCost, actualCostInUsdCents: actualCost, completedRuns: totalRuns, minStartedAt, maxStartedAt };
}

// ── Campaign identity: a campaign's stats are its IDENTITY's stats ───────────
//
// A campaign is (org, brand, sales funnel, acquisition channel) — campaign-service's own key. It
// used to create a new campaign row whenever workflow selection switched workflows, so one brand's
// two real campaigns arrive here as ~130 rows. The rows keep their runs and their costs; these two
// helpers only decide which of them are totalled together before anything is displayed.

/** Σ two raw stat maps, key by key. Counters sum; a key present in one side only carries through. */
function addRawStats(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + value;
  return out;
}

function addRunsEntries(a: RunsStatsEntry, b: RunsStatsEntry): RunsStatsEntry {
  return {
    totalCostInUsdCents: a.totalCostInUsdCents + b.totalCostInUsdCents,
    actualCostInUsdCents: a.actualCostInUsdCents + b.actualCostInUsdCents,
    completedRuns: a.completedRuns + b.completedRuns,
    minStartedAt:
      a.minStartedAt && b.minStartedAt ? (a.minStartedAt < b.minStartedAt ? a.minStartedAt : b.minStartedAt) : (a.minStartedAt ?? b.minStartedAt),
    maxStartedAt:
      a.maxStartedAt && b.maxStartedAt ? (a.maxStartedAt > b.maxStartedAt ? a.maxStartedAt : b.maxStartedAt) : (a.maxStartedAt ?? b.maxStartedAt),
  };
}

/**
 * Re-key a per-campaign map onto identity keys, summing the members of each family.
 *
 * Summing is exact at this grain: every counter here is an EVENT total (sends, opens, clicks, runs,
 * cost cents) attributed to exactly one campaign, so no event is counted twice by folding the rows
 * one campaign was split across. `__total__` passes through untouched — it is already the whole
 * population, not a member.
 */
function foldMapByIdentity<T>(
  map: Map<string, T>,
  identityKeyOfCampaign: (campaignId: string) => string,
  add: (a: T, b: T) => T,
): Map<string, T> {
  const folded = new Map<string, T>();
  for (const [key, value] of map) {
    if (key === "__total__") {
      folded.set(key, value);
      continue;
    }
    const identityKey = identityKeyOfCampaign(key);
    const existing = folded.get(identityKey);
    folded.set(identityKey, existing === undefined ? value : add(existing, value));
  }
  return folded;
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

    // `?offerId=` narrows every stat to the ONE offer a brand sells — the grain between the brand and
    // its campaigns (see lib/offer-scope.ts). It is NOT a downstream filter (no producer carries an
    // offer dimension): it resolves to the offer's campaign ids and takes the same group-by-campaign
    // and fold path a multi-row campaign identity already takes. Absent → byte-identical to today.
    const offerId = ((req.query.offerId as string | undefined) ?? "").trim() || undefined;

    const filters: Record<string, string> = {};
    if (req.query.brandId) filters.brandId = req.query.brandId as string;
    if (req.query.campaignId) filters.campaignId = req.query.campaignId as string;
    if (req.query.workflowSlug) filters.workflowSlug = req.query.workflowSlug as string;
    if (req.query.workflowDynastySlug) filters.workflowDynastySlug = req.query.workflowDynastySlug as string;

    // Scope downstream calls to this feature
    filters.featureSlug = featureSlug;

    // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) {
      return res.status(400).json({ error: "pricing must be one of: gross, net" });
    }
    // NET reads runs#179's frozen net cost fields (no billing call, no read-time multiply); GROSS reads
    // the gross fields → byte-identical. The selector is threaded into fetchRunsStats below.

    // ── Campaign identity ────────────────────────────────────────────────────
    // Anything keyed on a campaign reports that campaign's IDENTITY — (org, brand, sales funnel,
    // acquisition channel), campaign-service's own key — so the rows one campaign was split across
    // when workflow selection switched workflows read as the one campaign they are. All four parts
    // come from campaign-service; none is re-derived here, and the funnel is never inferred from a
    // goal (two funnels answer to one goal, so that inference prints a chain the campaign never
    // stated). Fail-soft: with campaign-service unreachable every campaign is its own family and the
    // response is exactly what it was before this feature.
    const preIdentity: Identity = { userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug };
    const wantsIdentity = groupBy === "campaignId" || Boolean(filters.campaignId);
    let identityBrandId: string | null = filters.brandId ?? null;
    if (wantsIdentity && !identityBrandId && filters.campaignId) {
      identityBrandId = await resolveBrandIdFromCampaign(orgId, filters.campaignId, preIdentity);
    }
    const families =
      wantsIdentity && identityBrandId
        ? await fetchCampaignFamiliesSoft(identityBrandId, featureSlug, { orgId, userId, runId })
        : EMPTY_CAMPAIGN_FAMILIES;
    const requestedIdentity = filters.campaignId ? families.identityOf(filters.campaignId) : null;

    // ── Offer scope ──────────────────────────────────────────────────────────
    // Three refusals, each because the alternative is a number that answers a question nobody asked:
    // an offer belongs to a brand, so it cannot be resolved without one; a campaign already sells
    // exactly one offer, so naming both is two scopes for one read; and the fold below consumes the
    // campaign grain, so it cannot also be spent on a caller's `groupBy`.
    if (offerId && !filters.brandId) {
      return res.status(400).json({ error: "brandId query parameter is required alongside offerId: an offer belongs to a brand" });
    }
    if (offerId && filters.campaignId) {
      return res.status(400).json({ error: "offerId and campaignId are mutually exclusive: a campaign already sells exactly one offer" });
    }
    if (offerId && groupBy) {
      return res.status(400).json({ error: "offerId cannot be combined with groupBy: an offer-scoped read is totalled over the offer's campaigns" });
    }
    // Fail-loud (unlike the identity read above): the partition IS the scope here, so serving without
    // it would print the whole brand's stats under one offer's name.
    const offerCampaignIds = offerId
      ? await resolveOfferCampaignIds(offerId, filters.brandId!, featureSlug, { orgId, userId, runId })
      : null;
    const offerMembers = offerCampaignIds ? new Set(offerCampaignIds) : null;

    // Served through the Gold snapshot cache (O(1) read; the 10-source fan-out recomputes a viewed
    // cell off the request path ~per TTL). Scope key spans org + every query param that changes the
    // body — with the campaign REPLACED by its identity, so every member of one family shares one
    // cell instead of each rendered row paying for its own identical fan-out.
    const payload = await servedCached({
      view: "stats",
      scopeKey: buildScopeKey(featureSlug, {
        orgId,
        groupBy: groupByParam,
        ...filters,
        campaignId: requestedIdentity?.key ?? filters.campaignId,
        // The offer narrows every stat, so it MUST be in the key or an offer-scoped body and the
        // brand-wide one would share a cell. Absent → dropped by buildScopeKey → key unchanged.
        offerId,
        pricing,
      }),
      orgId,
      compute: async () => {
    traceEvent(runId, { service: "features-service", event: "feature-stats-start", detail: `featureSlug=${featureSlug}, groupBy=${groupByParam ?? "none"}, filters=${JSON.stringify(filters)}` }, req.headers).catch(() => {});

    const identity: Identity = { userId, runId, brandId, campaignId, featureSlug: headerFeatureSlug };
    const identityKeyOfCampaign = (cid: string): string => families.identityOf(cid)?.key ?? `campaign:${cid}`;

    // A single-campaign read whose campaign has stopped ancestors must total them in. No producer
    // takes a campaign LIST, so the fan-out runs GROUPED by campaign over the brand and the family's
    // groups are folded back into the flat body — one call per source, never one per member.
    const foldSingleIntoTotal = Boolean(requestedIdentity && requestedIdentity.campaignIds.length > 1);
    // An OFFER-scoped read is the SAME fold over a different membership: the offer's campaigns rather
    // than one identity's. Every campaign the fan-out returns is mapped to one of two buckets — in the
    // offer or outside it — and only the first is kept, so the flat body totals exactly the offer.
    const OFFER_TOTAL_KEY = "__offer__";
    const scopeKeyOfCampaign = offerMembers
      ? (cid: string): string => (offerMembers.has(cid) ? OFFER_TOTAL_KEY : `outside-offer:${cid}`)
      : identityKeyOfCampaign;
    const scopeTotalKey = offerMembers ? OFFER_TOTAL_KEY : requestedIdentity?.key;
    const foldScopeIntoTotal = foldSingleIntoTotal || Boolean(offerMembers);
    const fanOutGroupBy: GroupByDimension | null = foldScopeIntoTotal ? "campaignId" : groupBy;
    // The campaign-groupable sources drop the campaign filter (the family narrows them locally) and
    // gain the brand. The sources that cannot group by campaign keep the caller's filters untouched,
    // so their scope is unchanged.
    const fanOutFilters: Record<string, string> = { ...filters };
    if (foldSingleIntoTotal) {
      fanOutFilters.brandId = identityBrandId!;
      delete fanOutFilters.campaignId;
    }

    // Scope the fan-out to the sources this feature actually renders (its outputs + charts).
    // A feature never waits on a stat family it doesn't declare — e.g. a cold-email feature
    // skips outlets / journalists / leads / press-kits / journalists-quotes / ai-visibility,
    // each of which is a separate (often cold-starting) sibling HTTP call. runs (cost +
    // systemStats) and activeCampaigns are universal, always fetched. A skipped source
    // contributes no keys → its (unrendered) stats default to null downstream, exactly as a
    // no-data fetch would. (See Promise.allSettled note for the PUBLIC path — here the families
    // are core to the dashboard and stay fail-loud via fetchWithRetry inside each fetcher.)
    const declaredKeys = new Set<string>();
    collectStatKeys(feature.outputs, declaredKeys);
    collectStatKeys(feature.charts, declaredKeys);
    const { sources: neededSources, needsRunFilter } = requiredStatsSources([...declaredKeys]);
    const EMPTY_STATS: Map<string, Record<string, number>> = new Map();
    const skip = (): Promise<Map<string, Record<string, number>>> => Promise.resolve(EMPTY_STATS);

    // The recipient-engagement counts are reconciled onto the SAME deduped lead snapshot /revenue
    // uses, so the brand stat card and the Overview can never disagree (features-service#388) — and,
    // since #749, so a campaign IDENTITY is counted the way its brand is counted. Both reads are
    // person-grain: a DISTINCT lead, never a per-send recipient row. email-gateway is still fetched
    // for the one key no lead evidence can produce (auto-replies); the snapshot OVERRIDES the nine
    // it owns. Both need the brand — a campaign-scoped read resolves it from campaign-service.
    const snapshotBrandId = filters.brandId ?? identityBrandId ?? null;
    const wantsSnapshotKeys = SNAPSHOT_ENGAGEMENT_KEYS.some((k) => declaredKeys.has(k));
    const wantEngagementSnapshot = !groupBy && Boolean(snapshotBrandId) && wantsSnapshotKeys;
    const wantIdentityEngagement = groupBy === "campaignId" && Boolean(snapshotBrandId) && wantsSnapshotKeys;

    const [rawEmailStatsMap, rawRunsStatsMap, rawOutletsStatsMap, rawJournalistsStatsMap, rawLeadsStatsMap, rawPipelineStatsMap, rawPressKitsStatsMap, journalistsQuotesStatsMap, aiVisibilityStatsMap, activeCampaigns, engagementSnapshot, engagementByIdentity] = await Promise.all([
      neededSources.has("email-gateway") ? fetchEmailStats(orgId, fanOutGroupBy, fanOutFilters, identity) : skip(),
      fetchRunsStats(orgId, fanOutGroupBy, fanOutFilters, [featureSlug], identity, pricing),
      neededSources.has("outlets") ? fetchOutletsStats(orgId, fanOutGroupBy, fanOutFilters, identity) : skip(),
      neededSources.has("journalists") ? fetchJournalistsStats(orgId, fanOutGroupBy, fanOutFilters, identity) : skip(),
      neededSources.has("leads") ? fetchLeadsStats(orgId, fanOutGroupBy, fanOutFilters, identity) : skip(),
      needsRunFilter ? fetchPipelineStats(orgId, fanOutGroupBy, fanOutFilters, [featureSlug], identity) : skip(),
      neededSources.has("press-kits") ? fetchPressKitsStats(orgId, fanOutGroupBy, fanOutFilters, identity) : skip(),
      neededSources.has("journalists-quotes") ? fetchJournalistsQuotesStats(orgId, filters, identity) : skip(),
      neededSources.has("ai-visibility") ? fetchAiVisibilityStats(orgId, filters, identity) : skip(),
      fetchActiveCampaigns(orgId, filters, identity),
      wantEngagementSnapshot
        // The offer's campaigns are a campaign SCOPE like any other here — the snapshot already
        // counts distinct leads over a campaign list, which is exactly what an offer's people are.
        ? fetchEngagementSnapshotCounts(snapshotBrandId!, offerCampaignIds ?? requestedIdentity?.campaignIds ?? filters.campaignId, { orgId, userId, runId, featureSlug })
        : Promise.resolve(null),
      wantIdentityEngagement
        ? fetchEngagementSnapshotByIdentity(snapshotBrandId!, identityKeyOfCampaign, { orgId, userId, runId, featureSlug })
        : Promise.resolve(null),
    ]);

    // Fold the per-campaign rows of one identity together. On the GROUPED path the maps are re-keyed
    // onto identity keys; on the single-campaign path the requested family's folded entry becomes the
    // flat body's `__total__`. Both are no-ops when every campaign is its own family.
    const asTotal = <T>(m: Map<string, T>): Map<string, T> => {
      const entry = m.get(scopeTotalKey!);
      return new Map(entry === undefined ? [] : [["__total__", entry]]);
    };
    const scopeMap = <T>(m: Map<string, T>, add: (a: T, b: T) => T): Map<string, T> => {
      if (foldScopeIntoTotal) return asTotal(foldMapByIdentity(m, scopeKeyOfCampaign, add));
      return groupBy === "campaignId" ? foldMapByIdentity(m, identityKeyOfCampaign, add) : m;
    };
    const emailStatsMap = scopeMap(rawEmailStatsMap, addRawStats);
    const runsStatsMap = scopeMap(rawRunsStatsMap, addRunsEntries);
    const outletsStatsMap = scopeMap(rawOutletsStatsMap, addRawStats);
    const journalistsStatsMap = scopeMap(rawJournalistsStatsMap, addRawStats);
    const leadsStatsMap = scopeMap(rawLeadsStatsMap, addRawStats);
    const pipelineStatsMap = scopeMap(rawPipelineStatsMap, addRawStats);
    const pressKitsStatsMap = scopeMap(rawPressKitsStatsMap, addRawStats);

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
        // Snapshot-derived engagement counts OVERRIDE the email-gateway aggregate for the nine keys
        // it owns (must come AFTER the emailStatsMap spread). Null when not applicable (grouped /
        // no brandId / feature renders none of them) → email-gateway aggregate stands. (#388)
        ...(engagementSnapshot ?? {}),
        totalCostInUsdCents: runsStatsMap.get("__total__")?.totalCostInUsdCents ?? 0,
        actualCostInUsdCents: runsStatsMap.get("__total__")?.actualCostInUsdCents ?? 0,
        completedRuns: runsStatsMap.get("__total__")?.completedRuns ?? 0,
      };

      // A single-campaign read of a MULTI-MEMBER identity is the same fold as a group, flattened:
      // the members' auto-reply aggregates would be added, counting a person once per member. Say
      // "could not count" instead. (The nine snapshot keys above are already identity-deduped.)
      // Same for an OFFER holding more than one campaign: the members' auto-reply aggregates would be
      // added, counting a person once per campaign they were served under.
      if (engagementSnapshot && (foldSingleIntoTotal || (offerCampaignIds?.length ?? 0) > 1)) delete rawStats[UNOWNED_ENGAGEMENT_KEY];

      return {
        featureSlug,
        systemStats: buildSystemStats(runsStatsMap.get("__total__"), activeCampaigns),
        stats: computeAllDerivedStats(rawStats),
      };
    }

    const allGroupKeys = new Set<string>();
    for (const m of [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, pressKitsStatsMap]) {
      for (const key of m.keys()) if (key !== "__total__") allGroupKeys.add(key);
    }

    // Which campaign ids each identity answers for. Taken from the FAMILY, not from the campaigns
    // that happen to carry data, so a member that produced nothing itself still resolves — it is
    // part of the campaign a consumer is rendering, and dropping it would blank a row.
    const identityMembers = new Map<string, string[]>();
    if (groupBy === "campaignId") {
      for (const m of [rawEmailStatsMap, rawRunsStatsMap, rawOutletsStatsMap, rawJournalistsStatsMap, rawLeadsStatsMap, rawPipelineStatsMap, rawPressKitsStatsMap]) {
        for (const cid of m.keys()) {
          if (cid === "__total__") continue;
          identityMembers.set(identityKeyOfCampaign(cid), families.identityOf(cid)?.campaignIds ?? [cid]);
        }
      }
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
        actualCostInUsdCents: (runsStatsMap.get(groupKey) as RunsStatsEntry | undefined)?.actualCostInUsdCents ?? 0,
        completedRuns: (runsStatsMap.get(groupKey) as RunsStatsEntry | undefined)?.completedRuns ?? 0,
      };

      // A campaign identity's PEOPLE are counted the way its brand's people are counted: distinct
      // leads over the identity's member campaigns, not the members' per-campaign recipient rows
      // added together. That fold counts a person once per member they were served under, which is
      // how an identity came to report more people contacted than the brand containing it. An
      // identity whose members reached no lead reads 0 on this basis, not the email-gateway sum.
      // The one key no lead evidence can produce is DROPPED for a multi-member identity (→ null,
      // "we could not count this") rather than summed into that same over-count.
      if (engagementByIdentity) {
        Object.assign(rawStats, engagementByIdentity.get(groupKey) ?? ZERO_ENGAGEMENT_COUNTS);
        if ((identityMembers.get(groupKey) ?? [groupKey]).length > 1) delete rawStats[UNOWNED_ENGAGEMENT_KEY];
      }

      const group: StatsGroup = {
        systemStats: buildSystemStats(runsStatsMap.get(groupKey) as RunsStatsEntry | undefined, activeCampaigns),
        stats: computeAllDerivedStats(rawStats),
      };

      if (groupBy === "workflowSlug") group.workflowSlug = groupKey;
      if (groupBy === "workflowDynastySlug") group.workflowDynastySlug = groupKey;
      if (groupBy === "brandId") group.brandId = groupKey;

      if (groupBy === "campaignId") {
        // `groupKey` is now an IDENTITY. Every member campaign id gets its own entry carrying that
        // identity's totals, so a consumer keyed on any campaign — the live one it renders the line
        // on, or a stopped ancestor it still has a link to — resolves to the same, whole campaign.
        const members = identityMembers.get(groupKey) ?? [groupKey];
        for (const memberId of members) {
          groups.push({ ...group, campaignId: memberId, campaignIdentity: describeIdentity(families.identityOf(memberId), memberId) });
        }
        continue;
      }

      groups.push(group);
    }

    traceEvent(runId, { service: "features-service", event: "feature-stats-done", detail: `featureSlug=${featureSlug}, groupCount=${groups.length}` }, req.headers).catch(() => {});

        return { featureSlug, groupBy, systemStats: buildSystemStats(totals, activeCampaigns), groups };
      },
    });

    res.json(payload);
  } catch (error) {
    // An offer no campaign of this brand sells has no evidence to answer with — named, never
    // substituted with the brand's own stats and never with a fabricated zero.
    if (error instanceof OfferHasNoCampaignsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_campaigns", offerId: error.offerId });
    }
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

    // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) {
      return res.status(400).json({ error: "pricing must be one of: gross, net" });
    }
    // NET reads runs#179's frozen net fields (no billing call, no read-time multiply); GROSS is byte-identical.

    const [emailStatsMap, runsStatsMap, outletsStatsMap, journalistsStatsMap, leadsStatsMap, pipelineStatsMap, journalistsQuotesStatsMap, aiVisibilityStatsMap, activeCampaigns] = await Promise.all([
      fetchEmailStats(orgId, groupBy, filters, identity),
      fetchRunsStats(orgId, groupBy, filters, undefined, identity, pricing),
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
        actualCostInUsdCents: runsStatsMap.get("__total__")?.actualCostInUsdCents ?? 0,
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
        actualCostInUsdCents: (runsStatsMap.get(groupKey) as RunsStatsEntry | undefined)?.actualCostInUsdCents ?? 0,
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
