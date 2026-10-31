/**
 * ONE RUN: the public fleet indexes' past days, recomputed as of each day (INDEX-HISTORY-BACKFILL-1019,
 * `lib/fleet-index-history.ts`). Inside the features-service container, in its own process (own heap, no route, no job):
 *
 *   node --max-old-space-size=1024 dist/scripts/backfill-fleet-indexes.js            # dry run: prints the plan
 *   node --max-old-space-size=1024 dist/scripts/backfill-fleet-indexes.js --apply    # writes it
 *   ... --vendor [--apply]   # the PUBLIC series at real vendor cost, every day from the first (PUBLIC-VENDOR-COST-1031):
 *                            # the billed picks of each day, their money on the vendor twin of the same rows
 *   ... --vendor-clients [--apply]   # the two CLIENT-median public indexes (ROI, cost per engaged lead) at real vendor
 *                            # cost, every day from the first (PUBLIC-VENDOR-COST-1031-HISTORY, `lib/client-index-history.ts`):
 *                            # each (org, brand) replayed as of each day; written only when the replay of today
 *                            # reproduces the live point
 *
 * Re-runnable: a day already recomputed with the same figures is not written again, a RECORDED day is never touched.
 */
import { FLEET_INDEXES, SCEO_FEATURE_SLUG, SCEO_POSITIVE_REPLY_LEG, SCEO_WEBSITE_VISIT_LEG } from "../lib/fleet-indexes.js";
import { addDays, dayRange, emptyPersonHistory, planRecomputedWrites, rankingOn, recomputeIndexHistory, recomputeVendorIndexHistory, type DatedIndexPoint, type HistoryInputs } from "../lib/fleet-index-history.js";
import { readAssignmentChanges, readDatedSlugSpend, readDatedSlugSpendBases, readHistoryLegs, readMeetingHistoryInputs, readMeetingSpendBases, readPersonHistory, readWorkflowVersions } from "../lib/fleet-index-history-io.js";
import { meetingPipeOn } from "../lib/meeting-pipe-history.js";
import { fetchDynastyMerges } from "../lib/public-stats-clients.js";
import { computeMeetingLegFleet } from "../lib/meeting-leg-fleet.js";
import { MEETING_RESEARCH_BEST_SLUG, MEETING_RESEARCH_MEDIAN_SLUG } from "../lib/research/pipe-series.js";
import { MEETING_COST_OUTCOME_PRICES_SLUG } from "../lib/research/meeting-cost-methods.js";
import { readFleetIndexRows, writeRecomputedFleetIndexPoints } from "../lib/fleet-index-store.js";
import { matchChannelLegKey } from "../lib/funnel-legs.js";
import { readMembershipPairs, readPairDatedSpend, readPairPersons } from "../lib/fleet-index-history-io.js";
import { addPairBrandEngagement, brandReturnRowsOn, CLIENT_RETURN_MIN_SPEND_USD, emptyBrandEngagementHistory, engagedLeadPointOn, replayPairReturn, roiPointOn, type PairReturnDay, type PairSpendDay } from "../lib/client-index-history.js";
import { withEngineCapture, type EngineCapture } from "../lib/engine-capture.js";
import { engagedLeadPoint } from "../lib/fleet-indexes.js";
import { getFunnel } from "../lib/funnel-registry.js";
import { computePairRevenue, pairVendorSpend, readFleetVendorReturn } from "../routes/public.js";
import { readVendorBrandEngagement } from "../routes/fleet-indexes.js";

const log = (line: string) => console.log(`[fleet-index-backfill] ${line}`);

function computationLegKey(servedLeg: string): string {
  const leg = matchChannelLegKey(SCEO_FEATURE_SLUG, servedLeg);
  if (!leg) throw new Error(`leg ${servedLeg} is not a leg of ${SCEO_FEATURE_SLUG}`);
  return leg;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const now = new Date();
  if (process.argv.includes("--vendor-clients")) {
    await clientIndexHistory(now, apply);
    return;
  }
  const visitLeg = computationLegKey(SCEO_WEBSITE_VISIT_LEG);
  const replyLeg = computationLegKey(SCEO_POSITIVE_REPLY_LEG);
  const legKeys = [visitLeg, replyLeg];
  const [legs, workflows, assignmentChanges, merges] = await Promise.all([
    readHistoryLegs(SCEO_FEATURE_SLUG, legKeys),
    readWorkflowVersions(SCEO_FEATURE_SLUG),
    readAssignmentChanges(SCEO_FEATURE_SLUG, legKeys),
    fetchDynastyMerges(SCEO_FEATURE_SLUG),
  ]);
  log(`legs: ${legs.map((l) => `${l.legKey} ${l.campaignIds.size} campaigns`).join(", ")}; ${workflows.length} workflow versions (${workflows.filter((w) => w.executableUntil === null).length} executable today); ${assignmentChanges.length} assignment changes`);
  const spend = await readDatedSlugSpend(SCEO_FEATURE_SLUG, legs);
  if (spend.length === 0) throw new Error("no spend on either leg: nothing to rebuild");
  const first = spend.reduce((a, s) => (s.day < a ? s.day : a), spend[0]!.day);
  // Today is the recorder's (still open); every day before it is rebuilt.
  const last = addDays(now.toISOString().slice(0, 10), -1);
  const days = dayRange(first, last);
  log(`${spend.length} (version, day) spend buckets; days ${first} .. ${last} (${days.length})`);
  const persons = emptyPersonHistory(days);
  const pairs = await readPersonHistory(SCEO_FEATURE_SLUG, persons, legs, log);
  log(`${pairs} pairs walked; ${persons.undatedPersons} persons with no serve date and no dated send (in no past day)`);
  // The AI Meeting Booking pipe as of each day (MEETING-COST-METHODS-1024): the meeting indexes, its Research series and
  // the outcome prices' meeting price. Checked first against the live pipe: rebuilt as of today, it must read the same.
  const meeting = await readMeetingHistoryInputs();
  const today = now.toISOString().slice(0, 10);
  const [asOfToday, live] = [meetingPipeOn(meeting, today).fleet, await computeMeetingLegFleet()];
  const pick = (f: typeof live) => JSON.stringify({ pooled: f.pooled, byDynasty: f.byDynasty.map(([d, x]) => [d, x.flash]), reporting: f.population });
  log(`meeting pipe as of today: ${pick(asOfToday)}`);
  log(`meeting pipe live:        ${pick(live)}`);
  log(`meeting pipe check: ${pick(asOfToday) === pick(live) ? "SAME" : "DIFFERENT"} (${meeting.campaigns.length} campaigns, ${meeting.acts.length} acts, ${meeting.meetings.length} meeting facts, ${meeting.spend.length} spend buckets)`);
  // The outcome prices price a reply WITH the sourcing its lead cost (`fed`), the ranking and the index without it.
  const fedSpend = await readDatedSlugSpend(SCEO_FEATURE_SLUG, legs.filter((l) => l.legKey === replyLeg), "fed");
  log(`${fedSpend.length} (version, day) fed spend buckets on ${replyLeg}`);
  const inputs = { days, websiteVisitLeg: visitLeg, positiveReplyLeg: replyLeg, persons, spend, assignmentChanges, workflows, meeting, merges, fedSpend };
  if (process.argv.includes("--vendor")) {
    await vendorHistory(inputs, legs, spend, now, apply);
    return;
  }
  const points = recomputeIndexHistory(inputs);
  const slugs = [...FLEET_INDEXES.map((d) => d.slug), MEETING_RESEARCH_BEST_SLUG, MEETING_RESEARCH_MEDIAN_SLUG, MEETING_COST_OUTCOME_PRICES_SLUG];
  const stored = await readFleetIndexRows(slugs);
  const plan = planRecomputedWrites(points, stored);
  for (const slug of slugs) {
    const def = { slug };
    const series = points.filter((p) => p.point.indexSlug === def.slug);
    const sample = series.filter((_, i) => i % 7 === 0 || i === series.length - 1).map((p) => `${p.day}=${p.point.value === null ? `null(${p.point.unavailableReason})` : p.point.value.toFixed(3)}@${p.point.workflowDynastySlug ?? "-"}`);
    log(`${def.slug}: ${series.length} days from ${series[0]?.day ?? "-"}; ${sample.join(" ")}`);
  }
  // The last recomputed day of the meeting chains, with what they were built from (a reader re-does them by hand).
  for (const slug of ["cold-email-cost-per-meeting", MEETING_COST_OUTCOME_PRICES_SLUG]) {
    const last = points.filter((p) => p.point.indexSlug === slug).at(-1);
    if (last) log(`last ${slug} ${last.day}: ${last.point.value} ${JSON.stringify(last.point.inputs)}`);
  }
  // A day both recorded live and recomputed: the two side by side (the recorded one is kept).
  for (const r of stored.filter((s) => s.basis === "recorded")) {
    const p = points.find((x) => x.day === r.day && x.point.indexSlug === r.indexSlug);
    if (!p) continue;
    log(`check ${r.indexSlug} ${r.day}: recorded ${r.value} @${r.workflowDynastySlug ?? "-"} / recomputed ${p.point.value} @${p.point.workflowDynastySlug ?? "-"}`);
    if (p.point.workflowDynastySlug === r.workflowDynastySlug) continue;
    // Why the two differ: the recomputed ranking's head rows and the recorded workflow's row, that day.
    const def = FLEET_INDEXES.find((d) => d.slug === r.indexSlug);
    const leg = def?.outcome === "website_visit" ? visitLeg : replyLeg;
    const rows = rankingOn(inputs, leg, days.indexOf(r.day));
    for (const row of rows.filter((x) => x.rank <= 5 || x.workflowDynastySlug === r.workflowDynastySlug)) {
      log(`  ${row.rank} ${row.workflowDynastySlug} ${row.place} selectable=${row.selectable} assignment=${row.assignment} executable=${row.executable} basis=${row.basis} outcomes=${row.outcomes} contacted=${row.contacted} spent=${row.spentUsd.toFixed(2)}`);
    }
  }
  log(`plan: ${plan.writes.length} to write, ${plan.unchanged} unchanged, ${plan.skippedRecorded} recorded days left as recorded`);
  if (!apply) {
    log("dry run: nothing written (pass --apply to write)");
    return;
  }
  await writeRecomputedFleetIndexPoints(plan.writes, now);
  log(`wrote ${plan.writes.length} recomputed point(s)`);
}

const usd = (cents: number) => (cents / 100).toFixed(2);
const sumCents = (xs: ReadonlyArray<{ spentCents: number }>) => xs.reduce((a, x) => a + x.spentCents, 0);

/** The public series at real vendor cost: every day from the first, the billed picks, the vendor money (PUBLIC-VENDOR-COST-1031). */
async function vendorHistory(
  inputs: HistoryInputs,
  legs: Awaited<ReturnType<typeof readHistoryLegs>>,
  billedSpend: readonly { legKey: string; spentCents: number }[],
  now: Date,
  apply: boolean,
): Promise<void> {
  const bases = await readDatedSlugSpendBases(SCEO_FEATURE_SLUG, legs);
  // The population check: the vendor read's own billed figure against the billed history's, per leg.
  for (const l of legs) {
    const billed = sumCents(billedSpend.filter((s) => s.legKey === l.legKey));
    const gross = sumCents(bases.gross.filter((s) => s.legKey === l.legKey));
    log(`vendor ${l.legKey}: billed $${usd(billed)} (history) / $${usd(gross)} (vendor read) | vendor $${usd(sumCents(bases.vendor.filter((s) => s.legKey === l.legKey)))} | unpriced $${usd(sumCents(bases.unpriced.filter((s) => s.legKey === l.legKey)))}`);
  }
  const meetingBases = inputs.meeting ? await readMeetingSpendBases(inputs.meeting.campaigns) : null;
  if (meetingBases) {
    log(`vendor meeting pipe: billed $${usd(sumCents(inputs.meeting!.spend))} (history) / $${usd(sumCents(meetingBases.gross))} (vendor read) | vendor $${usd(sumCents(meetingBases.vendor))} | unpriced $${usd(sumCents(meetingBases.unpriced))}`);
  }
  const points: DatedIndexPoint[] = recomputeVendorIndexHistory(inputs, {
    spend: bases.vendor,
    unpricedSpend: bases.unpriced,
    meetingSpend: meetingBases?.vendor,
    meetingUnpricedSpend: meetingBases?.unpriced,
  });
  const billedPoints = recomputeIndexHistory(inputs);
  const slugs = FLEET_INDEXES.map((d) => d.slug);
  for (const slug of slugs) {
    const series = points.filter((p) => p.point.indexSlug === slug);
    const first = series[0];
    const last = series.at(-1);
    const billedOn = (day: string | undefined) => billedPoints.find((p) => p.day === day && p.point.indexSlug === slug)?.point.value ?? null;
    log(`vendor ${slug}: ${series.length} days; first ${first?.day ?? "-"} vendor ${first?.point.value ?? `null(${first?.point.unavailableReason})`} / billed ${billedOn(first?.day)}; last ${last?.day ?? "-"} vendor ${last?.point.value ?? `null(${last?.point.unavailableReason})`} / billed ${billedOn(last?.day)}`);
  }
  const stored = await readFleetIndexRows(slugs, "vendor");
  const plan = planRecomputedWrites(points, stored);
  log(`vendor plan: ${plan.writes.length} to write, ${plan.unchanged} unchanged, ${plan.skippedRecorded} recorded days left as recorded`);
  if (!apply) {
    log("dry run: nothing written (pass --apply to write)");
    return;
  }
  await writeRecomputedFleetIndexPoints(plan.writes, now, "vendor");
  log(`wrote ${plan.writes.length} recomputed vendor point(s)`);
}

/** Relative gap between a replay and a live figure (both null = equal). */
function gapPct(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : Infinity;
  if (a === b) return 0;
  return (Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b))) * 100;
}

const PAIR_ATTEMPTS = 4;
const PAIR_RETRY_WAIT_MS = 60_000;

/** One pair's reads, asked again on a failure (the run is one-off and off any request); fails loud after the last try. */
async function withPairRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= PAIR_ATTEMPTS) throw err;
      log(`pair ${label}: read failed (${(err as Error).message.slice(0, 160)}), attempt ${attempt}/${PAIR_ATTEMPTS}; retrying`);
      await new Promise((w) => setTimeout(w, PAIR_RETRY_WAIT_MS * attempt));
    }
  }
}

/** The largest gap the as-of-today replay may show against the live point before the run refuses to write (%). */
const REPLAY_TOLERANCE_PCT = 0.5;

/** The two client-median public indexes at real vendor cost, every day from the first (PUBLIC-VENDOR-COST-1031-HISTORY). */
async function clientIndexHistory(now: Date, apply: boolean): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  const pairs = await readMembershipPairs(SCEO_FEATURE_SLUG);
  log(`client indexes: ${pairs.length} (org, brand) pairs`);
  const spendOf = new Map<string, PairSpendDay[]>();
  for (const p of pairs) spendOf.set(`${p.orgId}:${p.brandId}`, await readPairDatedSpend(SCEO_FEATURE_SLUG, p.orgId, p.brandId));
  const allSpend = [...spendOf.values()].flat();
  if (allSpend.length === 0) throw new Error("no spend on any pair: nothing to rebuild");
  const first = allSpend.reduce((a, s) => (s.day < a ? s.day : a), allSpend[0]!.day);
  const days = dayRange(first, today);
  // The population check: per day, the vendor read's own billed total against the billed read's, same rows.
  const byDay = new Map<string, { v: number; b: number; vendor: number; unpriced: number; net: number }>();
  for (const s of allSpend) {
    const d = byDay.get(s.day) ?? { v: 0, b: 0, vendor: 0, unpriced: 0, net: 0 };
    d.v += s.checkVendorReadCents;
    d.b += s.checkBilledReadCents;
    d.vendor += s.vendorCents;
    d.unpriced += s.unpricedCents;
    d.net += s.netCents;
    byDay.set(s.day, d);
  }
  const off = [...byDay].filter(([, d]) => Math.abs(d.v - d.b) >= 1);
  const tot = [...byDay.values()].reduce((a, d) => ({ v: a.v + d.v, b: a.b + d.b, vendor: a.vendor + d.vendor, unpriced: a.unpriced + d.unpriced, net: a.net + d.net }), { v: 0, b: 0, vendor: 0, unpriced: 0, net: 0 });
  log(`spend ${first} .. ${today}: billed $${usd(tot.b)} (billed read) / $${usd(tot.v)} (vendor read) | net $${usd(tot.net)} | vendor $${usd(tot.vendor)} | unpriced $${usd(tot.unpriced)}; ${byDay.size} days, ${off.length} day(s) where the two reads differ by >= 1 cent${off.length ? `: ${off.slice(0, 10).map(([d, x]) => `${d} ${usd(x.b)}/${usd(x.v)}`).join(", ")}` : ""}`);

  const engagement = emptyBrandEngagementHistory(days, today);
  const pairDays: Array<{ brandId: string; days: PairReturnDay[] }> = [];
  let n = 0;
  for (const p of pairs) {
    n += 1;
    // Every read of the pair, retried together (a sibling restarted or dropped a socket mid-walk under load); nothing is
    // added to the history before all of them answered, so a retry never counts a pair twice.
    const { persons, timelines, captures, live } = await withPairRetry(`${p.orgId}:${p.brandId}`, async () => {
      const read = await readPairPersons(p.orgId, p.brandId);
      const caught: EngineCapture[] = [];
      const pass = await withEngineCapture((c) => caught.push(c), () => computePairRevenue(SCEO_FEATURE_SLUG, getFunnel(SCEO_FEATURE_SLUG), p.orgId, p.brandId));
      return { ...read, captures: caught, live: pass };
    });
    addPairBrandEngagement(engagement, p.brandId, persons, timelines);
    if (live === null) {
      log(`pair ${n}/${pairs.length} ${p.orgId}:${p.brandId}: stale membership, skipped (the live warm skips it too)`);
      continue;
    }
    if (captures.length > 1) throw new Error(`pair ${p.orgId}:${p.brandId}: ${captures.length} engine passes captured, expected at most one`);
    const replay = replayPairReturn(captures[0] ?? null, spendOf.get(`${p.orgId}:${p.brandId}`) ?? [], days, today);
    pairDays.push({ brandId: p.brandId, days: replay });
    const t = replay[replay.length - 1]!;
    const lv = await withPairRetry(`${p.orgId}:${p.brandId} vendor`, () => pairVendorSpend(SCEO_FEATURE_SLUG, p.orgId, p.brandId));
    log(
      `pair ${n}/${pairs.length} ${p.orgId}:${p.brandId}: ${persons.length} persons | today replay/live: pipeline ${t.maturePipelineUsd?.toFixed(2) ?? "null"}/${live.maturePipeline?.toFixed(2) ?? "null"}` +
        ` net $${t.matureNetUsd.toFixed(2)}/$${live.matureCommittedCostUsd.toFixed(2)} vendor $${t.matureVendorUsd.toFixed(2)}/$${lv.matureUsd.toFixed(2)}` +
        ` unpriced $${t.matureUnpricedUsd.toFixed(2)}/$${lv.unpricedMatureUsd.toFixed(2)} mature ${t.isMature}/${live.isMature}`,
    );
  }

  const roiSlug = "cold-email-roi";
  const engagedSlug = "cold-email-cost-per-engaged-lead";
  const all: DatedIndexPoint[] = [];
  const spendByBrand = new Map<string, PairSpendDay[]>();
  for (const p of pairs) spendByBrand.set(p.brandId, [...(spendByBrand.get(p.brandId) ?? []), ...(spendOf.get(`${p.orgId}:${p.brandId}`) ?? [])]);
  for (let i = 0; i < days.length; i++) {
    const day = days[i]!;
    for (const point of [roiPointOn(brandReturnRowsOn(pairDays, i)), engagedLeadPointOn(engagement, spendByBrand, i).point]) {
      all.push({ day, point: { ...point, inputs: { ...point.inputs, asOfDay: day, costBasis: "vendor" } } });
    }
  }
  const series = (slug: string) => {
    const s = all.filter((p) => p.point.indexSlug === slug);
    const start = s.findIndex((p) => p.point.value !== null);
    return start >= 0 ? s.slice(start) : [];
  };
  const points = [...series(roiSlug), ...series(engagedSlug)];

  // The gate: the replay of TODAY against the live point computed now, the same live reads the recorder makes.
  const [liveEngagement, liveReturn] = await Promise.all([readVendorBrandEngagement(), readFleetVendorReturn(SCEO_FEATURE_SLUG, CLIENT_RETURN_MIN_SPEND_USD)]);
  const liveEngaged = liveEngagement ? engagedLeadPoint(liveEngagement).value : null;
  const replayToday = (slug: string) => all.find((p) => p.day === today && p.point.indexSlug === slug)?.point ?? null;
  const checks = [
    { slug: engagedSlug, replay: replayToday(engagedSlug), live: liveEngaged },
    { slug: roiSlug, replay: replayToday(roiSlug), live: liveReturn.measured ? liveReturn.medianReturnPerDollar : null },
  ];
  let reproduced = true;
  for (const c of checks) {
    const gap = gapPct(c.replay?.value ?? null, c.live);
    if (!(gap <= REPLAY_TOLERANCE_PCT)) reproduced = false;
    log(`check ${c.slug} today: replay ${c.replay?.value ?? `null(${c.replay?.unavailableReason})`} ${JSON.stringify(c.replay?.inputs)} / live ${c.live} (gap ${gap.toFixed(3)}%)`);
  }
  log(`live ROI snapshot read: brandCount ${liveReturn.brandCount}, vendorCostUnknownBrands ${liveReturn.vendorCostUnknownBrands}, reason ${liveReturn.reason}`);
  for (const slug of [roiSlug, engagedSlug]) {
    const s = series(slug);
    const sample = s.filter((_, i) => i % 7 === 0 || i === s.length - 1).map((p) => `${p.day}=${p.point.value === null ? `null(${p.point.unavailableReason})` : p.point.value.toFixed(3)}/${p.point.outcomes}`);
    log(`${slug}: ${s.length} days from ${s[0]?.day ?? "-"}; ${sample.join(" ")}`);
  }

  // Today is the recorder's: only past days are written, never over a recorded one.
  const stored = await readFleetIndexRows([roiSlug, engagedSlug], "vendor");
  const plan = planRecomputedWrites(points.filter((p) => p.day < today), stored);
  log(`client plan: ${plan.writes.length} to write, ${plan.unchanged} unchanged, ${plan.skippedRecorded} recorded days left as recorded`);
  if (!reproduced) {
    log(`REFUSED: the replay of today does not reproduce the live point within ${REPLAY_TOLERANCE_PCT}%: nothing written`);
    return;
  }
  if (!apply) {
    log("dry run: nothing written (pass --apply to write)");
    return;
  }
  await writeRecomputedFleetIndexPoints(plan.writes, now, "vendor");
  log(`wrote ${plan.writes.length} recomputed vendor client point(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[fleet-index-backfill] failed:", error);
    process.exit(1);
  });
