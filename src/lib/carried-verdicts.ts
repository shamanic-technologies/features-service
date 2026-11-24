/**
 * CARRIED VERDICTS THAT NEVER HEAR A NEW STRATEGY, MEASURED (PLAN-RECURSIVE-PER-ENGINE-1124). PURE; route
 * `routes/carried-verdicts.ts`. Changes nothing: `engineStrategyNeed` is untouched.
 *
 * A `carried` row of `campaign_engine_strategies` (the S6 migration, a human-brief rewrite) stands while its brief is
 * unchanged, WHATEVER the Engine's options: a strategy created after it is never offered to its campaign (prod
 * 2026-11-24: our Threads Posts campaign kept "no condition" on Signup until its row was removed by hand, then the judge
 * picked « Through Threads posts » at 0.97). This lists the carried rows whose stored options signature is not today's
 * (or is null): the verdicts that WOULD be re-asked if a carried row were read like a judged one. No Jev call, no write.
 *
 * What it cannot see: the campaign's brief TODAY (no campaign-service read). A verdict stored with no brief is listed
 * apart (`briefStatedAtVerdict: false`): a campaign still stating none keeps its verdict under either rule.
 */
import type { PlayCatalogue } from "./plays.js";
import type { RunnableScript } from "./script-catalogue-client.js";
import { engineStrategyOptions, optionsSignatureOf, type StoredEngineStrategy } from "./engine-strategy.js";

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
