/**
 * CARRIED VERDICTS THAT NEVER HEAR A NEW STRATEGY, MEASURED (PLAN-RECURSIVE-PER-ENGINE-1124). PURE; route
 * `routes/carried-verdicts.ts`. Changes nothing: `engineStrategyNeed` is untouched.
 *
 * A `carried` row of `campaign_engine_strategies` (the S6 migration, a human-brief rewrite) stands while its brief is
 * unchanged, WHATEVER the Engine's options: a strategy created after it is never offered to its campaign (prod
 * 2026-11-24: our Threads Posts campaign kept "no condition" on Signup until its row was removed by hand, then the judge
 * picked « Through Threads posts » at 0.97). This lists the carried rows whose stored options signature is not today's
 * (or is null): the verdicts that WOULD be re-asked if a carried row were read like a judged one. No Jev call, no write.
 * The opt-in dry judge (`carriedDryRow`, route `?judge=dry`) asks the live judge for those rows and stores nothing.
 *
 * What it cannot see: the campaign's brief TODAY (no campaign-service read). A verdict stored with no brief is listed
 * apart (`briefStatedAtVerdict: false`): a campaign still stating none keeps its verdict under either rule.
 */
import type { PlayCatalogue } from "./plays.js";
import type { RunnableScript } from "./script-catalogue-client.js";
import { NO_CONDITION_OPTION, engineOptionEffect, engineStrategyOptions, optionsSignatureOf, type StoredEngineStrategy } from "./engine-strategy.js";

export interface CarriedVerdictRow {
  campaignId: string;
  orgId: string;
  outcome: string;
  /** The strategy the carried verdict keeps; null = no condition. */
  storedStrategyId: string | null;
  /** Its name; null = no condition, or a strategy the catalogue no longer holds (`storedStrategyKnown` false). */
  storedStrategyName: string | null;
  storedStrategyKnown: boolean;
  carriedFrom: string | null;
  judgedAt: string;
  /** `no_signature_stored` = the row never recorded what it was chosen among; `options_moved` = it did, and they differ today. */
  reason: "no_signature_stored" | "options_moved";
  /** How many options the judge would choose among today, no condition included. */
  optionsToday: number;
  /** Today's options the verdict does not keep (ids; null = no condition). */
  otherOptionsToday: Array<{ strategyId: string | null; name: string }>;
  /** The verdict was stored against a brief (a brief-less campaign keeps its verdict under either rule). */
  briefStatedAtVerdict: boolean;
  /** Re-asked like a judged row, would it reach the judge? False = one option only (kept with no call) or no brief. */
  wouldCallJudge: boolean;
}

export interface CarriedVerdictsReport {
  carriedRows: number;
  carriedCampaigns: number;
  /** Carried rows whose stored signature equals today's: nothing to re-ask. */
  unchangedRows: number;
  wouldReaskRows: number;
  wouldReaskCampaigns: number;
  wouldCallJudgeRows: number;
  rows: CarriedVerdictRow[];
}

/** PURE: every carried verdict a judged-row reading would re-ask, by campaign then Engine. */
export function carriedVerdictsToReask(
  stored: readonly StoredEngineStrategy[],
  scripts: readonly RunnableScript[],
  catalogue: Pick<PlayCatalogue, "strategies" | "tactics" | "tacticsByWriter">,
): CarriedVerdictsReport {
  const carried = stored.filter((r) => r.source === "carried");
  const rows: CarriedVerdictRow[] = [];
  for (const r of carried) {
    // The options the one read (`engineStrategyOfCampaign`) would build for this row: the Engine's, plus the one it holds.
    const options = engineStrategyOptions(r.outcome, scripts, catalogue, r.strategyId ? [r.strategyId] : []);
    if (r.optionsSignature !== null && r.optionsSignature === optionsSignatureOf(options)) continue;
    const held = r.strategyId ? (catalogue.strategies.get(r.strategyId) ?? null) : null;
    const briefStatedAtVerdict = r.briefHash !== null;
    rows.push({
      campaignId: r.campaignId,
      orgId: r.orgId,
      outcome: r.outcome,
      storedStrategyId: r.strategyId,
      storedStrategyName: held?.name ?? null,
      storedStrategyKnown: r.strategyId === null || held !== null,
      carriedFrom: r.carriedFrom,
      judgedAt: r.judgedAt,
      reason: r.optionsSignature === null ? "no_signature_stored" : "options_moved",
      optionsToday: options.length,
      otherOptionsToday: options.filter((o) => o.strategyId !== r.strategyId).map((o) => ({ strategyId: o.strategyId, name: o.name })),
      briefStatedAtVerdict,
      wouldCallJudge: briefStatedAtVerdict && options.length > 1,
    });
  }
  rows.sort((a, b) => a.campaignId.localeCompare(b.campaignId) || a.outcome.localeCompare(b.outcome));
  const reask = rows.filter((x) => x.briefStatedAtVerdict);
  return {
    carriedRows: carried.length,
    carriedCampaigns: new Set(carried.map((r) => r.campaignId)).size,
    unchangedRows: carried.length - rows.length,
    wouldReaskRows: reask.length,
    wouldReaskCampaigns: new Set(reask.map((x) => x.campaignId)).size,
    wouldCallJudgeRows: rows.filter((x) => x.wouldCallJudge).length,
    rows,
  };
}

// ── The opt-in DRY judge (`?judge=dry`): what the judge would keep today, beside the carried verdict. Nothing stored. ──

/** The most judge calls one request may make; more is refused before the first call (never a silent truncation). */
export const DRY_JUDGE_MAX_CALLS = 100;

/** What the dry judge answered for one row: its pick, its failure, or no call because the campaign states no brief today. */
export type DryJudgeAnswer =
  | { kind: "picked"; strategyId: string | null; confidence: number; model: string }
  | { kind: "failed"; error: string }
  | { kind: "no_brief_today" };

export interface CarriedDryRow {
  campaignId: string;
  orgId: string;
  outcome: string;
  /** A unit of the campaign is running today; null = campaign-service lists no unit for it. */
  campaignRunning: boolean | null;
  /** The carried verdict; `strategyId` null = no condition. `name` null = a strategy the catalogue no longer holds. */
  stored: { strategyId: string | null; name: string | null };
  /** What the judge picks today from the campaign's current brief; null = not judged (`status`). */
  dryPick: { strategyId: string | null; name: string | null } | null;
  confidence: number | null;
  model: string | null;
  /** The brief moved since the verdict: the live read re-asks this row at its next run whatever the rule. Null = brief unread. */
  briefMovedSinceVerdict: boolean | null;
  /** `no_brief_today` = no brief: the verdict stands under either rule, no call. `failed` = see `error`, NEVER read as unchanged. */
  status: "judged" | "no_brief_today" | "failed";
  /** The pick is not the stored strategy. Null = unknown (the judge failed). */
  changes: boolean | null;
  /** Script dynasties the Engine keeps under the stored strategy and not under the pick (the runner's rule); null = unknown. */
  stopsBeingKept: string[] | null;
  /** Script dynasties kept under the pick and not under the stored strategy; null = unknown. */
  startsBeingKept: string[] | null;
  error: string | null;
}

const NO_CONDITION_NAME = NO_CONDITION_OPTION.name;

/** PURE: one dry-judged row. Compares what a run keeps (`scriptsKeptByStrategy`, through `engineOptionEffect`) under both. */
export function carriedDryRow(
  row: Pick<CarriedVerdictRow, "campaignId" | "orgId" | "outcome" | "storedStrategyId" | "storedStrategyName" | "storedStrategyKnown">,
  answer: DryJudgeAnswer,
  facts: { running: boolean | null; briefMovedSinceVerdict: boolean | null },
  scripts: readonly RunnableScript[],
  catalogue: Pick<PlayCatalogue, "strategies" | "tactics" | "tacticsByWriter">,
): CarriedDryRow {
  const base = {
    campaignId: row.campaignId,
    orgId: row.orgId,
    outcome: row.outcome,
    campaignRunning: facts.running,
    stored: { strategyId: row.storedStrategyId, name: row.storedStrategyId === null ? NO_CONDITION_NAME : row.storedStrategyName },
  };
  if (answer.kind === "failed") return { ...base, dryPick: null, confidence: null, model: null, briefMovedSinceVerdict: facts.briefMovedSinceVerdict, status: "failed", changes: null, stopsBeingKept: null, startsBeingKept: null, error: answer.error };
  if (answer.kind === "no_brief_today") return { ...base, dryPick: null, confidence: null, model: null, briefMovedSinceVerdict: facts.briefMovedSinceVerdict, status: "no_brief_today", changes: false, stopsBeingKept: [], startsBeingKept: [], error: null };
  const picked = answer.strategyId ? (catalogue.strategies.get(answer.strategyId) ?? null) : null;
  const judged = {
    ...base,
    dryPick: { strategyId: answer.strategyId, name: answer.strategyId === null ? NO_CONDITION_NAME : (picked?.name ?? null) },
    confidence: answer.confidence,
    model: answer.model,
    briefMovedSinceVerdict: facts.briefMovedSinceVerdict,
    status: "judged" as const,
    changes: answer.strategyId !== row.storedStrategyId,
  };
  if (!judged.changes) return { ...judged, stopsBeingKept: [], startsBeingKept: [], error: null };
  // What the stored strategy keeps cannot be read once the catalogue lost it (the live read throws on it).
  if (!row.storedStrategyKnown) return { ...judged, stopsBeingKept: null, startsBeingKept: null, error: "stored_strategy_not_in_catalogue" };
  const before = new Set(engineOptionEffect(row.outcome, scripts, row.storedStrategyId ? catalogue.strategies.get(row.storedStrategyId)! : null, catalogue).runs);
  const after = new Set(engineOptionEffect(row.outcome, scripts, picked, catalogue).runs);
  return { ...judged, stopsBeingKept: [...before].filter((d) => !after.has(d)).sort(), startsBeingKept: [...after].filter((d) => !before.has(d)).sort(), error: null };
}

/** PURE: the dry judge's totals. A failed row is counted apart, in no "changing" nor "unchanged" figure. */
export function carriedDryTotals(rows: readonly CarriedDryRow[]) {
  const changing = rows.filter((r) => r.changes === true);
  return {
    rowsAsked: rows.length,
    rowsJudged: rows.filter((r) => r.status === "judged").length,
    rowsChanging: changing.length,
    campaignsChanging: new Set(changing.map((r) => r.campaignId)).size,
    runningCampaignsChanging: new Set(changing.filter((r) => r.campaignRunning === true).map((r) => r.campaignId)).size,
    rowsFailed: rows.filter((r) => r.status === "failed").length,
    rowsNoBriefToday: rows.filter((r) => r.status === "no_brief_today").length,
  };
}
