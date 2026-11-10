/**
 * OUTCOME-RUNG-AND-TARGET-1106: `GET /brands/:brandId/campaign-targets[?pricing=]` (customer Today page, one row of cards
 * per ongoing funnel campaign, on its Target). Composes reads the campaign already has: its funnel people (activity Gold
 * cell), its pipes' dated outcomes and its spend (spend charts Gold cell, net by default), its stored plan line (the
 * factory pass: the projection's cost per Target and the Target's value) and its daily budget (billing caps). Pure rule
 * in `lib/campaign-targets.ts`.
 */
import { stepsOfPipeId, unitStepsOf } from "../lib/target-only-units.js";
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { funnelCampaignActivity } from "./sales-funnel-campaign-activity.js";
import { funnelCampaignSpendCharts } from "./spend-charts.js";
import { readPlan } from "../lib/factory-shadow-store.js";
import { listOutcomeRungs } from "../lib/outcome-rungs-store.js";
import { fetchFunnelCampaignDailyBudgetUsd } from "../lib/funnel-campaign-budget-client.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import { campaignTargetRowOf, offerTargetsOf, offerTargetFromLedger, PROJECTION_DAYS, type CampaignTargetInput, type CampaignTargetRow } from "../lib/campaign-targets.js";
import { milestoneChainOf, milestoneCardsOf, type MilestoneCard, type MilestoneCardInput } from "../lib/campaign-milestone-cards.js";
import { fetchCampaignLedgerUnits, sumLedgerUnits } from "../lib/campaign-ledger-units-client.js";
import { funnelCopiesFor } from "./agent-catalogue.js";
import { fetchBrandOutcomeLedger } from "../lib/scope-outcome-ledger-io.js";
import { ledgerKeysOfStep } from "../lib/ledger-counts.js";
import { scopeOutcomeLedgerRowOf, scopeOutcomeLedgerRows, type ScopeOutcomeLedgerInput } from "../lib/scope-outcome-ledger.js";
import { listDeclaredSteps } from "../lib/channel-declarations-store.js";
import { CHANNEL_STEPS } from "../lib/acquisition-channels.js";
import { NEW_LEAD_STATE_STEPS } from "../lib/lead-states.js";

const router = Router();

interface StoredPlanLeg {
  legKey: string;
  pipeId: string | null;
}
interface StoredPlanFigures {
  legs?: Array<{ legKey: string; outcomesNeededPerPayingClient: number | null }>;
  costPerTargetUsd?: number | null;
  basis?: string | null;
  unavailableReason?: string | null;
  targetValueUsd?: number | null;
}
interface StoredPlanBody {
  plan?: {
    target?: string;
    mode?: "proactive" | "reactive";
    running?: { funnelId?: string; reachesTarget?: boolean; unavailableReason?: string; legs?: StoredPlanLeg[]; figures?: StoredPlanFigures | null } | null;
    shadow?: { funnelId?: string; legs?: StoredPlanLeg[]; figures?: StoredPlanFigures | null } | null;
    shadowUnavailableReason?: string | null;
  } | null;
}

const titleOf = (key: string) => key.split("_").map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");

type TargetRowWithMilestones = CampaignTargetRow & { milestones: MilestoneCard[]; milestonesUnavailableReason: string | null; ledgerDaysMissing: string[]; ledgerOutcomeKeys: string[] };

async function rowFor(row: SalesFunnelCampaignRow, brandId: string, headers: DownstreamHeaders, pricing: Pricing, rungs: ReadonlyMap<string, string>, labels: ReadonlyMap<string, string>, now: string, brandLedger: ScopeOutcomeLedgerInput | null): Promise<{ row: TargetRowWithMilestones; input: CampaignTargetInput }> {
  const [activity, charts, stored, dailyBudgetUsd, copies, ledger] = await Promise.all([
    funnelCampaignActivity(row, brandId, headers, pricing),
    funnelCampaignSpendCharts(row, brandId, pricing, headers),
    readPlan(row.id),
    fetchFunnelCampaignDailyBudgetUsd(brandId, row, headers).catch((err: Error) => {
      console.error(`[features-service] campaign targets: daily budget of ${row.id} unreadable (projection on its spend pace): ${err.message}`);
      return null;
    }),
    funnelCopiesFor([row.salesFunnelId]),
    // The Units the campaign's runs produced (ledger). Unreadable = every milestone count null `ledger_unreadable` (LEDGER-ONLY-1107: no other count).
    Promise.all(row.units.map((u) => fetchCampaignLedgerUnits(u.campaignId)))
      .then(sumLedgerUnits)
      .catch((err: Error) => {
        console.error(`[features-service] campaign targets: ledger units of ${row.id} unreadable (milestone counts null): ${err.message}`);
        return null;
      }),
  ]);
  const plan = stored && stored.orgId === headers.orgId ? (stored.body as StoredPlanBody).plan ?? null : null;
  const funnelSteps = (activity.funnel?.steps ?? []).filter((s) => s.kind === "step");
  const targetKey = row.target ?? plan?.target ?? funnelSteps[funnelSteps.length - 1]?.key ?? null;
  const labelOf = (k: string) => funnelSteps.find((s) => s.key === k)?.label ?? labels.get(k) ?? titleOf(k);

  // The milestones: the campaign's units from Start to its Target (its own for its life, never the plan line).
  // BACKLINK-ENGINE-1109: a unit an Engine runs with no pipe makes its campaign's Target from Start.
  const stepsOfUnit = (u: (typeof row.units)[number]) => unitStepsOf(copies.pipeSteps, u, row);
  const edges = row.units.flatMap((u) => {
    const st = stepsOfUnit(u);
    return st ? [{ campaignId: u.campaignId, fromStep: st.fromStep, toStep: st.toStep }] : [];
  });
  // MIGRATE-1105 S5: a unit whose pipe's Engine makes a finer outcome (Threads post published on the leg to Post
  // published) lands its Units under that outcome; its milestone counts them too (a Unit has ONE outcome: no double count).
  const ledgerKeysOf = (step: string, unitCampaignIds: readonly string[]): string[] => {
    // LEDGER-ONLY-1107-P2: the step's ledger keys through the ONE resolver (a click is declared as `lead_visited`).
    const keys = new Set(ledgerKeysOfStep(step));
    for (const u of row.units) if (unitCampaignIds.includes(u.campaignId)) for (const k of ledgerKeysOfStep(stepsOfUnit(u)?.outcome ?? step)) keys.add(k);
    return [...keys].sort();
  };
  const notDeclared = (keys: readonly string[]): string | null => {
    if (brandLedger === null) return null;
    const r = scopeOutcomeLedgerRowOf(keys, brandLedger);
    return r.unitsUnavailableReason;
  };
  const ledgerOfMilestone = (step: string, unitCampaignIds: readonly string[]): Map<string, number> => {
    const keys = ledgerKeysOf(step, unitCampaignIds);
    const out = new Map<string, number>();
    for (const k of keys) for (const [day, n] of ledger?.byOutcome.get(k) ?? []) out.set(day, (out.get(day) ?? 0) + n);
    return out;
  };
  const chain = milestoneChainOf(edges, targetKey);
  const spendOf = (ids: readonly string[]) => {
    const own = charts.pipes.filter((p) => ids.includes(p.campaignId));
    if (own.length === ids.length) return own.reduce((a, p) => a + p.totals.spendUsd, 0);
    // BACKLINK-ENGINE-1109: a unit an Engine runs with no pipe has no pipe chart; a set holding every unit of the
    // campaign is the campaign's own spend.
    return row.units.every((u) => ids.includes(u.campaignId)) ? charts.campaign.totals.spendUsd : null;
  };
  // Expected outcomes of each step per ONE Target, off the plan line (outcomes needed per paying client, rescaled).
  const running = plan?.running?.reachesTarget ? plan.running : null;
  const line = running ?? plan?.shadow ?? null;
  const figures = line?.figures ?? null;
  const neededByStep = new Map<string, number>();
  for (const l of line?.legs ?? []) {
    const st = l.pipeId ? stepsOfPipeId(copies.pipeSteps, l.pipeId) : null;
    const f = (figures?.legs ?? []).find((x) => x.legKey === l.legKey);
    if (st && f?.outcomesNeededPerPayingClient != null) neededByStep.set(st.toStep, f.outcomesNeededPerPayingClient);
  }
  const neededAtTarget = targetKey ? neededByStep.get(targetKey) ?? null : null;
  let upTo = 0;
  let upToKnown = true;
  const cardInputs: MilestoneCardInput[] = chain.map((m) => {
    const own = m.unitCampaignIds.length > 0 ? spendOf(m.unitCampaignIds) : 0;
    if (own === null) upToKnown = false;
    else upTo += own;
    const needed = neededByStep.get(m.step);
    return {
      step: m.step,
      label: labelOf(m.step),
      lifecycleRung: rungs.get(m.step) ?? null,
      ledgerByDay: ledgerOfMilestone(m.step, m.unitCampaignIds),
      // LEDGER-ONLY-1107: an outcome no run declares (the brand consumed it, nobody produced it) is null, never counted elsewhere.
      ledgerUnavailableReason: ledger === null ? "ledger_unreadable" : notDeclared(ledgerKeysOf(m.step, m.unitCampaignIds)),
      ownSpendUsd: own,
      spendUpToUsd: upToKnown ? upTo : null,
      neededPerTarget: needed !== undefined && neededAtTarget !== null && neededAtTarget > 0 ? needed / neededAtTarget : null,
    };
  });
  // The Target's own card (counted like every milestone) gives the row its past; then the projection gives every card its pace.
  const unpaced = milestoneCardsOf({ milestones: cardInputs, targetOutcomesPerDay: null, targetProjectionUnavailableReason: null, projectionDays: PROJECTION_DAYS, now });
  const targetCard = targetKey ? unpaced.find((c) => c.step === targetKey) ?? null : null;

  const input: CampaignTargetInput = {
    salesFunnelCampaignId: row.id,
    name: row.salesFunnelName,
    offerId: row.offerId,
    mode: row.mode ?? plan?.mode ?? null,
    target: targetKey ? { key: targetKey, label: labelOf(targetKey), lifecycleRung: rungs.get(targetKey) ?? null } : null,
    targetDays: targetCard && targetCard.pastUnavailableReason === null ? targetCard.past.map((p) => ({ date: p.date, cumulativeOutcomes: p.cumulativeOutcomes })) : null,
    undatedTargetCount: targetCard?.count ?? null,
    spentUsd: charts.campaign.totals.spendUsd,
    spendByDay: charts.campaign.daily.map((d) => ({ date: d.date, spendUsd: d.spendUsd })),
    targetValueUsd: figures?.targetValueUsd ?? null,
    targetValueUnavailableReason: plan === null ? "plan_not_computed_yet" : figures === null ? "plan_has_no_line_to_target" : "target_has_no_value",
    plan: plan
      ? {
          computedAt: stored!.computedAt,
          funnelId: line?.funnelId ?? null,
          costPerTargetUsd: figures?.costPerTargetUsd ?? null,
          basis: figures?.basis ?? null,
          unavailableReason: figures?.unavailableReason ?? plan.running?.unavailableReason ?? plan.shadowUnavailableReason ?? null,
        }
      : null,
    dailyBudgetUsd,
    now,
  };
  const base = campaignTargetRowOf(input);
  const milestones = milestoneCardsOf({
    milestones: cardInputs,
    targetOutcomesPerDay: base.projection.outcomesPerDay,
    targetProjectionUnavailableReason: base.projection.unavailableReason,
    projectionDays: PROJECTION_DAYS,
    now,
  });
  return {
    input,
    row: {
      ...base,
      targetCountSource: targetCard?.countSource ?? null,
      milestones,
      milestonesUnavailableReason: chain.length === 0 ? "no_unit_reaches_a_step" : null,
      ledgerDaysMissing: ledger?.daysMissing ?? [],
      ledgerOutcomeKeys: targetKey ? ledgerKeysOf(targetKey, row.units.filter((u) => stepsOfUnit(u)?.toStep === targetKey).map((u) => u.campaignId)) : [],
    } as TargetRowWithMilestones,
  };
}

router.get("/brands/:brandId/campaign-targets", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string } };
    const { brandId } = auth.params;
    // $ per outcome on NET pricing by default (owner brief): what the client pays, discounts applied.
    const pricing = req.query.pricing === undefined ? "net" : parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const one = typeof req.query.salesFunnelCampaignId === "string" && req.query.salesFunnelCampaignId !== "" ? req.query.salesFunnelCampaignId : null;
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    if (one && !rows.some((r) => r.id === one)) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });
    // ONE Gold cell for the whole read (its own route's shape): its rows read the campaigns' activity and spend chart cells,
    // and a read that is no view of its own made the refresher replay this whole brand read once per cold nested cell
    // (prod 2026-11-06: 10 campaigns x 2 cells, every replay fanning out again, 502 at 200 s).
    const body = await servedCached({
      view: "brand-campaign-targets",
      scopeKey: buildScopeKey(brandId, { orgId: auth.orgId, pricing, campaign: one ?? "ongoing" }),
      orgId: auth.orgId,
      responseShape: routeResponseShapeFingerprint("/brands/{brandId}/campaign-targets"),
      compute: () => computeCampaignTargets(brandId, one, rows, headers, pricing),
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] campaign targets error:", err);
    res.status(502).json({ error: "Failed to read the brand's campaign Targets" });
  }
});

async function computeCampaignTargets(brandId: string, one: string | null, rows: readonly SalesFunnelCampaignRow[], headers: DownstreamHeaders, pricing: Pricing) {
  {
    const [rungs, declared] = await Promise.all([listOutcomeRungs(), listDeclaredSteps()]);
    const labels = new Map<string, string>([
      ...Object.entries(CHANNEL_STEPS).map(([k, v]) => [k, v.label] as const),
      ...NEW_LEAD_STATE_STEPS.map((s) => [s.key, s.label] as const),
      ...declared.map((d) => [d.key, d.label] as const),
    ]);
    // One campaign (the campaign page, any status) or every ONGOING one (Today).
    const picked = one ? rows.filter((r) => r.id === one) : rows.filter((r) => r.status === "ongoing");
    const ordered = [...picked].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const now = new Date().toISOString();
    // LEDGER-ONLY-1107: the brand's TOTAL Units per outcome in the general ledger (every source, every campaign). Unreadable =
    // every brand-total figure null `ledger_unreadable`, never a count from another source.
    const brandLedger = await fetchBrandOutcomeLedger(brandId, pricing === "gross" ? "gross" : "net").catch((err: Error) => {
      console.error(`[features-service] campaign targets: brand ledger of ${brandId} unreadable (brand totals null): ${err.message}`);
      return null;
    });
    const built = await mapWithConcurrency(ordered, 3, (r) => rowFor(r, brandId, headers, pricing, rungs, labels, now, brandLedger));
    const targets = built.map((b) => b.row);
    // TARGET-ROWS-UNIQUE-1107: Today reads ONE entry per (offer, Target), its campaigns merged; `targets` stays per campaign (campaign page).
    // LEDGER-ONLY-1107: each entry's count, $ each, spend, return and past are the BRAND's ledger total of its Target outcome.
    const keysByEntry = new Map<string, Set<string>>();
    for (const b of built) {
      const k = `${b.row.offerId}\u0000${b.row.target?.key ?? ""}`;
      const set = keysByEntry.get(k) ?? keysByEntry.set(k, new Set()).get(k)!;
      for (const x of b.row.ledgerOutcomeKeys) set.add(x);
    }
    const offerTargets = offerTargetsOf(built).map((e) => {
      const keys = [...(keysByEntry.get(`${e.offerId}\u0000${e.target?.key ?? ""}`) ?? [])];
      const member = built.find((b) => e.salesFunnelCampaignIds.includes(b.row.salesFunnelCampaignId) && b.input.targetValueUsd !== null) ?? built.find((b) => e.salesFunnelCampaignIds.includes(b.row.salesFunnelCampaignId))!;
      return offerTargetFromLedger(e, e.target === null || keys.length === 0 ? null : brandLedger === null ? "ledger_unreadable" : scopeOutcomeLedgerRowOf(keys, brandLedger), member.input.targetValueUsd, member.input.targetValueUnavailableReason, now);
    });
    const brandOutcomes =
      brandLedger === null ? null : scopeOutcomeLedgerRows(brandLedger).map((r) => ({ ...r, label: labels.get(r.outcomeKey) ?? titleOf(r.outcomeKey), lifecycleRung: rungs.get(r.outcomeKey) ?? null }));
    return {
      brandId,
      pricing,
      costBasis: "charged" as const,
      computedAt: now,
      targets,
      offerTargets,
      brandOutcomes,
      brandOutcomesUnavailableReason: brandLedger === null ? "ledger_unreadable" : null,
    };
  }
}

export default router;
