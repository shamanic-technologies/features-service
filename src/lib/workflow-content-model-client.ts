/**
 * WHICH MODEL EACH WORKFLOW WRITES ITS CONTENT WITH — read from the workflow catalogue, per DYNASTY
 *
 * workflow-service derives `contentModel` at read from the DAG itself: the `model` field of the
 * workflow's content-generation `POST /generate` request body. So a consumer can label a workflow row
 * without downloading and parsing a DAG, and — crucially — nothing here guesses it from a slug.
 *
 * ── WHY NOT `/public/workflows`, WHICH THIS SERVICE ALREADY READS ────────────────────────────────
 *
 * That listing is deliberately narrow (id, slugs, version, status, feature, brand) and carries no
 * `contentModel`; the field lives on the FULL workflow shape, which `GET /workflows` serves. Both are
 * workflow-service, both are one call, and `GET /workflows?featureSlug=&status=all` is filtered by
 * nothing but the feature — it returns the channel's whole cross-org catalogue, which is exactly the
 * set the projection ranks. It requires identity headers, which every leg-keyed read already holds.
 *
 * ── THE DYNASTY IS THE UNIT, AND ITS MODEL IS ITS ACTIVE VERSION'S ───────────────────────────────
 *
 * A projection row is keyed on the DYNASTY, so the model that matters is the one the version a run
 * would actually execute names — i.e. the ACTIVE version. `status=all` is read rather than
 * `status=active` so a RETIRED lineage (which still carries rows, with its real history) resolves to
 * the model its last version named instead of vanishing into "no model stated"; within a dynasty the
 * active version wins, and among versions of equal status the highest one does.
 *
 * Fail-LOUD client; the caller wraps it fail-SOFT. A workflow with no readable model reads as
 * UNKNOWABLE and stays ELIGIBLE — see `model-tier-eligibility.ts`.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { Identity } from "./workflow-projection-grains.js";

interface WorkflowRow {
  workflowDynastySlug?: unknown;
  version?: unknown;
  status?: unknown;
  contentModel?: unknown;
}

/**
 * Per workflow DYNASTY, the chat-service model alias its live version writes content with — `null`
 * when that version's DAG states none (no content-generation call, no stated model, a run-time value,
 * or several content calls disagreeing: workflow-service reports all four as null and never a guess).
 *
 * A dynasty absent from the map is one this feature's catalogue does not contain.
 */
export async function fetchWorkflowContentModels(
  featureSlug: string,
  identity: Identity,
): Promise<Map<string, string | null>> {
  const base = process.env.WORKFLOW_SERVICE_URL;
  const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] WORKFLOW_SERVICE_URL / WORKFLOW_SERVICE_API_KEY not configured");

  const headers: Record<string, string> = { "x-api-key": apiKey, "x-org-id": identity.orgId };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;

  const url = `${base}/workflows?featureSlug=${encodeURIComponent(featureSlug)}&status=all`;
  // The catalogue moves on the scale of minutes: an interactive view reuses it 30s, re-read behind
  // the answer (fetch-retry.ts `shareForMs`, features-service#1045) — still never the snapshot's age.
  const response = await fetchWithRetry(url, { headers }, { shareForMs: 30_000 });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] workflow-service GET /workflows failed: ${response.status} — ${body}`);
  }

  const data = (await response.json()) as { workflows?: unknown } | unknown[];
  const rows: WorkflowRow[] = Array.isArray(data) ? (data as WorkflowRow[]) : Array.isArray((data as { workflows?: unknown }).workflows) ? ((data as { workflows: WorkflowRow[] }).workflows) : [];
  if (!Array.isArray(rows)) throw new Error("[features-service] workflow-service GET /workflows returned no workflow list");

  // Pick the version whose model would actually run: active beats deprecated, then the highest
  // version number. Deterministic, so two reads of one catalogue can never label a dynasty twice.
  const best = new Map<string, { active: boolean; version: number; contentModel: string | null }>();
  for (const row of rows) {
    const dynasty = row?.workflowDynastySlug;
    if (typeof dynasty !== "string" || dynasty === "") continue;
    const active = row?.status === "active";
    const version = typeof row?.version === "number" ? row.version : 0;
    const contentModel = typeof row?.contentModel === "string" && row.contentModel !== "" ? row.contentModel : null;
    const current = best.get(dynasty);
    if (!current || (active && !current.active) || (active === current.active && version > current.version)) {
      best.set(dynasty, { active, version, contentModel });
    }
  }

  return new Map([...best.entries()].map(([dynasty, v]) => [dynasty, v.contentModel]));
}

/**
 * Fail-SOFT wrapper: `null` on any failure, with a loud log. A null map makes every workflow read as
 * "no model stated" — unknowable, and therefore ELIGIBLE. Never an exclusion on a failed read.
 */
export async function fetchWorkflowContentModelsSoft(
  featureSlug: string,
  identity: Identity,
): Promise<Map<string, string | null> | null> {
  try {
    return await fetchWorkflowContentModels(featureSlug, identity);
  } catch (error) {
    console.error(
      "[features-service] workflow content models unavailable — every workflow stays ELIGIBLE with the reason stated on its row:",
      error,
    );
    return null;
  }
}
