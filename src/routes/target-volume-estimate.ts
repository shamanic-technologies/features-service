/**
 * ONE-CAMPAIGN-VOLUME-1122: `GET /offers/:offerId/target-volume-estimate?brandId=&salesFunnelIds=a,b&target=<step>[&volume=&period=day|week|month]`.
 *
 * Before the campaign exists (the signup's campaign step), for this brand × offer × Target and the funnels the ONE
 * campaign will run underneath: what one Unit of the Target costs from Start as a 20th-80th percentile interval
 * (`perUnit`: multiply by a volume for its budget range, the dashboard may do it as the visitor types), and, for the
 * volume asked, the budget range per period, the campaign's max budget (the top of the range) and when the first Units
 * land then the steady pace. Every hypothesis named (pure `lib/target-volume-estimate.ts`).
 *
 * The heavy half (the offer's catalogue plan line, Silver's stored yields, delays and all-in costs, the draws) is ONE Gold
 * cell per (org, brand, offer, funnels, Target, Silver sweep); the volume is applied on every read, so typing a volume
 * costs nothing more than the stored cell.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { funnelById, rateBasisOf, SOURCED_STEP, stepLabel, type CatalogueModel, type CataloguePipe } from "../lib/agent-catalogue.js";
import type { ExpectedBasis } from "../lib/expected-return.js";
import { DEFAULT_ENTRY_RATE_PCT, defaultLegRatePct } from "../lib/default-leg-rates.js";
import { fleetLegRatePct } from "../lib/fleet-leg-rates.js";
import type { ChannelStepKey } from "../lib/acquisition-channels.js";
import { milestoneChainOf } from "../lib/campaign-milestone-cards.js";
import { ledgerKeysOfStep } from "../lib/ledger-counts.js";
import { readCurrentSilverSweep, readSilverStats } from "../lib/outcome-silver-io.js";
import { FLEET_SCOPE_ID, SILVER_RULE, type EntryCostStat, type TransitionStat } from "../lib/outcome-silver.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import { DeclarationError } from "../lib/channel-declarations.js";
import { loadCatalogueModelForOffer, offerContextFor, type OfferContext } from "./agent-catalogue.js";
import { VOLUME_ESTIMATE_RULE, VOLUME_PERIODS, volumeEstimateModelOf, volumeEstimateOf, type EstimateMilestone, type PlanRate, type VolumePeriod } from "../lib/target-volume-estimate.js";

const router = Router();
const PATH = "/offers/{offerId}/target-volume-estimate";
const TTL_MS = 10 * 60_000;
const MAX_VOLUME = 1_000_000;

const param = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const RANK: Record<ExpectedBasis, number> = { measured: 0, stated: 1, fleet: 2, default: 3 };
const weakest = (bases: ReadonlyArray<ExpectedBasis | null>): ExpectedBasis | null => bases.reduce<ExpectedBasis | null>((w, b) => (b === null ? w : w === null || RANK[b] > RANK[w] ? b : w), null);

interface EdgeInfo {
  pipe: CataloguePipe;
  ratePct: number | null;
  rateBasis: ExpectedBasis | null;
  costUsd: number | null;
  costBasis: ExpectedBasis | null;
}

/**
 * PURE. From the funnels the campaign runs underneath, the milestones from Start to the Target, the plan line's rate of
 * each transition and its cost of one Target from Start (the offer's catalogue: each leg's cost per outcome × the
 * outcomes one Target takes, the rate order brand measured > stated > fleet measured > default).
 */
export function chainAndPlanOf(model: CatalogueModel, offer: Pick<OfferContext, "rates">, funnelIds: readonly string[], target: string) {
  const edges: Array<{ campaignId: string; fromStep: string | null; toStep: string }> = [];
  const info = new Map<string, EdgeInfo>();
  for (const id of funnelIds) {
    const f = funnelById(model, id);
    if (!f) continue;
    f.legs.forEach((l, i) => {
      const p = l.pipe;
      if (!p) return;
      edges.push({ campaignId: p.id, fromStep: p.fromStep, toStep: p.toStep });
      const e = f.expected.legs[i];
      const key = `${p.fromStep ?? "start"}>${p.toStep}`;
      const held = info.get(key);
      const next: EdgeInfo = { pipe: p, ratePct: e?.ratePct ?? null, rateBasis: e?.rateBasis ?? null, costUsd: e?.costPerOutcomeUsd ?? null, costBasis: e?.costBasis ?? null };
      // A leg two funnels share keeps the reading holding a rate (a funnel's entry leg states none) and a cost.
      if (!held || (held.ratePct === null && next.ratePct !== null) || (held.costUsd === null && next.costUsd !== null)) info.set(key, { ...next, ratePct: next.ratePct ?? held?.ratePct ?? null, rateBasis: next.ratePct !== null ? next.rateBasis : held?.rateBasis ?? null, costUsd: next.costUsd ?? held?.costUsd ?? null, costBasis: next.costUsd !== null ? next.costBasis : held?.costBasis ?? null });
    });
  }
  const chain = milestoneChainOf(edges, target);
  const milestones: EstimateMilestone[] = chain.map((m) => {
    const keys = new Set(ledgerKeysOfStep(m.step));
    for (const e of edges) if (e.toStep === m.step) for (const k of ledgerKeysOfStep(info.get(`${e.fromStep ?? "start"}>${e.toStep}`)?.pipe.outcome ?? m.step)) keys.add(k);
    return { step: m.step, label: stepLabel(model, m.step), ledgerKeys: [...keys].sort() };
  });
  // The rate of each transition: the funnels' own, else the brand's, else the fleet's measured, else the defaults.
  const planRates: PlanRate[] = milestones.slice(0, -1).map((m, k) => {
    const to = milestones[k + 1]!.step;
    const e = info.get(`${m.step}>${to}`);
    if (e && e.ratePct !== null && e.ratePct > 0) return { ratePct: e.ratePct, basis: e.rateBasis };
    const own = offer.rates.get(`${m.step}>${to}`);
    if (own && own.ratePct > 0) return { ratePct: own.ratePct, basis: rateBasisOf(own.source) };
    const fleet = e ? fleetLegRatePct(model.fleetLegRates, e.pipe.computedLegKey, e.pipe.operatedBy === "platform" ? e.pipe.channelSlug : null) : null;
    if (fleet !== null && fleet > 0) return { ratePct: fleet, basis: "fleet" };
    const entry = m.step === SOURCED_STEP ? DEFAULT_ENTRY_RATE_PCT[to as ChannelStepKey] : undefined;
    if (entry !== undefined && entry > 0) return { ratePct: entry, basis: "default" };
    const def = defaultLegRatePct(m.step as ChannelStepKey, to as ChannelStepKey);
    return def !== null && def > 0 ? { ratePct: def, basis: "default" } : { ratePct: null, basis: null };
  });
  // The plan line's cost of one Target: each milestone's landing leg × the Units of it one Target takes.
  let needed = 1;
  let cost = 0;
  const bases: Array<ExpectedBasis | null> = [];
  let priced = true;
  for (let k = milestones.length - 1; k >= 0; k--) {
    const step = milestones[k]!.step;
    const from = k === 0 ? null : milestones[k - 1]!.step;
    const landing = from === null ? [...info.entries()].find(([key]) => key.endsWith(`>${step}`) && !milestones.some((m) => key === `${m.step}>${step}`))?.[1] : info.get(`${from}>${step}`);
    const legCost = landing ? (landing.pipe.operatedBy === "customer" ? 0 : landing.costUsd) : null;
    if (legCost === null) priced = false;
    else {
      cost += legCost * needed;
      if (landing!.pipe.operatedBy !== "customer") bases.push(landing!.costBasis);
    }
    if (k > 0) {
      const r = planRates[k - 1]!;
      if (r.ratePct === null) priced = false;
      else {
        needed /= r.ratePct / 100;
        bases.push(r.basis);
      }
    }
  }
  return { milestones, planRates, planCostPerTargetUsd: priced && cost > 0 ? cost : null, planCostBasis: priced && cost > 0 ? weakest(bases) : null };
}

async function computeModel(offer: OfferContext, funnelIds: readonly string[], target: string, sweptAt: string | null) {
  const model = await loadCatalogueModelForOffer(offer);
  const plan = chainAndPlanOf(model, offer, funnelIds, target);
  const [brand, fleet] = await Promise.all([sweptAt === null ? [] : readSilverStats("brand", offer.brandId), sweptAt === null ? [] : readSilverStats("fleet", FLEET_SCOPE_ID)]);
  const stats = new Map<string, TransitionStat>();
  const entry = new Map<string, EntryCostStat>();
  for (const r of [...brand, ...fleet]) {
    if (r.body.kind === "transition") stats.set(`${r.scope}\u0000${r.fromKey}\u0000${r.toKey}`, r.body.stat);
    else if (r.body.kind === "entry_cost") entry.set(`${r.scope}\u0000${r.toKey}`, r.body.stat);
  }
  const body = volumeEstimateModelOf({
    seed: `${offer.brandId}|${offer.offerId}|${[...funnelIds].sort().join("+")}|${target}`,
    milestones: plan.milestones,
    planRates: plan.planRates,
    planCostPerTargetUsd: plan.planCostPerTargetUsd,
    planCostBasis: plan.planCostBasis,
    transition: (scope, a, b) => stats.get(`${scope}\u0000${a}\u0000${b}`) ?? null,
    entryCost: (scope, key) => entry.get(`${scope}\u0000${key}`) ?? null,
    silverComputedAt: sweptAt,
  });
  return { target: { step: target, label: stepLabel(model, target) }, ...body };
}

router.get("/offers/:offerId/target-volume-estimate", apiKeyAuth, async (req, res) => {
  const auth = req as unknown as AuthenticatedRequest & { params: { offerId: string } };
  const offerId = auth.params.offerId;
  const brandId = param(req.query.brandId);
  const target = param(req.query.target);
  const funnelIds = [...new Set((param(req.query.salesFunnelIds) ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""))].sort();
  if (!brandId) return void res.status(400).json({ error: "brandId is required", reason: "brand_id_required" });
  if (!target) return void res.status(400).json({ error: "target is required (the step the campaign aims at)", reason: "target_required" });
  if (funnelIds.length === 0) return void res.status(400).json({ error: "salesFunnelIds is required (the funnels the campaign runs, comma separated)", reason: "sales_funnel_ids_required" });
  const volumeText = param(req.query.volume);
  const volume = volumeText === null ? null : Number(volumeText);
  if (volume !== null && !(Number.isFinite(volume) && volume > 0 && volume <= MAX_VOLUME)) return void res.status(400).json({ error: `volume must be a number above 0 and at most ${MAX_VOLUME}`, reason: "volume_unrecognised" });
  const periodText = param(req.query.period) ?? "week";
  if (!(VOLUME_PERIODS as readonly string[]).includes(periodText)) return void res.status(400).json({ error: "period must be one of: day, week, month", reason: "period_unrecognised" });
  const period = periodText as VolumePeriod;
  try {
    await assertBrandHeld(brandId, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId });
    const offer = await offerContextFor(offerId, brandId, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId });
    const model = await loadCatalogueModelForOffer(offer);
    const unknown = funnelIds.find((id) => !funnelById(model, id));
    if (unknown) return void res.status(400).json({ error: `no catalogue funnel ${unknown}`, reason: "sales_funnel_unknown" });
    if (!model.steps.has(target)) return void res.status(400).json({ error: `no catalogue step ${target}`, reason: "target_unknown" });
    const sweep = await readCurrentSilverSweep();
    const cell = await servedCached({
      view: "offer-target-volume-estimate",
      scopeKey: buildScopeKey(offerId, { orgId: auth.orgId, brandId, funnels: funnelIds.join("+"), target, silver: sweep?.sweptAt ?? "none", rule: SILVER_RULE, gold: VOLUME_ESTIMATE_RULE, rates: [...offer.rates].map(([k, r]) => `${k}=${r.ratePct}`).sort().join(",") }),
      orgId: auth.orgId,
      ttlMs: TTL_MS,
      responseShape: routeResponseShapeFingerprint(PATH),
      compute: () => computeModel(offer, funnelIds, target, sweep?.sweptAt ?? null),
    });
    const forVolume = volume === null ? null : volumeEstimateOf(cell, volume, period);
    res.json({
      offerId,
      brandId,
      salesFunnelIds: funnelIds,
      target: cell.target,
      basis: cell.basis,
      isExpected: cell.isExpected,
      unavailableReason: cell.unavailableReason,
      perUnit: cell.perUnit,
      volume: forVolume === null ? null : { volume: forVolume.volume, period: forVolume.period },
      budget: forVolume?.budget ?? null,
      timing: forVolume?.timing ?? null,
      rampShareByWeek: cell.rampShareByWeek,
      hypotheses: cell.hypotheses,
      silverComputedAt: cell.silverComputedAt,
      rule: cell.rule,
    });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    if (err instanceof DeclarationError && err.status === 404) return void res.status(404).json({ error: err.message, reason: "offer_not_found" });
    console.error(`[features-service] target volume estimate for offer ${offerId} (brand ${brandId}):`, err);
    res.status(502).json({ error: (err as Error).message, reason: "estimate_unreadable" });
  }
});

export default router;
