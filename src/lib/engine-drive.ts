/**
 * ENGINE-PER-OUTCOME-SWITCH (owner 2026-11-01, GTM Factory v10 "one Engine per outcome"): the LIVE half, one result at a
 * time. PURE; the IO lives in `routes/factory-shadow.ts` (the stored pass writes `engine_drives`) and
 * `routes/workflow-projection.ts` (the leg-keyed read campaign-service runs its rank 1 from).
 *
 * ENGINE-FULL-MIGRATION-1102 (owner 2026-11-02, « mets sur tout partout pour tous les clients, il est temps de migrer
 * fully »): the Engine drives EVERY result of every leg of every live funnel campaign, no hand-over. For each unit
 * campaign the pass records the workflow the Engine picks on that unit's pipe (its tick pick when it is a workflow of the
 * pipe the unit runs; else the pipe's workflow most draws pick: moving to another pipe is the plan's job, never a
 * unit's), and the leg-keyed workflow-projection puts it at rank 1 for that unit. A GUARD reads what the unit did since
 * the switch: once it took `GUARD_DECISIONS` decisions, a cost per outcome worse than the service path's rolls the unit
 * back to the service path (`rolled_back`, red on Monitoring). RECOVERY (`driveStepOf`): a rolled-back unit re-trials
 * the Engine after a cool-down (`RETRY_AFTER_DAYS`, doubled per repeated roll-back up to `RETRY_MAX_DAYS`), or at once
 * when the Engine's pick on its pipe moved to another workflow (a new candidate, the guard judged the old one); the new
 * trial is judged from zero against the cool-down's own service figures.
 */
import { dueShare, type DayCounts, type EnginePlace } from "./engine-shadow.js";

/**
 * DUE decisions a switched unit takes before its guard judges it: decisions weighted by the share of their outcomes
 * already due at their age (`dueShare` over the leg's maturity window). Never raw decisions: on a 21-day positive-reply
 * leg, 57 emails sent this morning owe no reply yet, and "no outcome" read as worse rolled a unit back two hours after its
 * switch (2026-11-02, the classic peeking error of reading an experiment before its outcomes can land).
 */
export const GUARD_DECISIONS = 50;
/** The service path's own cost is read on the unit's last days before the switch. */
export const SERVICE_LOOKBACK_DAYS = 30;
/**
 * A rolled-back unit re-trials the Engine after 14 days (two full weekly cycles: the minimum test length experimentation
 * practice asks for, Kohavi, Tang & Xu, "Trustworthy Online Controlled Experiments", 2020), doubled per repeated roll-back
 * (exponential backoff, the canary / retry consensus) up to 56 days, so a non-stationary arm is re-explored rather than
 * written off forever (Garivier & Moulines 2011, sliding-window / discounted bandits).
 */
export const RETRY_AFTER_DAYS = 14;
export const RETRY_MAX_DAYS = 56;

/** PURE: when a unit rolled back for the `rollBacks`-th time at `rolledBackAt` re-trials the Engine. */
export function retryAtOf(rolledBackAt: string, rollBacks: number): string {
  const days = Math.min(RETRY_MAX_DAYS, RETRY_AFTER_DAYS * 2 ** Math.max(0, rollBacks - 1));
  return new Date(Date.parse(rolledBackAt) + days * 86_400_000).toISOString();
}

/** PURE: the workflow the Engine drives on the pipe a unit runs (null: the place has no Engine pick on that pipe). */
export function drivenDynastyOf(place: EnginePlace, runningBasePipeId: string): { dynasty: string; source: "engine_tick_pick" | "pipe_most_drawn" } | null {
  const onPipe = (id: string) => id.startsWith(`${runningBasePipeId}::`);
  if (place.engine && onPipe(place.engine.candidateId)) return { dynasty: place.engine.workflowDynastySlug, source: "engine_tick_pick" };
  const best = place.candidates
    .filter((c) => onPipe(c.candidateId) && c.pickSharePct !== null)
    .sort((a, b) => (b.pickSharePct ?? 0) - (a.pickSharePct ?? 0) || (a.candidateId < b.candidateId ? -1 : 1))[0];
  return best ? { dynasty: best.workflowDynastySlug, source: "pipe_most_drawn" } : null;
}

export interface DriveGuard {
  /** Decisions, outcomes and spend of the unit since the switch (every workflow it ran). */
  decisions: number;
  /** Of those decisions, the share whose outcomes are due by now (the guard judges once this reaches `GUARD_DECISIONS`). */
  dueDecisions?: number;
  outcomes: number;
  spentUsd: number;
  /** Its cost per outcome since the switch, censored like for like (spend over the outcomes already due); null at 0. */
  costPerOutcomeUsd: number | null;
  /** The service path's cost per outcome: the unit's own before the switch, else the pipe's service workflow's (fleet). */
  serviceCostPerOutcomeUsd: number | null;
  serviceBasis: "unit_before_switch" | "fleet_service_workflow" | null;
  /** `measuring` (< GUARD_DECISIONS due), `holds`, `worse` (roll back), `no_service_figure` (nothing to compare: holds). */
  verdict: "measuring" | "holds" | "worse" | "no_service_figure";
}

const sumDays = (days: readonly DayCounts[], from: string, until: string, countedOnDay: string, maturityDays: number) => {
  let decisions = 0;
  let due = 0;
  let outcomes = 0;
  let spentUsd = 0;
  for (const d of days) {
    if (d.day < from || d.day >= until) continue;
    decisions += d.decisions;
    due += d.decisions * dueShare((Date.parse(`${countedOnDay}T00:00:00Z`) - Date.parse(`${d.day}T00:00:00Z`)) / 86_400_000, maturityDays);
    outcomes += d.outcomes;
    spentUsd += d.spentUsd;
  }
  // Spend over the outcomes already due: an open decision is not yet a failure.
  const cost = outcomes > 0 && decisions > 0 ? (spentUsd * (due / decisions)) / outcomes : null;
  return { decisions, due, outcomes, spentUsd, cost };
};

/**
 * PURE: a switched unit's guard. `unitDays` = the unit's decision days (every workflow), `switchedDay` its switch day,
 * `fleetServiceCost` the service workflow's fleet cost per outcome (the ranking's). Worse = its cost per outcome above
 * the service path's, or no outcome at all, after `GUARD_DECISIONS` decisions.
 */
export function guardOf(
  unitDays: readonly DayCounts[],
  switchedDay: string,
  countedOnDay: string,
  maturityDays: number,
  fleetServiceCost: number | null,
  /** A re-trial's service figure is read on its cool-down only (from the last roll-back day), never on the Engine's days. */
  serviceSinceDay: string | null = null,
  /** The Engine's days end here (a rolled-back unit is re-judged on the days it was driven only). */
  untilDay = "9999-12-31",
): DriveGuard {
  const since = sumDays(unitDays, switchedDay, untilDay, countedOnDay, maturityDays);
  const window = new Date(Date.parse(`${switchedDay}T00:00:00Z`) - SERVICE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const lookback = serviceSinceDay !== null && serviceSinceDay > window ? serviceSinceDay : window;
  const before = sumDays(unitDays, lookback, switchedDay, countedOnDay, maturityDays);
  const service = before.cost !== null ? { cost: before.cost, basis: "unit_before_switch" as const } : fleetServiceCost !== null && fleetServiceCost > 0 ? { cost: fleetServiceCost, basis: "fleet_service_workflow" as const } : null;
  const verdict: DriveGuard["verdict"] =
    since.due < GUARD_DECISIONS ? "measuring" : service === null ? "no_service_figure" : since.cost === null || since.cost > service.cost ? "worse" : "holds";
  const r = (v: number | null) => (v === null ? null : Math.round(v * 10_000) / 10_000);
  return {
    decisions: Math.round(since.decisions * 10) / 10,
    dueDecisions: Math.round(since.due * 10) / 10,
    outcomes: Math.round(since.outcomes * 10) / 10,
    spentUsd: r(since.spentUsd) ?? 0,
    costPerOutcomeUsd: r(since.cost),
    serviceCostPerOutcomeUsd: r(service?.cost ?? null),
    serviceBasis: service?.basis ?? null,
    verdict,
  };
}

/** A drive's guard as stored: the verdict figures plus its roll-back history. */
export type StoredGuard = DriveGuard & {
  outcomeName: string;
  source: string;
  /** Roll-backs this unit took so far (sets its next cool-down). */
  rollBacks?: number;
  /** A rolled-back unit re-trials the Engine at this instant (null while driving). */
  retryAt?: string | null;
  /** The replay family of the unit's pipe (outcome, step consumed, trigger): Monitoring groups drives on it. */
  family?: string;
};

export interface DriveState {
  state: "driving" | "rolled_back";
  workflowDynastySlug: string;
  switchedAt: string;
  rolledBackAt: string | null;
  guard: StoredGuard | null;
}

/**
 * PURE: a unit's next drive. `kept` = its stored drive, `driven` = the Engine's workflow on its pipe now, `guardAt(switchedDay,
 * serviceSinceDay)` its guard. Null = nothing to drive (no Engine pick and nothing stored).
 */
export function driveStepOf(input: {
  kept: DriveState | null;
  driven: { dynasty: string; source: string } | null;
  now: Date;
  outcomeName: string;
  guardAt: (switchedDay: string, serviceSinceDay: string | null, untilDay?: string) => DriveGuard;
}): DriveState | null {
  const { kept, driven, now, outcomeName, guardAt } = input;
  if (!driven && !kept) return null;
  const nowIso = now.toISOString();
  const rollBacks = kept?.guard?.rollBacks ?? (kept?.state === "rolled_back" ? 1 : 0);
  const source = driven?.source ?? kept?.guard?.source ?? "engine_tick_pick";
  if (kept?.state === "rolled_back") {
    // A roll-back the evidence no longer supports is undone (outcomes landed late, or it was judged before any was due):
    // the unit is re-judged on the days it was driven, against the same service figure, and drives on from its switch.
    const rolledBackDay = (kept.rolledBackAt ?? nowIso).slice(0, 10);
    const dayAfter = new Date(Date.parse(`${rolledBackDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const rejudged = guardAt(kept.switchedAt.slice(0, 10), null, dayAfter);
    if (rejudged.verdict !== "worse") {
      const back = Math.max(0, rollBacks - 1);
      return { state: "driving", workflowDynastySlug: driven?.dynasty ?? kept.workflowDynastySlug, switchedAt: kept.switchedAt, rolledBackAt: null, guard: { ...rejudged, outcomeName, source, rollBacks: back, retryAt: null } };
    }
    const retryAt = kept.guard?.retryAt ?? retryAtOf(kept.rolledBackAt ?? kept.switchedAt, rollBacks);
    const newCandidate = driven !== null && driven.dynasty !== kept.workflowDynastySlug;
    if (nowIso < retryAt && !newCandidate) {
      return { ...kept, guard: kept.guard ? { ...kept.guard, outcomeName, rollBacks, retryAt } : null };
    }
    // A new trial: switched now, judged from zero against the cool-down's service path.
    const day = nowIso.slice(0, 10);
    const guard = guardAt(day, (kept.rolledBackAt ?? day).slice(0, 10));
    return {
      state: "driving",
      workflowDynastySlug: driven?.dynasty ?? kept.workflowDynastySlug,
      switchedAt: nowIso,
      rolledBackAt: kept.rolledBackAt,
      guard: { ...guard, outcomeName, source, rollBacks, retryAt: null },
    };
  }
  const switchedAt = kept?.switchedAt ?? nowIso;
  const guard = guardAt(switchedAt.slice(0, 10), kept?.rolledBackAt ? kept.rolledBackAt.slice(0, 10) : null);
  const workflowDynastySlug = driven?.dynasty ?? kept!.workflowDynastySlug;
  if (guard.verdict === "worse") {
    return {
      state: "rolled_back",
      workflowDynastySlug,
      switchedAt,
      rolledBackAt: nowIso,
      guard: { ...guard, outcomeName, source, rollBacks: rollBacks + 1, retryAt: retryAtOf(nowIso, rollBacks + 1) },
    };
  }
  return { state: "driving", workflowDynastySlug, switchedAt, rolledBackAt: kept?.rolledBackAt ?? null, guard: { ...guard, outcomeName, source, rollBacks, retryAt: null } };
}

/** A leg-keyed projection body as far as the drive reads it (priced and unpriced pipes alike). */
interface DrivableBody {
  rows: Array<{ audienceId?: string | null; workflow: { workflowDynastySlug: string }; rank?: number; scopeRank?: number; legAssignment?: { selectable: boolean }; retired?: true }>;
  recommendedWorkflowDynastySlug: string | null;
}

export interface EngineDriveAnswer {
  workflowDynastySlug: string;
  /** False = the Engine's workflow cannot run on this read (not selectable, retired, absent): the service order stands. */
  applied: boolean;
  reason: "not_selectable" | "not_listed" | null;
}

/**
 * PURE: the leg-keyed answer with the Engine's workflow at rank 1 (every other rank shifted after it, their order kept)
 * and named the recommendation, when it can run there; else the body unchanged. `engineDrive` says which.
 */
export function withEngineDrive<B extends DrivableBody>(body: B, dynasty: string): B & { engineDrive: EngineDriveAnswer } {
  const own = body.rows.filter((r) => r.workflow.workflowDynastySlug === dynasty);
  if (own.length === 0) return { ...body, engineDrive: { workflowDynastySlug: dynasty, applied: false, reason: "not_listed" } };
  if (own.some((r) => r.legAssignment?.selectable === false || r.retired === true)) return { ...body, engineDrive: { workflowDynastySlug: dynasty, applied: false, reason: "not_selectable" } };
  const old = own[0]!.rank ?? Number.POSITIVE_INFINITY;
  const rows = body.rows.map((r) => {
    if (r.rank === undefined) return r;
    if (r.workflow.workflowDynastySlug === dynasty) return { ...r, rank: 1 };
    return r.rank < old ? { ...r, rank: r.rank + 1 } : r;
  });
  return { ...body, rows, recommendedWorkflowDynastySlug: dynasty, engineDrive: { workflowDynastySlug: dynasty, applied: true, reason: null } };
}
