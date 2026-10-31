/**
 * IO of the Engine-per-outcome shadow (`lib/engine-shadow.ts`, owner 2026-10-31, ENGINE-PER-OUTCOME-SHADOW). Called by the
 * stored factory shadow pass only (`routes/factory-shadow.ts`), never on a read. Every input is already held warm:
 * the leg workflow rankings (persisted cells, `readLegWorkflowRanking(…, 0)` never waits on a build), the ledger book
 * (held 15 min per cut), the fleet leg campaigns (cached). Shadow only: nothing here changes what runs.
 */
import { funnelById, legStepsOf, pipeRunnable, stepLabel, valueAddedTo, type CatalogueModel, type CataloguePipe } from "./agent-catalogue.js";
import { basePipeIdOf, frameOf, type ShadowCampaign } from "./factory-shadow.js";
import { ledgerRegime, loadLedgerBook, pipeOutcomeKey, runStartUntilOf, type LedgerBookRead } from "./ledger-book.js";
import { pipeWorkflowCosts } from "./ledger-pipe-costs.js";
import { legCutoffIso } from "./maturity.js";
import { fetchPublicWorkflows } from "./public-stats-clients.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  EMPTY_EVIDENCE,
  REPLAY_CAVEATS,
  engineShadowOf,
  enginePlaceOf,
  replayFamily,
  replayTotals,
  type EngineCandidate,
  type EnginePickRef,
  type EnginePlace,
  type EngineReplay,
  type EngineShadow,
  type Evidence,
  type ReplayCandidate,
} from "./engine-shadow.js";
import { getFleetLegCampaigns, readLegWorkflowRanking, type LegWorkflowRankingPayload } from "../routes/public.js";
import type { LegWorkflowRankingRow } from "./leg-workflow-ranking.js";

/** Per-pass memos: one ranking per pipe, one workflow list per channel, one book per cut. */
export function engineMemos() {
  const rankings = new Map<string, Promise<LegWorkflowRankingPayload | null>>();
  const dynasties = new Map<string, Promise<Map<string, string>>>();
  const books = new Map<string, Promise<LedgerBookRead | null>>();
  /** Reads served while runs-service's ledger was NOT reconciled (a stale or missing day): the shadow still reads the
   *  book, says so (`ledgerReconciled: false` + the days missing), never goes red for it (the Monitoring ledger card is). */
  const unreconciled = { reads: 0, daysMissing: 0 };
  const outcomeKeys = new Map<string, Promise<string>>();
  const memo = <T>(m: Map<string, Promise<T>>, k: string, f: () => Promise<T>): Promise<T> => {
    if (!m.has(k)) m.set(k, f());
    return m.get(k)!;
  };
  return {
    ranking: (p: CataloguePipe) =>
      memo(rankings, p.id, () =>
        readLegWorkflowRanking(p.channelSlug, p.computedLegKey, 0).catch((error) => {
          console.error(`[features-service] engine shadow: ranking of ${p.id} unreadable, the pipe offers no workflow:`, error);
          return null;
        }),
      ),
    dynastyOf: (featureSlug: string) => memo(dynasties, featureSlug, async () => new Map((await fetchPublicWorkflows(featureSlug, "all")).map((w) => [w.workflowSlug, w.workflowDynastySlug]))),
    book: (cutIso: string | null) =>
      memo(books, cutIso ?? "", async () => {
        const regime = await ledgerRegime("gross", cutIso);
        if (regime) return regime;
        const raw = await loadLedgerBook("gross", cutIso ? runStartUntilOf(cutIso) : undefined);
        unreconciled.reads += 1;
        unreconciled.daysMissing = Math.max(unreconciled.daysMissing, raw.daysMissing);
        return raw;
      }),
    unreconciled,
    outcomeKey: (p: CataloguePipe) => memo(outcomeKeys, p.id, () => pipeOutcomeKey(p.channelSlug, p.computedLegKey)),
  };
}
export type EngineMemos = ReturnType<typeof engineMemos>;

/** PURE: a ranking row's fleet evidence (flash = every decision, mature = those past the leg's window). */
export function rowEvidence(r: LegWorkflowRankingRow): Evidence {
  const v = r.figuresByView;
  if (!v) return { decisions: r.contacted, outcomes: r.outcomes, spentUsd: r.spentUsd, matureDecisions: null, matureOutcomes: null };
  return {
    decisions: v.flash.contacted,
    outcomes: v.flash.outcomes,
    spentUsd: v.flash.spentUsd.value ?? 0,
    matureDecisions: v.mature.contacted,
    matureOutcomes: v.mature.outcomes,
  };
}

/** Per dynasty, one grain's ledger evidence on a pipe (the campaign set IS the grain). */
async function ledgerEvidence(memos: EngineMemos, p: CataloguePipe, campaignIds: ReadonlySet<string>, cutIso: string | null, matureCutIso: string | null): Promise<Map<string, Evidence> | null> {
  const [flash, mature, key, dynastyOf] = await Promise.all([memos.book(cutIso), matureCutIso ? memos.book(matureCutIso) : Promise.resolve(null), memos.outcomeKey(p), memos.dynastyOf(p.channelSlug)]);
  if (!flash) return null;
  const sum = (read: LedgerBookRead | null) => {
    const out = new Map<string, { decisions: number; outcomes: number; spentUsd: number }>();
    if (!read) return out;
    for (const v of pipeWorkflowCosts(key, campaignIds, read.book).values()) {
      const d = dynastyOf.get(v.workflowSlug) ?? v.workflowSlug;
      const e = out.get(d) ?? { decisions: 0, outcomes: 0, spentUsd: 0 };
      e.decisions += v.inputs;
      e.outcomes += v.outcomes;
      e.spentUsd += v.costUsd;
      out.set(d, e);
    }
    return out;
  };
  const f = sum(flash);
  const m = matureCutIso ? (mature ? sum(mature) : null) : null;
  return new Map([...f].map(([d, e]) => [d, { ...e, matureDecisions: m ? (m.get(d)?.decisions ?? 0) : null, matureOutcomes: m ? (m.get(d)?.outcomes ?? 0) : null }]));
}

/** The workflows a pipe (or the play the brief chose on it) may run today, with their ranking rows. */
function selectableRows(pipe: CataloguePipe, ranking: LegWorkflowRankingPayload | null): LegWorkflowRankingRow[] {
  const rows = (ranking?.rows ?? []).filter((r) => r.selectable);
  const allowed = pipe.play?.allowedActiveDynasties;
  return allowed && allowed.length > 0 ? rows.filter((r) => allowed.includes(r.workflowDynastySlug)) : rows;
}

const DAY_MS = 86_400_000;

/**
 * One campaign's Engine shadow: per place of the line it runs (up to its Target), today's pick beside the Engine's.
 * `picks` = base pipe -> the play the brief chose; `excluded` = pipes the brief rules out.
 */
export async function engineShadowOfCampaign(
  memos: EngineMemos,
  model: CatalogueModel,
  c: Pick<ShadowCampaign, "id" | "brandId" | "salesFunnelId" | "target" | "mode" | "triggerId">,
  picks: ReadonlyMap<string, string>,
  excluded: ReadonlySet<string>,
  now: Date,
): Promise<EngineShadow> {
  const f = frameOf(model, c);
  const running = funnelById(model, c.salesFunnelId)!;
  const end = f.runningSteps.findIndex((s) => s.toStep === f.target);
  const legs = running.legs.slice(0, end < 0 ? running.legs.length : end + 1);
  const day = now.toISOString().slice(0, 10);
  const targetValued = model.steps.get(f.target)?.valueUsd != null;
  const valueOf = (s: string) => model.steps.get(s)?.valueUsd ?? null;
  let ledgerRead = true;
  const places: EnginePlace[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const outcome = legStepsOf(model, leg.legKey).toStep;
    const consumer = i + 1 < legs.length ? legStepsOf(model, legs[i + 1]!.legKey).toStep : "campaign";
    // The steps this campaign holds before this outcome: a script may consume any of them.
    const held = new Set<string | null>([null, "lead_found", f.startStep, ...legs.slice(0, i).map((l) => legStepsOf(model, l.legKey).toStep)]);
    // Every pipe we run ending on the outcome, as the brief allows it (its play when it chose one).
    // The pipe the campaign runs on this leg is always a candidate (its trigger and start are the campaign's own by
    // construction: a reactive funnel's pipe answers a trigger the campaign does not restate).
    const runningBase = leg.pipe && leg.pipe.operatedBy === "platform" ? basePipeIdOf(leg.pipe) : null;
    const bases = [...model.pipes.values()].filter(
      (p) =>
        p.toStep === outcome &&
        p.operatedBy === "platform" &&
        !excluded.has(p.id) &&
        (p.id === runningBase || (held.has(p.fromStep) && (p.triggerId === null || p.triggerId === f.triggerId))),
    );
    const candidates: EngineCandidate[] = [];
    await mapWithConcurrency(bases, 4, async (base) => {
      const chosen = picks.get(base.id);
      const pipe = (chosen ? (model.plays.get(chosen) ?? model.pipes.get(chosen)) : null) ?? base;
      if (!pipeRunnable(pipe)) return;
      const ranking = await memos.ranking(base);
      const rows = selectableRows(pipe, ranking);
      if (rows.length === 0) return;
      const campaignIds = new Set((await getFleetLegCampaigns(base.channelSlug, base.computedLegKey)).filter((x) => x.brandId === c.brandId).map((x) => x.campaignId));
      // The mature cut is a second ledger read per leg: taken only while the ledger is reconciled (the rankings read the
      // same cut then, held); unreconciled, the client's decisions count in full (no censoring at the client level).
      if (campaignIds.size > 0) await memos.book(null);
      const matureCut = memos.unreconciled.reads === 0 ? legCutoffIso(base.computedLegKey, now) : null;
      const client = campaignIds.size === 0 ? new Map<string, Evidence>() : await ledgerEvidence(memos, base, campaignIds, null, matureCut);
      if (client === null) ledgerRead = false;
      const rate = model.ratesOfChain([{ legKey: base.legKey, fromStep: base.fromStep, toStep: base.toStep }])[0]?.ratePct ?? null;
      for (const r of rows) {
        candidates.push({
          id: `${base.id}::${r.workflowDynastySlug}`,
          basePipeId: base.id,
          pipeId: pipe.id,
          channelSlug: base.channelSlug,
          channelName: base.channelName,
          legKey: base.legKey,
          fromStep: base.fromStep,
          dynastySlug: r.workflowDynastySlug,
          dynastyName: r.workflowDynastyName,
          valueAddedUsd: valueAddedTo(valueOf, base.fromStep, outcome),
          fleet: rowEvidence(r),
          client: client === null ? null : (client.get(r.workflowDynastySlug) ?? EMPTY_EVIDENCE),
          expectedCostPerOutcomeUsd: base.expectedCost?.costPerOutcomeUsd ?? null,
          defaultRatePct: rate,
        });
      }
    });
    candidates.sort((a, b) => (a.id < b.id ? -1 : 1));
    // Today's pick: the pipe the campaign runs on this leg, and the workflow its ranking puts first (within its play).
    let today: { candidateId: string | null; ref: EnginePickRef | null; unavailableReason: string | null };
    const runPipe = leg.pipe;
    if (!runPipe) today = { candidateId: null, ref: null, unavailableReason: "no_pipe_on_leg" };
    else if (runPipe.operatedBy !== "platform") today = { candidateId: null, ref: null, unavailableReason: "client_team_leg" };
    else {
      const base = model.pipes.get(basePipeIdOf(runPipe)) ?? runPipe;
      const first = selectableRows(runPipe, await memos.ranking(base))[0] ?? null;
      const id = first ? `${base.id}::${first.workflowDynastySlug}` : null;
      today = first
        ? { candidateId: id, ref: { candidateId: id!, pipeId: runPipe.id, channelName: runPipe.channelName, workflowDynastySlug: first.workflowDynastySlug, workflowDynastyName: first.workflowDynastyName }, unavailableReason: null }
        : { candidateId: null, ref: null, unavailableReason: "workflow_ranking_not_computed_yet" };
    }
    // A client-team leg is no pick of ours: it is not a place of our Engine.
    if (today.unavailableReason === "client_team_leg" && candidates.length === 0) continue;
    places.push(
      enginePlaceOf(
        { outcome, outcomeName: stepLabel(model, outcome), consumer, consumerName: consumer === "campaign" ? "Campaign" : stepLabel(model, consumer), targetValued: outcome === f.target ? targetValued : valueOf(outcome) != null, seed: `${c.id}|${outcome}|${consumer}|${day}` },
        candidates,
        today,
      ),
    );
  }
  return engineShadowOf(places, now.toISOString(), !ledgerRead ? "ledger_unreadable" : memos.unreconciled.reads > 0 ? "ledger_unreconciled" : "ledger");
}

// ── The replay ─────────────────────────────────────────────────────────────────────────────────────

export const REPLAY_WINDOW_DAYS = 30;
/**
 * Checkpoints of the window (days before today): beliefs are read as of each, its period runs to the next. ONE: every
 * cut is a full ledger read on runs-service, which calls features-service back; five cuts on 2026-10-31 (load 52) made
 * runs-service 500 and the pass take 280 s. The Engine decides once, at the window's start, on what it knew then.
 */
export const REPLAY_CHECKPOINTS = [30] as const;

/**
 * The replay (fleet, every outcome some pipe of ours produces): at each checkpoint the Engine's Thompson shares on the
 * evidence as of then, against what today's rule ran, both graded on the value per dollar the window measured.
 */
export async function computeEngineReplay(memos: EngineMemos, model: CatalogueModel, now: Date): Promise<EngineReplay> {
  const cut = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
  const checkpoints = REPLAY_CHECKPOINTS.map(cut);
  const valueOf = (s: string) => model.steps.get(s)?.valueUsd ?? null;
  const byOutcome = new Map<string, CataloguePipe[]>();
  for (const p of model.pipes.values()) if (p.operatedBy === "platform" && pipeRunnable(p)) byOutcome.set(p.toStep, [...(byOutcome.get(p.toStep) ?? []), p]);
  const families = [];
  for (const [outcome, pipes] of [...byOutcome].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const candidates: ReplayCandidate[] = [];
    for (const p of pipes) {
      const rows = selectableRows(p, await memos.ranking(p));
      if (rows.length === 0) continue;
      const ids = new Set((await getFleetLegCampaigns(p.channelSlug, p.computedLegKey)).map((x) => x.campaignId));
      // As of each checkpoint, and today (the end of the last period).
      const reads = await Promise.all([...checkpoints, null].map((iso) => ledgerEvidence(memos, p, ids, iso, null)));
      if (reads.some((r) => r === null)) throw new Error(`ledger book unreadable for ${p.id}`);
      const rate = model.ratesOfChain([{ legKey: p.legKey, fromStep: p.fromStep, toStep: p.toStep }])[0]?.ratePct ?? null;
      for (const r of rows) {
        const at = reads.map((m) => m!.get(r.workflowDynastySlug) ?? EMPTY_EVIDENCE);
        candidates.push({
          id: `${p.id}::${r.workflowDynastySlug}`,
          basePipeId: p.id,
          channelName: p.channelName,
          dynastySlug: r.workflowDynastySlug,
          valueAddedUsd: valueAddedTo(valueOf, p.fromStep, outcome),
          expectedCostPerOutcomeUsd: p.expectedCost?.costPerOutcomeUsd ?? null,
          defaultRatePct: rate,
          asOf: at.slice(0, checkpoints.length).map((e) => ({ ...e, matureDecisions: null, matureOutcomes: null })),
          period: checkpoints.map((_, k) => ({
            decisions: Math.max(0, at[k + 1]!.decisions - at[k]!.decisions),
            outcomes: Math.max(0, at[k + 1]!.outcomes - at[k]!.outcomes),
            spentUsd: Math.max(0, at[k + 1]!.spentUsd - at[k]!.spentUsd),
          })),
        });
      }
    }
    if (candidates.length === 0) continue;
    families.push(replayFamily(outcome, stepLabel(model, outcome), candidates.sort((a, b) => (a.id < b.id ? -1 : 1)), valueOf(outcome) != null, `replay|${outcome}|${now.toISOString().slice(0, 10)}`));
  }
  const ledgerReconciled = memos.unreconciled.reads === 0;
  return {
    computedAt: now.toISOString(),
    windowDays: REPLAY_WINDOW_DAYS,
    checkpoints,
    families,
    totals: replayTotals(families),
    caveats: ledgerReconciled ? REPLAY_CAVEATS : [...REPLAY_CAVEATS, "ledger_not_reconciled"],
    ledgerReconciled,
    ledgerDaysMissing: memos.unreconciled.daysMissing,
    failure: null,
  };
}
