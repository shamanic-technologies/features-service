/**
 * PUBLIC FLEET INDEXES (owner 2026-10-18; `lib/fleet-indexes.ts`): `GET /public/indexes` (every index, today's
 * value) and `GET /public/indexes/:slug` (one index + every recorded day). No identity: an index names no org,
 * brand or campaign. Values are RECORDED by `startFleetIndexRecorder` (a minute after listen, then hourly) and
 * only read here, so a read is one small table read, never a fleet walk.
 */
import { Router } from "express";
import {
  FLEET_INDEXES,
  ROBUST_MIN_OUTCOMES,
  SCEO_FEATURE_SLUG,
  SCEO_POSITIVE_REPLY_LEG,
  SCEO_WEBSITE_VISIT_LEG,
  SIGNAL_MIN_OUTCOMES,
  bestMeetingPipePick,
  computeFleetIndexPoints,
  fleetIndexBySlug,
  type BrandEngagement,
  type ClientReturnInput,
  type FleetIndexDefinition,
  type MeetingPipeEvidence,
} from "../lib/fleet-indexes.js";
import { readFleetIndexSeries, readLatestFleetIndexPoints, recordFleetIndexPoints } from "../lib/fleet-index-store.js";
import { getInternalPipeFleet, MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, type MeetingLegFleet } from "../lib/meeting-leg-fleet.js";
import { meetingResearchPoints } from "../lib/research/pipe-series.js";
import { fetchFleetEngagementByBrand } from "../lib/fleet-positive-repliers.js";
import type { FleetIndexPointRow } from "../db/schema.js";
import { matchChannelLegKey } from "../lib/funnel-legs.js";
import { readFleetReturnOnSpend, readLegWorkflowRanking, readPublicRanked } from "./public.js";

const router = Router();

const STATUS_RULE = { signalMinOutcomes: SIGNAL_MIN_OUTCOMES, robustMinOutcomes: ROBUST_MIN_OUTCOMES } as const;

/** What each point's `basis` means, in words a landing page can show beside the curve (INDEX-HISTORY-BACKFILL-1019). */
const BASIS_RULE = {
  recorded: "Recorded live on that day.",
  recomputed:
    "Recomputed later with today's rules, on what had happened by the end of that day: the workflows running that week, their spend and the replies and human clicks dated by then.",
} as const;

function summaryOf(def: FleetIndexDefinition, row: FleetIndexPointRow | undefined) {
  return {
    slug: def.slug,
    name: def.name,
    channelSlug: def.channelSlug,
    channelName: def.channelName,
    outcome: def.outcome,
    metric: def.metric,
    unit: def.unit,
    valuePer: def.valuePer,
    method: def.method,
    day: row?.day ?? null,
    value: row?.value ?? null,
    status: row?.status ?? "noise",
    outcomes: row?.outcomes ?? 0,
    contacted: row?.contacted ?? null,
    workflowDynastySlug: row?.workflowDynastySlug ?? null,
    workflowDynastyName: row?.workflowDynastyName ?? null,
    unavailableReason: row ? row.unavailableReason : "not_recorded_yet",
    recordedAt: row ? row.recordedAt.toISOString() : null,
  };
}

router.get("/public/indexes", async (_req, res) => {
  try {
    const latest = new Map((await readLatestFleetIndexPoints()).map((r) => [r.indexSlug, r]));
    res.json({ statusRule: STATUS_RULE, indexes: FLEET_INDEXES.map((d) => summaryOf(d, latest.get(d.slug))) });
  } catch (error) {
    console.error("[features-service] GET /public/indexes failed:", error);
    res.status(500).json({ error: "fleet_indexes_unreadable" });
  }
});

router.get("/public/indexes/:slug", async (req, res) => {
  const def = fleetIndexBySlug(req.params.slug);
  if (!def) {
    res.status(404).json({ error: "index_not_found", slugs: FLEET_INDEXES.map((d) => d.slug) });
    return;
  }
  try {
    const series = await readFleetIndexSeries(def.slug);
    res.json({
      statusRule: STATUS_RULE,
      basisRule: BASIS_RULE,
      index: summaryOf(def, series[series.length - 1]),
      points: series.map((r) => ({
        day: r.day,
        value: r.value,
        status: r.status,
        outcomes: r.outcomes,
        contacted: r.contacted,
        workflowDynastySlug: r.workflowDynastySlug,
        workflowDynastyName: r.workflowDynastyName,
        unavailableReason: r.unavailableReason,
        basis: r.basis,
        inputs: r.inputs,
      })),
    });
  } catch (error) {
    console.error(`[features-service] GET /public/indexes/${def.slug} failed:`, error);
    res.status(500).json({ error: "fleet_index_unreadable" });
  }
});

const RANKING_WAIT_MS = 10 * 60_000;

// Spend per brand from the `/public/stats/ranked` cell the landing read before it read this index (INDEX-ENGAGED-ROI-1019);
// the landing hero now reads the index itself.
const RANKED_OBJECTIVE = "emailsSent";
const RANKED_LIMIT = 200;
// The owner's bar for the ROI median (« la médiane des clients ayant dépensé au moins $100 »), the landing's too.
const CLIENT_RETURN_MIN_SPEND_USD = 100;

function statOf(stats: Record<string, number | null>, key: string): number {
  const v = stats[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Every client brand's cold email spend (the ranked read) and engaged PERSONS: positive replies + clicks judged human
 * (the fleet person cell, owner 2026-10-19: a scanner's click is not a visit). Null (logged) when either is unreadable.
 */
async function readBrandEngagement(): Promise<BrandEngagement[] | null> {
  try {
    const [ranked, engaged] = await Promise.all([
      readPublicRanked(SCEO_FEATURE_SLUG, RANKED_OBJECTIVE, "brand", RANKED_LIMIT),
      fetchFleetEngagementByBrand(SCEO_FEATURE_SLUG),
    ]);
    return ranked.results.map((r) => {
      const e = r.brand ? engaged.get(r.brand.id) : undefined;
      return { positiveReplies: e?.positiveReplies ?? 0, humanClicks: e?.humanClicks ?? 0, spendCents: statOf(r.stats, "totalCostInUsdCents") };
    });
  } catch (error) {
    console.error("[features-service] fleet indexes: per-brand engagement unreadable:", error);
    return null;
  }
}

/** The fleet return median; null (logged) when unreadable or not computed yet (no point beats a false "not measured"). */
async function readClientReturn(): Promise<ClientReturnInput | null> {
  try {
    const r = await readFleetReturnOnSpend(SCEO_FEATURE_SLUG, CLIENT_RETURN_MIN_SPEND_USD);
    if (!r.measured && (r.reason === "no_snapshot_yet" || r.reason === "maturity_not_recorded_yet")) return null;
    return { measured: r.measured, reason: r.reason, brandCount: r.brandCount, minSpendUsd: r.minSpendUsd, medianReturnPerDollar: r.medianReturnPerDollar };
  } catch (error) {
    console.error("[features-service] fleet indexes: client return unreadable:", error);
    return null;
  }
}

function computationLegKey(servedLeg: string): string {
  const leg = matchChannelLegKey(SCEO_FEATURE_SLUG, servedLeg);
  if (!leg) throw new Error(`[features-service] fleet indexes: leg ${servedLeg} is not a leg of ${SCEO_FEATURE_SLUG}`);
  return leg;
}

/** One recording: read every input, write today's point of each index whose inputs were readable. */
export async function recordFleetIndexesNow(now = new Date()): Promise<number> {
  // The ranking is keyed on the leg's COMPUTATION spelling (the route resolves it the same way): asked with the served
  // outbound spelling, maturity read the leg as unknown (0 days, no cutoff) and no workflow was mature (2026-10-18).
  const visitLeg = computationLegKey(SCEO_WEBSITE_VISIT_LEG);
  const replyLeg = computationLegKey(SCEO_POSITIVE_REPLY_LEG);
  const [visit, reply, mbRanking, mbFleet, brandEngagement, clientReturn] = await Promise.all([
    readLegWorkflowRanking(SCEO_FEATURE_SLUG, visitLeg, RANKING_WAIT_MS),
    readLegWorkflowRanking(SCEO_FEATURE_SLUG, replyLeg, RANKING_WAIT_MS),
    // The meeting chain's second pipe: Positive reply -> Meeting booked (AI Meeting Booking), its own workflows.
    readLegWorkflowRanking(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, RANKING_WAIT_MS),
    getInternalPipeFleet(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, "meeting_booked").catch((error): MeetingLegFleet | null => {
      console.error("[features-service] fleet indexes: meeting pipe fleet unreadable:", error);
      return null;
    }),
    readBrandEngagement(),
    readClientReturn(),
  ]);
  if (!visit) console.warn("[features-service] fleet indexes: website-visit ranking unreadable, its indexes not recorded this tick");
  if (!reply) console.warn("[features-service] fleet indexes: positive-reply ranking unreadable, its indexes not recorded this tick");
  const meetingPipe: MeetingPipeEvidence | null = mbRanking?.computedAt && mbFleet ? { rows: mbRanking.rows, pooled: mbFleet.pooled } : null;
  if (!meetingPipe) console.warn("[features-service] fleet indexes: meeting pipe unreadable, meeting indexes not recorded this tick");
  const points = computeFleetIndexPoints({
    websiteVisitRows: visit?.computedAt ? visit.rows : null,
    positiveReplyRows: reply?.computedAt ? reply.rows : null,
    meetingPipe,
    brandEngagement,
    clientReturn,
  });
  // The meeting pipe's Research series (best workflow, median client) are recorded day by day beside the indexes.
  if (meetingPipe && mbFleet) points.push(...meetingResearchPoints(bestMeetingPipePick(meetingPipe), mbFleet.byOrg));
  await recordFleetIndexPoints(points, now);
  console.log(`[features-service] fleet indexes: recorded ${points.length} point(s) for ${now.toISOString().slice(0, 10)}`);
  return points.length;
}

const FIRST_RECORD_AFTER_MS = 60_000;
const RECORD_EVERY_MS = 60 * 60_000;
let recording = false;

function tick(): void {
  if (recording) return;
  recording = true;
  recordFleetIndexesNow()
    .catch((error) => console.error("[features-service] fleet indexes: recording failed, retried next tick:", error))
    .finally(() => {
      recording = false;
    });
}

/** First recording a minute after listen (a deploy restarts the process more often than once a day), then hourly. */
export function startFleetIndexRecorder(): void {
  const first = setTimeout(tick, FIRST_RECORD_AFTER_MS);
  first.unref?.();
  const every = setInterval(tick, RECORD_EVERY_MS);
  every.unref?.();
}

export default router;
