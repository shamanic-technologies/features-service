/**
 * Every VERSION of a feature's workflows with what it DOES (its DAG and description), read org-less from
 * workflow-service with its api key only: the tactic sweep (`lib/tactic-judgments.ts`) runs with no org request
 * behind it. Fail-LOUD: the sweep catches per feature and retries next sweep.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface WorkflowDefinition {
  workflowSlug: string;
  workflowDynastySlug: string;
  version: number;
  /** This VERSION is the active one of its dynasty. */
  versionActive: boolean;
  description: string | null;
  dag: unknown;
}

const DEFINITIONS_TIMEOUT_MS = 60_000;

interface RawDefinition {
  workflowSlug?: unknown;
  workflowDynastySlug?: unknown;
  version?: unknown;
  status?: unknown;
  description?: unknown;
  dag?: unknown;
}

/** PURE: one served row, or null when it does not name its version (logged by the caller's count). */
export function parseDefinition(r: RawDefinition): WorkflowDefinition | null {
  if (typeof r.workflowSlug !== "string" || typeof r.workflowDynastySlug !== "string" || typeof r.version !== "number" || r.dag === undefined) return null;
  return {
    workflowSlug: r.workflowSlug,
    workflowDynastySlug: r.workflowDynastySlug,
    version: r.version,
    versionActive: r.status === "active",
    description: typeof r.description === "string" ? r.description : null,
    dag: r.dag,
  };
}

export async function fetchWorkflowDefinitions(featureSlug: string): Promise<WorkflowDefinition[]> {
  const base = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] WORKFLOW_SERVICE_URL / WORKFLOW_SERVICE_API_KEY not configured");
  const url = `${base}/public/workflows/definitions?featureSlug=${encodeURIComponent(featureSlug)}`;
  const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } }, { timeoutMs: DEFINITIONS_TIMEOUT_MS });
  if (!res.ok) throw new Error(`workflow-service ${url} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { workflows?: RawDefinition[] };
  if (!Array.isArray(body.workflows)) throw new Error(`workflow-service ${url} returned no workflows array`);
  const rows = body.workflows.map(parseDefinition);
  const bad = rows.filter((r) => r === null).length;
  if (bad > 0) throw new Error(`workflow-service ${url}: ${bad} row(s) without a version slug, dynasty, version or DAG`);
  return rows as WorkflowDefinition[];
}
