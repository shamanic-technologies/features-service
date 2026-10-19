/**
 * GET /orgs/leads/:leadId/written-by[?campaignId=] — who wrote the messages we sent to one person for the caller's org,
 * and how (owner 2026-10-19, WRITTEN-BY-1019; pure rule `lib/written-by.ts`). One entry per writer record (a generated
 * sequence: campaign x person), newest first; the dashboard shows, on each sent message, the entry of the message's
 * campaign written at or before it. Org-scoped: another org's person reads `entries: []`. Never a workflow name or id,
 * never a cost.
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
import { buildWrittenBy, type VersionVerdict } from "../lib/written-by.js";
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
    const slugs = [...new Set(records.map((r) => r.workflowSlug).filter((s): s is string => !!s))];
    const [models, verdicts, catalogue] = await Promise.all([
      records.length === 0
        ? Promise.resolve([] as ServedModel[])
        : readModelIds().catch((error) => {
            console.error("[features-service] written-by: chat-service model names unreadable this time:", error);
            return null;
          }),
      listVerdictsOfVersions(slugs),
      loadPlayCatalogue(),
    ]);
    const versionVerdicts: VersionVerdict[] = verdicts.map((v) => ({ workflowSlug: v.workflowSlug, workflowDynastySlug: v.workflowDynastySlug, tacticId: v.tacticId, verdict: v.verdict }));
    const maturity = await maturityByDynasty([...new Set(versionVerdicts.map((v) => v.workflowDynastySlug))]);
    const entries = buildWrittenBy({ records, verdicts: versionVerdicts, tactics: catalogue.tactics, models, maturityByDynasty: maturity });
    res.json({ leadId, campaignId, entries });
  } catch (error) {
    console.error(`[features-service] written-by error for org ${req.orgId} lead ${leadId}:`, error);
    res.status(502).json({ error: "Failed to read who wrote this person's messages" });
  }
});

export default router;
