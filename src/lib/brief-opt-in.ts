/**
 * A CAMPAIGN'S BRIEF ASKS FOR AN OPT-IN SCRIPT TACTIC (owner 2026-11-24, PLAN-RECURSIVE-PER-ENGINE-1124-SOURCES: « add the
 * instructions in the brief, so the source chosen is filtered by what the user wants »). PURE: the store is
 * `brief-opt-in-store.ts` (`campaign_brief_opt_in_asks`), the Jev call `brief-opt-in-io.ts`.
 *
 * An opt-in script tactic (`Tactic.optIn`, `lib/plays.ts` `optInRefusal`) lets a script in only where the campaign ASKS
 * for it. A campaign keeps ONE strategy per Engine, so a tactic about another matter than that strategy's (where people
 * are found, beside who is found) could never be asked for without one strategy per combination. So the brief asks for
 * it directly: per campaign x Engine x opt-in tactic applying on that Engine (`optInTacticsOnEngine`), Jev answers ONE
 * yes/no question, « does this brief ask for it? » (a brief silent on it = no), stored with the brief and the tactic
 * description it was judged on, re-asked when either moves. Everywhere the opt-in rule is read, what a campaign asks for
 * = the tactics its strategy requires ∪ the tactics its brief asks for.
 *
 * No brief = nothing asked, no Jev call (a campaign stating no brief asks for nothing; answers stored before a brief was
 * emptied stand, as a strategy verdict does). No tactic, Engine, outcome, brand or campaign is named here.
 */
import { writerSubjectKey, type PlayCatalogue, type Tactic } from "./plays.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";

/** One stored answer: does the brief of this campaign ask for this opt-in tactic on this Engine? */
export interface StoredBriefAsk {
  campaignId: string;
  outcome: string;
  tacticId: string;
  orgId: string;
  asks: boolean;
  /** Jev's probability that the brief asks for it. */
  probability: number;
  model: string;
  /** The brief the answer was judged on (`briefHashOf`). */
  briefHash: string;
  /** The tactic description the answer was judged on. */
  judgedDescription: string;
  judgedAt: string;
}

/** A brief asks for a tactic from one half up. */
export const BRIEF_ASKS_FROM = 0.5;

/**
 * MEASURE FIRST: until `BRIEF_OPT_IN_ENFORCE=true`, the answers are judged and STORED but let no script in: every reader
 * sees no ask, as before this file existed. Staff read the stored answers of every running campaign (a wrong yes would
 * run a script for people the client never asked to reach), then the switch goes on and this gate is deleted.
 */
export const briefAsksEnforced = (): boolean => process.env.BRIEF_OPT_IN_ENFORCE === "true";

/**
 * PURE: the opt-in tactics of one Engine whose stored answer no longer stands for this brief: never judged, judged on
 * another brief, or on another description of the tactic. No brief (`briefHash` null) = none: nothing is asked.
 */
export function briefAsksToJudge(optIns: readonly Tactic[], stored: readonly Pick<StoredBriefAsk, "tacticId" | "briefHash" | "judgedDescription">[], briefHash: string | null): Tactic[] {
  if (briefHash === null) return [];
  const byTactic = new Map(stored.map((r) => [r.tacticId, r]));
  return optIns.filter((t) => {
    const r = byTactic.get(t.id);
    return !r || r.briefHash !== briefHash || r.judgedDescription !== t.description;
  });
}

/** PURE: the tactic ids the brief asks for on one Engine, among the opt-in tactics applying there, in id order. */
export function askedByBrief(stored: readonly Pick<StoredBriefAsk, "outcome" | "tacticId" | "asks">[], outcome: string, optIns: readonly Pick<Tactic, "id">[]): string[] {
  if (!briefAsksEnforced()) return [];
  const yes = new Set(stored.filter((r) => r.outcome === outcome && r.asks).map((r) => r.tacticId));
  return optIns.map((t) => t.id).filter((id) => yes.has(id));
}

/**
 * PURE: stored answers as every read-only path takes them: Engine -> the tactic ids its brief asks for. Read as stored
 * (an answer stands until the live read re-asks it); `optInRefusal` only ever looks up tactics that are opt-in today.
 */
export function briefAsksByEngine(stored: readonly Pick<StoredBriefAsk, "outcome" | "tacticId" | "asks">[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!briefAsksEnforced()) return out;
  for (const r of stored) {
    if (!r.asks) continue;
    out.set(r.outcome, (out.get(r.outcome) ?? new Set<string>()).add(r.tacticId));
  }
  return out;
}

/** PURE: the same, per campaign (fleet reads): `<campaign>|<Engine>` -> tactic ids. */
export function briefAsksByCampaignEngine(stored: readonly Pick<StoredBriefAsk, "campaignId" | "outcome" | "tacticId" | "asks">[]): (campaignId: string, outcome: string) => ReadonlySet<string> {
  const out = new Map<string, Set<string>>();
  for (const r of briefAsksEnforced() ? stored : []) {
    if (!r.asks) continue;
    const k = `${r.campaignId}|${r.outcome}`;
    out.set(k, (out.get(k) ?? new Set<string>()).add(r.tacticId));
  }
  return (campaignId, outcome) => out.get(`${campaignId}|${outcome}`) ?? NO_ASK;
}

export const NO_ASK: ReadonlySet<string> = new Set<string>();

/** PURE: the Jev `noul` question for one opt-in tactic. The tactic is shown by its name and description, as catalogued. */
export function briefAsksQuestion(tactic: Pick<Tactic, "name" | "description">) {
  return {
    type: "noul" as const,
    instructions:
      "A client wrote a BRIEF for one sales campaign, in plain language (in the state). The campaign runs the ENGINE described in the state: " +
      "the scripts that make one outcome, each with what it does. Some of these scripts run only for a campaign whose brief asks for them. " +
      `This question is about one such kind of script, "${tactic.name}": ${tactic.description} ` +
      "The state lists which scripts of the Engine are of that kind. " +
      "True when some sentence of the brief asks for it, in the client's own words. False when the brief does not speak of it: " +
      "a brief silent on it does not ask for it, and a brief asking for something else does not either. Judge on the brief's words only.",
  };
}

/** PURE: the question keys of one call (`t0..tN`, in the order asked) mapped back by the caller. */
export const briefAsksQuestions = (tactics: readonly Pick<Tactic, "name" | "description">[]) => Object.fromEntries(tactics.map((t, i) => [`t${i}`, briefAsksQuestion(t)]));

/**
 * PURE: the state Jev reads: the WHOLE brief, the Engine in words, each runnable script of it with what it does, and per
 * tactic asked (by its name) the scripts judged to be of that kind: what a yes lets in.
 */
export function briefAsksState(
  brief: string,
  engine: { outcome: string; label: string },
  tactics: readonly Pick<Tactic, "id" | "name">[],
  scripts: readonly RunnableScript[],
  c: Pick<PlayCatalogue, "tacticsByWriter">,
): Record<string, unknown> {
  const own = scripts.filter((s) => s.outcome === engine.outcome).sort((a, b) => (a.dynasty < b.dynasty ? -1 : a.dynasty > b.dynasty ? 1 : 0));
  return {
    brief,
    engine: {
      outcome: engine.outcome,
      makes: engine.label,
      scripts: own.map((s) => ({ script: s.dynasty, does: s.description })),
      scriptsOfEachKind: Object.fromEntries(tactics.map((t) => [t.name, own.filter((s) => c.tacticsByWriter.get(writerSubjectKey("script", scriptDynastyKey(s)))?.get(t.id) === true).map((s) => s.dynasty)])),
    },
  };
}
