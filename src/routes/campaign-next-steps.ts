/**
 * WHAT COMES NEXT IN ONE SALES FUNNEL CAMPAIGN (owner 2026-10-18, CAMPAIGN-NEXT-STEPS-1018).
 *
 *   GET /brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/next-steps
 *
 * What our assistant reads to tell a client what happens next, with real figures (`lib/campaign-next-steps.ts`):
 *   - `emailSendQueue`: leads whose first email is queued, follow-ups queued, and when the sending window next opens
 *     in each lead's own business hours (instantly-service, over the campaign's units; a snapshot);
 *   - `scheduledFollowups`: the people the campaign's writers scheduled a follow-up for, on ANY channel (lead-service: a
 *     follow-up writer replies in Gmail threads, WhatsApp... and states a date there rather than queueing in a sender);
 *   - `nextSends`: both composed, what to say as "queued" and "next send" (NEXT-STEPS-ALL-CHANNELS-1019), and, when an
 *     Engine of the campaign cannot run, THE reason (`heldBy`) with the leads waiting at it, counted as queued
 *     (NEXT-STEPS-TRUE-REASON-1111: the Engine runner's latest refusals, `lib/engine-answers-store.ts`; the waiting leads
 *     = people served to the campaign with nothing of ours sent and nothing queued in the sender);
 *   - `timeToFirstPositiveReply`: the measured delay from a lead's first message (any channel) to its first positive reply, on this
 *     campaign once it holds enough replies, else on the same pipes across the fleet, else `learning` (since
 *     inception, never a window, never a default).
 * Accepts a unit campaign id too (a pipe of a campaign): the answer is its campaign's, with `requestedPipeId` set.
 * Each fact fails SOFT to a named null (the other still answers); campaign-service unreadable = 502; unknown = 404.
 */
import { pipeUnitsOf } from "../lib/target-only-units.js";
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { readHeldEngines } from "../lib/engine-answers-store.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { canonicalLegKey, chooseTimeToReply, composeNextSends, isReplyPipe, leadsWaitingAtEngine, type HeldEngine, type EmailSendQueue, type LatencyMetric, type NextSends, type ScheduledFollowups, type TimeToFirstPositiveReply } from "../lib/campaign-next-steps.js";
import { fetchEmailSendQueue, fetchReplyLatencyByCampaignGroups, fetchScheduledFollowups } from "../lib/campaign-next-steps-io.js";
import { readPipeFleetReplyLatency } from "./public.js";

const router = Router();

export interface CampaignNextStepsBody {
  salesFunnelCampaignId: string;
  name: string;
  status: string;
  brandId: string;
  offerId: string;
  /** Set when the id asked for was one pipe (unit campaign) of this campaign. */
  requestedPipeCampaignId: string | null;
  emailSendQueue: EmailSendQueue | null;
  emailSendQueueUnavailableReason: "sender_unreadable" | null;
  scheduledFollowups: ScheduledFollowups | null;
  scheduledFollowupsUnavailableReason: "follow_up_schedule_unreadable" | null;
  nextSends: NextSends;
  /** Every Engine of the campaign that cannot run now (latest answer in the last hour a refusal); null = unreadable. */
  heldEngines: HeldEngine[] | null;
  heldEnginesUnavailableReason: "engine_answers_unreadable" | null;
  timeToFirstPositiveReply: TimeToFirstPositiveReply;
  pipes: { campaignId: string; pipeId: string; featureSlug: string; legKey: string; status: string; endsOnPositiveReply: boolean }[];
}

export async function campaignNextSteps(
  row: SalesFunnelCampaignRow,
  orgId: string,
  requestedPipeCampaignId: string | null,
  identity: { userId?: string; runId?: string } = {},
): Promise<CampaignNextStepsBody> {
  const unitIds = row.units.map((u) => u.campaignId);
  // BACKLINK-ENGINE-1109: `pipes[]` and the reply latency read the units that run a pipe.
  const pipeUnits = pipeUnitsOf(row.units);
  const replyUnits = pipeUnits.filter((u) => isReplyPipe(u.legKey));
  const replyPipes = replyUnits.map((u) => ({ featureSlug: u.featureSlug, legKey: canonicalLegKey(u.legKey) }));

  const [queue, scheduled, latency, held] = await Promise.all([
    unitIds.length === 0
      ? Promise.resolve<EmailSendQueue | null>(null)
      : fetchEmailSendQueue(orgId, unitIds).catch((err: Error) => {
          console.error(`[features-service] next-steps: send queue unreadable for campaign ${row.id} (emailSendQueue null): ${err.message}`);
          return null;
        }),
    unitIds.length === 0
      ? Promise.resolve<ScheduledFollowups | null>(null)
      : fetchScheduledFollowups(orgId, unitIds).catch((err: Error) => {
          console.error(`[features-service] next-steps: follow-up schedule unreadable for campaign ${row.id} (scheduledFollowups null): ${err.message}`);
          return null;
        }),
    replyPipes.length === 0
      ? Promise.resolve({ campaign: null, pipeFleet: null, unreadable: false })
      : Promise.all([
          fetchReplyLatencyByCampaignGroups({ campaign: replyUnits.map((u) => u.campaignId) }).then((g) => g.campaign ?? { averageMs: null, medianMs: null, sampleSize: 0 }),
          readPipeFleetReplyLatency(replyPipes),
        ]).then(
          ([campaign, pipeFleet]): { campaign: LatencyMetric | null; pipeFleet: LatencyMetric | null; unreadable: boolean } => ({ campaign, pipeFleet, unreadable: false }),
          (err: Error) => {
            console.error(`[features-service] next-steps: reply latency unreadable for campaign ${row.id} (timeToFirstPositiveReply null): ${err.message}`);
            return { campaign: null, pipeFleet: null, unreadable: true };
          },
        ),
    readHeldEngines(unitIds).catch((err: Error): HeldEngine[] | null => {
      console.error(`[features-service] next-steps: engine answers unreadable for campaign ${row.id} (heldEngines null): ${err.message}`);
      return null;
    }),
  ]);

  // An Engine cannot run: count the people it holds back (served to the campaign, nothing of ours sent, not queued in the
  // sender). Read only then: one lead walk of the campaign.
  let waitingOnHeld: number | null = null;
  if (held && held.length > 0) {
    waitingOnHeld = await fetchLeadsForRevenue(row.brandId, unitIds, { orgId, userId: identity.userId, runId: identity.runId }).then(
      (persons) => leadsWaitingAtEngine(persons.filter((p) => !p.signals.contacted).length, queue),
      (err: Error) => {
        console.error(`[features-service] next-steps: leads unreadable for campaign ${row.id} (leadsWaitingOnHeldEngine null): ${err.message}`);
        return null;
      },
    );
  }

  return {
    salesFunnelCampaignId: row.id,
    name: row.salesFunnelName,
    status: row.status,
    brandId: row.brandId,
    offerId: row.offerId,
    requestedPipeCampaignId,
    emailSendQueue: queue,
    emailSendQueueUnavailableReason: queue === null && unitIds.length > 0 ? "sender_unreadable" : null,
    scheduledFollowups: scheduled,
    scheduledFollowupsUnavailableReason: scheduled === null && unitIds.length > 0 ? "follow_up_schedule_unreadable" : null,
    nextSends: composeNextSends({ scheduled, scheduledAsked: unitIds.length > 0, queue, queueAsked: unitIds.length > 0, held, waitingOnHeld }),
    heldEngines: held,
    heldEnginesUnavailableReason: held === null ? "engine_answers_unreadable" : null,
    timeToFirstPositiveReply: chooseTimeToReply({ hasReplyPipe: replyPipes.length > 0, ...latency }),
    pipes: pipeUnits.map((u) => ({ campaignId: u.campaignId, pipeId: u.pipeId, featureSlug: u.featureSlug, legKey: u.legKey, status: u.status, endsOnPositiveReply: isReplyPipe(u.legKey) })),
  };
}

router.get("/brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/next-steps", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; salesFunnelCampaignId: string } };
    const { brandId, salesFunnelCampaignId } = auth.params;
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === salesFunnelCampaignId) ?? rows.find((r) => r.units.some((u) => u.campaignId === salesFunnelCampaignId));
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });
    res.json(await campaignNextSteps(row, auth.orgId, row.id === salesFunnelCampaignId ? null : salesFunnelCampaignId, { userId: auth.userId, runId: auth.runId }));
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] campaign next steps error:", err);
    res.status(502).json({ error: "Failed to read the campaign's next steps" });
  }
});

export default router;
