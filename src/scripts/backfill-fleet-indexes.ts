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
import { readAssignmentChanges, readDatedSlugSpend, readHistoryLegs, readPersonHistory, readWorkflowVersions } from "../lib/fleet-index-history-io.js";
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
  const [legs, { versions: workflows, runnableToday }, assignmentChanges] = await Promise.all([
    readHistoryLegs(SCEO_FEATURE_SLUG, legKeys),
    readWorkflowVersions(SCEO_FEATURE_SLUG),
    readAssignmentChanges(SCEO_FEATURE_SLUG, legKeys),
  ]);
  log(`legs: ${legs.map((l) => `${l.legKey} ${l.campaignIds.size} campaigns`).join(", ")}; ${workflows.length} workflow versions (${runnableToday.size} dynasties runnable today); ${assignmentChanges.length} assignment changes`);
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
  const inputs = { days, websiteVisitLeg: visitLeg, positiveReplyLeg: replyLeg, persons, spend, assignmentChanges, workflows, runnableToday };
  const points = recomputeIndexHistory(inputs);
  const stored = await readFleetIndexRows(FLEET_INDEXES.map((d) => d.slug));
  const plan = planRecomputedWrites(points, stored);
  for (const def of FLEET_INDEXES) {
    const series = points.filter((p) => p.point.indexSlug === def.slug);
    const sample = series.filter((_, i) => i % 7 === 0 || i === series.length - 1).map((p) => `${p.day}=${p.point.value === null ? `null(${p.point.unavailableReason})` : p.point.value.toFixed(3)}@${p.point.workflowDynastySlug ?? "-"}`);
    log(`${def.slug}: ${series.length} days from ${series[0]?.day ?? "-"}; ${sample.join(" ")}`);
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
