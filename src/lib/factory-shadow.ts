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
  funnelRunnable,
  funnelsOfPath,
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
  /** The CATALOGUE sales funnel id carrying the line (what campaign-service runs, `funnelById` resolves it): the whole
   *  funnel, past the Target when the Target is before Paid client. */
  funnelId: string;
  /** The line up to the Target (`funnelIdOf`, a trigger head prefixed `trigger:<id>+`): what two plans are compared on. */
  lineId: string;
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
  /**
   * Why there is no shadow line: `no_runnable_line_to_target`; `pipe_unpriced:<pipe id>` when every line to the Target goes
   * through a pipe with no price yet (a catalogue gap: it ran, no outcome measured, no default or benchmark: nothing to
   * decide on), the pipe every line shares; `no_priced_line_to_target` otherwise.
   */
  shadowUnavailableReason: string | null;
  /** The same in one plain sentence (the pipe by channel and steps); null with a shadow line. */
  shadowUnavailableDetail: string | null;
  /** Every pipe with no price yet that blocks a line to the Target, the most shared first; [] with a shadow line. */
  unpricedPipes: Array<{ pipeId: string; channelName: string; fromStep: string | null; toStep: string; lines: number }>;
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

function lineOf(model: CatalogueModel, legs: readonly FunnelLeg[], target: string, ltrBasis: ExpectedBasis, headTriggerId: string | null, funnelId: string): PlanLine {
  const first = legs[0] ? legStepsOf(model, legs[0].legKey).fromStep : null;
  const parts: string[] = [first === null ? "Start" : stepLabel(model, first)];
  for (const l of legs) parts.push(`[${l.pipe?.channelName ?? "?"}]`, stepLabel(model, legStepsOf(model, l.legKey).toStep));
  return {
    funnelId,
    lineId: `${headTriggerId ? `trigger:${headTriggerId}+` : ""}${funnelIdOf(legs)}`,
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

/**
 * PURE: the catalogue paths a campaign's funnel may walk, with the index of the leg reaching its Target. Proactive: a path
 * from Start no trigger heads. Reactive: a path leaving the campaign's start step, either headed by its trigger (a
 * DECLARED trigger-headed path: the catalogue serves only those) or plain (its funnels then filtered on a first pipe
 * answering the trigger).
 */
export function candidatePaths(model: CatalogueModel, mode: "proactive" | "reactive", startStep: string | null, triggerId: string | null, target: string): Array<{ path: CataloguePath; cut: number }> {
  const out: Array<{ path: CataloguePath; cut: number }> = [];
  for (const path of model.paths.values()) {
    const legs = path.legKeys.map((k) => legStepsOf(model, k));
    if (legs.length === 0) continue;
    if (mode === "proactive") {
      if (path.triggerId || legs[0].fromStep !== null) continue;
    } else {
      if (legs[0].fromStep !== startStep) continue;
      if (path.triggerId && path.triggerId !== triggerId) continue;
    }
    const cut = legs.findIndex((l) => l.toStep === target);
    if (cut >= 0) out.push({ path, cut });
  }
  return out.sort((a, b) => (a.path.id < b.path.id ? -1 : 1));
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

/** PURE: the pipes with no price yet that block the lines (`pipe_unpriced:<id>`), the most shared first. */
function unpricedPipesOf(model: CatalogueModel, lines: readonly PlanLine[]): ShadowPlan["unpricedPipes"] {
  const count = new Map<string, number>();
  for (const l of lines) {
    const ids = new Set(l.figures.legs.filter((g) => g.pipeId && g.costSource === null).map((g) => g.pipeId!));
    for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return [...count.entries()]
    .map(([pipeId, n]) => {
      const p = model.pipes.get(pipeId) ?? model.plays.get(pipeId);
      return { pipeId, channelName: p?.channelName ?? pipeId, fromStep: p?.fromStep ?? null, toStep: p?.toStep ?? "", lines: n };
    })
    .sort((a, b) => b.lines - a.lines || (a.pipeId < b.pipeId ? -1 : 1));
}

/** PURE: the fewest unpriced pipes such that every line goes through one of them (most shared first), or null when a line
 *  is unpriced for another reason (a leg rate, a Target value). */
function coveringPipes(lines: readonly PlanLine[], blocked: ShadowPlan["unpricedPipes"]): ShadowPlan["unpricedPipes"] | null {
  // A line the client's own team works end to end costs us nothing and is no plan of ours: it blocks nothing.
  const ours = lines.filter((l) => l.figures.unavailableReason !== "customer_time_only");
  if (ours.length === 0 || blocked.length === 0) return null;
  const pipesOf = ours.map((l) => new Set(l.figures.legs.filter((g) => g.pipeId && g.costSource === null).map((g) => g.pipeId!)));
  if (pipesOf.some((set) => set.size === 0)) return null;
  const out: ShadowPlan["unpricedPipes"] = [];
  let left = pipesOf;
  for (const b of blocked) {
    if (left.length === 0) break;
    if (!left.some((set) => set.has(b.pipeId))) continue;
    out.push(b);
    left = left.filter((set) => !set.has(b.pipeId));
  }
  return out;
}

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
  /** Pipes (base ids) the brief rules out (the pipe judge): a funnel through one never enters the plan. */
  excludedPipes: ReadonlySet<string> = new Set(),
): ShadowPlan {
  const { running, runningSteps, target, head, triggerId, mode, startStep } = frameOf(model, campaign);

  // The running funnel, priced to the Target on the same basis.
  const end = runningSteps.findIndex((s) => s.toStep === target);
  const runningLine: ShadowPlan["running"] =
    end < 0
      ? { funnelId: running.id, reachesTarget: false, unavailableReason: "running_funnel_does_not_reach_target" }
      : { ...lineOf(model, running.legs.slice(0, end + 1), target, ltrBasis, head, running.id), reachesTarget: true };

  // Every catalogue funnel that can carry the campaign from its start to its Target, runnable today, brief picks applied,
  // priced up to the Target (FACTORY-P1: the plan names a funnel campaign-service can run, never a line the catalogue
  // does not serve: an undeclared trigger head read `unknown_sales_funnel` there).
  const byLine = new Map<string, PlanLine>();
  let setAside = 0;
  let budget = MAX_LINES_PER_CAMPAIGN;
  const allowedByPick = (p: CataloguePipe | null): boolean => {
    if (!p || p.operatedBy !== "platform") return true;
    const pick = picks.get(basePipeIdOf(p));
    return pick === undefined || pick === p.id;
  };
  for (const { path, cut } of candidatePaths(model, mode, startStep, triggerId, target)) {
    if (missingStepsOf(path.steps, offerSteps).length > 0) {
      setAside += 1;
      continue;
    }
    for (const f of funnelsOfPath(model, path)) {
      if (budget <= 0) break;
      if (!funnelRunnable(f)) continue;
      // Proactive: no trigger head and a first pipe that works on its own (a reactive pipe from Start waits on its trigger:
      // Cold WhatsApp on "WhatsApp number given" read as the start of every proactive plan). Reactive: a declared head of
      // the campaign's trigger, or a first pipe answering it.
      if (mode === "proactive" ? f.headTriggerId !== null || f.legs[0]?.pipe?.mode !== "proactive" : !f.headTriggerId && f.legs[0]?.pipe?.triggerId !== triggerId) continue;
      if (!f.legs.every((l) => allowedByPick(l.pipe) && !(l.pipe && excludedPipes.has(basePipeIdOf(l.pipe))))) continue;
      budget -= 1;
      const line = lineOf(model, f.legs.slice(0, cut + 1), target, ltrBasis, f.headTriggerId, f.id);
      // Funnels sharing the line to the Target differ only after it: one stands for them (the running one, else the first).
      const kept = byLine.get(line.lineId);
      if (!kept || (kept.funnelId !== running.id && (f.id === running.id || f.id < kept.funnelId))) byLine.set(line.lineId, line);
    }
  }
  const lines = [...byLine.values()];
  // A valued Target: the best ROI. An unvalued one (after Paid client): the cheapest per Target.
  const rankedOn: ShadowPlan["rankedOn"] = model.steps.get(target)?.valueUsd == null ? "cost_per_target" : "roi";
  lines.sort(rankedOn === "roi" ? byBestLine : byCheapestLine);
  const best = lines[0] ?? null;
  const shadow = best && (rankedOn === "roi" ? best.figures.roi !== null : best.figures.costPerTargetUsd !== null) ? best : null;
  const blocked = shadow ? [] : unpricedPipesOf(model, lines);
  // Every line goes through at least one pipe with no price yet: a catalogue gap. Named by the fewest pipes covering every
  // line (greedy, most shared first): one pipe when every line shares it.
  const blockers = coveringPipes(lines, blocked);
  const shadowUnavailableReason = shadow
    ? null
    : lines.length === 0
      ? "no_runnable_line_to_target"
      : blockers
        ? `pipe_unpriced:${blockers.map((b) => b.pipeId).join(", ")}`
        : "no_priced_line_to_target";
  const step = (k: string | null) => (k === null ? "Start" : stepLabel(model, k));
  const shadowUnavailableDetail = shadow
    ? null
    : lines.length === 0
      ? `No pipe we run today reaches ${step(target)} from ${step(startStep)}.`
      : blockers
        ? `Every line to ${step(target)} goes through ${blockers.map((b) => `${b.channelName} (${step(b.fromStep)} to ${step(b.toStep)})`).join(" or ")}, which ${blockers.length === 1 ? "has" : "have"} no price yet: no outcome measured, no default cost.`
        : `None of the ${lines.length} lines to ${step(target)} can be priced yet${blocked.length > 0 ? `: ${blocked.map((b) => b.channelName).join(", ")} have no price yet` : ""}.`;
  return {
    target,
    targetSource: campaign.target ? "campaign" : "funnel_last_step",
    mode,
    triggerId,
    startStep,
    running: runningLine,
    shadow,
    shadowUnavailableReason,
    shadowUnavailableDetail,
    unpricedPipes: blocked,
    rankedOn,
    planDiffers: shadow && runningLine.reachesTarget ? shadow.lineId !== runningLine.lineId : null,
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

// ── The pipe judge: which channels the brief allows (owner relay 2026-10-29, GTM Factory v10: a channel is a tactic) ──

/**
 * PURE: the pipes the brief judge keeps or rules out for a campaign: every pipe WE run (platform, base pipe: its plays are
 * the play judge's) on any leg of a catalogue path the plan may walk. The client's own team's legs are not ours to rule out.
 */
export function pipeCandidatesOf(model: CatalogueModel, campaign: Pick<ShadowCampaign, "salesFunnelId" | "target" | "mode" | "triggerId">): CataloguePipe[] {
  const f = frameOf(model, campaign);
  const ids = new Set<string>(runningPipesOf(model, campaign.salesFunnelId).keys());
  for (const { path } of candidatePaths(model, f.mode, f.startStep, f.triggerId, f.target))
    for (const k of path.legKeys) for (const p of pipesOnLeg(model, k)) if (p.operatedBy === "platform") ids.add(p.id);
  return [...ids]
    .map((id) => model.pipes.get(id))
    .filter((p): p is CataloguePipe => !!p && p.operatedBy === "platform")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** PURE: the pipe as Jev reads it (channel, its one-line caption, the step it starts from and the one it reaches). */
export function pipeWords(model: CatalogueModel, p: CataloguePipe): string {
  const caption = model.channels.find((c) => c.slug === p.channelSlug)?.shortDescription ?? "";
  const from = p.fromStep === null ? "Start" : stepLabel(model, p.fromStep);
  return withoutDashes(`${p.channelName}${caption ? ` (${caption})` : ""}: moves people from ${from} to ${stepLabel(model, p.toStep)}.`);
}

/** PURE: a fingerprint of what Jev judged a pipe on: its words move it (a re-judge). */
export const pipeSignatureOf = (model: CatalogueModel, p: CataloguePipe): string => sha256(pipeWords(model, p));

/** One stored keep / rule-out verdict on one pipe for one campaign (`factory_pipe_verdicts`). */
export interface PipeVerdict {
  campaignId: string;
  pipeId: string;
  briefHash: string;
  pipeSignature: string;
  /** The brief rules the pipe out (Jev p >= 0.5). */
  excluded: boolean;
  probability: number;
  model: string;
  judgedAt: string;
}

/** PURE: does a stored verdict still answer for this brief and this pipe? */
export const pipeVerdictCurrent = (v: Pick<PipeVerdict, "briefHash" | "pipeSignature"> | null | undefined, briefHash: string, signature: string): boolean =>
  !!v && v.briefHash === briefHash && v.pipeSignature === signature;

/** PURE: the Jev `noul` question for one pipe: yes = the brief rules it out. */
export function pipeQuestion(words: string) {
  return {
    type: "noul" as const,
    instructions:
      `A client wrote a BRIEF for one sales campaign (in the state). Would running this pipe go against the brief? The pipe: ${words} ` +
      "Answer yes when the brief names the channels or the kind of work the campaign uses and this pipe is not one of them, or when the brief rules it out. " +
      "Answer no when the brief names this channel, or says nothing about which channels to use. Judge on the brief's words only.",
    criteria: {
      true: "The brief rules this pipe out: it names other channels or another kind of work, or excludes this one.",
      false: "The brief names this channel, allows it, or says nothing about channels.",
    },
  };
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
    const sentence = playSentenceOf(model, running);
    if (sentence) sentences.push(sentence);
  }
  return { brief: sentences.join("\n"), expected };
}

/** PURE: one pipe's play in one plain line ("On Lead Sourcing (Start to Lead): Valid only. Sends only to ..."), from the
 *  strategy's own description (what Jev reads among the options); null on a pipe with no strategy (its plain default). */
export function playSentenceOf(model: CatalogueModel, running: CataloguePipe): string | null {
  if (!running.play) return null;
  const from = running.fromStep === null ? "Start" : stepLabel(model, running.fromStep);
  return withoutDashes(`On ${running.channelName} (${from} to ${stepLabel(model, running.toStep)}): ${running.play.strategyName}. ${running.play.strategyDescription}`);
}

/** No em or en dash in client copy (owner rule): a dash between words becomes a comma. */
export const withoutDashes = (text: string): string => text.replace(/\s*[\u2014\u2013]\s*/g, ", ");

/**
 * PURE: the brief a funnel campaign is PREFILLED with (owner 2026-10-28, FACTORY-P1-BRIEF-PREFILL): what it runs today, one
 * line per pipe of its running funnel that runs a named strategy, so the judge re-picks the plays running today until the
 * owner edits it. Null when every pipe runs its plain default (nothing to say: an empty brief already picks the defaults).
 */
export function prefillBriefOf(model: CatalogueModel, salesFunnelId: string): string | null {
  const lines = [...runningPipesOf(model, salesFunnelId).values()].map((p) => channelSentenceOf(model, p));
  return lines.length === 0 ? null : ["Use only these channels:", ...lines].join("\n");
}

/**
 * PURE: one pipe of the running funnel in one line of the prefilled brief: the CHANNEL it uses (so the pipe judge keeps the
 * campaign on its channels, owner relay 2026-10-29) and, when it runs a named strategy, that play (the play judge re-picks it).
 */
export function channelSentenceOf(model: CatalogueModel, running: CataloguePipe): string {
  const from = running.fromStep === null ? "Start" : stepLabel(model, running.fromStep);
  const head = `Use ${running.channelName} (${from} to ${stepLabel(model, running.toStep)})`;
  return withoutDashes(running.play ? `${head}: ${running.play.strategyName}. ${running.play.strategyDescription}` : `${head}.`);
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
