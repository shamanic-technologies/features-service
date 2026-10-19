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
 *   - `nextSends`: both composed, what to say as "queued" and "next send" (NEXT-STEPS-ALL-CHANNELS-1019);
 *   - `timeToFirstPositiveReply`: the measured delay from a lead's first message (any channel) to its first positive reply, on this
 *     campaign once it holds enough replies, else on the same pipes across the fleet, else `learning` (since
 *     inception, never a window, never a default).
 * Accepts a unit campaign id too (a pipe of a campaign): the answer is its campaign's, with `requestedPipeId` set.
 * Each fact fails SOFT to a named null (the other still answers); campaign-service unreadable = 502; unknown = 404.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { canonicalLegKey, chooseTimeToReply, composeNextSends, isReplyPipe, type EmailSendQueue, type LatencyMetric, type NextSends, type ScheduledFollowups, type TimeToFirstPositiveReply } from "../lib/campaign-next-steps.js";
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
  timeToFirstPositiveReply: TimeToFirstPositiveReply;
  pipes: { campaignId: string; pipeId: string; featureSlug: string; legKey: string; status: string; endsOnPositiveReply: boolean }[];
}

export async function campaignNextSteps(row: SalesFunnelCampaignRow, orgId: string, requestedPipeCampaignId: string | null): Promise<CampaignNextStepsBody> {
  const unitIds = row.units.map((u) => u.campaignId);
  const replyUnits = row.units.filter((u) => isReplyPipe(u.legKey));
  const replyPipes = replyUnits.map((u) => ({ featureSlug: u.featureSlug, legKey: canonicalLegKey(u.legKey) }));

  const [queue, scheduled, latency] = await Promise.all([
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
  ]);

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
    nextSends: composeNextSends({ scheduled, scheduledAsked: unitIds.length > 0, queue, queueAsked: unitIds.length > 0 }),
    timeToFirstPositiveReply: chooseTimeToReply({ hasReplyPipe: replyPipes.length > 0, ...latency }),
    pipes: row.units.map((u) => ({ campaignId: u.campaignId, pipeId: u.pipeId, featureSlug: u.featureSlug, legKey: u.legKey, status: u.status, endsOnPositiveReply: isReplyPipe(u.legKey) })),
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
    res.json(await campaignNextSteps(row, auth.orgId, row.id === salesFunnelCampaignId ? null : salesFunnelCampaignId));
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] campaign next steps error:", err);
    res.status(502).json({ error: "Failed to read the campaign's next steps" });
  }
});

export default router;
