/**
 * ONE SALES FUNNEL CAMPAIGN'S FUNNEL AND ITS PIPES' WORK, SINCE INCEPTION (owner 2026-10-11, the campaign page).
 *
 *   GET /brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/activity
 *
 * Serves, so the browser counts and divides nothing:
 *   - `funnel.steps`: every step of the campaign's path in PEOPLE, with the rate to the next step
 *     (`lib/funnel-campaign-activity.ts` states who the people are and where each count comes from);
 *   - `pipes[]`: one per unit campaign (pipe) — what it did and produced. A pipe that takes people over (it starts on
 *     a step other than Lead found: AI Meeting Booking, AI Instant Call) serves the people it was handed, acted on and
 *     brought to its own `to` step, in total and per UTC day. An outreach pipe serves its lead-service people counts
 *     (its day-by-day series is the unit campaign's own revenue read, `dailySource`). A sourcing pipe hands its leads
 *     to the outreach pipe (counted there).
 * Money (invested, ROI) is the funnel campaigns table read's (`routes/sales-funnel-campaigns.ts`), never re-served here.
 * Since inception only. Producers unreadable = 502; an unknown campaign = 404 `sales_funnel_campaign_not_found`.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelUnitRow } from "./sales-funnel-campaigns.js";
import { funnelCopiesFor } from "./agent-catalogue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchLeadBucketCounts, type LeadBucketCounts } from "../lib/lead-bucket-counts-client.js";
import { fetchFollowupActionRows, type FollowupActionRow } from "../lib/followup-actions-client.js";
import { fetchStepOutcomes } from "../lib/step-outcomes-client.js";
import { isInternalPipe } from "../lib/meeting-leg-fleet.js";
import { fetchCampaignCalls, type CampaignCalls } from "../lib/campaign-calls-client.js";
import { fetchRunsCostCents } from "../lib/runs-cost-client.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import {
  ACT_IS_OUTCOME_STEPS,
  OUTCOME_EVENT_OF_STEP,
  BUCKET_OF_STEP,
  earliestOutcomeByLead,
  internalPipeWork,
  proactiveFunnelSteps,
  reactiveFunnelSteps,
  type FunnelActivityStep,
  type PathStep,
  type PipeWork,
} from "../lib/funnel-campaign-activity.js";

const router = Router();

type PipeKind = "sourcing" | "outreach" | "takeover";

interface PipeActivity {
  campaignId: string;
  pipeId: string;
  featureSlug: string;
  legKey: string;
  status: string;
  fromStep: string | null;
  toStep: string | null;
  kind: PipeKind | null;
  /** Outreach pipe: its lead-service people counts (Lead found = `found`). */
  people: { found: number; contacted: number; sent: number; delivered: number; reachedToStep: number | null } | null;
  /** Takeover pipe: handed / acted on / reached, in total and per UTC day. */
  work: PipeWork | null;
  /** Where this pipe's day-by-day series lives when it is not `work.daily`. */
  dailySource: "campaign_revenue" | null;
  /** A pipe performing a call step: the calls it placed (twillio-service) and their cost, else null + `callsUnavailableReason`. */
  calls: PipeCalls | null;
  callsUnavailableReason: string | null;
}

/** twillio-service's counts, plus the pipe's committed spend over them (runs-service, the requested pricing basis). */
export type PipeCalls = CampaignCalls & {
  spend: { committedUsd: number; costPerPlacedCallUsd: number | null; costPerConnectedCallUsd: number | null } | null;
  spendUnavailableReason: "spend_unreadable" | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** PURE: the call block with its cost per call placed / per booking call obtained (connected). Null ratio on 0 calls. */
export function pipeCalls(calls: CampaignCalls, committedCents: number | null): PipeCalls {
  if (committedCents === null) return { ...calls, spend: null, spendUnavailableReason: "spend_unreadable" };
  const usd = committedCents / 100;
  const per = (n: number) => (n > 0 ? round2(usd / n) : null);
  return { ...calls, spend: { committedUsd: round2(usd), costPerPlacedCallUsd: per(calls.totals.placed), costPerConnectedCallUsd: per(calls.totals.connected) }, spendUnavailableReason: null };
}

export interface FunnelCampaignActivityBody {
  salesFunnelCampaignId: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  name: string;
  createdAt: string;
  basis: "people_since_inception";
  pricing: Pricing;
  funnel: { mode: "proactive" | "reactive"; steps: FunnelActivityStep[] } | null;
  funnelUnavailableReason: string | null;
  pipes: PipeActivity[];
}

const CALL_STEP = "booking_call";

router.get("/brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/activity", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; salesFunnelCampaignId: string } };
    const { brandId, salesFunnelCampaignId } = auth.params;
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === salesFunnelCampaignId);
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });

    const body = await servedCached<FunnelCampaignActivityBody>({
      view: "sales-funnel-campaign-activity",
      scopeKey: buildScopeKey(row.id, {
        orgId: headers.orgId,
        brandId,
        units: row.units.map((u) => `${u.campaignId}:${u.pipeId}`).sort().join("+"),
        pricing,
      }),
      orgId: headers.orgId,
      compute: async () => {
        const { copies, pipeSteps } = await funnelCopiesFor([row.salesFunnelId]);
        const copy = copies.get(row.salesFunnelId) ?? null;
        const path: PathStep[] = copy ? copy.path.items.flatMap((i) => (i.kind === "step" && i.key !== "start" ? [{ key: i.key, label: i.label }] : [])) : [];
        const stepsOf = (u: SalesFunnelUnitRow) => pipeSteps.get(u.pipeId) ?? null;
        const kindOf = (u: SalesFunnelUnitRow): PipeKind | null => {
          const s = stepsOf(u);
          if (!s) return null;
          if (s.fromStep === null || s.fromStep === "start") return "sourcing";
          return isInternalPipe(s.fromStep) ? "takeover" : "outreach";
        };
        const outreach = row.units.filter((u) => kindOf(u) === "outreach");
        const takeover = row.units.filter((u) => kindOf(u) === "takeover");

        // Reads, in parallel: each outreach unit's people counts, the takeover units' ledger, the call figures.
        const callUnits = takeover.filter((u) => stepsOf(u)?.toStep === CALL_STEP);
        const [bucketByUnit, ledger, callsByUnit, callSpendByUnit] = await Promise.all([
          Promise.all(outreach.map(async (u) => [u.campaignId, await fetchLeadBucketCounts(u.campaignId, headers)] as const)).then((e) => new Map<string, LeadBucketCounts>(e)),
          takeover.length > 0 ? fetchFollowupActionRows(brandId, takeover.map((u) => u.campaignId)) : Promise.resolve([] as FollowupActionRow[]),
          // The call figures ride FAIL-SOFT with a loud log: an unreadable twillio-service leaves the pipe's `calls`
          // null + `calls_unreadable`, never a 502 of the whole funnel.
          callUnits.length > 0
            ? fetchCampaignCalls(callUnits.map((u) => u.campaignId), headers).catch((err: Error) => {
                console.error(`[features-service] funnel campaign ${row.id}: twillio-service calls unreadable (calls null): ${err.message}`);
                return new Map<string, CampaignCalls>();
              })
            : Promise.resolve(new Map<string, CampaignCalls>()),
          // Each call pipe's committed spend (FAIL-SOFT per pipe: the calls stay served, `spend_unreadable`).
          Promise.all(callUnits.map(async (u) => {
            const cents = await fetchRunsCostCents(brandId, u.campaignId, u.featureSlug, headers, pricing).then((c) => c.committedCents).catch((err: Error) => {
              console.error(`[features-service] funnel campaign ${row.id}: spend of call pipe ${u.campaignId} unreadable (spend null): ${err.message}`);
              return null;
            });
            return [u.campaignId, cents] as const;
          })).then((e) => new Map<string, number | null>(e)),
        ]);

        // The attributed outcomes a takeover pipe or a reactive funnel step reads, one read per event.
        const isReactive = copy !== null && copy.firstStep !== null && copy.firstStep !== "lead_found";
        const events = new Set<string>();
        for (const u of takeover) {
          const to = stepsOf(u)?.toStep;
          if (to && !ACT_IS_OUTCOME_STEPS.has(to) && OUTCOME_EVENT_OF_STEP[to]) events.add(OUTCOME_EVENT_OF_STEP[to]);
        }
        if (isReactive) for (const s of path.slice(1)) if (OUTCOME_EVENT_OF_STEP[s.key]) events.add(OUTCOME_EVENT_OF_STEP[s.key]);
        const outcomesByEvent = new Map(
          await Promise.all([...events].map(async (e) => [e, earliestOutcomeByLead(await fetchStepOutcomes(brandId, e as Parameters<typeof fetchStepOutcomes>[1]))] as const)),
        );
        const reachedAtFor = (step: string | null | undefined) => {
          const e = step ? OUTCOME_EVENT_OF_STEP[step] : undefined;
          return e ? outcomesByEvent.get(e) ?? null : null;
        };

        const pipes: PipeActivity[] = row.units.map((u) => {
          const s = stepsOf(u);
          const kind = kindOf(u);
          const base = { campaignId: u.campaignId, pipeId: u.pipeId, featureSlug: u.featureSlug, legKey: u.legKey, status: u.status, fromStep: s?.fromStep ?? null, toStep: s?.toStep ?? null, kind };
          const isCall = s?.toStep === CALL_STEP;
          const raw = isCall ? callsByUnit.get(u.campaignId) ?? null : null;
          const calls = raw ? pipeCalls(raw, callSpendByUnit.get(u.campaignId) ?? null) : null;
          const callsUnavailableReason = isCall ? (calls ? null : "calls_unreadable") : "pipe_places_no_calls";
          if (kind === "outreach") {
            const b = bucketByUnit.get(u.campaignId)!;
            const toBucket = s ? BUCKET_OF_STEP[s.toStep] : undefined;
            return {
              ...base,
              people: { found: b.total, contacted: b.counts.contacted ?? 0, sent: b.people.sent, delivered: b.people.delivered, reachedToStep: toBucket && typeof b.counts[toBucket] === "number" ? b.counts[toBucket] : null },
              work: null,
              dailySource: "campaign_revenue" as const,
              calls,
              callsUnavailableReason,
            };
          }
          if (kind === "takeover") {
            const own = ledger.filter((r) => r.actingCampaignId === u.campaignId);
            return { ...base, people: null, work: internalPipeWork(s!.toStep, own, reachedAtFor(s!.toStep)), dailySource: null, calls, callsUnavailableReason };
          }
          return { ...base, people: null, work: null, dailySource: null, calls, callsUnavailableReason };
        });

        // THE FUNNEL.
        let funnel: FunnelCampaignActivityBody["funnel"] = null;
        let funnelUnavailableReason: string | null = null;
        if (!copy) funnelUnavailableReason = "sales_funnel_not_in_catalogue";
        else if (!isReactive) {
          if (outreach.length === 0) funnelUnavailableReason = "no_outreach_pipe";
          else if (outreach.length > 1) funnelUnavailableReason = "several_outreach_pipes";
          else funnel = { mode: "proactive", steps: proactiveFunnelSteps(path, bucketByUnit.get(outreach[0].campaignId)!) };
        } else {
          const handed = new Set(ledger.map((r) => r.leadId));
          const actedByStep = new Map<string, Set<string>>();
          for (const u of takeover) {
            const to = stepsOf(u)?.toStep;
            if (!to || !ACT_IS_OUTCOME_STEPS.has(to)) continue;
            const set = actedByStep.get(to) ?? new Set<string>();
            for (const r of ledger) if (r.actingCampaignId === u.campaignId && r.actedCount > 0) set.add(r.leadId);
            actedByStep.set(to, set);
          }
          const outcomeLeads = new Map<string, Set<string> | null>(path.map((p) => {
            const m = reachedAtFor(p.key);
            return [p.key, m ? new Set(m.keys()) : null] as const;
          }));
          funnel = { mode: "reactive", steps: reactiveFunnelSteps(path, handed, actedByStep, outcomeLeads) };
        }

        return {
          salesFunnelCampaignId: row.id,
          brandId,
          offerId: row.offerId,
          salesFunnelId: row.salesFunnelId,
          name: row.salesFunnelName,
          createdAt: row.createdAt,
          basis: "people_since_inception",
          pricing,
          funnel,
          funnelUnavailableReason,
          pipes,
        };
      },
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] sales funnel campaign activity error:", err);
    res.status(502).json({ error: "Failed to read the sales funnel campaign's activity" });
  }
});

export default router;
