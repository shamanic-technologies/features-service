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

export async function fetchPublicEmailStats(
  featureSlugs: string,
  groupBy: string,
): Promise<Map<string, Record<string, number>>> {
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
