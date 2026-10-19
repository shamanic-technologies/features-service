/**
 * GET /orgs/leads/:leadId/written-by[?campaignId=] — who wrote the messages we sent to one person for the caller's org,
 * and how (owner 2026-10-19, WRITTEN-BY-1019; pure rule `lib/written-by.ts`). `messages`: one row per message we sent,
 * any channel, keyed on lead-service's message id (the dashboard's timeline / Unibox row). `entries`: one per writer
 * record (a generated sequence: campaign x person), newest first. Org-scoped: another org's person reads empty lists.
 * Never a workflow name or id, never a run id, never a cost.
 *
 * Every part beside the writer record fails SOFT to a named null (the model names, the tactic verdicts, the pipe
 * maturity); the writer record itself fails loud (502): an empty list must mean "nothing written", never "unreadable".
 */
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { generationSequenceCopy } from "../db/schema.js";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { readModelIds, type ServedModel } from "../lib/model-ids-client.js";
import { listVerdictsOfVersions, loadPlayCatalogue } from "../lib/plays-store.js";
import { listLegAssignments } from "../lib/workflow-leg-assignments.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { fetchWorkflowDefinitions } from "../lib/workflow-definitions-client.js";
import { buildMessageWrittenBy, buildWrittenBy, writingModelAliasOfDag, type SentMessage, type VersionVerdict } from "../lib/written-by.js";
import { readLegWorkflowRanking } from "./public.js";

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A ranking not built yet is waited on this long, then the maturity reads null (the read never hangs on a fleet walk). */
const RANKING_WAIT_MS = 3_000;

/** dynasty -> its maturity verdict on every pipe it is assigned to (active or not). Null when a ranking cannot be read. */
async function maturityByDynasty(dynasties: readonly string[]): Promise<Map<string, Array<boolean | null>> | null> {
  if (dynasties.length === 0) return new Map();
  try {
    const wanted = new Set(dynasties);
    const legs = new Map<string, { featureSlug: string; legKey: string }>();
    for (const a of await listLegAssignments()) {
      if (wanted.has(a.workflowDynastySlug)) legs.set(`${a.featureSlug}|${a.legKey}`, { featureSlug: a.featureSlug, legKey: a.legKey });
    }
    const out = new Map<string, Array<boolean | null>>();
    for (const leg of legs.values()) {
      const ranking = await readLegWorkflowRanking(leg.featureSlug, leg.legKey, RANKING_WAIT_MS);
      if (!ranking) return null;
      for (const row of ranking.rows) {
        if (wanted.has(row.workflowDynastySlug)) out.set(row.workflowDynastySlug, [...(out.get(row.workflowDynastySlug) ?? []), row.isMature]);
      }
    }
    return out;
  } catch (error) {
    console.error("[features-service] written-by: pipe maturity unreadable this time:", error);
    return null;
  }
}

/**
 * Every message we sent the person at the org, any channel, with the version that wrote it (lead-service, WRITTEN-BY-1019-
 * SENDER). A lead holding no row of the org (404) sent nothing for it: `[]`.
 */
async function fetchSentMessages(orgId: string, leadId: string): Promise<SentMessage[]> {
  const base = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${base}/internal/leads/${encodeURIComponent(leadId)}/sent-messages`, { headers: { "x-api-key": apiKey, "x-org-id": orgId } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`lead-service sent-messages ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { messages?: SentMessage[] };
  if (!Array.isArray(body.messages)) throw new Error("lead-service sent-messages: no messages array");
  return body.messages;
}

/** run id -> the workflow version it ran (a run never changes version). Bounded; a failed read is not held. */
const runVersionHeld = new Map<string, string | null>();
const RUN_VERSION_HELD_MAX = 20_000;

/**
 * A message whose writing run predates lead-service recording the version (`workflowSlug` null, `runId` set): the
 * version is the run's own, read at runs-service (`GET /v1/runs/:id`, the run must be the org's). Fail SOFT per run:
 * an unreadable run keeps a null version (its model reads `no_workflow_recorded`), logged.
 */
async function withRunVersions(orgId: string, messages: SentMessage[]): Promise<SentMessage[]> {
  const base = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  const missing = [...new Set(messages.filter((m) => m.writtenBy.by === "workflow" && !m.writtenBy.workflowSlug && m.writtenBy.runId).map((m) => m.writtenBy.runId as string))].filter(
    (id) => !runVersionHeld.has(id),
  );
  if (missing.length > 0 && base && apiKey) {
    await mapWithConcurrency(missing, 4, async (runId) => {
      try {
        const res = await fetchWithRetry(`${base}/v1/runs/${encodeURIComponent(runId)}`, { headers: { "x-api-key": apiKey, "x-org-id": orgId } }, { timeoutMs: 15_000 });
        if (!res.ok) throw new Error(`runs-service run ${runId} ${res.status}`);
        const run = (await res.json()) as { organizationId?: unknown; workflowSlug?: unknown };
        if (run.organizationId !== orgId) throw new Error(`run ${runId} is not the org's`);
        if (runVersionHeld.size >= RUN_VERSION_HELD_MAX) runVersionHeld.clear();
        runVersionHeld.set(runId, typeof run.workflowSlug === "string" && run.workflowSlug ? run.workflowSlug : null);
      } catch (error) {
        console.error("[features-service] written-by: a writing run's version unreadable this time:", error);
      }
    });
  }
  return messages.map((m) =>
    m.writtenBy.by === "workflow" && !m.writtenBy.workflowSlug && m.writtenBy.runId && runVersionHeld.get(m.writtenBy.runId)
      ? { ...m, writtenBy: { ...m.writtenBy, workflowSlug: runVersionHeld.get(m.writtenBy.runId) ?? null } }
      : m,
  );
}

/** Per feature: workflow version slug -> the model alias its writing step names. Versions never change; held 15 min. */
const HOLD_ALIASES_MS = 15 * 60_000;
const aliasesHeld = new Map<string, { at: number; value: Promise<Map<string, string | null>> }>();
function featureModelAliases(featureSlug: string): Promise<Map<string, string | null>> {
  const held = aliasesHeld.get(featureSlug);
  if (held && Date.now() - held.at < HOLD_ALIASES_MS) return held.value;
  const value = fetchWorkflowDefinitions(featureSlug).then((defs) => new Map(defs.map((d) => [d.workflowSlug, writingModelAliasOfDag(d.dag)])));
  aliasesHeld.set(featureSlug, { at: Date.now(), value });
  value.catch(() => {
    if (aliasesHeld.get(featureSlug)?.value === value) aliasesHeld.delete(featureSlug);
  });
  return value;
}

/** Test seam. */
export function __resetWrittenByAliasesForTest(): void {
  aliasesHeld.clear();
  runVersionHeld.clear();
}

/**
 * workflow version slug -> its writing step's model alias, for the versions asked. The feature of a version is read
 * off its dynasty's pipe assignment (never its name). A feature whose definitions cannot be read leaves its versions
 * absent (their model reads `model_not_recorded`), logged.
 */
async function dagModelAliases(versions: ReadonlyArray<{ workflowSlug: string; workflowDynastySlug: string }>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (versions.length === 0) return out;
  const dynasties = new Set(versions.map((v) => v.workflowDynastySlug));
  const features = new Set((await listLegAssignments()).filter((a) => dynasties.has(a.workflowDynastySlug)).map((a) => a.featureSlug));
  const wanted = new Set(versions.map((v) => v.workflowSlug));
  for (const feature of features) {
    try {
      for (const [slug, alias] of await featureModelAliases(feature)) if (wanted.has(slug)) out.set(slug, alias);
    } catch (error) {
      console.error(`[features-service] written-by: ${feature} workflow definitions unreadable this time:`, error);
    }
  }
  return out;
}

router.get("/orgs/leads/:leadId/written-by", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as AuthenticatedRequest;
  const leadId = req.params.leadId;
  const campaignId = typeof req.query.campaignId === "string" && req.query.campaignId !== "" ? req.query.campaignId : null;
  if (!UUID.test(leadId)) return void res.status(400).json({ error: "leadId is not a lead id", reason: "lead_id_unrecognised" });
  if (campaignId !== null && !UUID.test(campaignId)) return void res.status(400).json({ error: "campaignId is not a campaign id", reason: "campaign_id_unrecognised" });
  try {
    const conds = [eq(generationSequenceCopy.orgId, req.orgId), eq(generationSequenceCopy.leadId, leadId)];
    if (campaignId) conds.push(eq(generationSequenceCopy.campaignId, campaignId));
    const records = await db
      .select({
        campaignId: generationSequenceCopy.campaignId,
        model: generationSequenceCopy.model,
        workflowSlug: generationSequenceCopy.workflowSlug,
        createdAt: generationSequenceCopy.createdAt,
      })
      .from(generationSequenceCopy)
      .where(and(...conds));
    // Every message we sent, any channel (lead-service). Fail SOFT: the writer records above still answer.
    let messages: SentMessage[] | null;
    try {
      const all = await withRunVersions(req.orgId, await fetchSentMessages(req.orgId, leadId));
      messages = campaignId ? all.filter((m) => (m.campaignId ?? m.writtenBy.campaignId) === campaignId) : all;
    } catch (error) {
      console.error(`[features-service] written-by: lead-service sent messages unreadable this time (lead ${leadId}):`, error);
      messages = null;
    }
    const slugs = [
      ...new Set([...records.map((r) => r.workflowSlug), ...(messages ?? []).map((m) => (m.writtenBy.by === "workflow" ? m.writtenBy.workflowSlug : null))].filter((s): s is string => !!s)),
    ];
    const [models, verdicts, catalogue] = await Promise.all([
      slugs.length === 0 && records.length === 0
        ? Promise.resolve([] as ServedModel[])
        : readModelIds().catch((error) => {
            console.error("[features-service] written-by: chat-service model names unreadable this time:", error);
            return null;
          }),
      listVerdictsOfVersions(slugs),
      loadPlayCatalogue(),
    ]);
    const versionVerdicts: VersionVerdict[] = verdicts.map((v) => ({ workflowSlug: v.workflowSlug, workflowDynastySlug: v.workflowDynastySlug, tacticId: v.tacticId, verdict: v.verdict }));
    const versions = [...new Map(versionVerdicts.map((v) => [v.workflowSlug, { workflowSlug: v.workflowSlug, workflowDynastySlug: v.workflowDynastySlug }])).values()];
    const [maturity, dagModelAliasOf] = await Promise.all([maturityByDynasty([...new Set(versionVerdicts.map((v) => v.workflowDynastySlug))]), dagModelAliases(versions)]);
    const shared = { verdicts: versionVerdicts, tactics: catalogue.tactics, models, maturityByDynasty: maturity };
    const entries = buildWrittenBy({ ...shared, records });
    res.json({
      leadId,
      campaignId,
      entries,
      messages: messages ? buildMessageWrittenBy({ ...shared, messages, records, dagModelAliasOf }) : null,
      messagesUnavailableReason: messages ? null : "sent_messages_unreadable",
    });
  } catch (error) {
    console.error(`[features-service] written-by error for org ${req.orgId} lead ${leadId}:`, error);
    res.status(502).json({ error: "Failed to read who wrote this person's messages" });
  }
});

export default router;
