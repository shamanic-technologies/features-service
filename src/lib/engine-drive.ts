/**
 * ENGINE-PER-OUTCOME-SWITCH (owner 2026-11-01, GTM Factory v10 "one Engine per outcome"): the LIVE half, one result at a
 * time. PURE; the IO lives in `routes/factory-shadow.ts` (the stored pass writes `engine_drives`) and
 * `routes/workflow-projection.ts` (the leg-keyed read campaign-service runs its rank 1 from).
 *
 * A funnel campaign hands a RESULT to the Engine as data on the campaign (campaign-service `engineOutcomes`). For each
 * of its unit campaigns whose pipe makes that result, the pass records the workflow the Engine picks on that pipe (its
 * tick pick when it is a workflow of the pipe the unit runs; else the pipe's workflow most draws pick: moving to another
 * pipe is the plan's job, never a unit's), and the leg-keyed workflow-projection puts it at rank 1 for that unit. A
 * GUARD reads what the unit did since the switch: once it took `GUARD_DECISIONS` decisions, a cost per outcome worse than
 * the service path's rolls the unit back to the service path (`rolled_back`, red on Monitoring); it stays rolled back
 * until the result is handed back and handed over again.
 */
import { dueShare, type DayCounts, type EnginePlace } from "./engine-shadow.js";

/** Decisions a switched unit takes before its guard judges it. */
export const GUARD_DECISIONS = 50;
/** The service path's own cost is read on the unit's last days before the switch. */
export const SERVICE_LOOKBACK_DAYS = 30;
/** Our brand holds this many days with no roll-back before the fleet may follow (stated, never automatic). */
export const FLEET_AFTER_DAYS = 7;

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
  outcomes: number;
  spentUsd: number;
  /** Its cost per outcome since the switch, censored like for like (spend over the outcomes already due); null at 0. */
  costPerOutcomeUsd: number | null;
  /** The service path's cost per outcome: the unit's own before the switch, else the pipe's service workflow's (fleet). */
  serviceCostPerOutcomeUsd: number | null;
  serviceBasis: "unit_before_switch" | "fleet_service_workflow" | null;
  /** `measuring` (< GUARD_DECISIONS), `holds`, `worse` (roll back), `no_service_figure` (nothing to compare: holds). */
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
  return { decisions, outcomes, spentUsd, cost };
};

/**
 * PURE: a switched unit's guard. `unitDays` = the unit's decision days (every workflow), `switchedDay` its switch day,
 * `fleetServiceCost` the service workflow's fleet cost per outcome (the ranking's). Worse = its cost per outcome above
 * the service path's, or no outcome at all, after `GUARD_DECISIONS` decisions.
 */
export function guardOf(unitDays: readonly DayCounts[], switchedDay: string, countedOnDay: string, maturityDays: number, fleetServiceCost: number | null): DriveGuard {
  const since = sumDays(unitDays, switchedDay, "9999-12-31", countedOnDay, maturityDays);
  const lookback = new Date(Date.parse(`${switchedDay}T00:00:00Z`) - SERVICE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const before = sumDays(unitDays, lookback, switchedDay, countedOnDay, maturityDays);
  const service = before.cost !== null ? { cost: before.cost, basis: "unit_before_switch" as const } : fleetServiceCost !== null && fleetServiceCost > 0 ? { cost: fleetServiceCost, basis: "fleet_service_workflow" as const } : null;
  const verdict: DriveGuard["verdict"] =
    since.decisions < GUARD_DECISIONS ? "measuring" : service === null ? "no_service_figure" : since.cost === null || since.cost > service.cost ? "worse" : "holds";
  const r = (v: number | null) => (v === null ? null : Math.round(v * 10_000) / 10_000);
  return {
    decisions: Math.round(since.decisions * 10) / 10,
    outcomes: Math.round(since.outcomes * 10) / 10,
    spentUsd: r(since.spentUsd) ?? 0,
    costPerOutcomeUsd: r(since.cost),
    serviceCostPerOutcomeUsd: r(service?.cost ?? null),
    serviceBasis: service?.basis ?? null,
    verdict,
  };
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
