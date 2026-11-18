/**
 * OUTCOME-RUNG-AND-TARGET-1106 follow-up (owner 2026-11-06 via douala-v11: « le QUOI c'est l'outcome, et il doit être
 * toujours aussi fin que possible »; « comment généraliser les pages campaigns dans notre infra usine générique? »): one
 * CARD per milestone of a funnel campaign from Start to its Target, the same figures Today serves for the Target.
 * PURE; IO in `routes/campaign-targets.ts`.
 *
 * WHICH milestones: the steps the campaign's own UNITS produce, on the chain of units from Start to the Target (units are
 * the campaign's for its life; never the plan line). WHAT is counted: the Units the campaign's runs PRODUCED, read from the
 * runs ledger (any outcome: a Threads post published as much as a positive reply), per UTC day. A step no run of the
 * campaign declares counts 0 when a unit of it makes it, and an outcome the ledger lacks altogether (the brand consumed it,
 * no run declared producing it) is NULL with the reason (LEDGER-ONLY-1107, owner 2026-11-07 « ERADICATION »: the campaign's
 * own people count is no basis any more). Never moves with the Plan; only `projection` reads it.
 */
import { projectSchedule, scaleSchedule, type CapacityPausedReason, type ExpectedSchedule } from "./spend-capacity.js";

export interface UnitEdge {
  campaignId: string;
  fromStep: string | null;
  toStep: string;
}

/**
 * PURE. The milestones from Start to the Target along the campaign's units: the shortest chain of units from a unit leaving
 * Start (or a step no unit produces: a trigger head) to the Target; no chain reaches it = the longest walk from the head, then
 * the Target appended. Each milestone names the units landing on it on the chain.
 *
 * CAMPAIGN-CONVERSION-1116 (prod 2026-11-16, Wide Email): a unit landing on the Target straight from Start (a script serving
 * people the campaign already took in, e.g. a follow-up writer on `start_to_paid_client`) is no chain of its own: the walk
 * reads the campaign's OTHER units (Lead found -> Positive reply -> Paid client), and that unit lands on the Target's card
 * beside them. The shortest walk picked it alone: one Paid client card, and a chart "% to Paid client" with nobody entered
 * over 4,157 leads found. A campaign whose every unit jumps Start -> Target keeps that one-step chain.
 */
export function milestoneChainOf(allUnits: readonly UnitEdge[], target: string | null): Array<{ step: string; unitCampaignIds: string[] }> {
  const fromStart = (u: UnitEdge) => u.fromStep === null || u.fromStep === "start";
  const jumps = (u: UnitEdge) => target !== null && fromStart(u) && u.toStep === target;
  const walking = allUnits.filter((u) => !jumps(u));
  const units = walking.length > 0 ? walking : allUnits;
  const produced = new Set(units.map((u) => u.toStep));
  const heads = units.filter((u) => u.fromStep === null || u.fromStep === "start" || !produced.has(u.fromStep));
  // Breadth-first over steps, from every head: the first time the Target is reached is the shortest chain.
  type Node = { step: string; path: string[] };
  const queue: Node[] = [];
  const seen = new Set<string>();
  for (const h of heads) if (!seen.has(h.toStep)) (seen.add(h.toStep), queue.push({ step: h.toStep, path: [h.toStep] }));
  let reached: string[] | null = null;
  let longest: string[] = queue[0]?.path ?? [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (n.path.length > longest.length) longest = n.path;
    if (target !== null && n.step === target) {
      reached = n.path;
      break;
    }
    for (const u of units) if (u.fromStep === n.step && !seen.has(u.toStep)) (seen.add(u.toStep), queue.push({ step: u.toStep, path: [...n.path, u.toStep] }));
  }
  const steps = reached ?? (target !== null && !longest.includes(target) ? [...longest, target] : longest);
  return steps.map((step, i) => {
    const from = i === 0 ? null : steps[i - 1]!;
    const landing = units.filter((u) => u.toStep === step && (i === 0 ? u.fromStep === null || u.fromStep === "start" || !produced.has(u.fromStep) : u.fromStep === from));
    // The units jumping Start -> Target land on the Target's card (left out of the walk only).
    const jumping = units === walking && step === target ? allUnits.filter(jumps) : [];
    return { step, unitCampaignIds: [...landing, ...jumping].map((u) => u.campaignId) };
  });
}

/**
 * PURE (MILESTONES-CONTACTED-1117, owner 2026-11-17 « Ajoute ça »: Wide Email read Lead found 4,157 -> Positive reply 2,
 * the 3,734 people its cold email part reached were nowhere). Between two milestones of the chain, every outcome the units
 * landing on the later one PRODUCED (`producedByUnit`: ledger keys with Units > 0) whose Lifecycle rung (`rankOf`, the
 * outcome rung catalogue) stands STRICTLY between the two milestones' rungs is a milestone of its own, placed before the
 * later one (lowest rung first, then key). The first milestone's lower bound is Start (rank 0). A rung-less outcome
 * (`none`: a message written, an email checked) or one on a milestone's own rung is no milestone; an outcome already
 * counted by a milestone (`counted`) is never counted twice. ONE rule for every campaign: never an outcome or a channel named.
 * `producedBy` = the units that produced it (the units landing on the later milestone); null on a chain milestone.
 */
export function withProducedMilestones(
  chain: ReadonlyArray<{ step: string; unitCampaignIds: string[] }>,
  producedByUnit: ReadonlyMap<string, ReadonlySet<string>>,
  rankOf: (outcomeKey: string) => number | null,
  counted: ReadonlySet<string>,
): Array<{ step: string; unitCampaignIds: string[]; producedBy: string[] | null }> {
  const onChain = new Set(chain.map((m) => m.step));
  const out: Array<{ step: string; unitCampaignIds: string[]; producedBy: string[] | null }> = [];
  chain.forEach((m, i) => {
    const lower = i === 0 ? 0 : rankOf(chain[i - 1]!.step);
    const upper = rankOf(m.step);
    if (lower !== null && upper !== null) {
      const keys = new Set(m.unitCampaignIds.flatMap((id) => [...(producedByUnit.get(id) ?? [])]));
      const between = [...keys]
        .filter((k) => !onChain.has(k) && !counted.has(k))
        .map((k) => ({ k, r: rankOf(k) }))
        .filter((x): x is { k: string; r: number } => x.r !== null && x.r > lower && x.r < upper)
        .sort((a, b) => a.r - b.r || a.k.localeCompare(b.k));
      for (const { k } of between) out.push({ step: k, unitCampaignIds: [], producedBy: [...m.unitCampaignIds] });
    }
    out.push({ step: m.step, unitCampaignIds: m.unitCampaignIds, producedBy: null });
  });
  return out;
}

export interface MilestoneCardInput {
  step: string;
  /** MILESTONES-CONTACTED-1117: an outcome the units landing on the next milestone produced on the way (no unit lands on it). */
  producedOnTheWay?: boolean;
  label: string;
  lifecycleRung: string | null;
  /** Units of this step the campaign's runs produced, per UTC day (ledger); empty when none declared one. */
  ledgerByDay: ReadonlyMap<string, number>;
  /**
   * LEDGER-ONLY-1107: why the ledger cannot count this milestone (`outcome_not_declared_in_ledger`: the brand consumed it,
   * no run declared producing it; `ledger_unreadable`), null = counted from the ledger. Never a people count instead.
   */
  ledgerUnavailableReason: string | null;
  /** What the units landing on this milestone spent (null = unreadable), and what every unit up to it spent. */
  ownSpendUsd: number | null;
  spendUpToUsd: number | null;
  /** The plan line's outcomes of this step needed per one Target (expected); null = the plan does not walk it. */
  neededPerTarget: number | null;
}

export interface MilestoneCard {
  step: string;
  label: string;
  lifecycleRung: string | null;
  isTarget: boolean;
  /** MILESTONES-CONTACTED-1117: produced on the way by the units landing on the next milestone (no unit lands here). */
  producedOnTheWay: boolean;
  count: number | null;
  countSource: "ledger" | null;
  countUnavailableReason: string | null;
  past: Array<{ date: string; outcomes: number; cumulativeOutcomes: number }>;
  pastUnavailableReason: string | null;
  /** The units landing on this milestone: their spend ÷ its count. */
  costPerUnitUsd: number | null;
  costPerUnitUnavailableReason: string | null;
  /** Everything the units up to this milestone spent ÷ its count. */
  costFromStartUsd: number | null;
  costFromStartUnavailableReason: string | null;
  /** Next milestone's count ÷ this one's, × 100; null on the Target or with nothing to divide. */
  conversionToNextPct: number | null;
  conversionToNextUnavailableReason: string | null;
  projection: {
    /** The pace WHILE the campaign spends (PROJECTION-CAP-1117). */
    outcomesPerDay: number | null;
    /** PROJECTION-CAP-1117: why nothing is expected NOW, until `resumesAt`; null = spending. */
    pausedReason: CapacityPausedReason | null;
    resumesAt: string | null;
    daily: Array<{ date: string; expectedOutcomes: number; cumulativeExpectedOutcomes: number }>;
    nextExpectedAt: string | null;
    nextExpectedInHours: number | null;
    unavailableReason: string | null;
  };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** PURE. A cumulative series from per-day counts, one point per day from the first to `today`, gaps filled. */
export function cumulativeFromDaily(byDay: ReadonlyMap<string, number>, today: string): Array<{ date: string; cumulativeOutcomes: number }> {
  const days = [...byDay.keys()].filter((d) => d <= today).sort();
  if (days.length === 0) return [];
  const out: Array<{ date: string; cumulativeOutcomes: number }> = [];
  let acc = 0;
  for (let d = days[0]!; d <= today; d = addDays(d, 1)) out.push({ date: d, cumulativeOutcomes: (acc += byDay.get(d) ?? 0) });
  return out;
}

/**
 * PURE. Every milestone's card. `targetSchedule` = the Target's expected schedule (Today's projection: the plan's cost per
 * Target × the campaign's spend per day, under its spend capacity, PROJECTION-CAP-1117); a milestone's = that × its outcomes
 * needed per Target (the plan line).
 */
export function milestoneCardsOf(input: {
  milestones: readonly MilestoneCardInput[];
  targetSchedule: ExpectedSchedule | null;
  targetProjectionUnavailableReason: string | null;
  projectionDays: number;
  now: string;
}): MilestoneCard[] {
  const today = input.now.slice(0, 10);
  const counted = input.milestones.map((m) => {
    const ledgerTotal = [...m.ledgerByDay.values()].reduce((a, n) => a + n, 0);
    if (ledgerTotal > 0) return { count: ledgerTotal, source: "ledger" as const, series: cumulativeFromDaily(m.ledgerByDay, today), reason: null };
    if (m.ledgerUnavailableReason !== null) return { count: null, source: null, series: null, reason: m.ledgerUnavailableReason };
    // The ledger is readable, a producer declares this outcome, and it saw none on this campaign: a MEASURED zero, whether
    // or not the campaign spends on a unit making it (FORECAST-FRESH-EVIDENCE-1118: a late Unit declared on a run naming no
    // campaign is credited through the ledger's links, so a step the client's own team makes is counted too; the card read
    // no count beside « 0 of 106 people went on to Paid client » on the same page).
    return { count: 0, source: "ledger" as const, series: [], reason: null };
  });
  return input.milestones.map((m, i) => {
    const c = counted[i]!;
    const isTarget = i === input.milestones.length - 1;
    let prev = 0;
    const past = (c.series ?? []).map((p) => {
      const outcomes = p.cumulativeOutcomes - prev;
      prev = p.cumulativeOutcomes;
      return { date: p.date, outcomes, cumulativeOutcomes: p.cumulativeOutcomes };
    });
    const per = (spend: number | null): [number | null, string | null] =>
      c.count === null ? [null, "not_counted_for_this_campaign"] : spend === null ? [null, "spend_unreadable"] : spend <= 0 ? [null, "no_spend_on_this_milestone"] : c.count === 0 ? [null, "no_unit_yet"] : [round(spend / c.count, 4), null];
    const [costPerUnitUsd, costPerUnitUnavailableReason] = per(m.ownSpendUsd);
    const [costFromStartUsd, costFromStartUnavailableReason] = per(m.spendUpToUsd);
    const next = counted[i + 1];
    const conversionToNextPct = !isTarget && next && next.count !== null && c.count !== null && c.count > 0 ? round((next.count / c.count) * 100, 2) : null;
    const conversionToNextUnavailableReason = conversionToNextPct !== null ? null : isTarget ? "target" : c.count === 0 ? "no_unit_yet" : "not_counted_for_this_campaign";
    const ts = input.targetSchedule;
    const schedule = ts === null ? null : isTarget ? ts : m.neededPerTarget !== null ? scaleSchedule(ts, m.neededPerTarget) : null;
    const pace = schedule?.outcomesPerDayWhenSpending ?? null;
    const projectionReason = schedule !== null ? null : ts === null ? input.targetProjectionUnavailableReason ?? "no_projection" : "not_on_current_plan";
    const { daily, nextExpectedAt, nextExpectedInHours } = projectSchedule(schedule !== null && pace! > 0 ? schedule : null, c.count, input.now, input.projectionDays);
    return {
      step: m.step,
      label: m.label,
      lifecycleRung: m.lifecycleRung,
      isTarget,
      producedOnTheWay: m.producedOnTheWay === true,
      count: c.count,
      countSource: c.source,
      countUnavailableReason: c.count === null ? c.reason ?? "not_counted_for_this_campaign" : null,
      past,
      pastUnavailableReason: c.series === null ? (c.count === null ? "not_counted_for_this_campaign" : "not_dated_for_this_campaign") : null,
      costPerUnitUsd,
      costPerUnitUnavailableReason,
      costFromStartUsd,
      costFromStartUnavailableReason,
      conversionToNextPct,
      conversionToNextUnavailableReason,
      projection: {
        outcomesPerDay: pace !== null ? round(pace, 4) : null,
        pausedReason: schedule?.pausedReason ?? null,
        resumesAt: schedule?.resumesAt ?? null,
        daily,
        nextExpectedAt,
        nextExpectedInHours,
        unavailableReason: projectionReason,
      },
    };
  });
}
