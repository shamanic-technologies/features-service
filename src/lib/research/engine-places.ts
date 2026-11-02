/**
 * FACTORY-USER-DASHBOARD-1102, Research (owner 2026-11-02: « on adaptera la page Research qui est outdated avec tous les
 * pipes »; GTM Factory Research design): the Engines' picks fleet-wide, read off the stored pass (every live campaign's
 * Engine places, `lib/engine-shadow.ts`) and the 30-day replay. PURE; IO in `routes/factory-shadow.ts`.
 *
 * A PLACE = one outcome as one caller asks for it (the next outcome, or the campaign at its Target) among one set of
 * candidate workflows (campaigns choosing among other workflows are another place). Per place, every
 * candidate workflow with its MEAN share of the Engine's draws and belief over the live campaigns that hold the place;
 * the favourite = the highest mean share, a CLEAR winner when that share is >= 90%. Per outcome, the callers it serves.
 */
import { compareVerdict, type VerdictKind } from "./verdict.js";

export interface StoredEngineCandidate {
  candidateId: string;
  channelName: string;
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
  pickSharePct: number | null;
  rateMeanPct: number | null;
  costPerDecisionMeanUsd: number | null;
  fleetDecisions: number;
  fleetOutcomes: number;
}
export interface StoredEnginePlace {
  outcome: string;
  outcomeName: string;
  consumer: string;
  consumerName: string;
  candidates?: StoredEngineCandidate[];
}
export interface ReplayFamilyLite {
  family?: string;
  outcome: string;
  outcomeName: string;
  todayRegret: number | null;
  engineRegret: number | null;
}

export const CLEAR_WINNER_PCT = 90;

export interface ResearchPlaceCandidate {
  candidateId: string;
  workflowDynastySlug: string;
  workflowName: string;
  channelName: string;
  sharePct: number | null;
  beliefRatePct: number | null;
  costPerDecisionUsd: number | null;
  fleetDecisions: number;
  fleetOutcomes: number;
}
export interface ResearchPlace {
  key: string;
  outcome: string;
  outcomeName: string;
  consumer: string;
  consumerName: string;
  campaigns: number;
  favourite: (ResearchPlaceCandidate & { chancePct: number | null }) | null;
  clearWinner: boolean;
  candidates: ResearchPlaceCandidate[];
}

const mean = (xs: number[]) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100);
const titleOf = (slug: string) => slug.split("-").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");

/** PURE: the research places over the live campaigns' stored Engine places. */
export function researchPlacesOf(placesByCampaign: ReadonlyArray<readonly StoredEnginePlace[]>): ResearchPlace[] {
  const groups = new Map<string, { place: StoredEnginePlace; campaigns: number; byCand: Map<string, StoredEngineCandidate[]> }>();
  for (const places of placesByCampaign)
    for (const p of places) {
      // A place = the same choice: the same outcome for the same caller among the SAME candidates. Campaigns choosing
      // among different workflows (another trigger, another pipe) are different places: pooled, six campaigns each sure
      // of its own Paid client pick read as a 33% "no winner" (2026-11-02).
      const pool = (p.candidates ?? []).map((c) => c.candidateId).sort().join(",");
      const key = `${p.outcome}|${p.consumer}|${pool}`;
      const g = groups.get(key) ?? { place: p, campaigns: 0, byCand: new Map() };
      g.campaigns += 1;
      for (const c of p.candidates ?? []) g.byCand.set(c.candidateId, [...(g.byCand.get(c.candidateId) ?? []), c]);
      groups.set(key, g);
    }
  const out: ResearchPlace[] = [];
  for (const [key, g] of groups) {
    const candidates: ResearchPlaceCandidate[] = [...g.byCand.values()].map((rows) => {
      const c = rows[0]!;
      // A campaign that holds the place but not this candidate gave it no draw: the mean is over every campaign.
      const shares = rows.map((r) => r.pickSharePct ?? 0);
      while (shares.length < g.campaigns) shares.push(0);
      return {
        candidateId: c.candidateId,
        workflowDynastySlug: c.workflowDynastySlug,
        workflowName: c.workflowDynastyName ?? titleOf(c.workflowDynastySlug),
        channelName: c.channelName,
        sharePct: rows.some((r) => r.pickSharePct !== null) ? mean(shares) : null,
        beliefRatePct: mean(rows.flatMap((r) => (r.rateMeanPct === null ? [] : [r.rateMeanPct]))),
        costPerDecisionUsd: mean(rows.flatMap((r) => (r.costPerDecisionMeanUsd === null ? [] : [r.costPerDecisionMeanUsd]))),
        fleetDecisions: Math.max(...rows.map((r) => r.fleetDecisions)),
        fleetOutcomes: Math.max(...rows.map((r) => r.fleetOutcomes)),
      };
    });
    candidates.sort((a, b) => (b.sharePct ?? -1) - (a.sharePct ?? -1) || (a.candidateId < b.candidateId ? -1 : 1));
    const top = candidates[0] && candidates[0].sharePct !== null ? candidates[0] : null;
    out.push({
      key,
      outcome: g.place.outcome,
      outcomeName: g.place.outcomeName,
      consumer: g.place.consumer,
      consumerName: g.place.consumerName,
      campaigns: g.campaigns,
      favourite: top ? { ...top, chancePct: top.sharePct } : null,
      clearWinner: top !== null && (top.sharePct ?? 0) >= CLEAR_WINNER_PCT,
      candidates,
    });
  }
  return out.sort((a, b) => (a.consumerName < b.consumerName ? -1 : a.consumerName > b.consumerName ? 1 : a.outcomeName < b.outcomeName ? -1 : a.outcomeName > b.outcomeName ? 1 : a.key < b.key ? -1 : 1));
}

/** PURE: per outcome Engine, the callers it serves and each caller's favourite (GTM Factory "One Engine, several callers"). */
export function enginesOf(places: readonly ResearchPlace[]) {
  const byOutcome = new Map<string, ResearchPlace[]>();
  for (const p of places) byOutcome.set(p.outcome, [...(byOutcome.get(p.outcome) ?? []), p]);
  return [...byOutcome].map(([outcome, ps]) => ({
    outcome,
    outcomeName: ps[0]!.outcomeName,
    callers: ps.map((p) => ({ consumer: p.consumer, consumerName: p.consumerName, best: p.favourite ? p.favourite.workflowName : null })),
  }));
}

// ── Proposed strategies (GTM Factory "Proposed strategies") ─────────────────────────────────────────


export interface StrategySplit {
  placeKey: string;
  outcomeName: string;
  consumerName: string;
  tacticId: string;
  tacticName: string;
  /** The tactic's own words (what a workflow following it does). */
  tacticDescription: string;
  /** `outcomesPer100Decisions` can pass 100: one decision may make several outcomes (a message per reply). */
  inside: { workflows: number; outcomes: number; decisions: number; outcomesPer100Decisions: number | null };
  outside: { workflows: number; outcomes: number; decisions: number; outcomesPer100Decisions: number | null };
  /** Which side converts better on the fleet evidence. */
  better: "inside" | "outside" | null;
  verdict: VerdictKind;
  reason: string;
  /** Kept as a proposed strategy only on a conclusion (the Research rule). */
  proposed: boolean;
}

/**
 * PURE: per place, every WORKFLOW tactic that splits its candidates in two judged halves (follows it / does not), the
 * fleet outcomes per decision on each side, read by the Research verdict (`lib/research/verdict.ts`, Bonferroni over the
 * place's splits). The client mix cannot be ruled out on this read (no per-client strata), so a split tops out at
 * `signal`: it is PROPOSED only on a conclusion, never on a hunch.
 */
export function strategySplitsOf(
  places: readonly ResearchPlace[],
  tacticsByDynasty: ReadonlyMap<string, ReadonlyMap<string, boolean>>,
  tactics: ReadonlyArray<{ id: string; name: string; description: string; appliesTo?: string }>,
): StrategySplit[] {
  const workflowTactics = tactics.filter((t) => (t.appliesTo ?? "workflow") === "workflow");
  const out: StrategySplit[] = [];
  for (const place of places) {
    const halves = workflowTactics.flatMap((t) => {
      const judged = place.candidates.filter((c) => tacticsByDynasty.get(c.workflowDynastySlug)?.has(t.id));
      const ins = judged.filter((c) => tacticsByDynasty.get(c.workflowDynastySlug)!.get(t.id) === true);
      const outs = judged.filter((c) => tacticsByDynasty.get(c.workflowDynastySlug)!.get(t.id) === false);
      return ins.length > 0 && outs.length > 0 ? [{ t, ins, outs }] : [];
    });
    for (const { t, ins, outs } of halves) {
      const side = (cs: ResearchPlaceCandidate[]) => {
        const outcomes = cs.reduce((a, c) => a + c.fleetOutcomes, 0);
        const decisions = cs.reduce((a, c) => a + c.fleetDecisions, 0);
        return { workflows: cs.length, outcomes, decisions, outcomesPer100Decisions: decisions > 0 ? Math.round((outcomes / decisions) * 10000) / 100 : null };
      };
      const inside = side(ins);
      const outside = side(outs);
      const rIn = inside.decisions > 0 ? inside.outcomes / inside.decisions : -1;
      const rOut = outside.decisions > 0 ? outside.outcomes / outside.decisions : -1;
      const better = rIn < 0 && rOut < 0 ? null : rIn >= rOut ? ("inside" as const) : ("outside" as const);
      const arm = (label: string, s: typeof inside) => ({ label, outcomes: s.outcomes, exposure: s.decisions, spend: 0 });
      const a = better === "outside" ? arm(`Not ${t.name}`, outside) : arm(t.name, inside);
      const b = better === "outside" ? arm(t.name, inside) : arm(`Not ${t.name}`, outside);
      const v = compareVerdict({ a, b, goal: "rate", comparisons: halves.length, strata: null, noun: "outcome", nouns: "outcomes", per: "per decision" });
      out.push({
        placeKey: place.key,
        outcomeName: place.outcomeName,
        consumerName: place.consumerName,
        tacticId: t.id,
        tacticName: t.name,
        tacticDescription: t.description,
        inside,
        outside,
        better,
        verdict: v.kind,
        reason: v.reason,
        proposed: v.kind === "conclusion",
      });
    }
  }
  return out;
}
