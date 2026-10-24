/**
 * THE LEDGER IS THE COST BASIS OF EVERY WORKFLOW FIGURE (owner 2026-10-24, COST-ACCOUNTING-1023-SWITCH: « complète tout
 * de suite. OK que le chiffre se réajuste au cours du temps »; doctrine: agent-config skill `cost-accounting`).
 *
 * ONE choke point: a leg's fleet evidence per workflow version (`fetchFleetLegSlugEvidence`, and the projection's
 * crossOrg grain) is what the leg ranking (what runs), the fleet maturity, the outcome prices, the catalogue pipe price
 * and Research read. Here its FLASH half is re-based on runs-service's outcome ledger for the leg's outcome: per version,
 *   spend    = everything the version produced inside the leg's campaigns (rule 3; unanswered sends included, rule 2)
 *              + each of its outcomes' share of the stages beyond workflow runs (judging, inputs bought from other pipes)
 *   outcomes = the outcome occurrences whose hand-off input it produced (the reply to its send)
 * so cost per outcome = the ledger's unit production cost. A version the ledger holds nothing for (no declared
 * production on the leg, no outcome sourced to it) keeps its runs figures, logged. The MATURE half stays on its own
 * basis until runs-service groups a consumption by the day its source was produced (then it moves the same way).
 * Figures readjust as declarations fill in (owner accepted). Pure apart from the cached loader.
 */
import type { CostGroup } from "./public-stats-clients.js";
import { fetchOutcomeLedgerByWorkflow, fetchOutcomeLedgerTotals, type LedgerBasis, type OutcomeLedgerByWorkflow, type OutcomeLedgerTotals } from "./outcome-cost-totals-client.js";
import { rollUpOutcomeUnitCosts, workflowUnitCosts } from "./outcome-unit-costs.js";
import { campaignOutputsOf } from "./campaign-outputs.js";
import { fetchFleetCampaignRows } from "./fleet-leg-campaigns.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { legMaturity } from "./maturity.js";
import type { Pricing } from "./pricing.js";

/**
 * The leg's ledger outcome, when the ledger counts it on the evidence's own rule: the positive reply (a judged reply,
 * the person cell's basis). The website visit stays on runs until the ledger counts HUMAN-judged clicks only (the
 * screened-visit rule): a provider click is mostly link scanners. Null = the leg keeps its runs figures.
 */
export function ledgerOutcomeOfLeg(legKey: string): string | null {
  return legMaturity(legKey).outcomeSignal === "positiveReply" ? "conversation" : null;
}

/** The ledger basis of a pricing (the staff vendor twins read vendor; an unpriced-vendor read stays on runs). */
export function ledgerBasisOf(pricing: Pricing): LedgerBasis | null {
  if (pricing === "gross" || pricing === "net" || pricing === "vendor") return pricing;
  return null;
}

export interface LedgerInputs {
  totals: OutcomeLedgerTotals;
  byWorkflow: OutcomeLedgerByWorkflow;
  outputOf: (campaignId: string) => string | null;
  pipeOutputs: ReadonlySet<string>;
}

/**
 * PURE. Re-bases one leg's flash evidence on the ledger, on COPIES (the cost groups come from a shared cache): per
 * version slug the ledger knows, its cost group's spend (gross and net twin alike: the basis read) and its positive
 * outcomes. `outcomeKey` = the leg's `to` step; `legCampaignIds` = the leg's campaigns (only their production counts).
 */
export function overlayLegEvidence(
  costGroups: readonly CostGroup[],
  emailStats: ReadonlyMap<string, Record<string, number>>,
  outcomeKey: string,
  legCampaignIds: ReadonlySet<string>,
  ledger: LedgerInputs,
): { costGroups: CostGroup[]; emailStats: Map<string, Record<string, number>>; rebased: string[] } {
  const groups = costGroups.map((g) => ({ ...g, dimensions: { ...g.dimensions } }));
  const stats = new Map([...emailStats].map(([k, v]) => [k, { ...v }]));
  const fleet = rollUpOutcomeUnitCosts(ledger.totals.produced, ledger.totals.consumed, ledger.outputOf, ledger.pipeOutputs).units.get(outcomeKey);
  if (!fleet || fleet.produced === 0) return { costGroups: groups, emailStats: stats, rebased: [] };
  const rows = workflowUnitCosts(
    outcomeKey,
    ledger.byWorkflow.produced.filter((r) => r.campaignId !== null && legCampaignIds.has(r.campaignId)),
    ledger.byWorkflow.sourced,
    ledger.outputOf,
    fleet,
  );
  const rebased: string[] = [];
  for (const r of rows) {
    const spendUsd = r.unitCostUsd !== null ? r.unitCostUsd * r.outcomes : r.ownCostUsd;
    const cents = (spendUsd * 100).toFixed(10);
    const group = groups.find((g) => g.dimensions.workflowSlug === r.workflowSlug);
    if (group) {
      group.totalCostInUsdCents = cents;
      group.netTotalCostInUsdCents = cents;
    } else {
      groups.push({ dimensions: { workflowSlug: r.workflowSlug }, totalCostInUsdCents: cents, netTotalCostInUsdCents: cents, runCount: 0, minStartedAt: null, maxStartedAt: null });
    }
    const st = stats.get(r.workflowSlug) ?? {};
    st.recipientsRepliesPositive = r.outcomes;
    stats.set(r.workflowSlug, st);
    rebased.push(r.workflowSlug);
  }
  return { costGroups: groups, emailStats: stats, rebased };
}

const HELD_MS = 15 * 60_000;
const held = new Map<LedgerBasis, { at: number; value: LedgerInputs }>();
const inFlight = new Map<LedgerBasis, Promise<LedgerInputs>>();

/** The ledger inputs, held 15 min per basis, one read at a time. Throws when the ledger cannot be read. */
export async function loadLedgerInputs(basis: LedgerBasis): Promise<LedgerInputs> {
  const h = held.get(basis);
  if (h && Date.now() - h.at < HELD_MS) return h.value;
  const running = inFlight.get(basis);
  if (running) return running;
  const p = (async () => {
    const [totals, byWorkflow, rows, catalogue] = await Promise.all([
      fetchOutcomeLedgerTotals(basis),
      fetchOutcomeLedgerByWorkflow(basis),
      fetchFleetCampaignRows(),
      loadChannelCatalogue({ publishedOnly: false }),
    ]);
    const { outputOf, pipeOutputs } = campaignOutputsOf(rows, catalogue.channels);
    const value = { totals, byWorkflow, outputOf, pipeOutputs };
    held.set(basis, { at: Date.now(), value });
    return value;
  })().finally(() => inFlight.delete(basis));
  inFlight.set(basis, p);
  return p;
}

/**
 * IO. One leg's flash evidence re-based on the ledger (the choke point's single call). The ledger unreadable = the runs
 * evidence unchanged, logged loud (never a 502 of the ranking: the figures readjust on the next build).
 */
export async function withLedgerFlash<T extends { costGroups: CostGroup[]; emailStats: Map<string, Record<string, number>> }>(
  label: string,
  legKey: string,
  pricing: Pricing,
  flash: T,
  legCampaignIds: ReadonlySet<string>,
): Promise<T> {
  const outcomeKey = ledgerOutcomeOfLeg(legKey);
  const basis = ledgerBasisOf(pricing);
  if (!outcomeKey || !basis) return flash;
  try {
    const ledger = await loadLedgerInputs(basis);
    const o = overlayLegEvidence(flash.costGroups, flash.emailStats, outcomeKey, legCampaignIds, ledger);
    if (o.rebased.length === 0) console.warn(`[features-service] ledger switch ${label}: the ledger holds no workflow on the leg yet, runs figures kept`);
    return { ...flash, costGroups: o.costGroups, emailStats: o.emailStats };
  } catch (error) {
    console.error(`[features-service] ledger switch ${label}: ledger unreadable, runs figures kept:`, error);
    return flash;
  }
}

/** Test seam. */
export function __resetLedgerInputs(): void {
  held.clear();
  inFlight.clear();
}
