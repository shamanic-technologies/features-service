/**
 * Fetch functions for public (no-identity-header) downstream endpoints.
 * Each function sends only x-api-key — no x-org-id, x-user-id, x-run-id.
 * Service URLs and keys are read lazily from process.env.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowMetadata {
  id: string;
  slug: string;
  name: string;
  dynastyName: string;
  dynastySlug: string;
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
    console.error(`[features-service] workflow-service /public/workflows failed: ${response.status}`);
    return [];
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
    console.error(`[features-service] runs-service /v1/stats/public/costs failed: ${response.status}`);
    return [];
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
    console.error(`[features-service] email-gateway /public/stats failed: ${response.status}`);
    return new Map();
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

const EMAIL_FIELDS = [
  "emailsContacted", "emailsSent", "emailsDelivered", "emailsOpened",
  "emailsClicked", "emailsReplied", "emailsBounced", "recipients",
  "repliesWillingToMeet", "repliesInterested", "repliesNotInterested",
  "repliesOutOfOffice", "repliesUnsubscribe", "repliesMoreInfo", "repliesWrongContact",
];

function extractBroadcastEmailFields(data: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  const broadcast = (data.broadcast ?? {}) as Record<string, number>;
  for (const field of EMAIL_FIELDS) {
    result[field] = broadcast[field] ?? 0;
  }
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
    console.error(`[features-service] journalists-service /public/stats failed: ${response.status}`);
    return new Map();
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
  return {
    journalistsFound: Number(data.totalJournalists ?? 0),
    journalistsContacted: Number((data.byStatus as Record<string, number> | undefined)?.contacted ?? 0),
  };
}
