/**
 * THE RATING RATES LLMs PER ENGINE (LLM-RATING-PER-ENGINE-1112; rule `lib/engine-llm-rating.ts`, IO
 * `lib/engine-llm-rating-io.ts`, stores `lib/engine-llm-store.ts`).
 *
 * The separate LLM and template PICKS are DELETED (SCRIPT-VALUE-RATING-1113, owner 2026-11-13: « un pick = toujours un
 * script », the LLM and the template are tactics of the script; `routes/script-rating.ts` picks). What stays is the
 * staff read of what each LLM and template did, and the stored universes it shows.
 *
 *   GET /internal/research/engine-llms[?outcome=]          (api key, staff) per Engine: its universe, every LLM ranked + usage
 *   GET /internal/engine-llm-universes                     (api key, staff) the stored universes
 *   PUT /internal/engine-llm-universes                     (api key, staff) set one Engine's universe (or the fleet row `*`)
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { engineLlmBody, FLEET_UNIVERSE, SPEND_SERIES_DAYS } from "../lib/engine-llm-rating.js";
import { readRatingInputs } from "../lib/engine-llm-rating-io.js";
import { listUniverseRules, putUniverseRule } from "../lib/engine-llm-store.js";
import { readLlmDynasties } from "../lib/llm-dynasties.js";
import { labelOfOutcome } from "../lib/engine-strategy-io.js";
import { engineTemplateLines, everyEngineTemplateLines, listTemplatePicks, type TemplateLine } from "../lib/engine-template-rating-io.js";
import type { EngineLlmBody, LlmRow } from "../lib/engine-llm-rating.js";

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

/** PURE: template lines as the Rating's lines (a template is "served" when it is pickable; no vendor). */
const templateRatingLines = (lines: readonly TemplateLine[]) => lines.map((l) => ({ slug: l.slug, name: l.name, provider: "", servedToday: l.pickable }));

/** PURE: the template half of an Engine's staff body: the LLM Rating's rows, named as templates. */
function templateBlock(b: EngineLlmBody, lines: readonly TemplateLine[]) {
  const lineOf = new Map(lines.map((l) => [l.slug, l]));
  const row = (r: LlmRow) => {
    const { llmDynastySlug, provider: _provider, allowed: _allowed, notPickableReason, ...rest } = r;
    const l = lineOf.get(llmDynastySlug);
    return {
      templateDynastySlug: llmDynastySlug,
      ...rest,
      status: l?.status ?? null,
      head: l?.head ?? null,
      notPickableReason: notPickableReason === null ? null : l ? ("not_active" as const) : ("not_an_engine_template" as const),
    };
  };
  return {
    favourite: b.favourite ? { templateDynastySlug: b.favourite.llmDynastySlug, name: b.favourite.name } : null,
    places: b.places,
    // The Engine's dynasties: pickable ones ranked, then the deprecated / headless ones; then what it wrote with before
    // and no longer lists.
    rows: [...b.llms, ...b.outsideUniverse.filter((r) => lineOf.has(r.llmDynastySlug))].map(row),
    outsideEngine: b.outsideUniverse.filter((r) => !lineOf.has(r.llmDynastySlug)).map(row),
    totals: b.totals,
  };
}

router.get("/internal/research/engine-llms", apiKeyOnly, async (req: Request, res: Response) => {
  const only = str(req.query.outcome);
  try {
    const [inputs, templateLines, templatePicks] = await Promise.all([readRatingInputs("research engine-llms"), everyEngineTemplateLines(), listTemplatePicks("2026-11-01")]);
    const evidence = inputs.build?.evidence ?? [];
    const templateEvidence = inputs.build?.templates ?? [];
    const outcomes = new Set<string>([...evidence.map((e) => e.outcome), ...inputs.picks.map((p) => p.outcome), ...inputs.rules.map((r) => r.outcome).filter((o) => o !== FLEET_UNIVERSE)]);
    const day = today();
    const engines = [...outcomes]
      .filter((o) => !only || o === only)
      .map((outcome) => ({
        name: labelOfOutcome(outcome),
        ...engineLlmBody({ outcome, rules: inputs.rules, lines: inputs.lines, evidence: evidence.filter((e) => e.outcome === outcome), picks: inputs.picks, outOfCreditProviders: inputs.outOfCreditProviders, today: day }),
        templates: templateBlock(
          engineLlmBody({ outcome, rules: [], lines: templateRatingLines(templateLines.get(outcome) ?? []), evidence: templateEvidence.filter((e) => e.outcome === outcome), picks: templatePicks, outOfCreditProviders: new Set(), today: day }),
          templateLines.get(outcome) ?? [],
        ),
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
