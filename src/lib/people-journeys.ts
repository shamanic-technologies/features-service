/**
 * FACTORY-USER-DASHBOARD-1102 (owner 2026-11-02, customer campaign page, GTM Factory "What its people went through"):
 * per step transition a funnel campaign's people made since it started, how many made it and the share of that work
 * each workflow did. PURE; IO in `routes/campaign-milestones.ts` (`/people-journeys`).
 *
 * One rule for every transition: the people = the outcomes of the pipe making it (the spend chart's own count, so
 * this table and the spend charts never disagree); a workflow's share = its share of that pipe's committed spend
 * (`shareBasis: spend`: what each workflow DID on the transition, every pipe kind alike).
 */
export interface JourneyPipe {
  pipeId: string;
  fromStep: string | null;
  toStep: string;
  people: number;
  /** Committed cents per workflow DYNASTY on the pipe's campaign. */
  spendByDynasty: ReadonlyMap<string, number>;
}
export interface JourneyScript {
  workflowDynastySlug: string;
  workflowName: string;
  sharePct: number;
}
export interface JourneyTransition {
  pipeId: string;
  fromStep: string;
  fromLabel: string;
  toStep: string;
  toLabel: string;
  people: number;
  shareBasis: "spend";
  scripts: JourneyScript[];
  /** `no_spend_yet`: the pipe spent nothing yet, so no share can be said. */
  scriptsUnavailableReason: string | null;
}

/** PURE: the transitions in path order (`pipes` already in path order). */
export function peopleJourneysOf(
  pipes: readonly JourneyPipe[],
  labelOf: (step: string) => string,
  nameOf: (dynasty: string) => string,
): JourneyTransition[] {
  return pipes.map((p) => {
    const total = [...p.spendByDynasty.values()].reduce((a, c) => a + c, 0);
    const scripts =
      total > 0
        ? [...p.spendByDynasty]
            .filter(([, c]) => c > 0)
            .map(([slug, c]) => ({ workflowDynastySlug: slug, workflowName: nameOf(slug), sharePct: Math.round((c / total) * 1000) / 10 }))
            .sort((a, b) => b.sharePct - a.sharePct || (a.workflowDynastySlug < b.workflowDynastySlug ? -1 : 1))
        : [];
    const from = p.fromStep ?? "start";
    return {
      pipeId: p.pipeId,
      fromStep: from,
      fromLabel: from === "start" ? "Start" : labelOf(from),
      toStep: p.toStep,
      toLabel: labelOf(p.toStep),
      people: p.people,
      shareBasis: "spend" as const,
      scripts,
      scriptsUnavailableReason: total > 0 ? null : "no_spend_yet",
    };
  });
}
