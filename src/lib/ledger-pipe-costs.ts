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
  /** UTC day the declaring run started (the daily book only, `loadDailyLedgerBook`). */
  runStartDay?: string | null;
  /** The stored script the declaring run works for (`<outcome>/<dynasty>/v<version>`, runs-service 0111; daily book only). */
  scriptSlug?: string | null;
}

export interface LedgerNoOutputRow {
  campaignId: string | null;
  workflowSlug: string | null;
  audienceId?: string | null;
  /** Spend of runs that produced nothing, support marks taken out (support is apart by design). */
  costUsd: number;
  runStartDay?: string | null;
  scriptSlug?: string | null;
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
  /** UTC day the consuming run started, and the day the run that produced the consumed occurrence started (daily book only). */
  runStartDay?: string | null;
  sourceRunStartDay?: string | null;
  /** The consuming run's script, and the script of the run that produced the consumed occurrence (daily book only). */
  scriptSlug?: string | null;
  sourceScriptSlug?: string | null;
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

/**
 * USD of one occurrence of `s` made by a run of NO workflow (its own stage, standard cost): off any campaign, or inside one
 * (since 2026-10-23 the reply judge runs under the campaign it answers, with no workflow); 0 when none is declared.
 */
export function offCampaignUnitCost(s: string, book: LedgerPipeBook): number {
  let cost = 0;
  let n = 0;
  for (const r of book.produced) {
    if (r.outcomeKey !== s || (r.campaignId !== null && r.workflowSlug !== null)) continue;
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
  // occurrences of s made by a run of no workflow (off campaign, or the reply judge under the campaign it answers since
  // 2026-10-23: dropped before, ENGINE-PER-OUTCOME-SHADOW), credited to the version that produced what they consumed
  const byInput = new Map<string, Map<string, number>>();
  for (const c of book.consumed) {
    if (c.consumerKey !== s || c.workflowSlug !== null || !c.sourceCampaignId || !c.sourceWorkflowSlug || !campaignIds.has(c.sourceCampaignId) || !inAud(c.sourceAudienceId)) continue;
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

/**
 * The SCRIPTS of a pipe, pooled (MON-SCRIPT-PRICES-1111). Since MIGRATE-1105 a campaign runs its Engine's stored scripts
 * with NO workflow (workflow-service names the run `script:<outcome>/<dynasty>` and sends no `x-workflow-slug`), so every
 * row of a pipe's campaigns carries `workflowSlug: null` and `pipeWorkflowCosts` (per workflow) priced nothing: every
 * pipe read borrowed or expected. runs-service states no script per row yet, so the pipe's script runs are ONE pool, the
 * pipe's own production on what runs now, the same rule as a workflow's:
 *   cost     = every no-workflow row inside the pipe's campaigns (any outcome) + their runs that produced nothing
 *              + the pipe's outcomes judged OUTSIDE its campaigns (a reply judged on a per-org run) at that stage's own
 *              unit cost (`offCampaignUnitCost`)
 *   outcomes = the pipe's outcome made inside its campaigns by a no-workflow run, + the ones made outside whose consumed
 *              input a no-workflow run of the pipe made (counted once: the largest count over the inputs)
 *   inputs   = what those runs consumed from outside the pipe's campaigns (the largest count over the input kinds)
 * An outcome a no-workflow run made inside the campaigns whose input a WORKFLOW made is that workflow's (the reply judge
 * ran under the campaign with no workflow since 2026-10-23, `pipeWorkflowCosts` credits it to the workflow at the stage
 * unit cost): it leaves the pool at that same cost, never counted twice. `cutDay` = the mature cohort (runs started on or
 * before it; an outcome counts when the input it consumed was made by such a run): the daily book only (`runStartDay`).
 * Null when the pool holds nothing.
 */
export const SCRIPT_POOL = "scripts";

export function pipeScriptCost(s: string, campaignIds: ReadonlySet<string>, book: LedgerPipeBook, cutDay?: string): PipeWorkflowCost | null {
  const ran = (day: string | null | undefined) => cutDay === undefined || (day != null && day <= cutDay);
  const inSet = (c: string | null) => c !== null && campaignIds.has(c);
  let costUsd = 0;
  let made = 0;
  let any = false;
  for (const r of book.produced) {
    if (r.workflowSlug !== null || !inSet(r.campaignId) || !ran(r.runStartDay)) continue;
    any = true;
    costUsd += r.costUsd;
    if (r.outcomeKey === s && cutDay === undefined) made += r.occurrences;
  }
  for (const r of book.noOutput) {
    if (r.workflowSlug !== null || !inSet(r.campaignId) || !ran(r.runStartDay)) continue;
    any = true;
    costUsd += r.costUsd;
  }
  // per consumed kind: inputs from outside, outcomes credited from outside, a workflow's outcomes to hand back, and
  // (mature cohort) the pool's own outcomes by the day their input was made
  const inputs = new Map<string, number>();
  const offSet = new Map<string, number>();
  const toWorkflows = new Map<string, number>();
  const madeByInput = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const c of book.consumed) {
    const poolRun = c.workflowSlug === null && inSet(c.campaignId);
    if (poolRun && ran(c.runStartDay) && !inSet(c.sourceCampaignId)) add(inputs, c.consumedKey, c.count);
    if (c.consumerKey !== s || c.workflowSlug !== null) continue;
    if (poolRun && c.sourceWorkflowSlug !== null && inSet(c.sourceCampaignId)) {
      if (ran(c.runStartDay)) add(toWorkflows, c.consumedKey, c.count);
    } else if (poolRun) {
      if (cutDay !== undefined && ran(c.sourceRunStartDay)) add(madeByInput, c.consumedKey, c.count);
    } else if (c.sourceWorkflowSlug === null && inSet(c.sourceCampaignId) && ran(cutDay === undefined ? c.runStartDay : c.sourceRunStartDay)) {
      add(offSet, c.consumedKey, c.count);
    }
  }
  const most = (m: Map<string, number>) => (m.size > 0 ? Math.max(...m.values()) : 0);
  const unit = offCampaignUnitCost(s, book);
  const handedBack = most(toWorkflows);
  const credited = most(offSet);
  if (!any && credited === 0) return null;
  const outcomes = (cutDay === undefined ? Math.max(made - handedBack, 0) : most(madeByInput)) + credited;
  return { workflowSlug: SCRIPT_POOL, costUsd: Math.max(costUsd - handedBack * unit, 0) + credited * unit, outcomes, inputs: most(inputs) };
}

/** PURE. The script DYNASTY a stored script's name belongs to (`<outcome>/<dynasty>`, the key its verdicts and the Rating
 *  use; `scriptDynastyKey`): its versions pool, like a workflow's. A run of no script = the pool of unnamed runs. */
export function scriptDynastyOfSlug(slug: string | null | undefined): string {
  if (!slug) return SCRIPT_POOL;
  const m = /^(.+)\/v\d+$/.exec(slug);
  return m ? m[1]! : slug;
}

/**
 * Each SCRIPT of a pipe, measured apart (MON-SCRIPT-PRICES-2-1111): runs-service names the script every run works for
 * (`scriptSlug`, the outermost script of its chain), so the pool above splits per script dynasty (`keyOf`, default
 * `scriptDynastyOfSlug`; pass the identity for one figure per VERSION). The same rule, per script K:
 *   cost     = K's no-workflow rows inside the pipe's campaigns + K's runs there that produced nothing
 *              + the pipe's outcomes credited to K × the stage's own unit cost (`offCampaignUnitCost`)
 *   outcomes = the pipe's outcome K's runs made there, + the ones made elsewhere whose consumed input K made
 * An outcome belongs to the script that made its INPUT: a reply judged under another script of the pipe's campaigns (the
 * inbound decision answering K's send) leaves that script for K at the stage's unit cost, as one judged outside does; a
 * workflow's goes back to it. Rows naming no script (runs older than runs-service's script field, never stated) stay the
 * one pool `SCRIPT_POOL`. Σ over the keys = `pipeScriptCost` (one pool), every dollar and outcome once. `cutDay` = the
 * mature cohort, as there.
 */
export function pipeScriptCosts(
  s: string,
  campaignIds: ReadonlySet<string>,
  book: LedgerPipeBook,
  cutDay?: string,
  keyOf: (slug: string | null | undefined) => string = scriptDynastyOfSlug,
): Map<string, PipeWorkflowCost> {
  const ran = (day: string | null | undefined) => cutDay === undefined || (day != null && day <= cutDay);
  const inSet = (c: string | null) => c !== null && campaignIds.has(c);
  type Acc = { cost: number; made: number; any: boolean; inputs: Map<string, number>; credited: Map<string, number>; handed: Map<string, number>; madeByInput: Map<string, number> };
  const accs = new Map<string, Acc>();
  const acc = (k: string): Acc => {
    let a = accs.get(k);
    if (!a) accs.set(k, (a = { cost: 0, made: 0, any: false, inputs: new Map(), credited: new Map(), handed: new Map(), madeByInput: new Map() }));
    return a;
  };
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const r of book.produced) {
    if (r.workflowSlug !== null || !inSet(r.campaignId) || !ran(r.runStartDay)) continue;
    const a = acc(keyOf(r.scriptSlug));
    a.any = true;
    a.cost += r.costUsd;
    if (r.outcomeKey === s && cutDay === undefined) a.made += r.occurrences;
  }
  for (const r of book.noOutput) {
    if (r.workflowSlug !== null || !inSet(r.campaignId) || !ran(r.runStartDay)) continue;
    const a = acc(keyOf(r.scriptSlug));
    a.any = true;
    a.cost += r.costUsd;
  }
  for (const c of book.consumed) {
    const poolRun = c.workflowSlug === null && inSet(c.campaignId);
    const k = keyOf(c.scriptSlug);
    if (poolRun && ran(c.runStartDay) && !inSet(c.sourceCampaignId)) add(acc(k).inputs, c.consumedKey, c.count);
    if (c.consumerKey !== s || c.workflowSlug !== null) continue;
    const fromPool = c.sourceWorkflowSlug === null && inSet(c.sourceCampaignId);
    const sk = keyOf(c.sourceScriptSlug);
    if (poolRun && c.sourceWorkflowSlug !== null && inSet(c.sourceCampaignId)) {
      // a workflow's input: the outcome goes back to that workflow (`pipeWorkflowCosts`)
      if (ran(c.runStartDay)) add(acc(k).handed, c.consumedKey, c.count);
    } else if (poolRun && fromPool && sk !== k) {
      // another script of the pipe made the input: the outcome leaves k for it
      if (ran(c.runStartDay)) add(acc(k).handed, c.consumedKey, c.count);
      if (ran(cutDay === undefined ? c.runStartDay : c.sourceRunStartDay)) add(acc(sk).credited, c.consumedKey, c.count);
    } else if (poolRun) {
      if (cutDay !== undefined && ran(c.sourceRunStartDay)) add(acc(k).madeByInput, c.consumedKey, c.count);
    } else if (fromPool && ran(cutDay === undefined ? c.runStartDay : c.sourceRunStartDay)) {
      add(acc(sk).credited, c.consumedKey, c.count);
    }
  }
  const most = (m: Map<string, number>) => (m.size > 0 ? Math.max(...m.values()) : 0);
  const unit = offCampaignUnitCost(s, book);
  const out = new Map<string, PipeWorkflowCost>();
  for (const [k, a] of [...accs].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const handed = most(a.handed);
    const credited = most(a.credited);
    if (!a.any && credited === 0) continue;
    const outcomes = (cutDay === undefined ? Math.max(a.made - handed, 0) : most(a.madeByInput)) + credited;
    out.set(k, { workflowSlug: k, costUsd: Math.max(a.cost - handed * unit, 0) + credited * unit, outcomes, inputs: most(a.inputs) });
  }
  return out;
}
