/**
 * THE SCRIPT RATING ON VALUE, IO (SCRIPT-VALUE-RATING-1113; pure rule `script-value-rating.ts`).
 * Two fleet reads of runs-service's outcome chains (rebuilt there every ~15 min; shared here for 10 min through the one
 * ledger read): the one-step rates and every script decision by what its chain reached. FAIL-LOUD: a rating built on a
 * half-read graph would rank scripts on nothing.
 */
import { FLEET_LEDGER_HOLD_MS } from "./outcome-cost-totals-client.js";
import { readRunsLedgerJson } from "./runs-ledger-read.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { ReachGroup, ReportedDecision, StepRate } from "./script-value-rating.js";

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

const UNIT_DECISIONS_PATH = "/internal/stats/outcome-chains/unit-decisions";
const UNIT_DECISIONS_BATCH = 500;

export interface ReportedUnit {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  reportedAt: string;
  /** When the thing the client points at was made; null = the Unit standing at the report time. */
  unitAt: string | null;
}

/** PURE: the script decisions of a runs-service unit-decisions body, each once (several Units of one decision = one). */
export function parseUnitDecisions(body: unknown, seen: Set<string>): ReportedDecision[] {
  if (!isRecord(body) || !Array.isArray(body.units)) throw new Error("[features-service] outcome chains: unit-decisions served no units");
  const out: ReportedDecision[] = [];
  for (const u of body.units) {
    if (!isRecord(u)) throw new Error("[features-service] outcome chains: a unit answer is not an object");
    if (u.status !== "script_decision") continue;
    const id = text(u.decisionRunId, "decisionRunId");
    if (seen.has(id)) continue;
    seen.add(id);
    const d = u.decision;
    if (!isRecord(d)) throw new Error("[features-service] outcome chains: a script decision carries no decision");
    const cents = typeof d.costInUsdCents === "string" && d.costInUsdCents.trim() !== "" ? Number(d.costInUsdCents) : NaN;
    if (!Number.isFinite(cents) || cents < 0) throw new Error("[features-service] outcome chains: a decision's costInUsdCents is not an amount");
    out.push({
      scriptDynasty: text(d.scriptSlug, "scriptSlug").replace(/\/v\d+$/, ""),
      day: text(d.day, "day"),
      producedOutcomes: texts(d.producedOutcomes, "producedOutcomes"),
      reachedOutcomes: texts(d.reachedOutcomes, "reachedOutcomes"),
      spentUsd: cents / 100,
    });
  }
  return out;
}

/**
 * The script decision behind each reported Unit (runs-service resolves the Unit standing at the report time). FAIL-LOUD:
 * a report we could not place would read as a good Unit. No report = no call.
 */
export async function readReportedDecisions(units: readonly ReportedUnit[]): Promise<ReportedDecision[]> {
  const seen = new Set<string>();
  const out: ReportedDecision[] = [];
  for (let i = 0; i < units.length; i += UNIT_DECISIONS_BATCH) {
    const batch = units.slice(i, i + UNIT_DECISIONS_BATCH).map((u) => ({ outcomeKey: u.outcomeKey, subjectService: u.subjectService, subjectId: u.subjectId, at: u.unitAt ?? u.reportedAt }));
    const res = await fetchWithRetry(
      `${process.env.RUNS_SERVICE_URL}${UNIT_DECISIONS_PATH}`,
      { method: "POST", headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "", "content-type": "application/json" }, body: JSON.stringify({ units: batch }) },
      { backgroundShare: false },
    );
    if (!res.ok) throw new Error(`[features-service] runs-service ${UNIT_DECISIONS_PATH} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    out.push(...parseUnitDecisions(await res.json(), seen));
  }
  return out;
}

/** PURE: a step-rates body as a book (the denominators of every consumed outcome beside the chained pairs). */
export function parseStepRateBook(body: unknown): { builtAt: string; consumed: Map<string, number>; steps: StepRate[] } {
  const { builtAt, steps } = parseStepRates(body);
  const raw = (body as Record<string, unknown>).consumed;
  if (!Array.isArray(raw)) throw new Error("[features-service] outcome chains: step-rates served no consumed list");
  const consumed = new Map<string, number>();
  for (const c of raw) {
    if (!isRecord(c)) throw new Error("[features-service] outcome chains: a consumed row is not an object");
    consumed.set(text(c.outcome, "outcome"), count(c.consumedUnits, "consumedUnits"));
  }
  return { builtAt, consumed, steps };
}

/** One brand's step-rates book and the fleet's (null brand). Held like every ledger read; FAIL-LOUD. */
export async function readStepRateBook(brandId: string | null): Promise<{ builtAt: string; consumed: Map<string, number>; steps: StepRate[] }> {
  const path = brandId === null ? STEP_RATES_PATH : `${STEP_RATES_PATH}?brandId=${encodeURIComponent(brandId)}`;
  return parseStepRateBook(await readRunsLedgerJson(path, brandId === null ? FLEET_LEDGER_HOLD_MS : 60_000));
}
