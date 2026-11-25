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
  type ExpectedMeetingPrice,
  type FleetIndexDefinition,
  type FleetIndexPoint,
  type MeetingPipeEvidence,
} from "../lib/fleet-indexes.js";
import { lastRecordedTodayAt, readFleetIndexSeries, readLatestFleetIndexPoints, recordFleetIndexPoints } from "../lib/fleet-index-store.js";
import { storedCopyIsFresh } from "../lib/boot-warms.js";
import { RANGE_HIGH_PERCENTILE, RANGE_LOW_PERCENTILE, RANGE_RULE_TEXT, indexValueRange } from "../lib/fleet-index-range.js";
import { vendorLegPrice, vendorPooled, vendorRankingRows, type IndexRow, type PipeVendorTwin } from "../lib/fleet-index-vendor.js";
import { dailyBookSinceDay, loadDailyLedgerBook, runStartUntilOf, SCRIPTS_FIRST_DAY } from "../lib/ledger-book.js";
import { readRunnableScriptsForCatalogue, scriptDynastyKey } from "../lib/script-catalogue-client.js";
import { scriptKeyOf } from "../lib/research/engine-script-performance.js";
import { indexRowsWithHistory, scriptIndexRows, type IndexRowsBoth } from "../lib/script-index-rows.js";
import { legCutoffIso } from "../lib/maturity.js";
import { PUBLIC_COST_BASIS_TEXT, VENDOR_COST_UNKNOWN, vendorCoverage } from "../lib/public-vendor-cost.js";
import { meetingBookedPrice } from "../lib/outcome-prices.js";
import { fetchPublicCosts } from "../lib/public-stats-clients.js";
import { effectiveSpendSlugs } from "../lib/feature-scope.js";
import { getInternalPipeFleet, MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, type MeetingLegFleet } from "../lib/meeting-leg-fleet.js";
import { meetingResearchPoints } from "../lib/research/pipe-series.js";
import { fetchFleetEngagementByBrand } from "../lib/fleet-positive-repliers.js";
import type { FleetIndexPointRow } from "../db/schema.js";
import { matchChannelLegKey } from "../lib/funnel-legs.js";
import {
  computeFleetLegWorkflowMaturity,
  fleetPipeFigures,
  internalPipeSpendOn,
  readLegWorkflowRanking,
  readOutcomePricesMeetingBooked,
  readPublicRanked,
} from "./public.js";

const router = Router();

const STATUS_RULE = { signalMinOutcomes: SIGNAL_MIN_OUTCOMES, robustMinOutcomes: ROBUST_MIN_OUTCOMES } as const;

/** What each point's `basis` means, in words a landing page can show beside the curve (INDEX-HISTORY-BACKFILL-1019). */
const BASIS_RULE = {
  recorded: "Recorded live on that day.",
  recomputed:
    "Recomputed later with today's rules, on what had happened by the end of that day: the workflows that could run then, their spend and the replies and human clicks dated by then.",
} as const;

/** `expected` = the value is a quoted price, not a measurement (MEETING-INDEX-EXPECTED-1025); a landing labels it. */
function valueKindOf(row: FleetIndexPointRow | undefined): "measured" | "expected" {
  const inputs = row?.inputs as Record<string, unknown> | null | undefined;
  return inputs?.valueKind === "expected" ? "expected" : "measured";
}

/** How the likely range beside every value is read (INDEX-RANGE-1125), for the fine print. */
const RANGE_RULE = { lowPercentile: RANGE_LOW_PERCENTILE, highPercentile: RANGE_HIGH_PERCENTILE, text: RANGE_RULE_TEXT } as const;

/** The likely range of one stored point (INDEX-RANGE-1125): null + reason on a null or expected value. */
function rangeOf(def: FleetIndexDefinition, row: FleetIndexPointRow | undefined) {
  if (!row) return { valueRange: null, valueRangeUnavailableReason: "no_value" };
  return indexValueRange({
    indexSlug: def.slug,
    day: row.day,
    metric: def.metric,
    outcome: def.outcome,
    value: row.value,
    outcomes: row.outcomes,
    contacted: row.contacted,
    inputs: row.inputs as Record<string, unknown> | null,
  });
}

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
    valueKind: valueKindOf(row),
    recordedAt: row ? row.recordedAt.toISOString() : null,
    ...rangeOf(def, row),
  };
}

router.get("/public/indexes", async (_req, res) => {
  try {
    // Every money value a visitor reads is real vendor cost, before our markup, whole history (PUBLIC-VENDOR-COST-1031).
    const latest = new Map((await readLatestFleetIndexPoints("vendor")).map((r) => [r.indexSlug, r]));
    res.json({ statusRule: STATUS_RULE, rangeRule: RANGE_RULE, costBasis: "vendor", costBasisText: PUBLIC_COST_BASIS_TEXT, indexes: FLEET_INDEXES.map((d) => summaryOf(d, latest.get(d.slug))) });
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
    const series = await readFleetIndexSeries(def.slug, "vendor");
    res.json({
      statusRule: STATUS_RULE,
      basisRule: BASIS_RULE,
      rangeRule: RANGE_RULE,
      costBasis: "vendor",
      costBasisText: PUBLIC_COST_BASIS_TEXT,
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
        valueKind: valueKindOf(r),
        inputs: r.inputs,
        ...rangeOf(def, r),
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
      return {
        contacted: e?.contacted ?? 0,
        positiveReplies: e?.positiveReplies ?? 0,
        screenedContacted: e?.screenedContacted ?? 0,
        humanClicks: e?.humanClicks ?? 0,
        spendCents: statOf(r.stats, "totalCostInUsdCents"),
      };
    });
  } catch (error) {
    console.error("[features-service] fleet indexes: per-brand engagement unreadable:", error);
    return null;
  }
}

function computationLegKey(servedLeg: string): string {
  const leg = matchChannelLegKey(SCEO_FEATURE_SLUG, servedLeg);
  if (!leg) throw new Error(`[features-service] fleet indexes: leg ${servedLeg} is not a leg of ${SCEO_FEATURE_SLUG}`);
  return leg;
}

/**
 * The cold email indexes' rows today (PUBLIC-INDEXES-NULL-1117, `lib/script-index-rows.ts`): the `email_sent` Engine's
 * scripts on the daily ledger book, billed and vendor. Null (logged) when the book or the script catalogue cannot be read,
 * or when a PAST day of the scripts' era is missing from the book (the rule of `pipeScriptFigures`): their indexes then
 * record nothing this tick, never a null pretending to be a measure.
 */
export async function readScriptIndexRows(now = new Date()): Promise<ScriptIndexRowsNow | null> {
  try {
    const since = dailyBookSinceDay(now.getTime());
    const [gross, vendor, unpriced, runnableScripts] = await Promise.all([
      loadDailyLedgerBook("gross", since),
      loadDailyLedgerBook("vendor", since),
      loadDailyLedgerBook("unpricedGross", since),
      readRunnableScriptsForCatalogue(),
    ]);
    const today = now.toISOString().slice(0, 10);
    for (const read of [gross, vendor, unpriced]) {
      const stale = new Set(read.staleDays ?? []);
      const late = (read.missingDays ?? []).filter((d) => d >= SCRIPTS_FIRST_DAY && d < today && !stale.has(d));
      if (late.length > 0) {
        console.error(`[features-service] fleet indexes: the daily ledger book misses ${late.length} day(s) of the scripts' era (${late.slice(0, 5).join(",")}), cold email indexes not recorded this tick`);
        return null;
      }
    }
    const runnable = new Set(runnableScripts.map(scriptDynastyKey));
    const keyOf = scriptKeyOf([...runnable]);
    const books = { gross: gross.book, vendor: vendor.book, unpriced: unpriced.book };
    const rowsOf = (counts: string, servedLeg: string) => {
      const legKey = computationLegKey(servedLeg);
      const cutoffIso = legCutoffIso(legKey, now);
      return scriptIndexRows(counts, legKey, books, keyOf, runnable, cutoffIso ? runStartUntilOf(cutoffIso) : null);
    };
    return { visit: rowsOf("website_visit", SCEO_WEBSITE_VISIT_LEG), reply: rowsOf("conversation", SCEO_POSITIVE_REPLY_LEG) };
  } catch (error) {
    console.error("[features-service] fleet indexes: the cold email Engine's scripts are unreadable, their indexes not recorded this tick:", error);
    return null;
  }
}

/**
 * The pipe's workflow-era rows today, both bases (INDEX-HISTORY-1117): its stored leg workflow ranking (every workflow on
 * its whole history; all retired since MIGRATE-1105, figures kept) and the same rows at real vendor cost. Null (logged)
 * when the ranking is not built or its vendor twin cannot be read: the index then records nothing this tick.
 */
async function readWorkflowHistoryRows(servedLeg: string): Promise<IndexRowsBoth | null> {
  const legKey = computationLegKey(servedLeg);
  try {
    const ranking = await readLegWorkflowRanking(SCEO_FEATURE_SLUG, legKey, RANKING_WAIT_MS);
    if (!ranking?.computedAt) {
      console.warn(`[features-service] fleet indexes: the ${legKey} workflow ranking is not built, its indexes not recorded this tick`);
      return null;
    }
    return { billed: ranking.rows, vendor: vendorRankingRows(ranking.rows, await pipeVendorTwin(SCEO_FEATURE_SLUG, ranking.legKey)) };
  } catch (error) {
    console.error(`[features-service] fleet indexes: the ${legKey} workflow history is unreadable, its indexes not recorded this tick:`, error);
    return null;
  }
}

/**
 * The cold email indexes' rows today, EVERY era (INDEX-HISTORY-1117, `indexRowsWithHistory`): the Engine's scripts and the
 * pipe's workflows, each on its whole history. A leg whose scripts or workflows cannot be read records nothing.
 */
export async function readColdEmailIndexRows(now = new Date()): Promise<{ visit: IndexRowsBoth | null; reply: IndexRowsBoth | null }> {
  const scripts = await readScriptIndexRows(now);
  const visitHistory = await readWorkflowHistoryRows(SCEO_WEBSITE_VISIT_LEG);
  const replyHistory = await readWorkflowHistoryRows(SCEO_POSITIVE_REPLY_LEG);
  return {
    visit: scripts && visitHistory ? indexRowsWithHistory(scripts.visit, visitHistory) : null,
    reply: scripts && replyHistory ? indexRowsWithHistory(scripts.reply, replyHistory) : null,
  };
}

export interface ScriptIndexRowsNow {
  visit: { billed: IndexRow[]; vendor: IndexRow[] };
  reply: { billed: IndexRow[]; vendor: IndexRow[] };
}

/** One recording: read every input, write today's point of each index whose inputs were readable. */
export async function recordFleetIndexesNow(now = new Date()): Promise<number> {
  const [coldEmail, mbRanking, mbFleet, brandEngagement] = await Promise.all([
    readColdEmailIndexRows(now),
    // The meeting chain's second pipe: Positive reply -> Meeting booked (AI Meeting Booking), its own workflows.
    readLegWorkflowRanking(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, RANKING_WAIT_MS),
    getInternalPipeFleet(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, "meeting_booked").catch((error): MeetingLegFleet | null => {
      console.error("[features-service] fleet indexes: meeting pipe fleet unreadable:", error);
      return null;
    }),
    readBrandEngagement(),
  ]);
  // The Cost Per Meeting Index reads the ledger (MEETING-COST-METHODS-1024, owner 2026-10-24 « go ledger accounting direct »).
  const meetingLedger = await (await import("./research.js")).readLedgerMeetingCost();
  // While the ledger is not a price, the index serves the outcome prices' meeting price, labelled expected (MEETING-INDEX-EXPECTED-1025).
  const meetingExpected = await readExpectedMeetingPrice();
  const meetingPipe: MeetingPipeEvidence | null = mbRanking?.computedAt && mbFleet ? { rows: mbRanking.rows, pooled: mbFleet.pooled } : null;
  if (!meetingPipe) console.warn("[features-service] fleet indexes: meeting pipe unreadable, meeting indexes not recorded this tick");
  const points = computeFleetIndexPoints({
    websiteVisitRows: coldEmail.visit?.billed ?? null,
    positiveReplyRows: coldEmail.reply?.billed ?? null,
    meetingPipe,
    brandEngagement,
    meetingLedger,
    meetingExpected,
    bestAvailableStandsIn: true,
  });
  // The meeting pipe's Research series (best workflow, median client) are recorded day by day beside the indexes.
  if (meetingPipe && mbFleet) points.push(...meetingResearchPoints(bestMeetingPipePick(meetingPipe), mbFleet.byOrg));
  await recordFleetIndexPoints(points, now);
  console.log(`[features-service] fleet indexes: recorded ${points.length} point(s) for ${now.toISOString().slice(0, 10)}`);
  // The PUBLIC twin (PUBLIC-VENDOR-COST-1031): the same picks, every money value at real vendor cost. Its own failure
  // records nothing on the vendor basis this tick (logged); the billed series above stands.
  try {
    const vendorPoints = await vendorIndexPoints({ coldEmail, mbRanking, mbFleet, meetingExpected });
    await recordFleetIndexPoints(vendorPoints, now, "vendor");
    console.log(`[features-service] fleet indexes: recorded ${vendorPoints.length} vendor-cost point(s)`);
  } catch (error) {
    console.error("[features-service] fleet indexes: vendor-cost points not recorded this tick:", error);
  }
  return points.length;
}

export type Ranking = Awaited<ReturnType<typeof readLegWorkflowRanking>>;

/** One pipe's per-dynasty spend on the vendor basis and its unpriced twin, the billed figures' own population. */
async function pipeVendorTwin(featureSlug: string, legKey: string): Promise<PipeVendorTwin> {
  // One heavy vendor aggregation at a time (runs-service's vendor-priced fleet read takes ~16 s on a leg).
  const vendor = await fleetPipeFigures(featureSlug, legKey, "vendor");
  const unpriced = await fleetPipeFigures(featureSlug, legKey, "vendorUnpriced");
  return { vendor: new Map(vendor.byDynasty), unpriced: new Map(unpriced.byDynasty) };
}

/** The AI Meeting Booking pipe with its money at real vendor cost: the billed ranking's rows and pool, spend swapped. */
export async function vendorMeetingPipe(mbRanking: NonNullable<Ranking>, mbFleet: MeetingLegFleet): Promise<{ pipe: MeetingPipeEvidence; twin: PipeVendorTwin }> {
  const twin = await pipeVendorTwin(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY);
  const vendor = await internalPipeSpendOn(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, mbFleet, "vendor");
  const unpriced = await internalPipeSpendOn(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, mbFleet, "vendorUnpriced");
  return {
    pipe: { rows: vendorRankingRows(mbRanking.rows, twin), pooled: vendorPooled(mbFleet.pooled, vendor.pooledByDynasty, unpriced.pooledByDynasty) },
    twin,
  };
}

/**
 * Today's point of every index on the VENDOR basis: the billed ranking's picks (`lib/fleet-index-vendor.ts`), each money
 * value read on the vendor basis of the same rows. An input that cannot be read records nothing for its indexes.
 */
async function vendorIndexPoints(billed: {
  coldEmail: { visit: IndexRowsBoth | null; reply: IndexRowsBoth | null };
  mbRanking: Ranking;
  mbFleet: MeetingLegFleet | null;
  meetingExpected: ExpectedMeetingPrice | null;
}): Promise<FleetIndexPoint[]> {
  const visitRows = billed.coldEmail.visit?.vendor ?? null;
  const replyRows = billed.coldEmail.reply?.vendor ?? null;
  const vendorMeeting = billed.mbRanking?.computedAt && billed.mbFleet ? await vendorMeetingPipe(billed.mbRanking, billed.mbFleet) : null;
  const meetingPipe = vendorMeeting?.pipe ?? null;
  const meetingTwin = vendorMeeting?.twin ?? null;
  const [brandEngagement, meetingExpected] = await Promise.all([
    readVendorBrandEngagement(),
    meetingTwin ? readVendorExpectedMeetingPrice(meetingTwin) : Promise.resolve(null),
  ]);
  return computeFleetIndexPoints({
    websiteVisitRows: visitRows,
    positiveReplyRows: replyRows,
    meetingPipe,
    brandEngagement,
    // The ledger's figure is not a public price while it does not reconcile (its index reads expected meanwhile); the
    // vendor twin reads the vendor book through the same gate.
    meetingLedger: await (await import("./research.js")).readLedgerMeetingCost("vendor"),
    meetingExpected,
    bestAvailableStandsIn: true,
  });
}

/** Every client brand's cold email engagement with its spend at real vendor cost (null, logged, when unreadable). */
export async function readVendorBrandEngagement(): Promise<BrandEngagement[] | null> {
  try {
    const [ranked, engaged, vendor, unpriced] = await Promise.all([
      readPublicRanked(SCEO_FEATURE_SLUG, RANKED_OBJECTIVE, "brand", RANKED_LIMIT),
      fetchFleetEngagementByBrand(SCEO_FEATURE_SLUG),
      // The ranked read's own population (`fetchPublicCosts(slug, "brandId")`: incurred, fed), on the vendor basis.
      fetchPublicCosts(SCEO_FEATURE_SLUG, "brandId", "vendor", "incurred"),
      fetchPublicCosts(SCEO_FEATURE_SLUG, "brandId", "vendorUnpriced", "incurred"),
    ]);
    const cents = (groups: Awaited<ReturnType<typeof fetchPublicCosts>>) => {
      const m = new Map<string, number>();
      for (const g of groups) if (g.dimensions.brandId) m.set(g.dimensions.brandId, (m.get(g.dimensions.brandId) ?? 0) + Number(g.totalCostInUsdCents));
      return m;
    };
    const vendorByBrand = cents(vendor);
    const unpricedByBrand = cents(unpriced);
    return ranked.results.map((r) => {
      const id = r.brand?.id;
      const e = id ? engaged.get(id) : undefined;
      const billedCents = statOf(r.stats, "totalCostInUsdCents");
      const vendorCents = id ? (vendorByBrand.get(id) ?? 0) : 0;
      const cov = vendorCoverage(vendorCents / 100, (id ? (unpricedByBrand.get(id) ?? 0) : 0) / 100, billedCents / 100);
      return {
        contacted: e?.contacted ?? 0,
        positiveReplies: e?.positiveReplies ?? 0,
        screenedContacted: e?.screenedContacted ?? 0,
        humanClicks: e?.humanClicks ?? 0,
        spendCents: vendorCents,
        vendorCostUnknown: !cov.servable,
      };
    });
  } catch (error) {
    console.error("[features-service] fleet indexes: per-brand vendor spend unreadable:", error);
    return null;
  }
}

/** The outcome prices' meeting price with both legs at real vendor cost (the same picks); null when unreadable. */
async function readVendorExpectedMeetingPrice(meetingTwin: PipeVendorTwin): Promise<ExpectedMeetingPrice | null> {
  const price = await readOutcomePricesMeetingBooked(RANKING_WAIT_MS);
  if (!price) return null;
  const [replyLeg, meetingLeg] = price.legs;
  if (!replyLeg || !meetingLeg) return null;
  // The reply leg is priced on the leg maturity WITH its sourcing (`fed`, `coldEmailLegPrice`): its twin reads the same.
  const slugs = effectiveSpendSlugs(SCEO_FEATURE_SLUG, "fed");
  const vendor = await computeFleetLegWorkflowMaturity(SCEO_FEATURE_SLUG, replyLeg.legKey, slugs, "vendor");
  const unpriced = await computeFleetLegWorkflowMaturity(SCEO_FEATURE_SLUG, replyLeg.legKey, slugs, "vendorUnpriced");
  const reply = vendorLegPrice(replyLeg, { vendor: new Map(vendor.byDynasty), unpriced: new Map(unpriced.byDynasty) });
  const meeting = vendorLegPrice(meetingLeg, meetingTwin);
  const outcomes = Math.min(...price.legs.map((l) => l.figures?.outcomes ?? 0));
  if (reply.vendorCostUnknown || meeting.vendorCostUnknown) {
    return { priceUsd: null, maturity: price.maturity, outcomes: Number.isFinite(outcomes) ? outcomes : 0, unmeasuredReason: VENDOR_COST_UNKNOWN };
  }
  const v = meetingBookedPrice(reply, meeting);
  return { priceUsd: v.priceUsd, maturity: v.maturity, outcomes: Number.isFinite(outcomes) ? outcomes : 0, unmeasuredReason: v.unmeasuredReason ?? null };
}

async function readExpectedMeetingPrice(): Promise<ExpectedMeetingPrice | null> {
  const price = await readOutcomePricesMeetingBooked(RANKING_WAIT_MS);
  if (!price) return null;
  const outcomes = Math.min(...price.legs.map((l) => l.figures?.outcomes ?? 0));
  return { priceUsd: price.priceUsd, maturity: price.maturity, outcomes: Number.isFinite(outcomes) ? outcomes : 0, unmeasuredReason: price.unmeasuredReason ?? null };
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

/**
 * The boot tick skips when today's points were recorded less than {@link RECORD_EVERY_MS} ago (MON-PAGE-SPEED-2-1112: a
 * deploy re-ran the whole recording, its fleet vendor reads included, a minute into every boot); the hourly clock records
 * as before. An unreadable store records (the recorder's own path, logged).
 */
async function bootTick(): Promise<void> {
  try {
    const last = await lastRecordedTodayAt(new Date());
    if (storedCopyIsFresh(last, RECORD_EVERY_MS)) {
      console.log(`[features-service] fleet indexes: today's points recorded at ${new Date(last!).toISOString()}, boot recording skipped`);
      return;
    }
  } catch (error) {
    console.error("[features-service] fleet indexes: last recording unreadable, recording now:", error);
  }
  tick();
}

/** First recording a minute after listen (a deploy restarts the process more often than once a day), then hourly. */
export function startFleetIndexRecorder(): void {
  const first = setTimeout(() => void bootTick(), FIRST_RECORD_AFTER_MS);
  first.unref?.();
  const every = setInterval(tick, RECORD_EVERY_MS);
  every.unref?.();
}

export default router;
