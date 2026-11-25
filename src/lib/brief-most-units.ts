/**
 * THE MOST UNITS A CAMPAIGN'S BRIEF ALLOWS AT ONE ENGINE (owner 2026-11-25, BRIEF-DAILY-CAP-1125; framework v10 §6:
 * « Daily caps in the brief become most Units per day at an Engine. … The verdicts are stored on the campaign. »).
 * PURE: the store is `brief-most-units-store.ts` (`campaign_brief_most_units`), the Jev call `brief-most-units-io.ts`.
 *
 * Per campaign x Engine, the brief judge reads whether the brief states a most number of Units of THAT Engine's outcome
 * per day, week or month, and which number. A brief silent on it = no cap (null), never a default. The cap is on the
 * Engine whose outcome the sentence counts: the judge sees the Engine's outcome in words and its scripts, and a limit
 * counting what another Engine makes is a no here.
 *
 * Jev answers probabilities, a choice or a score, never a free number, and no code reads the brief's text. So the number
 * comes as CHOICES: one yes/no (does the brief state such a limit here), one choice of the period, and one choice per
 * decimal digit of the number (`DIGITS` of them, highest first). The period is kept AS STATED and served with its length
 * in days (`DAYS_OF_PERIOD`): « 3 a week » is 3 Units per 7 days, never a rounded fraction of a day.
 *
 * Stored with the brief it was judged on; re-asked when the brief moves or `MOST_UNITS_RULE` does. No brief = nothing
 * asked, no Jev call (an answer stored before a brief was emptied stands, as a strategy verdict does). Enforcement is
 * the Engine runner's (workflow-service): this only judges and serves. No Engine, outcome, brand or campaign named here.
 */
import type { RunnableScript } from "./script-catalogue-client.js";

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];
/** The length each period is served with: the runner counts the Units made over that many days. */
export const DAYS_OF_PERIOD: Record<Period, number> = { day: 1, week: 7, month: 30 };

/** Decimal digits read: a number up to 99,999 per period. */
export const DIGITS = 5;
/** The brief states a limit from one half up. */
export const STATES_FROM = 0.5;
/** Bump with any change of the questions: every stored answer is re-asked on its next live read. */
export const MOST_UNITS_RULE = "v1";

/** What is served: at most `units` Units of the Engine's outcome per `per` (`days` days). */
export interface MostUnits {
  units: number;
  per: Period;
  days: number;
}

/** One stored answer per campaign x Engine. `units` null = the brief states no limit on this Engine. */
export interface StoredBriefMostUnits {
  campaignId: string;
  outcome: string;
  orgId: string;
  units: number | null;
  per: Period | null;
  /** Jev's probability that the brief states a limit on this Engine's outcome. */
  probability: number;
  /** The weakest confidence among the period and digit choices; null when no limit is stated. */
  confidence: number | null;
  model: string;
  /** The brief the answer was judged on (`briefHashOf`). */
  briefHash: string;
  rule: string;
  judgedAt: string;
}

/**
 * PURE: `stored` = read it; `ask` = Jev; `none` = no brief and nothing stored: no cap, nothing asked. A stored answer
 * stands while its brief and the rule are unchanged; a brief emptied after an answer keeps that answer.
 */
export function briefMostUnitsNeed(stored: Pick<StoredBriefMostUnits, "briefHash" | "rule"> | null, briefHash: string | null): "stored" | "ask" | "none" {
  if (briefHash === null) return stored ? "stored" : "none";
  return stored && stored.briefHash === briefHash && stored.rule === MOST_UNITS_RULE ? "stored" : "ask";
}

/** PURE: what a stored answer serves; null = no cap. */
export function mostUnitsOf(stored: Pick<StoredBriefMostUnits, "units" | "per"> | null | undefined): MostUnits | null {
  if (!stored || stored.units === null || stored.per === null || stored.units < 1) return null;
  return { units: stored.units, per: stored.per, days: DAYS_OF_PERIOD[stored.per] };
}

/** PURE: stored answers as every read-only path takes them: Engine -> its cap (Engines with none are absent). */
export function mostUnitsByEngine(stored: readonly Pick<StoredBriefMostUnits, "outcome" | "units" | "per">[]): Map<string, MostUnits> {
  const out = new Map<string, MostUnits>();
  for (const r of stored) {
    const m = mostUnitsOf(r);
    if (m) out.set(r.outcome, m);
  }
  return out;
}

const PLACE = ["units", "tens", "hundreds", "thousands", "ten-thousands"];
const digitKey = (place: number) => `d${place}`;

const FRAME =
  "A client wrote a BRIEF for one sales campaign, in plain language (in the state). The campaign runs the ENGINE described in the state: " +
  "the scripts that make ONE outcome (`makes`), each with what it does. " +
  "A brief may state a LIMIT on that outcome: the most of it to make per day, per week or per month (« at most one a day », « no more than 20 a week », « 3 per day maximum »). ";

/**
 * PURE: the Jev questions of one Engine, in one call: `states` (noul), `per` (choice of the period), and one choice per
 * decimal digit of the number (`d4`..`d0`, option keys `n0`..`n9`). The answers are mapped back by `mostUnitsOfAnswers`.
 */
export function briefMostUnitsQuestions() {
  const digits = Object.fromEntries(
    Array.from({ length: DIGITS }, (_, i) => DIGITS - 1 - i).map((place) => [
      digitKey(place),
      {
        type: "choice" as const,
        instructions:
          FRAME +
          `Take the number of that limit as a whole number written in figures (« one » or « a » = 1, « twice » = 2, « a dozen » = 12, « 1,200 » = 1200), ` +
          `padded with zeros on the left to ${DIGITS} digits (1 = 00001, 25 = 00025, 1200 = 01200). ` +
          `Pick its ${PLACE[place]} digit: the digit number ${DIGITS - place} from the left of the padded number. ` +
          "When the brief states no such limit on this Engine's outcome, pick 0.",
        criteria: Object.fromEntries(Array.from({ length: 10 }, (_, d) => [`n${d}`, `The ${PLACE[place]} digit is ${d}.`])),
      },
    ]),
  );
  return {
    states: {
      type: "noul" as const,
      instructions:
        "A client wrote a BRIEF for one sales campaign (in the state). The state also names ONE Engine and the single thing it produces (`makes`), with its scripts. " +
        "Question: does the brief cap how many of that exact thing may be produced per day, week or month? " +
        "Answer yes only if (1) the brief contains a maximum per day, week or month, and (2) the thing that maximum counts is the very thing in `makes`. " +
        "If the maximum counts something else, the answer is no, however closely this Engine is related to it: an Engine that prepares, writes for, feeds or follows the thing capped is NOT capped. " +
        "A budget in money, a duration, a goal or wish (« we want 30 a month ») and a total without a period are not maximums.",
    },
    per: {
      type: "choice" as const,
      instructions: FRAME + "Pick the period of the limit the brief states on this Engine's outcome. When it states none, pick day.",
      criteria: {
        day: "The limit is per day (« a day », « daily », « per day », « every day »).",
        week: "The limit is per week (« a week », « weekly », « per week »).",
        month: "The limit is per month (« a month », « monthly », « per month »).",
      },
    },
    ...digits,
  };
}

/**
 * PURE: the state Jev reads: the WHOLE brief, the Engine in words and each runnable script of it with what it does (the
 * strategy judge's own shape).
 */
export function briefMostUnitsState(brief: string, engine: { outcome: string; label: string }, scripts: readonly RunnableScript[]): Record<string, unknown> {
  const own = scripts.filter((s) => s.outcome === engine.outcome).sort((a, b) => (a.dynasty < b.dynasty ? -1 : a.dynasty > b.dynasty ? 1 : 0));
  return { brief, engine: { outcome: engine.outcome, makes: engine.label, scripts: own.map((s) => ({ script: s.dynasty, does: s.description })) } };
}

type Answer = { type?: unknown; noul?: unknown; choice?: unknown; confidence?: unknown } | undefined;

/**
 * PURE: Jev's answers read back into a cap. No limit stated (below one half) = null. A stated limit whose digits read
 * zero is no cap either (a limit of none is not a pace: an Engine a brief wants nothing from is its strategy's matter).
 * Throws on an answer that cannot be read: the caller fails closed, like the strategy judge.
 */
export function mostUnitsOfAnswers(answers: Record<string, Answer> | undefined): Pick<StoredBriefMostUnits, "units" | "per" | "probability" | "confidence"> {
  const states = answers?.states;
  if (states?.type !== "noul" || typeof states.noul !== "number") throw new Error("chat-service answered without a readable probability on whether the brief states a limit");
  if (states.noul < STATES_FROM) return { units: null, per: null, probability: states.noul, confidence: null };
  const per = answers?.per;
  if (per?.type !== "choice" || typeof per.confidence !== "number" || !PERIODS.includes(per.choice as Period)) throw new Error("chat-service answered without a readable period for the limit the brief states");
  let units = 0;
  let confidence = per.confidence;
  for (let place = DIGITS - 1; place >= 0; place -= 1) {
    const a = answers?.[digitKey(place)];
    const digit = a?.type === "choice" && typeof a.choice === "string" && /^n[0-9]$/.test(a.choice) ? Number(a.choice.slice(1)) : null;
    if (digit === null || typeof a?.confidence !== "number") throw new Error(`chat-service answered without a readable ${PLACE[place]} digit for the limit the brief states`);
    units = units * 10 + digit;
    confidence = Math.min(confidence, a.confidence);
  }
  if (units < 1) return { units: null, per: null, probability: states.noul, confidence };
  return { units, per: per.choice as Period, probability: states.noul, confidence };
}
