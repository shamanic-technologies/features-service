/**
 * IO of the Engine-per-outcome shadow (`lib/engine-shadow.ts`, owner 2026-10-31, ENGINE-PER-OUTCOME-SHADOW). Called by the
 * stored factory shadow pass only (`routes/factory-shadow.ts`), never on a read. ONE ledger read per pass: the DAILY book
 * (`loadDailyLedgerBook`, every decision day of the last `BOOK_DAYS`, held per pass) feeds the fleet and client beliefs and the replay alike; the
 * leg workflow rankings (persisted cells, `readLegWorkflowRanking(…, 0)` never waits on a build) say which workflows may
 * run; the stored Research Performance build gives each workflow's sub-picks (uplift). Shadow only: nothing runs from it.
 */
import { funnelById, legStepsOf, pipeRunnable, stepLabel, valueAddedTo, type CatalogueModel, type CataloguePipe } from "./agent-catalogue.js";
import { basePipeIdOf, frameOf, type ShadowCampaign } from "./factory-shadow.js";
import { loadDailyLedgerBook, pipeOutcomeKey, type LedgerBookRead } from "./ledger-book.js";
import { offCampaignUnitCost } from "./ledger-pipe-costs.js";
import { legMaturity } from "./maturity.js";
import { pipeLegKeyOf } from "./funnel-legs.js";
import { fetchPublicWorkflows } from "./public-stats-clients.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  EMPTY_EVIDENCE,
  ENGINE_MODEL,
  REPLAY_CAVEATS,
  engineShadowOf,
  enginePlaceOf,
  pipeDailyEvidence,
  replayFamily,
  replayTotals,
  upliftOf,
  weighEvidence,
  type DayCounts,
  type EngineCandidate,
  type EnginePickRef,
  type EnginePlace,
  type EngineReplay,
  type EngineShadow,
  type ReplayCandidate,
} from "./engine-shadow.js";
import { getFleetLegCampaigns, readLegWorkflowRanking, type LegWorkflowRankingPayload } from "../routes/public.js";
import { readResearchBuild } from "../routes/research.js";
import type { LegWorkflowRankingRow } from "./leg-workflow-ranking.js";

const DAY_MS = 86_400_000;
/** How far back the daily book is read: a decision this old weighs (1/2)^(150/45) ≈ 10% (`HALF_LIFE_DAYS`). */
export const BOOK_DAYS = 150;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** One pipe's decision days: per workflow dynasty, fleet-wide and per brand. */
interface PipeDays {
  fleet: Map<string, DayCounts[]>;
  byBrand: Map<string, Map<string, DayCounts[]>>;
  maturityDays: number;
}

/** Per-pass memos: one ranking per pipe, one daily book, one daily split per pipe, one Research build. */
export function engineMemos() {
  const rankings = new Map<string, Promise<LegWorkflowRankingPayload | null>>();
  const pipeDays = new Map<string, Promise<PipeDays>>();
  let book: Promise<LedgerBookRead> | null = null;
  let perf: Promise<Map<string, Map<string, Array<{ outcomes: number; spentUsd: number }>>>> | null = null;
  const memo = <T>(m: Map<string, Promise<T>>, k: string, f: () => Promise<T>): Promise<T> => {
    if (!m.has(k)) m.set(k, f());
    return m.get(k)!;
  };
  const self = {
    ranking: (p: CataloguePipe) =>
      memo(rankings, p.id, () =>
        readLegWorkflowRanking(p.channelSlug, p.computedLegKey, 0).catch((error) => {
          console.error(`[features-service] engine shadow: ranking of ${p.id} unreadable, the pipe offers no workflow:`, error);
          return null;
        }),
      ),
    book: () => (book ??= loadDailyLedgerBook("gross", new Date(Date.now() - BOOK_DAYS * DAY_MS).toISOString().slice(0, 10))),
    /** The pipe's decision days per workflow dynasty (fleet and per brand), off the daily book. */
    days: (p: CataloguePipe) =>
      memo(pipeDays, p.id, async (): Promise<PipeDays> => {
        const [read, s, campaigns, workflows] = await Promise.all([
          self.book(),
          pipeOutcomeKey(p.channelSlug, p.computedLegKey),
          getFleetLegCampaigns(p.channelSlug, p.computedLegKey),
          fetchPublicWorkflows(p.channelSlug, "all"),
        ]);
        const dynastyOf = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
        const brandOf = new Map(campaigns.map((c) => [c.campaignId, c.brandId]));
        const fleet = new Map<string, Map<string, DayCounts>>();
        const byBrand = new Map<string, Map<string, Map<string, DayCounts>>>();
        const add = (m: Map<string, Map<string, DayCounts>>, dyn: string, e: DayCounts) => {
          const days = m.get(dyn) ?? new Map<string, DayCounts>();
          const d = days.get(e.day) ?? { day: e.day, decisions: 0, outcomes: 0, spentUsd: 0 };
          d.decisions += e.decisions;
          d.outcomes += e.outcomes;
          d.spentUsd += e.spentUsd;
          days.set(e.day, d);
          m.set(dyn, days);
        };
        for (const e of pipeDailyEvidence(s, new Set(brandOf.keys()), read.book, offCampaignUnitCost(s, read.book)).values()) {
          const dyn = dynastyOf.get(e.workflowSlug) ?? e.workflowSlug;
          add(fleet, dyn, e);
          const brand = brandOf.get(e.campaignId);
          if (brand) {
            if (!byBrand.has(brand)) byBrand.set(brand, new Map());
            add(byBrand.get(brand)!, dyn, e);
          }
        }
        const flat = (m: Map<string, Map<string, DayCounts>>) => new Map([...m].map(([k, v]) => [k, [...v.values()].sort((a, b) => (a.day < b.day ? -1 : 1))]));
        return { fleet: flat(fleet), byBrand: new Map([...byBrand].map(([b, m]) => [b, flat(m)])), maturityDays: legMaturity(p.computedLegKey).durationDays };
      }),
    /** Per pipe (`<channel>|<computed leg>`), per workflow dynasty, its template x LLM rows (Research Performance, flash). */
    subPicks: () =>
      (perf ??= readResearchBuild("user", "flash")
        .then((b) => {
          const out = new Map<string, Map<string, Array<{ outcomes: number; spentUsd: number }>>>();
          for (const p of Object.values(b?.performance ?? {})) {
            if (!p.featureSlug || !p.legKey) continue;
            const key = `${p.featureSlug}|${pipeLegKeyOf(p.featureSlug, p.legKey)}`;
            const byWf = out.get(key) ?? new Map<string, Array<{ outcomes: number; spentUsd: number }>>();
            for (const r of p.rows) {
              if (!r.written) continue;
              byWf.set(r.workflow.key, [...(byWf.get(r.workflow.key) ?? []), { outcomes: r.outcomes.value, spentUsd: r.spentUsd.value }]);
            }
            out.set(key, byWf);
          }
          return out;
        })
        .catch((error) => {
          console.error("[features-service] engine shadow: Research Performance unreadable, every uplift reads 1 this pass:", error);
          return new Map();
        })),
    uplift: async (p: CataloguePipe, dynasty: string) => upliftOf((await self.subPicks()).get(`${p.channelSlug}|${pipeLegKeyOf(p.channelSlug, p.computedLegKey)}`)?.get(dynasty) ?? []),
  };
  return self;
}
export type EngineMemos = ReturnType<typeof engineMemos>;

/** The workflows a pipe (or the play the brief chose on it) may run today, with their ranking rows. */
function selectableRows(pipe: CataloguePipe, ranking: LegWorkflowRankingPayload | null): LegWorkflowRankingRow[] {
  const rows = (ranking?.rows ?? []).filter((r) => r.selectable);
  const allowed = pipe.play?.allowedActiveDynasties;
  return allowed && allowed.length > 0 ? rows.filter((r) => allowed.includes(r.workflowDynastySlug)) : rows;
}

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
  const today = dayOf(now);
  const tomorrow = dayOf(new Date(now.getTime() + DAY_MS));
  const targetValued = model.steps.get(f.target)?.valueUsd != null;
  const valueOf = (s: string) => model.steps.get(s)?.valueUsd ?? null;
  const places: EnginePlace[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const outcome = legStepsOf(model, leg.legKey).toStep;
    const consumer = i + 1 < legs.length ? legStepsOf(model, legs[i + 1]!.legKey).toStep : "campaign";
    // The steps this campaign holds before this outcome: a script may consume any of them.
    const held = new Set<string | null>([null, "lead_found", f.startStep, ...legs.slice(0, i).map((l) => legStepsOf(model, l.legKey).toStep)]);
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
      const rows = selectableRows(pipe, await memos.ranking(base));
      if (rows.length === 0) return;
      const days = await memos.days(base);
      const clientDays = days.byBrand.get(c.brandId);
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
          uplift: await memos.uplift(base, r.workflowDynastySlug),
          fleet: weighEvidence(days.fleet.get(r.workflowDynastySlug) ?? [], tomorrow, today, days.maturityDays),
          client: clientDays ? weighEvidence(clientDays.get(r.workflowDynastySlug) ?? [], tomorrow, today, days.maturityDays) : EMPTY_EVIDENCE,
          expectedCostPerOutcomeUsd: base.expectedCost?.costPerOutcomeUsd ?? null,
          defaultRatePct: rate,
        });
      }
    });
    candidates.sort((a, b) => (a.id < b.id ? -1 : 1));
    // Today's pick: the pipe the campaign runs on this leg, and the workflow its ranking puts first (within its play).
    let todayPick: { candidateId: string | null; ref: EnginePickRef | null; unavailableReason: string | null };
    const runPipe = leg.pipe;
    if (!runPipe) todayPick = { candidateId: null, ref: null, unavailableReason: "no_pipe_on_leg" };
    else if (runPipe.operatedBy !== "platform") todayPick = { candidateId: null, ref: null, unavailableReason: "client_team_leg" };
    else {
      const base = model.pipes.get(basePipeIdOf(runPipe)) ?? runPipe;
      const first = selectableRows(runPipe, await memos.ranking(base))[0] ?? null;
      const id = first ? `${base.id}::${first.workflowDynastySlug}` : null;
      todayPick = first
        ? { candidateId: id, ref: { candidateId: id!, pipeId: runPipe.id, channelName: runPipe.channelName, workflowDynastySlug: first.workflowDynastySlug, workflowDynastyName: first.workflowDynastyName }, unavailableReason: null }
        : { candidateId: null, ref: null, unavailableReason: "workflow_ranking_not_computed_yet" };
    }
    // A client-team leg is no pick of ours: it is not a place of our Engine.
    if (todayPick.unavailableReason === "client_team_leg" && candidates.length === 0) continue;
    places.push(
      enginePlaceOf(
        { outcome, outcomeName: stepLabel(model, outcome), consumer, consumerName: consumer === "campaign" ? "Campaign" : stepLabel(model, consumer), targetValued: outcome === f.target ? targetValued : valueOf(outcome) != null, seed: `${c.id}|${outcome}|${consumer}|${today}` },
        candidates,
        todayPick,
      ),
    );
  }
  const read = await memos.book();
  return engineShadowOf(places, now.toISOString(), read.daysMissing > 0 ? "ledger_unreconciled" : "ledger");
}

// ── The replay ─────────────────────────────────────────────────────────────────────────────────────

export const REPLAY_WINDOW_DAYS = 30;

/**
 * The replay (fleet, every outcome some pipe of ours produces), off the same daily book: each decision day of the last
 * 30, the Engine's Thompson shares on the evidence as of that day against what today's rule ran, both graded on the
 * window's measured value per dollar (gradable picks only).
 */
export async function computeEngineReplay(memos: EngineMemos, model: CatalogueModel, now: Date): Promise<EngineReplay> {
  const countedOnDay = dayOf(now);
  const read = await memos.book();
  // The window ends where the stored decision days end: runs-service lists the recent days it has not stored with their
  // run-start day yet (2026-10-31: the last 10); a day it does not hold would read as a day nobody decided.
  const recentMissing = (read.missingDays ?? []).filter((d) => d >= dayOf(new Date(now.getTime() - 2 * REPLAY_WINDOW_DAYS * DAY_MS)));
  const untilDay = recentMissing[0] && recentMissing[0] < countedOnDay ? recentMissing[0] : countedOnDay;
  const sinceDay = dayOf(new Date(Date.parse(`${untilDay}T00:00:00Z`) - REPLAY_WINDOW_DAYS * DAY_MS));
  const valueOf = (s: string) => model.steps.get(s)?.valueUsd ?? null;
  const byOutcome = new Map<string, CataloguePipe[]>();
  for (const p of model.pipes.values()) if (p.operatedBy === "platform" && pipeRunnable(p)) byOutcome.set(p.toStep, [...(byOutcome.get(p.toStep) ?? []), p]);
  const families = [];
  const checkpoints = new Set<string>();
  for (const [outcome, pipes] of [...byOutcome].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const candidates: ReplayCandidate[] = [];
    for (const p of pipes) {
      const rows = selectableRows(p, await memos.ranking(p));
      if (rows.length === 0) continue;
      const days = await memos.days(p);
      const rate = model.ratesOfChain([{ legKey: p.legKey, fromStep: p.fromStep, toStep: p.toStep }])[0]?.ratePct ?? null;
      for (const r of rows) {
        candidates.push({
          id: `${p.id}::${r.workflowDynastySlug}`,
          basePipeId: p.id,
          channelName: p.channelName,
          dynastySlug: r.workflowDynastySlug,
          valueAddedUsd: valueAddedTo(valueOf, p.fromStep, outcome),
          uplift: await memos.uplift(p, r.workflowDynastySlug),
          expectedCostPerOutcomeUsd: p.expectedCost?.costPerOutcomeUsd ?? null,
          defaultRatePct: rate,
          maturityDays: days.maturityDays,
          days: days.fleet.get(r.workflowDynastySlug) ?? [],
        });
      }
    }
    if (candidates.length === 0) continue;
    const fam = replayFamily(outcome, stepLabel(model, outcome), candidates.sort((a, b) => (a.id < b.id ? -1 : 1)), valueOf(outcome) != null, { sinceDay, untilDay, countedOnDay }, `replay|${outcome}|${countedOnDay}`);
    for (const c of candidates) for (const d of c.days) if (d.day >= sinceDay && d.day < untilDay && d.decisions > 0) checkpoints.add(d.day);
    families.push(fam);
  }
  return {
    computedAt: now.toISOString(),
    windowDays: REPLAY_WINDOW_DAYS,
    window: { sinceDay, untilDay },
    checkpoints: [...checkpoints].sort(),
    families,
    totals: replayTotals(families),
    caveats: read.daysMissing > 0 ? [...REPLAY_CAVEATS, "ledger_not_reconciled"] : REPLAY_CAVEATS,
    ledgerReconciled: read.daysMissing === 0,
    ledgerDaysMissing: read.daysMissing,
    model: ENGINE_MODEL,
    failure: null,
  };
}
