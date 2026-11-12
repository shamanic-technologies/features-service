/**
 * THE RATING RATES LLMs PER ENGINE (LLM-RATING-PER-ENGINE-1112; rule `lib/engine-llm-rating.ts`, IO
 * `lib/engine-llm-rating-io.ts`, stores `lib/engine-llm-store.ts`).
 *
 *   GET /internal/llm-pick?outcome=&place=[&campaignId=]   (api key) which LLM one call of a script uses (x-run-id = the run)
 *   GET /internal/research/engine-llms[?outcome=]          (api key, staff) per Engine: its universe, every LLM ranked + usage
 *   GET /internal/engine-llm-universes                     (api key, staff) the stored universes
 *   PUT /internal/engine-llm-universes                     (api key, staff) set one Engine's universe (or the fleet row `*`)
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { engineLlmBody, pickLlm, FLEET_UNIVERSE, SPEND_SERIES_DAYS } from "../lib/engine-llm-rating.js";
import { readRatingInputs } from "../lib/engine-llm-rating-io.js";
import { listUniverseRules, putUniverseRule, recordLlmPick } from "../lib/engine-llm-store.js";
import { readLlmDynasties } from "../lib/llm-dynasties.js";
import { labelOfOutcome } from "../lib/engine-strategy-io.js";

const router = Router();

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const today = () => new Date().toISOString().slice(0, 10);

/** Said on every staff body: what the figures are and are not. */
export const ENGINE_LLM_LIMITS = [
  "An LLM's spend is its own calls' billed money (what choosing it moves), never the rest of the run.",
  "A decision is one root run; it made the Unit when the ledger credits it one of its Engine's outcome. A decision that called two LLMs counts for each.",
  "Calls before the Rating existed have no place: they seed the LLM's belief at every place of its Engine.",
  `Daily spend covers the last ${SPEND_SERIES_DAYS} days, today included; every other figure is whole history.`,
];

router.get("/internal/llm-pick", apiKeyOnly, async (req: Request, res: Response) => {
  const outcome = str(req.query.outcome);
  const place = str(req.query.place);
  if (!outcome || !place) {
    res.status(400).json({ error: "outcome and place are required", reason: "outcome_and_place_required" });
    return;
  }
  const campaignId = str(req.query.campaignId);
  const runId = str(req.headers["x-run-id"]);
  try {
    const inputs = await readRatingInputs(`llm pick ${outcome}|${place}`);
    const day = today();
    const picked = pickLlm({
      outcome,
      place,
      rules: inputs.rules,
      lines: inputs.lines,
      evidence: (inputs.build?.evidence ?? []).filter((e) => e.outcome === outcome),
      outOfCreditProviders: inputs.outOfCreditProviders,
      today: day,
      seed: `${outcome}|${place}|${runId ?? `${Date.now()}-${Math.random()}`}`,
    });
    if (picked.llmDynastySlug === null) {
      res.status(422).json({ error: `no LLM of the ${outcome} Engine's universe can be picked now (not served or vendor out of credit)`, reason: picked.reason, outcome, place });
      return;
    }
    await recordLlmPick({ outcome, place, llmDynastySlug: picked.llmDynastySlug, runId, campaignId });
    const line = inputs.lines.find((l) => l.slug === picked.llmDynastySlug)!;
    res.json({
      outcome,
      place,
      llm: { llmDynastySlug: line.slug, name: line.name, provider: line.provider || null, model: line.slug },
      candidates: picked.candidates,
      evidenceComputedAt: inputs.build?.computedAt ?? null,
      evidenceUnavailableReason: inputs.build ? null : "evidence_not_built_yet",
    });
  } catch (error) {
    console.error(`[features-service] llm-pick ${outcome}|${place}:`, error);
    res.status(502).json({ error: (error as Error).message, reason: "llm_rating_unreadable" });
  }
});

router.get("/internal/research/engine-llms", apiKeyOnly, async (req: Request, res: Response) => {
  const only = str(req.query.outcome);
  try {
    const inputs = await readRatingInputs("research engine-llms");
    const evidence = inputs.build?.evidence ?? [];
    const outcomes = new Set<string>([...evidence.map((e) => e.outcome), ...inputs.picks.map((p) => p.outcome), ...inputs.rules.map((r) => r.outcome).filter((o) => o !== FLEET_UNIVERSE)]);
    const day = today();
    const engines = [...outcomes]
      .filter((o) => !only || o === only)
      .map((outcome) => ({
        name: labelOfOutcome(outcome),
        ...engineLlmBody({ outcome, rules: inputs.rules, lines: inputs.lines, evidence: evidence.filter((e) => e.outcome === outcome), picks: inputs.picks, outOfCreditProviders: inputs.outOfCreditProviders, today: day }),
      }))
      .sort((a, b) => b.totals.spentUsdToDate - a.totals.spentUsdToDate || (a.outcome < b.outcome ? -1 : 1));
    res.json({
      computedAt: new Date().toISOString(),
      evidenceComputedAt: inputs.build?.computedAt ?? null,
      evidenceUnavailableReason: inputs.build ? null : "evidence_not_built_yet",
      evidenceCounts: inputs.build?.counts ?? null,
      engines,
      limits: ENGINE_LLM_LIMITS,
    });
  } catch (error) {
    console.error("[features-service] research engine-llms:", error);
    res.status(502).json({ error: (error as Error).message, reason: "llm_rating_unreadable" });
  }
});

router.get("/internal/engine-llm-universes", apiKeyOnly, async (_req: Request, res: Response) => {
  try {
    res.json({ universes: await listUniverseRules() });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message, reason: "universes_unreadable" });
  }
});

router.put("/internal/engine-llm-universes", apiKeyOnly, async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const outcome = str(b.outcome);
  const decidedBy = str(b.decidedBy);
  const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
  if (!outcome || !decidedBy || !(b.allowed === null || isList(b.allowed)) || !isList(b.excluded)) {
    res.status(400).json({ error: "outcome, decidedBy, allowed (list or null) and excluded (list) are required", reason: "universe_unrecognised" });
    return;
  }
  try {
    const known = new Set((await readLlmDynasties()).map((d) => d.slug));
    const unknown = [...(b.allowed ?? []), ...b.excluded].filter((s) => !known.has(s));
    if (unknown.length) {
      res.status(400).json({ error: `unknown LLM dynasties: ${unknown.join(", ")}`, reason: "llm_dynasty_unknown" });
      return;
    }
    res.json(await putUniverseRule({ outcome, allowed: b.allowed, excluded: b.excluded, decidedBy, note: str(b.note) }));
  } catch (error) {
    res.status(502).json({ error: (error as Error).message, reason: "universe_unwritable" });
  }
});

export default router;
