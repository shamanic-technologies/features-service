/**
 * GTM FACTORY, STEP 1: THE BRIEF JUDGE AND THE SHADOW PLAN (owner 2026-10-28, FACTORY-P1-BRIEF-JUDGE-SHADOW-PLAN). PURE;
 * the IO lives in `factory-shadow-io.ts`, the store in `factory-shadow-store.ts`.
 *
 * A funnel campaign states its TARGET (a catalogue step) and its BRIEF (its strategy in plain language), both held by
 * campaign-service. Two ideas, served SHADOW ONLY (nothing here changes what a campaign runs):
 *
 * 1. THE BRIEF JUDGE. Per campaign x PIPE, Jev reads the brief and picks one of the pipe's PLAYS (`lib/plays.ts`: pipe x
 *    strategy), or the pipe's DEFAULT play when nothing in the brief bears on it. A pipe with one play, or an empty brief,
 *    is its default play with no Jev call. Each verdict is stored with the brief it read (hash) and the plays it chose
 *    among (signature): re-judged only when either moves.
 *
 * 2. THE SHADOW PLAN. From where the campaign starts (Start when proactive, its trigger's step when reactive) to its
 *    Target, the best-ROI STRAIGHT line of pipes (one pipe or play per leg, the catalogue's funnel rule), respecting the
 *    brief's picks, priced by the DECIDE rule of the cost-accounting doctrine: each pipe's OWN cost per outcome (its best
 *    workflow's, `expectedPipeCost`: measured when mature, else the stated assumption) and each leg's yield (the catalogue
 *    rate), never the every-path ledger. Cost per TARGET = Σ legs cost per outcome x outcomes needed per Target; ROI =
 *    (value of the Target − what the people taken over were already worth) ÷ that cost, the catalogue's funnel formula
 *    (`expectedFunnelEconomics`) with the Target in place of Paid client. The running funnel is priced the same way, so
 *    the two sit side by side on one basis.
 */
import { createHash } from "node:crypto";
import {
  expectedFunnelEconomics,
  funnelById,
  funnelIdOf,
  funnelMixed,
  legStepsOf,
  pipeFeeds,
  pipeRunnable,
  pipesOnLeg,
  playsOfPipe,
  stepLabel,
  type CatalogueModel,
  type CataloguePath,
  type CataloguePipe,
  type ExpectedFunnelLeg,
  type FunnelLeg,
} from "./agent-catalogue.js";
import type { ExpectedBasis } from "./expected-return.js";
import { missingStepsOf, type OfferStepStatement } from "./offer-step-fit.js";
import { STEP_SIGNAL } from "./value-added.js";

// ── The campaign as campaign-service states it ─────────────────────────────────────────────────────

export interface ShadowCampaign {
  id: string;
  orgId: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName: string;
  /** The catalogue step it targets; null = not stated yet (campaign-service: born as the funnel's last step). */
  target: string | null;
  /** Its strategy in plain language; null = none. */
  brief: string | null;
  briefUpdatedAt: string | null;
  /** What it starts from, as campaign-service states it; null = not stated yet (read off the running funnel). */
  mode: "proactive" | "reactive" | null;
  triggerId: string | null;
}

// ── The brief judge ────────────────────────────────────────────────────────────────────────────────

/** One play a pipe may run, as Jev is offered it. */
export interface PlayOption {
  /** The pipe or play id (`<pipe id>` = the default play, `<pipe id>~<strategy>` another). */
  id: string;
  isDefault: boolean;
  name: string;
  /** What Jev reads: the strategy's own description (who the play reaches, how it works). */
  description: string;
}

/** The pipe a play runs on (its own id for a pipe or its default play). */
export const basePipeIdOf = (p: CataloguePipe): string => p.play?.basePipeId ?? p.id;

/**
 * PURE: the plays one pipe may run, default first: the pipe itself (its default play) and every other play that can run
 * today (`pipeRunnable`: a play allowing no workflow is never offered). A customer-team pipe has none of ours to choose.
 */
export function playOptionsOf(model: CatalogueModel, base: CataloguePipe): PlayOption[] {
  if (base.operatedBy !== "platform") return [];
  return playsOfPipe(model, base)
    .filter((p, i) => i === 0 || pipeRunnable(p))
    .map((p, i) => ({
      id: p.id,
      isDefault: i === 0,
      name: p.play ? p.play.strategyName : "Default",
      description: p.play
        ? `${p.play.strategyName}: ${p.play.strategyDescription}`
        : "Every workflow assigned to this pipe, no strategy narrowing who it reaches or how it works.",
    }));
}

/** PURE: a stable fingerprint of what Jev chooses among (ids + descriptions): a play added, retired or reworded moves it. */
export const playsSignatureOf = (options: readonly PlayOption[]): string =>
  sha256(JSON.stringify(options.map((o) => [o.id, o.isDefault, o.description]).sort()));

/** PURE: the fingerprint of the brief judged (trimmed text); null = no brief. */
export const briefHashOf = (brief: string | null): string | null => {
  const t = brief?.trim() ?? "";
  return t === "" ? null : sha256(t);
};

export type JudgmentSource = "jev" | "empty_brief" | "single_play";

/** One stored verdict (`factory_brief_judgments`). */
export interface BriefJudgment {
  campaignId: string;
  basePipeId: string;
  briefHash: string | null;
  playsSignature: string;
  chosenPipeId: string;
  defaultPipeId: string;
  /** Jev's confidence in its choice; null when no Jev call was made (empty brief, single play). */
  confidence: number | null;
  probabilities: Record<string, number> | null;
  model: string | null;
  source: JudgmentSource;
  judgedAt: string;
}

/**
 * PURE: what a pipe of a campaign needs. `stored` = the verdict kept, still valid (same brief, same plays); `default` = no
 * Jev call (empty brief, or one play); `ask` = Jev must judge (never judged, or the brief or the plays moved).
 */
export function judgingNeed(
  stored: Pick<BriefJudgment, "briefHash" | "playsSignature"> | null,
  briefHash: string | null,
  options: readonly PlayOption[],
): { kind: "stored" } | { kind: "default"; source: "empty_brief" | "single_play" } | { kind: "ask" } {
  if (options.length <= 1) return { kind: "default", source: "single_play" };
  if (briefHash === null) return { kind: "default", source: "empty_brief" };
  if (stored && stored.briefHash === briefHash && stored.playsSignature === playsSignatureOf(options)) return { kind: "stored" };
  return { kind: "ask" };
}

/** PURE: the Jev `choice` question for one pipe (option keys `o0..oN`, mapped back by the caller). */
export function briefQuestion(options: readonly PlayOption[]) {
  return {
    type: "choice" as const,
    instructions:
      "A client wrote a BRIEF for one sales campaign, in plain language (in the state). The campaign runs the PIPE described in the state: " +
      "one channel moving people from one step to the next. Each option is a PLAY of that pipe: a strategy deciding who the pipe reaches " +
      "or how it works. Pick the play the brief asks for on this pipe. When nothing in the brief bears on this pipe's choice, pick the option " +
      "marked DEFAULT. Judge on the brief's words only, never on the options' names.",
    criteria: Object.fromEntries(options.map((o, i) => [`o${i}`, `${o.isDefault ? "DEFAULT. " : ""}${o.description}`])),
  };
}

/** PURE: the state Jev reads: the brief and the pipe, in words. */
export function briefState(model: CatalogueModel, base: CataloguePipe, brief: string): Record<string, unknown> {
  return {
    brief,
    pipe: { channel: base.channelName, fromStep: base.fromStep === null ? "Start" : stepLabel(model, base.fromStep), toStep: stepLabel(model, base.toStep) },
  };
}

// ── The shadow plan ────────────────────────────────────────────────────────────────────────────────

/** A path's expected figures to its Target. */
export interface TargetFigures {
  /** What one Target costs to produce on this line (our pipes only; a customer-team leg costs us nothing). */
  costPerTargetUsd: number | null;
  /** (Target value − value of the people taken over) ÷ cost per Target. */
  roi: number | null;
  /** The weakest input it rests on (measured < stated < fleet < default). */
  basis: ExpectedBasis | null;
  unavailableReason: string | null;
  targetValueUsd: number | null;
  legs: ExpectedFunnelLeg[];
}

export interface PlanLine {
  /** The funnel id of the line up to the Target (`funnelIdOf`, a trigger head prefixed `trigger:<id>+`). */
  funnelId: string;
  /** "Start → Lead found → Positive reply" in step labels, the pipe's channel between each two. */
  line: string;
  legs: Array<{ legKey: string; pipeId: string | null; channelSlug: string | null; channelName: string | null; playId: string | null; strategyName: string | null }>;
  figures: TargetFigures;
}

export interface ShadowPlan {
  target: string;
  targetSource: "campaign" | "funnel_last_step";
  mode: "proactive" | "reactive";
  triggerId: string | null;
  /** The step the line starts from (null = Start). */
  startStep: string | null;
  running: (PlanLine & { reachesTarget: true }) | { funnelId: string; reachesTarget: false; unavailableReason: string };
  shadow: PlanLine | null;
  shadowUnavailableReason: string | null;
  /** What the shadow line is the best on: `roi`, or `cost_per_target` when the Target has no value (a step after Paid client). */
  rankedOn: "roi" | "cost_per_target";
  /** Did the shadow line differ from the running one (to the Target)? null when either side is missing. */
  planDiffers: boolean | null;
  /** Straight lines priced to pick from (after the brief's picks and the offer's steps). */
  candidatesPriced: number;
  candidatesSetAside: number;
}

/** Stops a pathological catalogue from spinning a sweep (straight lines priced per campaign). */
export const MAX_LINES_PER_CAMPAIGN = 20_000;

export class ShadowPlanError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = "ShadowPlanError";
  }
}

/** PURE: the value of a person at the step a line takes them over at ($0 from Start / Lead found, `lib/value-added.ts`). */
function takeoverValueOf(model: CatalogueModel, firstFromStep: string | null): number | null {
  return firstFromStep && STEP_SIGNAL[firstFromStep] ? (model.steps.get(firstFromStep)?.valueUsd ?? null) : 0;
}

/** PURE: one line's figures to its Target. */
export function lineFigures(model: CatalogueModel, legs: readonly FunnelLeg[], target: string, ltrBasis: ExpectedBasis): TargetFigures {
  const chain = legs.map((l) => ({ legKey: l.legKey, ...legStepsOf(model, l.legKey) }));
  const path: CataloguePath = {
    id: chain.map((c) => c.legKey).join("+"),
    legKeys: chain.map((c) => c.legKey),
    steps: chain.map((c) => c.toStep),
    type: chain[0]?.fromStep === null || chain[0]?.fromStep === "lead_found" ? "proactive" : "reactive",
    rates: model.ratesOfChain(chain),
  };
  const targetValue = model.steps.get(target)?.valueUsd ?? null;
  // Paid client is worth the offer's lifetime revenue; any earlier step adds the catalogue's default leg rates to it.
  const basis: ExpectedBasis = target === "paid_client" ? ltrBasis : "default";
  // A Target with no value (a step after Paid client: Client Satisfied, owner 2026-10-27, never a made-up share of a
  // client's value) still has a cost per Target; its ROI stays null (`target_unvalued`) and lines rank on cost.
  const e = expectedFunnelEconomics(path, legs, targetValue ?? 1, basis, targetValue === null ? 0 : takeoverValueOf(model, chain[0]?.fromStep ?? null));
  return {
    costPerTargetUsd: e.costUsd,
    roi: targetValue === null ? null : e.roi,
    basis: e.basis,
    unavailableReason: targetValue === null && e.costUsd !== null ? "target_unvalued" : e.unavailableReason,
    targetValueUsd: targetValue,
    legs: e.legs,
  };
}

function lineOf(model: CatalogueModel, legs: readonly FunnelLeg[], target: string, ltrBasis: ExpectedBasis, headTriggerId: string | null): PlanLine {
  const first = legs[0] ? legStepsOf(model, legs[0].legKey).fromStep : null;
  const parts: string[] = [first === null ? "Start" : stepLabel(model, first)];
  for (const l of legs) parts.push(`[${l.pipe?.channelName ?? "?"}]`, stepLabel(model, legStepsOf(model, l.legKey).toStep));
  return {
    funnelId: `${headTriggerId ? `trigger:${headTriggerId}+` : ""}${funnelIdOf(legs)}`,
    line: parts.join(" → "),
    legs: legs.map((l) => ({
      legKey: l.legKey,
      pipeId: l.pipe?.id ?? null,
      channelSlug: l.pipe?.channelSlug ?? null,
      channelName: l.pipe?.channelName ?? null,
      playId: l.pipe?.play ? l.pipe.id : null,
      strategyName: l.pipe?.play?.strategyName ?? null,
    })),
    figures: lineFigures(model, legs, target, ltrBasis),
  };
}

/**
 * PURE: every chain of legs (served leg keys) from where the campaign starts to its Target, cut out of the catalogue's
 * paths (each leg a leg some channel performs). Proactive: from Start. Reactive: from the trigger's step. Deduplicated.
 */
export function chainsToTarget(model: CatalogueModel, mode: "proactive" | "reactive", startStep: string | null, target: string): string[][] {
  const out = new Map<string, string[]>();
  for (const path of model.paths.values()) {
    const legs = path.legKeys.map((k) => legStepsOf(model, k));
    let start: number;
    if (mode === "proactive") {
      if (path.triggerId || legs[0]?.fromStep !== null) continue;
      start = 0;
    } else start = legs.findIndex((l) => l.fromStep === startStep);
    if (start < 0) continue;
    const end = legs.findIndex((l, i) => i >= start && l.toStep === target);
    if (end < 0) continue;
    const chain = path.legKeys.slice(start, end + 1);
    out.set(chain.join("+"), chain);
  }
  return [...out.values()].sort((a, b) => a.length - b.length || a.join("+").localeCompare(b.join("+")));
}

/**
 * PURE: the pipes (or plays) that may work one leg of a line: runnable today, one per leg; the brief's pick narrows a pipe
 * to the play it chose; on a reactive line's first leg only a pipe answering the campaign's trigger, or a proactive pipe
 * the trigger heads (the catalogue's trigger-headed funnel rule).
 */
export function legOptions(
  model: CatalogueModel,
  legKey: string,
  picks: ReadonlyMap<string, string>,
  first: { mode: "proactive" | "reactive"; triggerId: string | null } | null,
): CataloguePipe[] {
  const onLeg = pipesOnLeg(model, legKey);
  const variants = [...model.plays.values()].filter((v) => v.legKey === legKey);
  const platform = [...onLeg.filter((p) => p.operatedBy === "platform"), ...variants].filter((p) => {
    const pick = picks.get(basePipeIdOf(p));
    return pick === undefined || pick === p.id;
  });
  const customer = onLeg.filter((p) => p.operatedBy === "customer").slice(0, 1);
  return [...platform, ...customer]
    .filter(pipeRunnable)
    .filter((p) => {
      if (!first || first.mode === "proactive") return true;
      if (!first.triggerId) return p.mode === "reactive";
      return p.triggerId === first.triggerId || (p.mode === "proactive" && triggerCanHead(model, first.triggerId, p.fromStep));
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * PURE: may this trigger head a line whose first pipe is a proactive one leaving `fromStep`? The catalogue's trigger-headed
 * rule (`triggerHeadRefusal`): an `any_of` trigger (Lead event) stands at every step; any other must name the step the pipe
 * leaves from (a step-less trigger, Follow-up Due or Email Pushed Via API, heads no proactive pipe).
 */
export function triggerCanHead(model: CatalogueModel, triggerId: string, fromStep: string | null): boolean {
  if (model.anyStepTriggers?.has(triggerId)) return true;
  const step = model.triggerSteps.get(triggerId) ?? null;
  return step !== null && step === fromStep;
}

/** PURE: the best line first: priced before unpriced, then highest ROI, then cheapest per Target, then id. */
const byBestLine = (a: PlanLine, b: PlanLine): number => {
  const pa = a.figures.roi !== null && a.figures.costPerTargetUsd !== null;
  const pb = b.figures.roi !== null && b.figures.costPerTargetUsd !== null;
  if (pa !== pb) return pa ? -1 : 1;
  if (pa && pb && a.figures.roi !== b.figures.roi) return b.figures.roi! - a.figures.roi!;
  const ca = a.figures.costPerTargetUsd ?? Infinity;
  const cb = b.figures.costPerTargetUsd ?? Infinity;
  if (ca !== cb) return ca - cb;
  return a.funnelId < b.funnelId ? -1 : a.funnelId > b.funnelId ? 1 : 0;
};

/** PURE: the cheapest line per Target first (an unvalued Target), then id. */
const byCheapestLine = (a: PlanLine, b: PlanLine): number => {
  const ca = a.figures.costPerTargetUsd ?? Infinity;
  const cb = b.figures.costPerTargetUsd ?? Infinity;
  if (ca !== cb) return ca - cb;
  return a.funnelId < b.funnelId ? -1 : a.funnelId > b.funnelId ? 1 : 0;
};

/** PURE: where a campaign starts and what it targets, read off campaign-service's statement, else its running funnel. */
export function frameOf(model: CatalogueModel, campaign: Pick<ShadowCampaign, "salesFunnelId" | "target" | "mode" | "triggerId">) {
  const running = funnelById(model, campaign.salesFunnelId);
  if (!running) throw new ShadowPlanError("running_funnel_unknown", `funnel ${campaign.salesFunnelId} is not in the catalogue`);
  const runningSteps = running.legs.map((l) => legStepsOf(model, l.legKey));
  const target = campaign.target ?? runningSteps[runningSteps.length - 1]?.toStep ?? null;
  if (!target) throw new ShadowPlanError("target_unknown", `funnel ${campaign.salesFunnelId} has no step to target`);
  if (!model.steps.has(target)) throw new ShadowPlanError("target_not_in_catalogue", `target ${target} is not a catalogue step`);
  const head = running.headTriggerId;
  const firstPipe = running.legs[0]?.pipe ?? null;
  const triggerId = campaign.triggerId ?? head ?? (firstPipe?.mode === "reactive" ? firstPipe.triggerId : null);
  const mode: "proactive" | "reactive" = campaign.mode ?? (head || firstPipe?.mode === "reactive" ? "reactive" : "proactive");
  // Where the running funnel starts: Start (null) for every proactive campaign and for a reactive one whose trigger is met
  // at Start (Email Pushed Via API, a WhatsApp number given), else the trigger's step.
  const startStep = mode === "proactive" ? null : (runningSteps[0]?.fromStep ?? null);
  return { running, runningSteps, target, head, triggerId, mode, startStep };
}

/**
 * PURE: one campaign's shadow plan. `picks` = base pipe id -> the play the brief judge chose (absent = unconstrained).
 * `offerSteps` = the offer's stated steps (a line through a step the offer lacks is set aside, campaign-service refuses it).
 * Throws `ShadowPlanError` when the campaign cannot be read at all (its funnel unknown to the catalogue, no target).
 */
export function planCampaign(
  model: CatalogueModel,
  campaign: Pick<ShadowCampaign, "salesFunnelId" | "target" | "mode" | "triggerId">,
  picks: ReadonlyMap<string, string>,
  offerSteps: OfferStepStatement,
  ltrBasis: ExpectedBasis,
): ShadowPlan {
  const { running, runningSteps, target, head, triggerId, mode, startStep } = frameOf(model, campaign);

  // The running funnel, priced to the Target on the same basis.
  const end = runningSteps.findIndex((s) => s.toStep === target);
  const runningLine: ShadowPlan["running"] =
    end < 0
      ? { funnelId: running.id, reachesTarget: false, unavailableReason: "running_funnel_does_not_reach_target" }
      : { ...lineOf(model, running.legs.slice(0, end + 1), target, ltrBasis, head), reachesTarget: true };

  // Every straight line from the start to the Target, one pipe per leg, brief picks applied.
  const lines: PlanLine[] = [];
  let setAside = 0;
  let budget = MAX_LINES_PER_CAMPAIGN;
  const reactiveHead = mode === "reactive" ? triggerId : null;
  for (const chain of chainsToTarget(model, mode, startStep, target)) {
    const steps = chain.map((k) => legStepsOf(model, k).toStep);
    if (missingStepsOf(steps, offerSteps).length > 0) {
      setAside += 1;
      continue;
    }
    const options = chain.map((k, i) => legOptions(model, k, picks, i === 0 ? { mode, triggerId } : null));
    if (options.some((o) => o.length === 0)) continue;
    const walk = (i: number, acc: FunnelLeg[]) => {
      if (budget <= 0) return;
      if (i === chain.length) {
        if (mode === "proactive" && funnelMixed({ legs: acc })) return;
        budget -= 1;
        // A reactive line whose first pipe answers the trigger itself is a plain reactive funnel (no trigger head).
        const headed = reactiveHead && acc[0]?.pipe?.triggerId !== reactiveHead ? reactiveHead : null;
        lines.push(lineOf(model, acc, target, ltrBasis, headed));
        return;
      }
      const before = acc[acc.length - 1]?.pipe;
      for (const p of options[i]) if (!before || pipeFeeds(before, p)) walk(i + 1, [...acc, { legKey: chain[i], pipe: p }]);
    };
    walk(0, []);
  }
  // A valued Target: the best ROI. An unvalued one (after Paid client): the cheapest per Target.
  const rankedOn: ShadowPlan["rankedOn"] = model.steps.get(target)?.valueUsd == null ? "cost_per_target" : "roi";
  lines.sort(rankedOn === "roi" ? byBestLine : byCheapestLine);
  const best = lines[0] ?? null;
  const shadow = best && (rankedOn === "roi" ? best.figures.roi !== null : best.figures.costPerTargetUsd !== null) ? best : null;
  const shadowUnavailableReason = shadow ? null : lines.length === 0 ? "no_runnable_line_to_target" : "no_priced_line_to_target";
  return {
    target,
    targetSource: campaign.target ? "campaign" : "funnel_last_step",
    mode,
    triggerId,
    startStep,
    running: runningLine,
    shadow,
    shadowUnavailableReason,
    rankedOn,
    planDiffers: shadow && runningLine.reachesTarget ? shadow.funnelId !== runningLine.funnelId : null,
    candidatesPriced: lines.length,
    candidatesSetAside: setAside,
  };
}

// ── What runs vs what the brief asks, per pipe ─────────────────────────────────────────────────────

export interface PipePick {
  basePipeId: string;
  channelName: string;
  /** In the running funnel (a pipe of the campaign) or only on a shadow candidate line. */
  inRunningFunnel: boolean;
  runningPipeId: string | null;
  runningPlayName: string | null;
  pickedPipeId: string | null;
  pickedPlayName: string | null;
  confidence: number | null;
  source: JudgmentSource | null;
  /** Jev failed on this pipe (red on Monitoring); null when judged. */
  failure: string | null;
  /** The brief's pick differs from the play running today (only on a pipe of the running funnel). */
  differs: boolean | null;
}

/** PURE: the play name a pipe object runs (its strategy's, else "Default"). */
export const playNameOf = (p: CataloguePipe | null | undefined): string | null => (p ? (p.play ? p.play.strategyName : "Default") : null);

/** PURE: the base pipes of a running funnel's platform legs, each with the pipe/play it runs. */
export function runningPipesOf(model: CatalogueModel, salesFunnelId: string): Map<string, CataloguePipe> {
  const f = funnelById(model, salesFunnelId);
  const out = new Map<string, CataloguePipe>();
  for (const l of f?.legs ?? []) if (l.pipe && l.pipe.operatedBy === "platform") out.set(basePipeIdOf(l.pipe), l.pipe);
  return out;
}

/**
 * PURE: the base pipes the judge must answer for: every pipe of the running funnel and every pipe that may work a leg of a
 * line to the Target, each with at least two plays to choose from (a pipe with one play needs no judge).
 */
export function pipesToJudge(model: CatalogueModel, campaign: Pick<ShadowCampaign, "salesFunnelId" | "target" | "mode" | "triggerId">): CataloguePipe[] {
  const ids = new Set<string>(runningPipesOf(model, campaign.salesFunnelId).keys());
  const f = frameOf(model, campaign);
  for (const chain of chainsToTarget(model, f.mode, f.startStep, f.target))
    for (const k of chain) for (const p of pipesOnLeg(model, k)) if (p.operatedBy === "platform") ids.add(p.id);
  return [...ids]
    .map((id) => model.pipes.get(id))
    .filter((p): p is CataloguePipe => !!p && playOptionsOf(model, p).length >= 2)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ── The eval: a brief written from the plays a campaign runs today ─────────────────────────────────

/**
 * PURE: the brief a campaign would state if it asked exactly for the plays it runs today: one sentence per pipe of the
 * running funnel that has plays to choose from and runs a named strategy ("On Cold Email: Valid only: ..."). A pipe on its
 * plain default (no strategy) adds nothing: the judge must then pick the default.
 */
export function evalBriefOf(model: CatalogueModel, salesFunnelId: string): { brief: string; expected: Map<string, string> } {
  const sentences: string[] = [];
  const expected = new Map<string, string>();
  for (const [baseId, running] of runningPipesOf(model, salesFunnelId)) {
    const base = model.pipes.get(baseId);
    if (!base || playOptionsOf(model, base).length < 2) continue;
    expected.set(baseId, running.id);
    if (running.play) sentences.push(`On ${base.channelName} (${stepLabel(model, base.fromStep ?? "start")} to ${stepLabel(model, base.toStep)}): ${running.play.strategyName}. ${running.play.strategyDescription}`);
  }
  return { brief: sentences.join("\n"), expected };
}

// ── Monitoring: per org, per day ───────────────────────────────────────────────────────────────────

export type ShadowStatus = "ok" | "judge_failed" | "plan_failed";

export interface ShadowRowSummary {
  orgId: string;
  status: ShadowStatus;
  planDiffers: boolean | null;
  pickDiffers: boolean;
}

export interface OrgDayCounts {
  orgId: string;
  campaigns: number;
  planDiffers: number;
  pickDiffers: number;
  /** Campaigns where the plan OR a pick differs from what runs. */
  differs: number;
  judgeFailed: number;
  planFailed: number;
}

/** PURE: one sweep's rows counted per org (sorted by org). */
export function orgDayCountsOf(rows: readonly ShadowRowSummary[]): OrgDayCounts[] {
  const by = new Map<string, OrgDayCounts>();
  for (const r of rows) {
    const c = by.get(r.orgId) ?? { orgId: r.orgId, campaigns: 0, planDiffers: 0, pickDiffers: 0, differs: 0, judgeFailed: 0, planFailed: 0 };
    c.campaigns += 1;
    if (r.planDiffers === true) c.planDiffers += 1;
    if (r.pickDiffers) c.pickDiffers += 1;
    if (r.planDiffers === true || r.pickDiffers) c.differs += 1;
    if (r.status === "judge_failed") c.judgeFailed += 1;
    if (r.status === "plan_failed") c.planFailed += 1;
    by.set(r.orgId, c);
  }
  return [...by.values()].sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
}

/** How often the sweep runs, and how old its last pass may be before Monitoring reads red. */
export const SWEEP_EVERY_MS = 3 * 3_600_000;
export const STALE_AFTER_MS = 2 * SWEEP_EVERY_MS + 3_600_000;

/** PURE: the Monitoring verdict: red when a campaign's judge or plan failed on the last pass, or the last pass is stale. */
export function monitoringVerdict(latest: { sweptAt: string | null; judgeFailed: number; planFailed: number }, now: Date): { red: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (latest.sweptAt === null) reasons.push("never_computed");
  else if (now.getTime() - Date.parse(latest.sweptAt) > STALE_AFTER_MS) reasons.push("last_pass_stale");
  if (latest.judgeFailed > 0) reasons.push("judge_failed");
  if (latest.planFailed > 0) reasons.push("plan_failed");
  return { red: reasons.length > 0, reasons };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
