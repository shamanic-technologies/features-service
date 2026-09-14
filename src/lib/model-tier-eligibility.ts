/**
 * THE MODEL WRITING THE EMAIL DECIDES THE OUTCOME, SO A LEG EXCLUDES THE TIERS THAT ARE WRONG FOR IT
 *
 * We measured, fleet-wide, that the CAPABILITY TIER of the model a workflow writes its content with
 * decides how that workflow performs, and that the direction of the effect depends on WHAT THE LEG
 * SELLS: the cheap tier badly underperforms on a leg that has to earn a REPLY, and the strong and
 * frontier tiers are money burnt on a leg that only has to earn a WEBSITE VISIT.
 *
 * Nothing this service ranked carried any notion of which model writes a workflow's content, so that
 * finding could not be applied anywhere — and campaign-service kept consuming cells from the wrong
 * tier. Most visibly during the EXPLORE ALLOWANCE, which is where the large majority of cells sit:
 * an unproven workflow is priced at the channel's outreach floor whatever model it names, so the
 * cheapest-cell argmin picks tiers the study says cannot work for that leg.
 *
 * ── THE RULE, AND NOTHING BEYOND IT ──────────────────────────────────────────────────────────────
 *
 *   • a leg whose `toStep` is the funnel's CONVERSATION step  → only `strong` and `frontier`
 *   • a leg whose `toStep` is a WEBSITE VISIT                 → only `cheap`
 *   • every other leg                                         → NO restriction
 *
 * The third line is the one worth stating out loud: the study says nothing about a leg that sells a
 * booked meeting, an attended meeting, a signup, a form or a paid client, so nothing is excluded
 * there and nothing is invented. A rule that "felt" like it should extend to the deeper legs would be
 * a claim about data nobody measured.
 *
 * ── THE VERDICT IS STATED ON THE ROW; THE ROW IS NEVER DROPPED ──────────────────────────────────
 *
 * Two consumers need the difference and neither can recover it from an absence. campaign-service
 * FILTERS on the verdict, so it needs the boolean. The customer dashboard must be able to tell
 * "this workflow is excluded" apart from "this workflow does not exist" — and a workflow that is
 * excluded but has ALREADY RUN for the campaign must keep appearing with its history, exactly as a
 * retired lineage does. A dropped row is also undebuggable: "why does this workflow never run" has
 * no answer if the workflow is nowhere on the body.
 *
 * ── AN UNKNOWABLE TIER IS ELIGIBLE, LOUDLY ───────────────────────────────────────────────────────
 *
 * A workflow whose DAG names no model, or names an alias the catalogue does not carry, stays
 * ELIGIBLE and says why. Never a guess, never an exclusion on ignorance — excluding a workflow
 * because we could not read its tier would silently starve it on evidence we do not have. Same for a
 * catalogue read that FAILS: every row stays eligible and the reason names the failure.
 *
 * ── THE TIER IS NEVER DERIVED FROM THE ALIAS STRING ──────────────────────────────────────────────
 *
 * `flash-pro` resolves to a Flash model and belongs to the CHEAP tier despite containing "pro", so a
 * substring rule gets at least one live alias wrong. Only chat-service — which owns the model
 * catalogue — knows an alias's tier, and this module reads it from there and nowhere else.
 */
import type { ChannelStepKey } from "./acquisition-channels.js";

/** chat-service's own three levels. Read from its catalogue; never inferred here. */
export type CapabilityTier = "cheap" | "strong" | "frontier";

export const CAPABILITY_TIERS: readonly CapabilityTier[] = ["cheap", "strong", "frontier"] as const;

export const isCapabilityTier = (value: unknown): value is CapabilityTier =>
  typeof value === "string" && (CAPABILITY_TIERS as readonly string[]).includes(value);

/**
 * THE RULE. The tiers a leg selling this step may be served by — `null` means "every tier", which is
 * the answer for every step the study is silent about.
 *
 * Keyed on the leg's own `toStep`, the SAME step `lib/leg-outcome.ts` denominates every leg-keyed
 * figure in. So the thing being bought decides the restriction, exactly as it decides the price.
 */
export function eligibleTiersForStep(toStep: ChannelStepKey): readonly CapabilityTier[] | null {
  if (toStep === "conversation") return ["strong", "frontier"];
  if (toStep === "website_visit") return ["cheap"];
  return null;
}

/** What a row says about the model behind it. Present ⟺ the read named a leg. */
export interface ModelEligibility {
  /** The chat-service alias this workflow writes its content with. `null` = its DAG names none. */
  modelAlias: string | null;
  /** The tier recorded for that alias. `null` = UNKNOWABLE (no alias, unknown alias, read failed). */
  modelTier: CapabilityTier | null;
  /** FALSE ⟺ the tier is known AND the leg's rule excludes it. Unknowable is always TRUE. */
  eligible: boolean;
  /**
   * Why this row is not eligible, in a form a human reads — present ⟺ `eligible` is false. A code
   * would make a dashboard re-author the sentence, and two surfaces would then word it differently.
   */
  ineligibleReason: string | null;
  /**
   * Why the tier could not be read, in the same human form — present ⟺ `modelTier` is null. It is
   * stated rather than left to a bare null so a reader can tell "nobody recorded a model for this
   * workflow" apart from "chat-service was unreachable", which are different problems with different
   * owners. A row carrying this is ELIGIBLE: we never exclude on ignorance.
   */
  unknownTierReason: string | null;
}

/** Why an alias could not be resolved to a tier — the four cases, told apart. */
export type UnknownTierCause =
  /** The workflow's DAG states no content model (or several content calls disagree). */
  | "workflow_states_no_model"
  /** The workflow names an alias chat-service's catalogue does not carry. */
  | "alias_absent_from_catalogue"
  /** chat-service's tier catalogue could not be read — unreachable or answering badly. */
  | "catalogue_unavailable"
  /** workflow-service could not be asked which model each workflow names. */
  | "workflow_models_unavailable";

const UNKNOWN_TIER_SENTENCE: Record<UnknownTierCause, (alias: string | null) => string> = {
  workflow_states_no_model: () =>
    "this workflow's DAG names no content model, so we cannot tell which capability tier writes its emails — it is left eligible rather than excluded on a gap in our own reading",
  alias_absent_from_catalogue: (alias) =>
    `chat-service's model catalogue carries no entry for the alias "${alias}", so its capability tier is unknown — left eligible rather than excluded on a gap in our own reading`,
  catalogue_unavailable: () =>
    "chat-service's model catalogue could not be read on this request, so no workflow's capability tier is known — every row is left eligible rather than excluded on a failed read",
  workflow_models_unavailable: () =>
    "workflow-service could not be asked which model each workflow writes its content with, so no capability tier is known — every row is left eligible rather than excluded on a failed read",
};

const TIER_LABEL: Record<CapabilityTier, string> = {
  cheap: "cheap",
  strong: "strong",
  frontier: "frontier",
};

/**
 * The verdict for ONE workflow, against ONE leg's restriction.
 *
 * `restriction` is `eligibleTiersForStep(leg.toStep)`: `null` there means the leg restricts nothing,
 * and every row then reads eligible with its tier still stated — the tier is worth serving even when
 * it decides nothing, because a surface listing the models a campaign could run should name them.
 */
export function modelEligibilityFor(input: {
  /** The leg's own step, used for the human sentence. */
  stepLabel: string;
  restriction: readonly CapabilityTier[] | null;
  /** The alias the workflow's DAG names, or `null` when it names none. */
  modelAlias: string | null;
  /** TRUE when workflow-service could not be asked at all — a different gap from "names none". */
  modelsUnavailable?: boolean;
  /** The alias→tier catalogue. `null` = the read failed, so every row is unknowable-but-eligible. */
  tierByAlias: ReadonlyMap<string, CapabilityTier> | null;
}): ModelEligibility {
  const { stepLabel, restriction, modelAlias, tierByAlias } = input;

  const cause: UnknownTierCause | null =
    input.modelsUnavailable === true
      ? "workflow_models_unavailable"
      : tierByAlias === null
        ? "catalogue_unavailable"
        : modelAlias == null
          ? "workflow_states_no_model"
          : tierByAlias.has(modelAlias)
            ? null
            : "alias_absent_from_catalogue";

  if (cause !== null) {
    return {
      modelAlias,
      modelTier: null,
      eligible: true,
      ineligibleReason: null,
      unknownTierReason: UNKNOWN_TIER_SENTENCE[cause](modelAlias),
    };
  }

  const tier = tierByAlias!.get(modelAlias!)!;
  if (restriction === null || restriction.includes(tier)) {
    return { modelAlias, modelTier: tier, eligible: true, ineligibleReason: null, unknownTierReason: null };
  }

  const allowed = restriction.map((t) => TIER_LABEL[t]);
  const allowedSentence = allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(", ")} and ${allowed[allowed.length - 1]}`;
  return {
    modelAlias,
    modelTier: tier,
    eligible: false,
    ineligibleReason:
      `this workflow writes its emails with "${modelAlias}", a ${TIER_LABEL[tier]}-tier model, and a campaign selling ` +
      `"${stepLabel}" performs on the ${allowedSentence} tier${allowed.length === 1 ? "" : "s"} — measured fleet-wide, not assumed`,
    unknownTierReason: null,
  };
}
