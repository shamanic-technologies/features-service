/**
 * GTM FACTORY STEP 1, SHADOW ONLY (owner 2026-10-28, FACTORY-P1-BRIEF-JUDGE-SHADOW-PLAN; pure rules `lib/factory-shadow.ts`).
 *
 * A stored pass (never on a read: `startFactoryShadowLoop`, 10 min after listen, then every 3 h, single flight) walks every
 * LIVE funnel campaign (campaign-service), asks Jev which play each pipe should run from the campaign's brief (judged once,
 * re-judged when the brief or the pipe's plays move), prices the best-ROI straight line to the campaign's Target beside the
 * running funnel, stores both per campaign and today's per-org counts for Monitoring. Nothing here changes what runs.
 *
 *   GET  /brands/:brandId/sales-funnel-campaigns/:id/factory-shadow   the campaign's last plan (org-scoped)
 *   GET  /internal/factory-shadow/monitoring?days=N                   daily series per org + the verdict (red = a judge or a
 *                                                                     plan failed on the last pass, or the pass is stale)
 *   POST /internal/factory-shadow/sweep                               run a pass now (202)
 *   POST /internal/factory-shadow/eval, GET /internal/factory-shadow/eval
 *        the judge's proof: on every live campaign, a brief written from the plays it runs today, Jev re-picks; agreement
 *        rate + every disagreement (run in the background, last result stored)
 */
import { Router } from "express";
import { apiKeyAuth, apiKeyOnly, type AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { fetchBrandLegEconomics, type BrandLegEconomics } from "../lib/brand-leg-economics-client.js";
import { offerLifetimeRevenue } from "../lib/offer-lifetime-revenue.js";
import { fetchOfferSteps, type OfferSteps } from "../lib/offer-steps-client.js";
import { loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { BRIEF_JUDGMENT_SUPPORT } from "../lib/platform-caller.js";
import type { CatalogueModel, CataloguePipe } from "../lib/agent-catalogue.js";
import type { ExpectedBasis } from "../lib/expected-return.js";
import {
  SWEEP_EVERY_MS,
  ShadowPlanError,
  briefHashOf,
  briefQuestion,
  briefState,
  evalBriefOf,
  judgingNeed,
  monitoringVerdict,
  orgDayCountsOf,
  pipesToJudge,
  prefillBriefOf,
  planCampaign,
  playNameOf,
  playOptionsOf,
  playsSignatureOf,
  runningPipesOf,
  type BriefJudgment,
  type PipePick,
  type PlayOption,
  type ShadowCampaign,
  type ShadowPlan,
  type ShadowRowSummary,
  type ShadowStatus,
} from "../lib/factory-shadow.js";
import { readDays, readJudgments, readPlan, readPlansSince, readPrefilledCampaignIds, recordPrefill, writeDay, writeJudgment, writePlan } from "../lib/factory-shadow-store.js";
import { loadCatalogueModelForLifetimeRevenue } from "./agent-catalogue.js";

const router = Router();

const JEV_TIMEOUT_MS = 60_000;
const JEV_CONCURRENCY = 3;
const CAMPAIGN_CONCURRENCY = 2;
const PASS_CELL = "factory-shadow:last-pass";
const EVAL_CELL = "factory-shadow:eval";
/** Written when the brief backfill is APPLIED: from then on every pass prefills new live campaigns. */
const PREFILL_CELL = "factory-shadow:prefill-backfill";

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────

/** Every LIVE funnel campaign of every org: campaign-service's units name their funnel campaign, read per (org, brand). */
async function readLiveFunnelCampaigns(): Promise<ShadowCampaign[]> {
  return (await readFunnelCampaigns()).filter((x) => x.status === "ongoing").map((x) => x.campaign);
}

/** Every funnel campaign of every org, any status. */
async function readFunnelCampaigns(): Promise<Array<{ campaign: ShadowCampaign; status: string }>> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { campaigns?: Array<{ orgId?: unknown; brandIds?: unknown; salesFunnelCampaignId?: unknown }> };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");
  const pairs = new Map<string, { orgId: string; brandId: string }>();
  for (const c of data.campaigns) {
    const brandId = Array.isArray(c.brandIds) && typeof c.brandIds[0] === "string" ? c.brandIds[0] : null;
    if (typeof c.salesFunnelCampaignId !== "string" || typeof c.orgId !== "string" || !brandId) continue;
    pairs.set(`${c.orgId}|${brandId}`, { orgId: c.orgId, brandId });
  }
  const rows = await mapWithConcurrency([...pairs.values()], 4, (p) => fetchSalesFunnelCampaigns(p.brandId, null, { orgId: p.orgId }).then((rs) => rs.map((r) => ({ r, orgId: p.orgId }))));
  return rows.flat().map(({ r, orgId }) => ({ campaign: shadowCampaignOf(r, orgId), status: r.status }));
}

/** "Running" = the funnel the campaign RUNS: campaign-service's `runningSalesFunnelId` (a campaign following its plan
 *  runs the plan's funnel), else the funnel it was born on (older campaign-service). */
export const runningFunnelIdOf = (r: Pick<SalesFunnelCampaignRow, "salesFunnelId" | "runningSalesFunnelId">): string => r.runningSalesFunnelId ?? r.salesFunnelId;

const shadowCampaignOf = (r: SalesFunnelCampaignRow, orgId: string): ShadowCampaign => ({
  id: r.id,
  orgId,
  brandId: r.brandId,
  offerId: r.offerId,
  salesFunnelId: runningFunnelIdOf(r),
  salesFunnelName: r.salesFunnelName,
  target: r.target ?? null,
  brief: r.brief ?? null,
  briefUpdatedAt: r.briefUpdatedAt ?? null,
  mode: r.mode ?? null,
  triggerId: r.triggerId ?? null,
});

/** Per-pass memos: one brand-service read per brand, one offer-steps read per offer, one model per lifetime revenue. */
function passMemos() {
  const econ = new Map<string, Promise<BrandLegEconomics>>();
  const steps = new Map<string, Promise<OfferSteps>>();
  const models = new Map<string, Promise<CatalogueModel>>();
  return {
    async pricing(c: ShadowCampaign): Promise<{ model: CatalogueModel; ltrBasis: ExpectedBasis }> {
      const key = `${c.orgId}|${c.brandId}`;
      if (!econ.has(key)) econ.set(key, fetchBrandLegEconomics(c.brandId, c.orgId));
      const offer = (await econ.get(key)!).offers.find((o) => o.offerId === c.offerId);
      if (!offer) throw new ShadowPlanError("offer_not_found", `offer ${c.offerId} is not an offer of brand ${c.brandId}`);
      const ltr = await offerLifetimeRevenue(offer.lifetimeRevenueUsd);
      const mkey = `${ltr.usd}|${ltr.source}`;
      if (!models.has(mkey)) models.set(mkey, loadCatalogueModelForLifetimeRevenue(ltr.usd, ltr.source));
      return { model: await models.get(mkey)!, ltrBasis: ltr.source === "offer_stated" ? "stated" : "fleet" };
    },
    offerSteps(c: ShadowCampaign): Promise<OfferSteps> {
      const key = `${c.orgId}|${c.brandId}|${c.offerId}`;
      if (!steps.has(key)) steps.set(key, fetchOfferSteps(c.brandId, c.offerId, { orgId: c.orgId }));
      return steps.get(key)!;
    },
  };
}

// ── The brief prefill (owner 2026-10-28, FACTORY-P1-BRIEF-PREFILL) ─────────────────────────────────

/** The identity a prefilled brief is attributed to at campaign-service (`briefUpdatedByUserId`). */
export const PREFILL_USER_ID = "system-features-service";

/** campaign-service owns the brief: written through its own PATCH, as a system identity, never over a stated brief. */
async function patchBrief(c: ShadowCampaign, brief: string): Promise<void> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${url}/sales-funnel-campaigns/${encodeURIComponent(c.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "x-org-id": c.orgId, "x-user-id": PREFILL_USER_ID },
    body: JSON.stringify({ brief }),
  });
  if (!res.ok) throw new Error(`campaign-service PATCH /sales-funnel-campaigns/${c.id} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

export interface PrefillRow {
  campaignId: string;
  orgId: string;
  brandId: string;
  salesFunnelName: string;
  status: string;
  /** `written` / `would_write` (dry run); `brief_stated` (never overwritten); `prefilled_before` (once per campaign, a
   *  cleared brief stays cleared); `plain_defaults` (no pipe runs a named strategy: an empty brief already picks them);
   *  `unreadable` (its funnel or offer could not be read). */
  outcome: "written" | "would_write" | "brief_stated" | "prefilled_before" | "plain_defaults" | "unreadable" | "write_failed";
  brief: string | null;
  failure: string | null;
}

/** Prefill the brief of every campaign given whose brief is empty and was never prefilled. `apply: false` = dry run. */
async function prefillBriefs(campaigns: ReadonlyArray<{ campaign: ShadowCampaign; status: string }>, apply: boolean, memos: ReturnType<typeof passMemos>): Promise<PrefillRow[]> {
  const done = await readPrefilledCampaignIds();
  return mapWithConcurrency(campaigns, CAMPAIGN_CONCURRENCY, async ({ campaign: c, status }) => {
    const row: PrefillRow = { campaignId: c.id, orgId: c.orgId, brandId: c.brandId, salesFunnelName: c.salesFunnelName, status, outcome: "plain_defaults", brief: null, failure: null };
    if (briefHashOf(c.brief) !== null) return { ...row, outcome: "brief_stated", brief: c.brief };
    if (done.has(c.id)) return { ...row, outcome: "prefilled_before" };
    let brief: string | null;
    try {
      brief = prefillBriefOf((await memos.pricing(c)).model, c.salesFunnelId);
    } catch (error) {
      return { ...row, outcome: "unreadable", failure: failureOf(error) };
    }
    if (brief === null) return row;
    if (!apply) return { ...row, outcome: "would_write", brief };
    try {
      await patchBrief(c, brief);
      await recordPrefill({ campaignId: c.id, orgId: c.orgId, brief });
      c.brief = brief;
      return { ...row, outcome: "written", brief };
    } catch (error) {
      console.error(`[features-service] factory brief prefill failed for campaign ${c.id}:`, error);
      return { ...row, outcome: "write_failed", brief, failure: failureOf(error) };
    }
  });
}

// ── Jev ────────────────────────────────────────────────────────────────────────────────────────────

interface JevPick {
  chosenPipeId: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
}

/** One Jev `choice` through chat-service's platform door (no org request stands behind a pass: a support mark). */
async function askJev(state: Record<string, unknown>, options: readonly PlayOption[]): Promise<JevPick> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(
    `${base}/internal/platform-judgments`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey }, body: JSON.stringify({ state, questions: { play: briefQuestion(options) }, support: BRIEF_JUDGMENT_SUPPORT }) },
    { timeoutMs: JEV_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown }> };
  const a = body.answers?.play;
  if (a?.type !== "choice" || typeof a.choice !== "string" || typeof a.confidence !== "number") throw new Error("chat-service answered without a readable choice");
  const index = Number(a.choice.slice(1));
  const chosen = a.choice.startsWith("o") && Number.isInteger(index) ? options[index] : undefined;
  if (!chosen) throw new Error(`chat-service picked ${a.choice}, not one of the plays offered`);
  const raw = (a.probabilities && typeof a.probabilities === "object" ? a.probabilities : { [a.choice]: 1 }) as Record<string, number>;
  const probabilities = Object.fromEntries(Object.entries(raw).map(([k, v]) => [options[Number(k.slice(1))]?.id ?? k, v]));
  if (typeof body.model !== "string" || body.model === "") throw new Error("chat-service answered without naming the model release");
  return { chosenPipeId: chosen.id, confidence: a.confidence, probabilities, model: body.model };
}

// ── One campaign ───────────────────────────────────────────────────────────────────────────────────

export interface ShadowBody {
  campaignId: string;
  orgId: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName: string;
  brief: string | null;
  briefUpdatedAt: string | null;
  status: ShadowStatus;
  failure: string | null;
  picks: PipePick[];
  pickDiffers: boolean;
  plan: ShadowPlan | null;
  computedAt: string;
}

/** Judge every pipe the campaign needs (stored verdicts reused), then plan. Never throws: a failure is the row's status. */
async function shadowOfCampaign(c: ShadowCampaign, memos: ReturnType<typeof passMemos>, stored: ReadonlyMap<string, BriefJudgment>, now: Date): Promise<ShadowBody> {
  const head = { campaignId: c.id, orgId: c.orgId, brandId: c.brandId, offerId: c.offerId, salesFunnelId: c.salesFunnelId, salesFunnelName: c.salesFunnelName, brief: c.brief, briefUpdatedAt: c.briefUpdatedAt, computedAt: now.toISOString() };
  let model: CatalogueModel;
  let ltrBasis: ExpectedBasis;
  let steps: OfferSteps;
  let toJudge: CataloguePipe[];
  try {
    ({ model, ltrBasis } = await memos.pricing(c));
    steps = await memos.offerSteps(c);
    toJudge = pipesToJudge(model, c);
  } catch (error) {
    return { ...head, status: "plan_failed", failure: failureOf(error), picks: [], pickDiffers: false, plan: null };
  }
  const running = runningPipesOf(model, c.salesFunnelId);
  const briefHash = briefHashOf(c.brief);
  const picks = new Map<string, string>();
  const pickRows: PipePick[] = [];
  const failures: string[] = [];
  await mapWithConcurrency(toJudge, JEV_CONCURRENCY, async (base) => {
    const options = playOptionsOf(model, base);
    const kept = stored.get(`${c.id}|${base.id}`) ?? null;
    const need = judgingNeed(kept, briefHash, options);
    let verdict: BriefJudgment | null = null;
    let failure: string | null = null;
    const signature = playsSignatureOf(options);
    if (need.kind === "stored" && kept && options.some((o) => o.id === kept.chosenPipeId)) verdict = kept;
    else if (need.kind === "default") {
      verdict = { campaignId: c.id, basePipeId: base.id, briefHash, playsSignature: signature, chosenPipeId: options[0].id, defaultPipeId: options[0].id, confidence: null, probabilities: null, model: null, source: need.source, judgedAt: now.toISOString() };
      if (!kept || kept.source !== need.source || kept.chosenPipeId !== verdict.chosenPipeId || kept.briefHash !== briefHash || kept.playsSignature !== signature) {
        await writeJudgment({ ...verdict, orgId: c.orgId, briefUpdatedAt: c.briefUpdatedAt });
      }
    } else {
      try {
        const a = await askJev(briefState(model, base, c.brief!), options);
        verdict = { campaignId: c.id, basePipeId: base.id, briefHash, playsSignature: signature, chosenPipeId: a.chosenPipeId, defaultPipeId: options[0].id, confidence: a.confidence, probabilities: a.probabilities, model: a.model, source: "jev", judgedAt: now.toISOString() };
        await writeJudgment({ ...verdict, orgId: c.orgId, briefUpdatedAt: c.briefUpdatedAt });
      } catch (error) {
        failure = failureOf(error);
        failures.push(`${base.id}: ${failure}`);
        console.error(`[features-service] factory shadow: brief judge failed for campaign ${c.id} pipe ${base.id}:`, error);
      }
    }
    if (verdict) picks.set(base.id, verdict.chosenPipeId);
    const run = running.get(base.id) ?? null;
    const picked = verdict ? (model.pipes.get(verdict.chosenPipeId) ?? model.plays.get(verdict.chosenPipeId) ?? null) : null;
    pickRows.push({
      basePipeId: base.id,
      channelName: base.channelName,
      inRunningFunnel: run !== null,
      runningPipeId: run?.id ?? null,
      runningPlayName: playNameOf(run),
      pickedPipeId: verdict?.chosenPipeId ?? null,
      pickedPlayName: playNameOf(picked),
      confidence: verdict?.confidence ?? null,
      source: verdict?.source ?? null,
      failure,
      differs: run && verdict ? run.id !== verdict.chosenPipeId : null,
    });
  });
  pickRows.sort((a, b) => Number(b.inRunningFunnel) - Number(a.inRunningFunnel) || (a.basePipeId < b.basePipeId ? -1 : 1));
  const pickDiffers = pickRows.some((p) => p.differs === true);
  let plan: ShadowPlan | null = null;
  try {
    plan = planCampaign(model, c, picks, steps, ltrBasis);
  } catch (error) {
    return { ...head, status: "plan_failed", failure: failureOf(error), picks: pickRows, pickDiffers, plan: null };
  }
  if (failures.length > 0) return { ...head, status: "judge_failed", failure: failures.join("; "), picks: pickRows, pickDiffers, plan };
  if (plan.shadow === null) return { ...head, status: "plan_failed", failure: plan.shadowUnavailableReason, picks: pickRows, pickDiffers, plan };
  return { ...head, status: "ok", failure: null, picks: pickRows, pickDiffers, plan };
}

const failureOf = (error: unknown): string => (error instanceof ShadowPlanError ? error.reason : (error as Error)?.message ?? String(error)).slice(0, 500);

// ── The pass ───────────────────────────────────────────────────────────────────────────────────────

interface PassRecord {
  sweptAt: string;
  campaigns: number;
  judgeFailed: number;
  planFailed: number;
  durationMs: number;
}

let passInFlight: Promise<PassRecord> | null = null;

/** One pass over every live funnel campaign (single flight). */
export function runFactoryShadowPass(): Promise<PassRecord> {
  passInFlight ??= (async () => {
    const started = Date.now();
    const now = new Date();
    const campaigns = await readLiveFunnelCampaigns();
    const memos = passMemos();
    // A campaign born after the prefill gets its brief here, before it is judged (FACTORY-P1-BRIEF-PREFILL); only once the
    // backfill was APPLIED (dry run first, owner 2026-10-28): before that, a pass writes nothing.
    const backfilled = (await loadFleetCell(PREFILL_CELL)) !== null;
    const prefilled = !backfilled ? [] : (await prefillBriefs(campaigns.map((campaign) => ({ campaign, status: "ongoing" })), true, memos)).filter((r) => r.outcome === "written");
    if (prefilled.length > 0) console.log(`[features-service] factory brief prefill: ${prefilled.length} campaign(s) given the brief of what they run today`);
    const stored = await readJudgments(campaigns.map((c) => c.id));
    const bodies = await mapWithConcurrency(campaigns, CAMPAIGN_CONCURRENCY, (c) => shadowOfCampaign(c, memos, stored, now));
    for (const b of bodies) await writePlan({ campaignId: b.campaignId, orgId: b.orgId, brandId: b.brandId, offerId: b.offerId, status: b.status, failure: b.failure, body: b, computedAt: now });
    const summaries: ShadowRowSummary[] = bodies.map((b) => ({ orgId: b.orgId, status: b.status, planDiffers: b.plan?.planDiffers ?? null, pickDiffers: b.pickDiffers }));
    await writeDay(now.toISOString().slice(0, 10), orgDayCountsOf(summaries), now);
    const record: PassRecord = {
      sweptAt: now.toISOString(),
      campaigns: bodies.length,
      judgeFailed: bodies.filter((b) => b.status === "judge_failed").length,
      planFailed: bodies.filter((b) => b.status === "plan_failed").length,
      durationMs: Date.now() - started,
    };
    await storeFleetCell(PASS_CELL, JSON.stringify(record), now.getTime());
    console.log(`[features-service] factory shadow pass: ${record.campaigns} campaigns, ${record.judgeFailed} judge failed, ${record.planFailed} plan failed, ${record.durationMs} ms`);
    return record;
  })().finally(() => {
    passInFlight = null;
  });
  return passInFlight;
}

/** 10 minutes after listen (the catalogue figures are warm by then), then every 3 hours. */
export function startFactoryShadowLoop(): void {
  const tick = () => void runFactoryShadowPass().catch((err) => console.error("[features-service] factory shadow pass failed:", err));
  setTimeout(tick, 600_000).unref();
  setInterval(tick, SWEEP_EVERY_MS).unref();
}

// ── The eval ───────────────────────────────────────────────────────────────────────────────────────

export interface EvalItem {
  campaignId: string;
  orgId: string;
  salesFunnelName: string;
  basePipeId: string;
  brief: string;
  expectedPipeId: string;
  pickedPipeId: string | null;
  confidence: number | null;
  agrees: boolean | null;
  failure: string | null;
}

export interface EvalResult {
  computedAt: string;
  campaigns: number;
  /** Pipes Jev was asked about (a campaign with at least one named strategy on a pipe that has plays). */
  judged: number;
  agreed: number;
  agreementPct: number | null;
  /** Pipes with plays on a campaign that runs only default plays: the brief is empty, the rule picks the default, no Jev. */
  emptyBriefPipes: number;
  failed: number;
  disagreements: EvalItem[];
  items: EvalItem[];
}

let evalInFlight: Promise<EvalResult> | null = null;

/** The judge's proof (see the header): never stored as verdicts, never read by a plan. */
export function runBriefJudgeEval(): Promise<EvalResult> {
  evalInFlight ??= (async () => {
    const campaigns = await readLiveFunnelCampaigns();
    const memos = passMemos();
    const items: EvalItem[] = [];
    let emptyBriefPipes = 0;
    await mapWithConcurrency(campaigns, CAMPAIGN_CONCURRENCY, async (c) => {
      let model: CatalogueModel;
      try {
        ({ model } = await memos.pricing(c));
      } catch (error) {
        console.error(`[features-service] factory shadow eval: campaign ${c.id} unreadable:`, error);
        return;
      }
      const { brief, expected } = evalBriefOf(model, c.salesFunnelId);
      if (brief === "") {
        emptyBriefPipes += expected.size;
        return;
      }
      await mapWithConcurrency([...expected], JEV_CONCURRENCY, async ([baseId, expectedPipeId]) => {
        const base = model.pipes.get(baseId)!;
        const item: EvalItem = { campaignId: c.id, orgId: c.orgId, salesFunnelName: c.salesFunnelName, basePipeId: baseId, brief, expectedPipeId, pickedPipeId: null, confidence: null, agrees: null, failure: null };
        try {
          const a = await askJev(briefState(model, base, brief), playOptionsOf(model, base));
          Object.assign(item, { pickedPipeId: a.chosenPipeId, confidence: a.confidence, agrees: a.chosenPipeId === expectedPipeId });
        } catch (error) {
          item.failure = failureOf(error);
        }
        items.push(item);
      });
    });
    items.sort((a, b) => (a.campaignId + a.basePipeId < b.campaignId + b.basePipeId ? -1 : 1));
    const judged = items.filter((i) => i.agrees !== null);
    const agreed = judged.filter((i) => i.agrees).length;
    const result: EvalResult = {
      computedAt: new Date().toISOString(),
      campaigns: campaigns.length,
      judged: judged.length,
      agreed,
      agreementPct: judged.length === 0 ? null : Math.round((1000 * agreed) / judged.length) / 10,
      emptyBriefPipes,
      failed: items.filter((i) => i.failure !== null).length,
      disagreements: judged.filter((i) => !i.agrees),
      items,
    };
    await storeFleetCell(EVAL_CELL, JSON.stringify(result), Date.now());
    return result;
  })().finally(() => {
    evalInFlight = null;
  });
  return evalInFlight;
}

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────────

router.get("/brands/:brandId/sales-funnel-campaigns/:id/factory-shadow", apiKeyAuth, async (req, res) => {
  const { orgId } = req as AuthenticatedRequest;
  try {
    const row = await readPlan(req.params.id);
    if (!row || row.orgId !== orgId || row.brandId !== req.params.brandId) {
      res.status(404).json({ error: "factory_shadow_not_computed", detail: "no shadow plan stored for this funnel campaign of this brand yet (a pass runs every 3 hours)" });
      return;
    }
    res.json(row.body);
  } catch (error) {
    console.error("[features-service] factory shadow read failed:", error);
    res.status(500).json({ error: "factory_shadow_unreadable" });
  }
});

router.get("/internal/factory-shadow/monitoring", apiKeyOnly, async (req, res) => {
  const days = req.query.days === undefined ? 30 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    res.status(400).json({ error: "days_unrecognised", detail: "days must be an integer between 1 and 90" });
    return;
  }
  try {
    const now = new Date();
    const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const [rows, passCell] = await Promise.all([readDays(since), loadFleetCell(PASS_CELL)]);
    const pass = passCell ? (JSON.parse(passCell.text) as PassRecord) : null;
    const byDay = new Map<string, typeof rows>();
    for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
    const series = [...byDay.entries()].map(([day, orgs]) => ({
      day,
      campaigns: orgs.reduce((s, o) => s + o.campaigns, 0),
      differs: orgs.reduce((s, o) => s + o.differs, 0),
      planDiffers: orgs.reduce((s, o) => s + o.planDiffers, 0),
      pickDiffers: orgs.reduce((s, o) => s + o.pickDiffers, 0),
      judgeFailed: orgs.reduce((s, o) => s + o.judgeFailed, 0),
      planFailed: orgs.reduce((s, o) => s + o.planFailed, 0),
      orgs: orgs.map(({ day: _d, sweptAt: _s, ...o }) => o),
    }));
    const latestPlans = pass ? (await readPlansSince(new Date(pass.sweptAt))).map((p) => {
      const b = p.body as ShadowBody;
      return {
        campaignId: p.campaignId,
        orgId: p.orgId,
        brandId: p.brandId,
        salesFunnelName: b.salesFunnelName,
        status: p.status,
        failure: p.failure,
        planDiffers: b.plan?.planDiffers ?? null,
        pickDiffers: b.pickDiffers,
      };
    }) : [];
    const verdict = monitoringVerdict({ sweptAt: pass?.sweptAt ?? null, judgeFailed: pass?.judgeFailed ?? 0, planFailed: pass?.planFailed ?? 0 }, now);
    res.json({ verdict, lastPass: pass, everyHours: SWEEP_EVERY_MS / 3_600_000, series, campaigns: latestPlans });
  } catch (error) {
    console.error("[features-service] factory shadow monitoring read failed:", error);
    res.status(500).json({ error: "factory_shadow_unreadable" });
  }
});

router.post("/internal/factory-shadow/sweep", apiKeyOnly, (_req, res) => {
  void runFactoryShadowPass().catch((err) => console.error("[features-service] factory shadow pass (kicked) failed:", err));
  res.status(202).json({ started: true });
});

router.post("/internal/factory-shadow/prefill-briefs", apiKeyOnly, async (req, res) => {
  const apply = req.body?.apply === true;
  try {
    const rows = await prefillBriefs(await readFunnelCampaigns(), apply, passMemos());
    if (apply) await storeFleetCell(PREFILL_CELL, JSON.stringify({ appliedAt: new Date().toISOString(), written: rows.filter((r) => r.outcome === "written").length }), Date.now());
    const count = (o: PrefillRow["outcome"]) => rows.filter((r) => r.outcome === o).length;
    res.json({
      apply,
      campaigns: rows.length,
      written: count("written"),
      wouldWrite: count("would_write"),
      briefStated: count("brief_stated"),
      prefilledBefore: count("prefilled_before"),
      plainDefaults: count("plain_defaults"),
      unreadable: count("unreadable"),
      writeFailed: count("write_failed"),
      rows,
    });
  } catch (error) {
    console.error("[features-service] factory brief prefill failed:", error);
    res.status(502).json({ error: "prefill_failed", detail: failureOf(error) });
  }
});

router.post("/internal/factory-shadow/eval", apiKeyOnly, (_req, res) => {
  void runBriefJudgeEval().catch((err) => console.error("[features-service] brief judge eval failed:", err));
  res.status(202).json({ started: true });
});

router.get("/internal/factory-shadow/eval", apiKeyOnly, async (_req, res) => {
  const cell = await loadFleetCell(EVAL_CELL);
  if (!cell) {
    res.status(404).json({ error: "eval_not_run_yet" });
    return;
  }
  res.type("application/json").send(cell.text);
});

export default router;
