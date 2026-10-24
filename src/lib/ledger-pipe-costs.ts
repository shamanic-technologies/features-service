/**
 * ONE REGIME FOR EVERY PIPE (owner 2026-10-24, LEDGER-HISTORY-1024: « Ne fait pas de cas particulier dans le code qui
 * ajouteraient de la complexité. Passe tout d'un coup au même régime »; doctrine: agent-config skill `cost-accounting`).
 * Pure.
 *
 * A workflow's price on a pipe, read from runs-service's general ledger, the same way on every channel and leg:
 *   cost(v)     = everything v's runs produced inside the pipe's campaigns (any outcome: leads found, checks, writes,
 *                 sends...) + the spend of v's runs there that produced nothing (normal loss, rule 2)
 *                 + its outcomes × the outcome's own stage run off any campaign (a reply judged on a per-org run)
 *   outcomes(v) = the pipe's outcome produced by v's runs in those campaigns, + the ones produced off any campaign
 *                 whose consumed input v produced in those campaigns (the reply answering v's send); one occurrence
 *                 counts once (the largest count over the inputs it consumed)
 * Inputs bought from OTHER pipes never enter (a lead found by a sourcing pipe is that pipe's price, the funnel adds it:
 * inside a pipe price it would be counted twice). The campaign set IS the grain (fleet, brand, campaign, offer): one
 * function for every grain.
 */

export interface LedgerProducedRow {
  outcomeKey: string;
  campaignId: string | null;
  workflowSlug: string | null;
  /** The producing run's audience (the one its lead was served under); null = none stated. */
  audienceId?: string | null;
  occurrences: number;
  costUsd: number;
}

export interface LedgerNoOutputRow {
  campaignId: string | null;
  workflowSlug: string | null;
  audienceId?: string | null;
  /** Spend of runs that produced nothing, support marks taken out (support is apart by design). */
  costUsd: number;
}

export interface LedgerConsumedRow {
  consumerKey: string;
  consumedKey: string;
  /** The consuming run's campaign and workflow. */
  campaignId: string | null;
  workflowSlug: string | null;
  audienceId?: string | null;
  sourceCampaignId: string | null;
  sourceWorkflowSlug: string | null;
  sourceAudienceId?: string | null;
  count: number;
}

export interface LedgerPipeBook {
  produced: readonly LedgerProducedRow[];
  noOutput: readonly LedgerNoOutputRow[];
  consumed: readonly LedgerConsumedRow[];
}

export interface PipeWorkflowCost {
  workflowSlug: string;
  costUsd: number;
  outcomes: number;
  /** What the pipe worked on: occurrences it consumed from OTHER pipes (the leads a reply pipe wrote to, the replies a
   *  booking pipe took over), the largest count over the input kinds: the conversion rate's denominator. */
  inputs: number;
}

/** USD of one occurrence of `s` spent off any campaign (its own stage, standard cost); 0 when none is declared. */
export function offCampaignUnitCost(s: string, book: LedgerPipeBook): number {
  let cost = 0;
  let n = 0;
  for (const r of book.produced) {
    if (r.outcomeKey !== s || r.campaignId !== null) continue;
    cost += r.costUsd;
    n += r.occurrences;
  }
  return n > 0 ? cost / n : 0;
}

/**
 * PURE. Per workflow version, its cost and outcomes of `s` inside `campaignIds`; `audienceId` narrows to the runs (and
 * the consumed inputs' producing runs) of that audience: the audience is one more grain, the same rule.
 */
export function pipeWorkflowCosts(s: string, campaignIds: ReadonlySet<string>, book: LedgerPipeBook, audienceId?: string): Map<string, PipeWorkflowCost> {
  const inAud = (a: string | null | undefined) => audienceId === undefined || a === audienceId;
  const out = new Map<string, PipeWorkflowCost>();
  const row = (w: string) => {
    const e = out.get(w) ?? { workflowSlug: w, costUsd: 0, outcomes: 0, inputs: 0 };
    out.set(w, e);
    return e;
  };
  for (const r of book.produced) {
    if (!r.campaignId || !r.workflowSlug || !campaignIds.has(r.campaignId) || !inAud(r.audienceId)) continue;
    const e = row(r.workflowSlug);
    e.costUsd += r.costUsd;
    if (r.outcomeKey === s) e.outcomes += r.occurrences;
  }
  for (const r of book.noOutput) {
    if (!r.campaignId || !r.workflowSlug || !campaignIds.has(r.campaignId) || !inAud(r.audienceId)) continue;
    row(r.workflowSlug).costUsd += r.costUsd;
  }
  // off-campaign occurrences of s, credited to the version that produced what they consumed, once per occurrence
  const byInput = new Map<string, Map<string, number>>();
  for (const c of book.consumed) {
    if (c.consumerKey !== s || c.campaignId !== null || !c.sourceCampaignId || !c.sourceWorkflowSlug || !campaignIds.has(c.sourceCampaignId) || !inAud(c.sourceAudienceId)) continue;
    const m = byInput.get(c.sourceWorkflowSlug) ?? new Map<string, number>();
    m.set(c.consumedKey, (m.get(c.consumedKey) ?? 0) + c.count);
    byInput.set(c.sourceWorkflowSlug, m);
  }
  // what each version worked on: inputs its runs in the pipe consumed from outside the pipe
  const inputsBy = new Map<string, Map<string, number>>();
  for (const c of book.consumed) {
    if (!c.campaignId || !c.workflowSlug || !campaignIds.has(c.campaignId) || !inAud(c.audienceId)) continue;
    if (c.sourceCampaignId !== null && campaignIds.has(c.sourceCampaignId)) continue;
    const m = inputsBy.get(c.workflowSlug) ?? new Map<string, number>();
    m.set(c.consumedKey, (m.get(c.consumedKey) ?? 0) + c.count);
    inputsBy.set(c.workflowSlug, m);
  }
  for (const [w, m] of inputsBy) row(w).inputs = Math.max(...m.values());
  const unit = offCampaignUnitCost(s, book);
  for (const [w, m] of byInput) {
    const n = Math.max(...m.values());
    const e = row(w);
    e.outcomes += n;
    e.costUsd += n * unit;
  }
  return out;
}

/** USD per occurrence of every outcome, fleet-wide, on its own production: what an input bought from another pipe costs. */
export function fleetUnitCosts(book: LedgerPipeBook): Map<string, number> {
  const acc = new Map<string, { cost: number; n: number }>();
  for (const r of book.produced) {
    const e = acc.get(r.outcomeKey) ?? { cost: 0, n: 0 };
    e.cost += r.costUsd;
    e.n += r.occurrences;
    acc.set(r.outcomeKey, e);
  }
  return new Map([...acc].filter(([, e]) => e.n > 0).map(([k, e]) => [k, e.cost / e.n]));
}

/**
 * PURE. A leg's per-VERSION evidence (cost groups by `workflowSlug` + per-slug stats) re-stated on the ledger, on COPIES
 * (the inputs come from shared caches): every version's spend = its pipe production (`pipeWorkflowCosts`), its outcome
 * stat (`statKey`) = its outcomes, its contacted = what it worked on. `fed` adds the inputs it bought from other pipes at
 * their fleet unit cost (a money total that pays its sourcing; a pipe's own price never does). A version with spend on
 * the runs side and nothing on the ledger reads $0: on a reconciled ledger that cannot happen, so it is said loud.
 */
export function ledgerSlugEvidence<G extends { dimensions: Record<string, string | null>; totalCostInUsdCents: string; netTotalCostInUsdCents?: string }>(
  costGroups: readonly G[],
  emailStats: ReadonlyMap<string, Record<string, number>>,
  outcomeKey: string,
  statKey: "recipientsRepliesPositive" | "recipientsClicked",
  campaignIds: ReadonlySet<string>,
  book: LedgerPipeBook,
  fed: boolean,
): { costGroups: G[]; emailStats: Map<string, Record<string, number>>; missingOnLedger: string[] } {
  const costs = pipeWorkflowCosts(outcomeKey, campaignIds, book);
  const unit = fed ? fleetUnitCosts(book) : null;
  const inputsUsd = new Map<string, number>();
  if (unit) {
    for (const c of book.consumed) {
      if (!c.campaignId || !c.workflowSlug || !campaignIds.has(c.campaignId)) continue;
      if (c.sourceCampaignId !== null && campaignIds.has(c.sourceCampaignId)) continue;
      inputsUsd.set(c.workflowSlug, (inputsUsd.get(c.workflowSlug) ?? 0) + c.count * (unit.get(c.consumedKey) ?? 0));
    }
  }
  const missingOnLedger: string[] = [];
  const groups = costGroups.map((g) => {
    const slug = g.dimensions.workflowSlug;
    if (!slug || slug === "__total__") return { ...g, dimensions: { ...g.dimensions } };
    const v = costs.get(slug);
    if (!v && Number(g.totalCostInUsdCents) > 0) missingOnLedger.push(slug);
    const cents = (((v?.costUsd ?? 0) + (inputsUsd.get(slug) ?? 0)) * 100).toFixed(10);
    return { ...g, dimensions: { ...g.dimensions }, totalCostInUsdCents: cents, netTotalCostInUsdCents: cents };
  });
  const seen = new Set(costGroups.map((g) => g.dimensions.workflowSlug));
  for (const v of costs.values()) {
    if (seen.has(v.workflowSlug)) continue;
    const cents = ((v.costUsd + (inputsUsd.get(v.workflowSlug) ?? 0)) * 100).toFixed(10);
    groups.push({ dimensions: { workflowSlug: v.workflowSlug }, totalCostInUsdCents: cents, netTotalCostInUsdCents: cents, runCount: 1, minStartedAt: null, maxStartedAt: null } as unknown as G);
  }
  const stats = new Map([...emailStats].map(([k, v]) => [k, { ...v }]));
  for (const slug of new Set([...stats.keys(), ...costs.keys()])) {
    const v = costs.get(slug);
    const st = stats.get(slug) ?? {};
    st[statKey] = v?.outcomes ?? 0;
    st.recipientsContacted = v?.inputs ?? 0;
    stats.set(slug, st);
  }
  return { costGroups: groups, emailStats: stats, missingOnLedger };
}

/**
 * PURE. The AUDIENCE grain on the ledger: per audience of `audienceIds`, per dynasty (`dynastyOf`, a slug's own when
 * unmapped), its pipe cost, what it worked on and its outcomes (`statKey`'s slot), the shape every grain reads.
 */
export function ledgerAudienceEvidence(
  s: string,
  campaignIds: ReadonlySet<string>,
  audienceIds: readonly string[],
  book: LedgerPipeBook,
  dynastyOf: ReadonlyMap<string, string>,
  statKey: "recipientsRepliesPositive" | "recipientsClicked",
): Array<{ audienceId: string; byDynasty: Map<string, { totalCostInUsdCents: number; completedRuns: number; contacted: number; clicks: number; replies: number }> }> {
  return audienceIds.map((audienceId) => {
    const byDynasty = new Map<string, { totalCostInUsdCents: number; completedRuns: number; contacted: number; clicks: number; replies: number }>();
    for (const v of pipeWorkflowCosts(s, campaignIds, book, audienceId).values()) {
      const d = dynastyOf.get(v.workflowSlug) ?? v.workflowSlug;
      const e = byDynasty.get(d) ?? { totalCostInUsdCents: 0, completedRuns: 0, contacted: 0, clicks: 0, replies: 0 };
      e.totalCostInUsdCents += v.costUsd * 100;
      e.completedRuns += 1;
      e.contacted += v.inputs;
      if (statKey === "recipientsClicked") e.clicks += v.outcomes;
      else e.replies += v.outcomes;
      byDynasty.set(d, e);
    }
    return { audienceId, byDynasty };
  });
}
