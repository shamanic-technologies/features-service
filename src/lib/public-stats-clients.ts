/**
 * Fetch functions for public (no-identity-header) downstream endpoints.
 * Each function sends only x-api-key — no x-org-id, x-user-id, x-run-id.
 * Service URLs and keys are read lazily from process.env.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { selectCostCentsString, type Pricing } from "./pricing.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowMetadata {
  id: string;
  workflowSlug: string;
  workflowName: string;
  workflowDynastyName: string;
  workflowDynastySlug: string;
  version: number;
  status: string;
  featureSlug: string;
  createdForBrandId: string | null;
  upgradedTo: string | null;
}

export interface CostGroup {
  dimensions: Record<string, string | null>;
  totalCostInUsdCents: string;
  /** Frozen-NET twin (runs#179) — present on the runs response; selected when pricing === "net". */
  netTotalCostInUsdCents?: string;
  runCount: number;
  minStartedAt: string | null;
  maxStartedAt: string | null;
}

export interface EngagementLatencyMetric {
  averageMs: number | null;
  medianMs: number | null;
  sampleSize: number;
}

export interface WorkflowEngagementLatency {
  workflowSlug: string;
  timeToFirstLinkClick: EngagementLatencyMetric;
  timeToFirstPositiveReply: EngagementLatencyMetric;
}

// ── Workflow metadata ────────────────────────────────────────────────────────

export async function fetchPublicWorkflows(
  featureSlugs: string,
  status = "all",
): Promise<WorkflowMetadata[]> {
  const url = `${process.env.WORKFLOW_SERVICE_URL}/public/workflows?featureSlugs=${encodeURIComponent(featureSlugs)}&status=${status}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": process.env.WORKFLOW_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] workflow-service /public/workflows failed: ${response.status} — ${body}`);
  }

  const data = await response.json() as { workflows: WorkflowMetadata[] };
  return data.workflows;
}

// ── Cost stats (runs-service) ────────────────────────────────────────────────

export async function fetchPublicCosts(
  featureSlugs: string,
  groupBy: string,
  // GROSS (the default) returns each group's gross `totalCostInUsdCents` verbatim → byte-identical for
  // every existing caller (pipeline-activity, /public/stats/*). NET remaps `totalCostInUsdCents` to
  // runs#179's frozen `netTotalCostInUsdCents` (fail-loud if absent) so the fleet crossOrg grain reads
  // frozen net — no read-time discount multiply.
  pricing: Pricing = "gross",
): Promise<CostGroup[]> {
  const params = new URLSearchParams({ featureSlugs, groupBy });

  const url = `${process.env.RUNS_SERVICE_URL}/v1/stats/public/costs?${params}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] runs-service /v1/stats/public/costs failed: ${response.status} — ${body}`);
  }

  const data = await response.json() as { groups: CostGroup[] };
  if (pricing === "gross") return data.groups;
  return data.groups.map((g) => ({
    ...g,
    totalCostInUsdCents: selectCostCentsString(g, "totalCostInUsdCents", pricing),
  }));
}

/**
 * Fleet-wide (cross-org) spend per UTC day for a feature — runs-service
 * `GET /v1/stats/public/costs/timeseries?interval=day` (dated buckets by run started_at). Returns a
 * Map<YYYY-MM-DD, spentUsd> (spentUsd = totalCostInUsdCents / 100, committed = actual + provisioned).
 * Feeds the cross-org cost-per-outcome trend join against dated outcome counts. api-key only, no org
 * identity. Fail loud (essential input, not optional enrichment).
 */
export async function fetchFleetSpendByDay(featureSlug: string, brandId?: string): Promise<Map<string, number>> {
  const params = new URLSearchParams({ interval: "day", featureSlug });
  // runs filters brandId as a single `= ANY(r.brand_ids)` (NOT comma-split) — pass ONE brand per call.
  if (brandId) params.set("brandId", brandId);
  return fetchCostTimeseriesByDay(params);
}

/**
 * Cross-org spend per UTC day for ONE workflow dynasty of a feature — same runs-service dated cost
 * endpoint as `fetchFleetSpendByDay`, filtered to a single `workflowDynastySlug` (resolved to all its
 * versioned slugs upstream). Feeds the per-workflow RECENT trailing-window cost-per-outcome (the
 * per-workflow analogue of the fleet cost-per-outcome trend). api-key only, fail loud.
 */
export async function fetchDynastySpendByDay(
  featureSlug: string,
  workflowDynastySlug: string,
): Promise<Map<string, number>> {
  const params = new URLSearchParams({ interval: "day", featureSlug, workflowDynastySlug });
  return fetchCostTimeseriesByDay(params);
}

/** Shared parse of runs-service `/v1/stats/public/costs/timeseries` → Map<YYYY-MM-DD, spentUsd>. */
async function fetchCostTimeseriesByDay(params: URLSearchParams): Promise<Map<string, number>> {
  const url = `${process.env.RUNS_SERVICE_URL}/v1/stats/public/costs/timeseries?${params}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] runs-service /v1/stats/public/costs/timeseries failed: ${response.status} — ${body}`);
  }

  const data = (await response.json()) as { buckets?: Array<{ period?: string; totalCostInUsdCents?: string }> };
  if (!Array.isArray(data.buckets)) {
    throw new Error("[features-service] runs-service costs/timeseries returned no buckets array");
  }

  const byDay = new Map<string, number>();
  for (const b of data.buckets) {
    if (typeof b.period !== "string" || typeof b.totalCostInUsdCents !== "string") {
      throw new Error(`[features-service] runs-service costs/timeseries bucket missing period/totalCostInUsdCents`);
    }
    byDay.set(b.period.slice(0, 10), (byDay.get(b.period.slice(0, 10)) ?? 0) + Number(b.totalCostInUsdCents) / 100);
  }
  return byDay;
}

// ── Email stats (email-gateway) ──────────────────────────────────────────────

export async function fetchPublicEmailStats(
  featureSlugs: string,
  groupBy: string,
  brandIds?: string[],
  // Optional workflow-dynasty filter (resolved to all versioned slugs upstream). Combined with
  // groupBy=day it yields ONE dynasty's dated outcomes — the per-workflow RECENT-window join partner.
  workflowDynastySlug?: string,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams({ featureSlugs, groupBy });
  // email-gateway accepts a comma-separated brandId filter (per its public /stats contract).
  if (brandIds && brandIds.length > 0) params.set("brandId", brandIds.join(","));
  if (workflowDynastySlug) params.set("workflowDynastySlug", workflowDynastySlug);

  const url = `${process.env.EMAIL_GATEWAY_SERVICE_URL}/public/stats?${params}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": process.env.EMAIL_GATEWAY_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] email-gateway /public/stats failed: ${response.status} — ${body}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const result = new Map<string, Record<string, number>>();

  if (data.groups && Array.isArray(data.groups)) {
    for (const group of data.groups as Array<Record<string, unknown>>) {
      const groupKey = String(group.key ?? "__total__");
      result.set(groupKey, extractBroadcastEmailFields(group));
    }
  } else {
    result.set("__total__", extractBroadcastEmailFields(data));
  }

  return result;
}

export async function fetchPublicWorkflowEngagementLatency(
  featureSlugs: string,
): Promise<Map<string, WorkflowEngagementLatency>> {
  const params = new URLSearchParams({ featureSlugs, groupBy: "workflowSlug" });

  const url = `${process.env.EMAIL_GATEWAY_SERVICE_URL}/public/stats/engagement-latency?${params}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": process.env.EMAIL_GATEWAY_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] email-gateway /public/stats/engagement-latency failed: ${response.status} — ${body}`);
  }

  const data = await response.json() as Record<string, unknown>;
  if (!Array.isArray(data.groups)) {
    throw new Error("[features-service] email-gateway /public/stats/engagement-latency returned no groups array");
  }

  const result = new Map<string, WorkflowEngagementLatency>();
  for (const group of data.groups) {
    if (!isRecord(group)) {
      throw new Error("[features-service] email-gateway engagement-latency group is not an object");
    }
    const workflowSlug = readString(group, "key");
    result.set(workflowSlug, {
      workflowSlug,
      timeToFirstLinkClick: readLatencyMetric(group, "timeToFirstLinkClick"),
      timeToFirstPositiveReply: readLatencyMetric(group, "timeToFirstPositiveReply"),
    });
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[features-service] email-gateway engagement-latency missing string field: ${key}`);
  }
  return value;
}

function readNullableNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`[features-service] email-gateway engagement-latency invalid nullable number field: ${key}`);
}

function readNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`[features-service] email-gateway engagement-latency invalid number field: ${key}`);
}

function readLatencyMetric(data: Record<string, unknown>, key: string): EngagementLatencyMetric {
  const value = data[key];
  if (!isRecord(value)) {
    throw new Error(`[features-service] email-gateway engagement-latency missing metric: ${key}`);
  }
  return {
    averageMs: readNullableNumber(value, "averageMs"),
    medianMs: readNullableNumber(value, "medianMs"),
    sampleSize: readNumber(value, "sampleSize"),
  };
}

function extractBroadcastEmailFields(data: Record<string, unknown>): Record<string, number> {
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

// ── Journalist stats (journalists-service) ───────────────────────────────────

export async function fetchPublicJournalistsStats(
  featureSlugs: string,
  groupBy: string,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams({ featureSlugs, groupBy });

  const url = `${process.env.JOURNALISTS_SERVICE_URL}/public/stats?${params}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": process.env.JOURNALISTS_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] journalists-service /public/stats failed: ${response.status} — ${body}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const result = new Map<string, Record<string, number>>();

  if (data.groupedBy && typeof data.groupedBy === "object") {
    for (const [key, value] of Object.entries(data.groupedBy as Record<string, Record<string, unknown>>)) {
      result.set(key, extractJournalistFields(value));
    }
  } else {
    result.set("__total__", extractJournalistFields(data));
  }

  return result;
}

function extractJournalistFields(data: Record<string, unknown>): Record<string, number> {
  const byOutreachStatus = data.byOutreachStatus as Record<string, number>;
  return {
    journalistsFound: Number(data.totalJournalists),
    journalistsContacted: Number(byOutreachStatus.contacted),
  };
}

// ── Brand info (brand-service) ──────────────────────────────────────────────

export interface BrandInfo {
  id: string;
  name: string | null;
  domain: string | null;
}

// brand-service GET /internal/brands caps at 100 ids per request.
const BRAND_BATCH_CHUNK_SIZE = 100;

/**
 * Fetch brand display info (name, domain) for a list of brand IDs.
 * Uses brand-service's batch endpoint GET /internal/brands?ids=csv,
 * chunked at the upstream cap. Failures are logged, not thrown.
 */
export async function fetchBrandInfoBatch(brandIds: string[]): Promise<Map<string, BrandInfo>> {
  const brandServiceUrl = process.env.BRAND_SERVICE_URL;
  const brandServiceApiKey = process.env.BRAND_SERVICE_API_KEY;

  if (!brandServiceUrl || !brandServiceApiKey) {
    console.error("[features-service] BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured, skipping brand enrichment");
    return new Map();
  }

  if (brandIds.length === 0) return new Map();

  const chunks: string[][] = [];
  for (let i = 0; i < brandIds.length; i += BRAND_BATCH_CHUNK_SIZE) {
    chunks.push(brandIds.slice(i, i + BRAND_BATCH_CHUNK_SIZE));
  }

  const map = new Map<string, BrandInfo>();

  await Promise.all(
    chunks.map(async (chunk) => {
      const url = `${brandServiceUrl}/internal/brands?ids=${chunk.join(",")}`;
      try {
        const response = await fetchWithRetry(url, {
          headers: { "x-api-key": brandServiceApiKey },
        });

        if (!response.ok) {
          console.error(`[features-service] brand-service GET /internal/brands batch failed: ${response.status}`);
          return;
        }

        const data = await response.json() as { brands: Array<{ id: string; name: string | null; domain: string | null }> };
        for (const b of data.brands) {
          map.set(b.id, { id: b.id, name: b.name, domain: b.domain });
        }
      } catch (error) {
        console.error(`[features-service] brand-service GET /internal/brands batch error:`, (error as Error).message);
      }
    }),
  );

  return map;
}
