import { Router } from "express";
import { eq } from "drizzle-orm";
import { apiKeyOnly } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { funnelLeg, matchChannelLegKey, servedLegKeyOf, storedLegKeyOf } from "../lib/funnel-legs.js";
import { loadChannelCatalogue } from "../lib/channel-declarations-store.js";
import { fetchPublicWorkflows } from "../lib/public-stats-clients.js";
import {
  isLegAssignmentState,
  listLegAssignmentChanges,
  listLegAssignments,
  registerLegAssignment,
  setLegAssignment,
} from "../lib/workflow-leg-assignments.js";

/**
 * Staff routes for WHICH WORKFLOWS MAY RUN ON A LEG (`lib/workflow-leg-assignments.ts`). Service-key
 * only: the owner's assistant drives them from the box. The leg-keyed workflow projection reads the
 * table live, so a write moves the selector-facing verdict on the very next read.
 */
const router = Router();

router.get("/internal/workflow-leg-assignments", apiKeyOnly, async (req, res) => {
  const featureSlug = typeof req.query.featureSlug === "string" ? req.query.featureSlug : undefined;
  // Both spellings of an outbound leg name the same rows, stored in the new one (wave 2, `lib/funnel-legs.ts`).
  const legKey = typeof req.query.legKey === "string" ? storedLegKeyOf(req.query.legKey) : undefined;
  try {
    res.json({ assignments: await listLegAssignments({ featureSlug, legKey }) });
  } catch (err) {
    console.error("[features-service] workflow-leg-assignments list failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/workflow-leg-assignments/history", apiKeyOnly, async (req, res) => {
  const { featureSlug, legKey, workflowDynastySlug } = req.query;
  if (typeof featureSlug !== "string" || typeof legKey !== "string" || typeof workflowDynastySlug !== "string") {
    res.status(400).json({ error: "featureSlug, legKey and workflowDynastySlug are required" });
    return;
  }
  try {
    res.json({ changes: await listLegAssignmentChanges({ featureSlug, legKey: storedLegKeyOf(legKey), workflowDynastySlug }) });
  } catch (err) {
    console.error("[features-service] workflow-leg-assignments history failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Put a workflow dynasty on a leg in a state: assign (`active`), deprecate on this leg only
 * (`deprecated`), or reactivate (`active` again). Every write records who and when, plus a history row.
 */
router.put("/internal/workflow-leg-assignments", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { featureSlug, legKey: rawLegKey, workflowDynastySlug, state, decidedBy, note } = body;
  if (typeof featureSlug !== "string" || featureSlug === "") {
    res.status(400).json({ error: "featureSlug (the acquisition channel) is required", reason: "feature_slug_required" });
    return;
  }
  // The stored spelling: the new outbound spelling (`lead_found_to_*`) of an outbound channel writes the
  // same row as the legacy one; the row is stored in the new spelling (wave 2, `lib/workflow-leg-assignments.ts`).
  const legKey = typeof rawLegKey === "string" ? matchChannelLegKey(featureSlug, rawLegKey) : null;
  if (typeof rawLegKey !== "string" || !legKey || !funnelLeg(legKey)) {
    res.status(400).json({ error: `legKey must be a leg of the funnel catalogue, got ${JSON.stringify(rawLegKey)}`, reason: "leg_unrecognised" });
    return;
  }
  if (typeof workflowDynastySlug !== "string" || workflowDynastySlug === "") {
    res.status(400).json({ error: "workflowDynastySlug is required", reason: "workflow_dynasty_required" });
    return;
  }
  if (!isLegAssignmentState(state)) {
    res.status(400).json({ error: "state must be `active` or `deprecated`", reason: "state_unrecognised" });
    return;
  }
  if (typeof decidedBy !== "string" || decidedBy.trim() === "") {
    res.status(400).json({ error: "decidedBy (who decided) is required", reason: "decided_by_required" });
    return;
  }
  if (note != null && typeof note !== "string") {
    res.status(400).json({ error: "note must be a string", reason: "note_invalid" });
    return;
  }
  try {
    const [feature] = await db.select({ slug: features.slug }).from(features).where(eq(features.slug, featureSlug));
    if (!feature) {
      res.status(404).json({ error: `no feature (acquisition channel) ${featureSlug}`, reason: "feature_not_found" });
      return;
    }
    // A typo would store an assignment no row ever matches, so the dynasty must be one workflow-service
    // describes for this channel (any status: a retired lineage can still be deprecated on a leg).
    const catalogue = await fetchPublicWorkflows(featureSlug, "all");
    if (!catalogue.some((w) => w.workflowDynastySlug === workflowDynastySlug)) {
      res.status(404).json({
        error: `workflow-service describes no dynasty ${workflowDynastySlug} for ${featureSlug}`,
        reason: "workflow_dynasty_not_found",
      });
      return;
    }
    const result = await setLegAssignment({
      featureSlug,
      legKey,
      workflowDynastySlug,
      state,
      decidedBy: decidedBy.trim(),
      note: (note as string | null | undefined) ?? null,
    });
    res.json(result);
  } catch (err) {
    console.error("[features-service] workflow-leg-assignments write failed:", err);
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * REGISTER "workflow X serves pipe Y" (owner 2026-10-10: the pipe <-> workflow link lives in features-service
 * ONLY; option A: a workflow created for a pipe is ACTIVE at once). workflow-service calls this when it
 * creates a workflow for a pipe, service-to-service. Body: `{pipeId: "<channel slug>|<leg key>",
 * workflowDynastySlug, registeredBy, note?}`. The pipe must be one the channel performs (seeded or declared);
 * the dynasty one workflow-service describes for that channel. Insert-if-absent: 201 `created: true` with the
 * new active row; 200 `created: false` with the EXISTING row untouched (a staff `deprecated` stays). The
 * answer carries the pipe itself (`fromStep`, `toStep` = what the workflow produces, `mode`, `triggerId`):
 * read it here, never store a copy.
 */
router.post("/internal/workflow-leg-assignments/register", apiKeyOnly, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { pipeId, workflowDynastySlug, registeredBy, note } = body;
  if (typeof pipeId !== "string" || !pipeId.includes("|")) {
    res.status(400).json({ error: "pipeId is required: `<channel slug>|<leg key>`", reason: "pipe_id_required" });
    return;
  }
  if (typeof workflowDynastySlug !== "string" || workflowDynastySlug === "") {
    res.status(400).json({ error: "workflowDynastySlug is required", reason: "workflow_dynasty_required" });
    return;
  }
  if (typeof registeredBy !== "string" || registeredBy.trim() === "") {
    res.status(400).json({ error: "registeredBy (the caller, e.g. workflow-service) is required", reason: "registered_by_required" });
    return;
  }
  if (note != null && typeof note !== "string") {
    res.status(400).json({ error: "note must be a string", reason: "note_invalid" });
    return;
  }
  const at = pipeId.indexOf("|");
  const featureSlug = pipeId.slice(0, at);
  const rawLeg = pipeId.slice(at + 1);
  try {
    const cat = await loadChannelCatalogue({ publishedOnly: false });
    const channel = cat.channels.find((c) => c.slug === featureSlug);
    const computed = storedLegKeyOf(rawLeg);
    const transition = channel?.stepTransitions.find((t) => t.legKey === computed || t.legKey === rawLeg);
    if (!channel || !transition) {
      res.status(404).json({ error: `no pipe ${pipeId}: the channel does not perform that leg`, reason: "pipe_not_found" });
      return;
    }
    const catalogue = await fetchPublicWorkflows(featureSlug, "all", true);
    if (!catalogue.some((w) => w.workflowDynastySlug === workflowDynastySlug)) {
      res.status(404).json({ error: `workflow-service describes no dynasty ${workflowDynastySlug} for ${featureSlug}`, reason: "workflow_dynasty_not_found" });
      return;
    }
    const result = await registerLegAssignment({
      featureSlug,
      legKey: transition.legKey,
      workflowDynastySlug,
      registeredBy: registeredBy.trim(),
      note: (note as string | null | undefined) ?? null,
    });
    const servedLeg = servedLegKeyOf(featureSlug, transition.legKey);
    console.log(`[features-service] workflow ${workflowDynastySlug} ${result.created ? "registered ACTIVE on" : "already stated on"} pipe ${featureSlug}|${servedLeg} (${result.assignment.state}) by ${registeredBy}`);
    res.status(result.created ? 201 : 200).json({
      created: result.created,
      assignment: result.assignment,
      pipe: {
        id: `${featureSlug}|${servedLeg}`,
        channelSlug: featureSlug,
        legKey: servedLeg,
        // An outbound channel's entry leg is served from Lead found (wave 2).
        fromStep: servedLeg !== transition.legKey ? "lead_found" : (transition.from?.key ?? null),
        toStep: transition.to.key,
        mode: transition.mode,
        triggerId: transition.triggerId,
      },
    });
  } catch (err) {
    console.error("[features-service] workflow-leg-assignments register failed:", err);
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
