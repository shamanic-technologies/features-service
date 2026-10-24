/**
 * ONE RUN: the public fleet indexes' past days, recomputed as of each day (INDEX-HISTORY-BACKFILL-1019,
 * `lib/fleet-index-history.ts`). Inside the features-service container, in its own process (own heap, no route, no job):
 *
 *   node --max-old-space-size=1024 dist/scripts/backfill-fleet-indexes.js            # dry run: prints the plan
 *   node --max-old-space-size=1024 dist/scripts/backfill-fleet-indexes.js --apply    # writes it
 *
 * Re-runnable: a day already recomputed with the same figures is not written again, a RECORDED day is never touched.
 */
import { FLEET_INDEXES, SCEO_FEATURE_SLUG, SCEO_POSITIVE_REPLY_LEG, SCEO_WEBSITE_VISIT_LEG } from "../lib/fleet-indexes.js";
import { addDays, dayRange, emptyPersonHistory, planRecomputedWrites, rankingOn, recomputeIndexHistory } from "../lib/fleet-index-history.js";
import { readAssignmentChanges, readDatedSlugSpend, readHistoryLegs, readMeetingHistoryInputs, readPersonHistory, readWorkflowVersions } from "../lib/fleet-index-history-io.js";
import { meetingPipeOn } from "../lib/meeting-pipe-history.js";
import { fetchDynastyMerges } from "../lib/public-stats-clients.js";
import { computeMeetingLegFleet } from "../lib/meeting-leg-fleet.js";
import { MEETING_RESEARCH_BEST_SLUG, MEETING_RESEARCH_MEDIAN_SLUG } from "../lib/research/pipe-series.js";
import { MEETING_COST_OUTCOME_PRICES_SLUG } from "../lib/research/meeting-cost-methods.js";
import { readFleetIndexRows, writeRecomputedFleetIndexPoints } from "../lib/fleet-index-store.js";
import { matchChannelLegKey } from "../lib/funnel-legs.js";

const log = (line: string) => console.log(`[fleet-index-backfill] ${line}`);

function computationLegKey(servedLeg: string): string {
  const leg = matchChannelLegKey(SCEO_FEATURE_SLUG, servedLeg);
  if (!leg) throw new Error(`leg ${servedLeg} is not a leg of ${SCEO_FEATURE_SLUG}`);
  return leg;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const now = new Date();
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

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[fleet-index-backfill] failed:", error);
    process.exit(1);
  });
