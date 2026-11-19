/**
 * CAMPAIGN-CHANGE-LOG-1119: `GET /brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/changes[?limit=&cursor=]`.
 * The dated list of what changed on a campaign (which script serves each Engine, models and ways of writing included,
 * its budget, pauses, plan, brief, Target, strategies), newest first, each with its measured result and a verdict
 * (pure `lib/campaign-change-log.ts`). Every figure is served; the page computes none. A Gold cell on its own route's
 * shape: built in the view refresher from each owner's stored journal (never a fleet sweep on a read), the stored body
 * answers every read and is recomputed behind it at most every 10 minutes, and on each Silver sweep (stamp in the key).
 * No spend is served: a cap is a ceiling, never discounted, so no `pricing` applies.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import { listOutcomeLabels } from "../lib/outcome-labels.js";
import { readRunnableScriptsForCatalogue, scriptDynastyKey } from "../lib/script-catalogue-client.js";
import { readCurrentSilverSweep } from "../lib/outcome-silver-io.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { listEngineStrategyChanges } from "../lib/engine-strategy-io.js";
import { readCampaignCapChanges, readCampaignChangeHistory, readCampaignVersionReach, readFleetTransitions } from "../lib/campaign-change-log-io.js";
import {
  addDays,
  campaignChangeEventsOf,
  campaignChangesOf,
  CHANGE_KINDS,
  CHANGE_LOG_RULE,
  MAX_WINDOW_DAYS,
  MIN_ENGINE_DAY_DECISIONS,
  MIN_STEP_PAIRS,
  MIN_WINDOW_DAYS,
  SERVING_ENTER_SHARE,
  SERVING_LEAVE_SHARE,
  THIN_CASES,
  THIN_DECISIONS,
  TRIED_MIN_SCRIPTS,
  TRIED_SHARE,
  VERDICT_THRESHOLDS,
  WINDOW_MATURITY_MULTIPLE,
  type FleetTransition,
  type ServedChange,
} from "../lib/campaign-change-log.js";
import { BLEND_PSEUDO_CASES } from "../lib/outcome-forecast.js";

const router = Router();
const PATH = "/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/changes";
const TTL_MS = 10 * 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** The script decisions read start this many days before the campaign was born (what its Engines ran before). */
const READ_BEFORE_BIRTH_DAYS = 2 * MAX_WINDOW_DAYS;

/** The rules the list was built on, served so the page can word them and never restate a number of its own. */
export const CHANGE_LOG_RULES = {
  minEngineDayDecisions: MIN_ENGINE_DAY_DECISIONS,
  servingEnterShare: SERVING_ENTER_SHARE,
  servingLeaveShare: SERVING_LEAVE_SHARE,
  triedShare: TRIED_SHARE,
  triedMinScripts: TRIED_MIN_SCRIPTS,
  minStepPairs: MIN_STEP_PAIRS,
  windowMaturityMultiple: WINDOW_MATURITY_MULTIPLE,
  minWindowDays: MIN_WINDOW_DAYS,
  maxWindowDays: MAX_WINDOW_DAYS,
  blendPseudoCases: BLEND_PSEUDO_CASES,
  thinCases: THIN_CASES,
  thinDecisions: THIN_DECISIONS,
  verdictThresholds: VERDICT_THRESHOLDS,
} as const;

export async function computeCampaignChanges(row: SalesFunnelCampaignRow, headers: DownstreamHeaders, silverComputedAt: string | null) {
  const now = new Date();
  const owner = { orgId: headers.orgId, userId: headers.userId, runId: headers.runId };
  // The owners' journals first: the units it EVER had (a replaced unit's decisions are its history too).
  const [history, caps] = await Promise.all([readCampaignChangeHistory(row, owner), readCampaignCapChanges(row, owner)]);
  const unitIds = [...new Set([...history.units.map((u) => u.campaignId), ...row.units.map((u) => u.campaignId)])];
  const since = addDays(row.createdAt.slice(0, 10), -READ_BEFORE_BIRTH_DAYS);
  const [reach, scripts, labels, transitions, strategies, plays] = await Promise.all([
    readCampaignVersionReach(unitIds, since),
    readRunnableScriptsForCatalogue(),
    listOutcomeLabels(),
    // No sweep on today's rule = no measured step to read: every change says so.
    silverComputedAt === null ? Promise.resolve([] as FleetTransition[]) : readFleetTransitions(),
    listEngineStrategyChanges(unitIds),
    loadPlayCatalogue(),
  ]);
  const names = new Map(scripts.flatMap((s) => (s.name ? [[scriptDynastyKey(s), s.name] as const] : [])));
  const campaignEvents = campaignChangeEventsOf({ caps, transitions: history.statusTransitions, settings: history.settingChanges, plans: history.planChanges, strategies });
  const changes = campaignChangesOf({
    rows: reach.rows,
    campaignEvents,
    transitions,
    today: now.toISOString().slice(0, 10),
    scriptLabel: (d) => names.get(d) ?? null,
    strategyLabel: (id) => plays.strategies.get(id)?.name ?? null,
    outcomeLabel: labels,
  });
  return {
    salesFunnelCampaignId: row.id,
    name: row.salesFunnelName,
    computedAt: now.toISOString(),
    decisionsBuiltAt: reach.builtAt,
    silverComputedAt,
    /** Brief, Target, follows-its-plan and strategy changes are recorded from this day only (none invented before). */
    settingsRecordedSince: history.settingsRecordedSince,
    rules: CHANGE_LOG_RULES,
    kindsServed: CHANGE_KINDS,
    total: changes.length,
    changes,
  };
}

router.get("/brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/changes", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; salesFunnelCampaignId: string } };
    const { brandId, salesFunnelCampaignId } = auth.params;
    const limit = req.query.limit === undefined ? DEFAULT_LIMIT : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return void res.status(400).json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}`, reason: "limit_invalid" });
    const offset = req.query.cursor === undefined ? 0 : Number(req.query.cursor);
    if (!Number.isInteger(offset) || offset < 0) return void res.status(400).json({ error: "cursor is not a cursor this read served", reason: "cursor_invalid" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === salesFunnelCampaignId);
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });
    const sweep = await readCurrentSilverSweep();
    const body = await servedCached({
      view: "campaign-changes",
      scopeKey: buildScopeKey(row.id, { orgId: auth.orgId, brandId, rule: CHANGE_LOG_RULE, silver: sweep?.sweptAt ?? "none", units: row.units.map((u) => u.campaignId).sort().join("+") }),
      orgId: auth.orgId,
      ttlMs: TTL_MS,
      responseShape: routeResponseShapeFingerprint(PATH),
      compute: () => computeCampaignChanges(row, headers, sweep?.sweptAt ?? null),
    });
    const page: ServedChange[] = body.changes.slice(offset, offset + limit);
    res.json({ brandId, ...body, changes: page, nextCursor: offset + limit < body.total ? String(offset + limit) : null });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] campaign changes error:", err);
    res.status(502).json({ error: "Failed to read the campaign's changes" });
  }
});

export default router;
