/**
 * Fetch functions for public (no-identity-header) downstream endpoints.
 * Each function sends only x-api-key — no x-org-id, x-user-id, x-run-id.
 * Service URLs and keys are read lazily from process.env.
 */

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
  runCount: number;
  minStartedAt: string | null;
  maxStartedAt: string | null;
}

export interface PublicBrandTimelinePoint {
  date: string;
  cumulativePipelineUsd: number | null;
  emailsSent: number | null;
  emailsOpened: number | null;
  emailsClicked: number | null;
  emailsReplied: number | null;
}

export interface PublicEmailStatsResult {
  stats: Map<string, Record<string, number>>;
  timelines: Map<string, PublicBrandTimelinePoint[]>;
}

// ── Workflow metadata ────────────────────────────────────────────────────────

export async function fetchPublicWorkflows(
  featureSlugs: string,
  status = "all",
): Promise<WorkflowMetadata[]> {
  const url = `${process.env.WORKFLOW_SERVICE_URL}/public/workflows?featureSlugs=${encodeURIComponent(featureSlugs)}&status=${status}`;
  const response = await fetch(url, {
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
): Promise<CostGroup[]> {
  const params = new URLSearchParams({ featureSlugs, groupBy });

  const url = `${process.env.RUNS_SERVICE_URL}/v1/stats/public/costs?${params}`;
  const response = await fetch(url, {
    headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] runs-service /v1/stats/public/costs failed: ${response.status} — ${body}`);
  }

  const data = await response.json() as { groups: CostGroup[] };
  return data.groups;
}

// ── Email stats (email-gateway) ──────────────────────────────────────────────

export async function fetchPublicEmailStatsWithTimelines(
  featureSlugs: string,
  groupBy: string,
): Promise<PublicEmailStatsResult> {
  const params = new URLSearchParams({ featureSlugs, groupBy });

  const url = `${process.env.EMAIL_GATEWAY_SERVICE_URL}/public/stats?${params}`;
  const response = await fetch(url, {
    headers: { "x-api-key": process.env.EMAIL_GATEWAY_SERVICE_API_KEY! },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] email-gateway /public/stats failed: ${response.status} — ${body}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const stats = new Map<string, Record<string, number>>();
  const timelines = new Map<string, PublicBrandTimelinePoint[]>();

  if (data.groups && Array.isArray(data.groups)) {
    for (const group of data.groups as Array<Record<string, unknown>>) {
      const groupKey = String(group.key ?? "__total__");
      stats.set(groupKey, extractBroadcastEmailFields(group));
      const timeline = extractPublicTimeline(group);
      if (timeline.length > 0) timelines.set(groupKey, timeline);
    }
  } else {
    stats.set("__total__", extractBroadcastEmailFields(data));
    const timeline = extractPublicTimeline(data);
    if (timeline.length > 0) timelines.set("__total__", timeline);
  }

  return { stats, timelines };
}

export async function fetchPublicEmailStats(
  featureSlugs: string,
  groupBy: string,
): Promise<Map<string, Record<string, number>>> {
  return (await fetchPublicEmailStatsWithTimelines(featureSlugs, groupBy)).stats;
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

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function firstNumber(data: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = numberOrNull(data[key]);
    if (n !== null) return n;
  }
  return null;
}

function timelineCounts(point: Record<string, unknown>): {
  sent: number | null;
  opened: number | null;
  clicked: number | null;
  replied: number | null;
  cumulative: boolean;
} {
  const broadcast = point.broadcast as Record<string, unknown> | undefined;
  const recipientStats = broadcast?.recipientStats as Record<string, unknown> | undefined;
  const flat = recipientStats ?? point;
  const cumulative = [
    "cumulativeEmailsSent",
    "cumulativeEmailsOpened",
    "cumulativeEmailsClicked",
    "cumulativeEmailsReplied",
    "cumulativeRecipientsSent",
    "cumulativeRecipientsOpened",
    "cumulativeRecipientsClicked",
    "cumulativeRecipientsRepliesPositive",
  ].some((key) => flat[key] != null);

  return {
    sent: firstNumber(flat, cumulative ? ["cumulativeEmailsSent", "cumulativeRecipientsSent"] : ["emailsSent", "recipientsSent", "sent"]),
    opened: firstNumber(flat, cumulative ? ["cumulativeEmailsOpened", "cumulativeRecipientsOpened"] : ["emailsOpened", "recipientsOpened", "opened"]),
    clicked: firstNumber(flat, cumulative ? ["cumulativeEmailsClicked", "cumulativeRecipientsClicked"] : ["emailsClicked", "recipientsClicked", "clicked"]),
    replied: firstNumber(flat, cumulative ? ["cumulativeEmailsReplied", "cumulativeRecipientsRepliesPositive"] : ["emailsReplied", "recipientsRepliesPositive", "repliesPositive"]),
    cumulative,
  };
}

function extractPublicTimeline(data: Record<string, unknown>): PublicBrandTimelinePoint[] {
  const raw = Array.isArray(data.timeline)
    ? data.timeline
    : Array.isArray(data.timeSeries)
      ? data.timeSeries
      : [];

  const rows = raw
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object" && typeof (p as Record<string, unknown>).date === "string")
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let sent = 0;
  let opened = 0;
  let clicked = 0;
  let replied = 0;

  const points: PublicBrandTimelinePoint[] = [];
  for (const row of rows) {
    const counts = timelineCounts(row);
    if (counts.cumulative) {
      if (counts.sent !== null) sent = counts.sent;
      if (counts.opened !== null) opened = counts.opened;
      if (counts.clicked !== null) clicked = counts.clicked;
      if (counts.replied !== null) replied = counts.replied;
    } else {
      sent += counts.sent ?? 0;
      opened += counts.opened ?? 0;
      clicked += counts.clicked ?? 0;
      replied += counts.replied ?? 0;
    }

    points.push({
      date: String(row.date),
      cumulativePipelineUsd: null,
      emailsSent: sent,
      emailsOpened: opened,
      emailsClicked: clicked,
      emailsReplied: replied,
    });
  }

  return points;
}

// ── Journalist stats (journalists-service) ───────────────────────────────────

export async function fetchPublicJournalistsStats(
  featureSlugs: string,
  groupBy: string,
): Promise<Map<string, Record<string, number>>> {
  const params = new URLSearchParams({ featureSlugs, groupBy });

  const url = `${process.env.JOURNALISTS_SERVICE_URL}/public/stats?${params}`;
  const response = await fetch(url, {
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
        const response = await fetch(url, {
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
