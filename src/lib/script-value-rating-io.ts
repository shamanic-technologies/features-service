/**
 * THE SCRIPT RATING ON VALUE, IO (SCRIPT-VALUE-RATING-1113; pure rule `script-value-rating.ts`).
 * Two fleet reads of runs-service's outcome chains (rebuilt there every ~15 min; shared here for 10 min through the one
 * ledger read): the one-step rates and every script decision by what its chain reached. FAIL-LOUD: a rating built on a
 * half-read graph would rank scripts on nothing.
 */
import { FLEET_LEDGER_HOLD_MS } from "./outcome-cost-totals-client.js";
import { readRunsLedgerJson } from "./runs-ledger-read.js";
import type { ReachGroup, StepRate } from "./script-value-rating.js";

const STEP_RATES_PATH = "/internal/stats/outcome-chains/step-rates";
const SCRIPT_REACH_PATH = "/internal/stats/outcome-chains/script-reach?groupBy=dynasty";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const count = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`[features-service] outcome chains: ${what} is not a count`);
  return v;
};
const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new Error(`[features-service] outcome chains: ${what} is not text`);
  return v;
};
const texts = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v)) throw new Error(`[features-service] outcome chains: ${what} is not a list`);
  return v.map((x) => text(x, what));
};

/** PURE: the step rates of a runs-service body. */
export function parseStepRates(body: unknown): { builtAt: string; steps: StepRate[] } {
  if (!isRecord(body) || !Array.isArray(body.steps)) throw new Error("[features-service] outcome chains: step-rates served no steps");
  return {
    builtAt: text(body.builtAt, "builtAt"),
    steps: body.steps.map((r) => {
      if (!isRecord(r)) throw new Error("[features-service] outcome chains: a step is not an object");
      return { fromOutcome: text(r.fromOutcome, "fromOutcome"), toOutcome: text(r.toOutcome, "toOutcome"), consumedUnits: count(r.consumedUnits, "consumedUnits"), ledUnits: count(r.ledUnits, "ledUnits") };
    }),
  };
}

/**
 * PURE: the script decisions of a runs-service body. Spend = `costInUsdCents` (billed, the decision and everything under
 * it, a decimal text of cents); a body that does not carry it serves `spentUsd: null` (never 0).
 */
export function parseScriptReach(body: unknown): { builtAt: string; groups: ReachGroup[] } {
  if (!isRecord(body) || !Array.isArray(body.groups)) throw new Error("[features-service] outcome chains: script-reach served no groups");
  return {
    builtAt: text(body.builtAt, "builtAt"),
    groups: body.groups.map((r) => {
      if (!isRecord(r)) throw new Error("[features-service] outcome chains: a group is not an object");
      let spentUsd: number | null = null;
      if (r.costInUsdCents !== undefined && r.costInUsdCents !== null) {
        const cents = typeof r.costInUsdCents === "string" && r.costInUsdCents.trim() !== "" ? Number(r.costInUsdCents) : NaN;
        if (!Number.isFinite(cents) || cents < 0) throw new Error("[features-service] outcome chains: costInUsdCents is not an amount");
        spentUsd = cents / 100;
      }
      return {
        scriptDynasty: text(r.scriptDynasty, "scriptDynasty"),
        day: text(r.day, "day"),
        producedOutcomes: texts(r.producedOutcomes, "producedOutcomes"),
        reachedOutcomes: texts(r.reachedOutcomes, "reachedOutcomes"),
        runs: count(r.runs, "runs"),
        spentUsd,
      };
    }),
  };
}

export async function readOutcomeChains(): Promise<{ builtAt: string; steps: StepRate[]; groups: ReachGroup[] }> {
  const [rates, reach] = await Promise.all([readRunsLedgerJson(STEP_RATES_PATH, FLEET_LEDGER_HOLD_MS), readRunsLedgerJson(SCRIPT_REACH_PATH, FLEET_LEDGER_HOLD_MS)]);
  const s = parseStepRates(rates);
  const g = parseScriptReach(reach);
  return { builtAt: g.builtAt, steps: s.steps, groups: g.groups };
}
