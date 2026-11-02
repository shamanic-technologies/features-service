/**
 * FACTORY-USER-DASHBOARD-1102, Research (owner 2026-11-02: « on adaptera la page Research qui est outdated avec tous les
 * pipes »; GTM Factory Research design): the Engines' picks fleet-wide, read off the stored pass (every live campaign's
 * Engine places, `lib/engine-shadow.ts`) and the 30-day replay. PURE; IO in `routes/factory-shadow.ts`.
 *
 * A PLACE = one outcome as one caller asks for it (the next outcome, or the campaign at its Target). Per place, every
 * candidate workflow with its MEAN share of the Engine's draws and belief over the live campaigns that hold the place;
 * the favourite = the highest mean share, a CLEAR winner when that share is >= 90%. Per outcome, the callers it serves.
 */
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
      const key = `${p.outcome}|${p.consumer}`;
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
  return out.sort((a, b) => (a.consumerName < b.consumerName ? -1 : a.consumerName > b.consumerName ? 1 : a.outcomeName < b.outcomeName ? -1 : 1));
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
