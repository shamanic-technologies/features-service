/**
 * WHO A MEETING FIGURE IS MEASURED ON (owner 2026-10-18, MEETING-POPULATION-1018): ONE rule for every figure built on
 * booked meetings (cost per meeting, positive reply -> meeting rate, the meeting indexes, AI Meeting Booking's gain and
 * before/after, the meeting pipe's per-workflow figures and its fleet price).
 *
 * A booked meeting is a fact the CLIENT reports to us (a CRM import, a tracker, a hand statement): we never see it in
 * our own inbox. So a brand that never reported one meeting reads zero meetings whether it booked none or a hundred,
 * and counting it as zero lowers every rate and inflates every cost (2026-10-18: the public Cost Per Meeting Index read
 * $1,093 on 8 meetings over 48 positive repliers of 5 brands, 3 of which had never reported a meeting).
 *
 * The rule: a brand counts in a meeting figure only when it REPORTS meetings, i.e. lead-service holds at least one live
 * meeting fact for it (booked or attended, any source, matched to a lead or not: `byBrand[].meetings.total > 0` on
 * `GET /internal/meeting-attribution`, every non-withdrawn `conversion_events` meeting row). Positive evidence only: no
 * brand list, no id in code. A brand that reports none is LEFT OUT, never counted as zero, and every served figure
 * states how many brands it counted and how many it left out. No brand reports any: the figure is null with a reason,
 * never a default rate.
 *
 * The same population the Research page's meeting-cost study stated by hand ("Measured on the 2 brands that report
 * their booked meetings to us").
 *
 * PURE: `meeting-reporting-client.ts` reads lead-service and holds the answer.
 */
import { funnelLeg, pipeLegKeyOf } from "./funnel-legs.js";

/** The steps only a client's report can witness. A leg landing on one is measured on reporting brands only. */
export const MEETING_STEPS: ReadonlySet<string> = new Set(["meeting_booked", "meeting_attended"]);

export const MEETING_POPULATION_RULE = "brands_reporting_meetings" as const;

/** Why a meeting figure is null because of its population. */
export const NO_BRAND_REPORTS_MEETINGS = "no_brand_reports_meetings" as const;
export const BRAND_REPORTS_NO_MEETINGS = "brand_reports_no_meetings" as const;

/** The brands that report meetings to us, fleet-wide. */
export interface MeetingReporting {
  reports(brandId: string | null | undefined): boolean;
  /** Sorted, for a reader and a test. */
  reportingBrandIds: readonly string[];
}

/** Who a served meeting figure was measured on. */
export interface MeetingPopulation {
  rule: typeof MEETING_POPULATION_RULE;
  /** Brands whose people are in the figure (they report meetings). */
  brandsCounted: number;
  /** Brands with people in scope that report no meeting, left out of the figure. */
  brandsLeftOut: number;
}

export function meetingReportingFrom(brandIds: Iterable<string>): MeetingReporting {
  const set = new Set(brandIds);
  return { reports: (brandId) => typeof brandId === "string" && set.has(brandId), reportingBrandIds: [...set].sort() };
}

/**
 * A meeting source that does not MEASURE meetings (owner 2026-10-24, MEETING-TRACKER-1024: « le tracker est trop imprécis
 * pour qu'on le considère comme fiable pour mesurer les meetings »): a brand whose only meeting facts come from it reports
 * no meetings, and its facts count in no meeting figure. Prod: Legistai's 11 tracker meetings, none matched to a person.
 */
export const UNRELIABLE_MEETING_SOURCES: ReadonlySet<string> = new Set(["tracker"]);

/** PURE: whether one lead-service meeting fact measures a meeting (its source is not an unreliable one). */
export const isMeasuringMeetingFact = (m: { source?: unknown }): boolean => typeof m.source === "string" && !UNRELIABLE_MEETING_SOURCES.has(m.source);

/**
 * PURE: the reporting brands off lead-service's `/internal/meeting-attribution` body: every brand holding at least one
 * live meeting fact (booked or attended, any person, matched or not) from a source that measures meetings
 * (`attributedMeetings[].source`, MEETING-TRACKER-1024; was `byBrand[].meetings.total > 0`, every source).
 */
export function meetingReportingOf(body: unknown): MeetingReporting {
  const rows = (body as { attributedMeetings?: unknown } | null)?.attributedMeetings;
  if (!Array.isArray(rows)) throw new Error("[features-service] lead-service meeting-attribution has no attributedMeetings");
  const ids = new Set<string>();
  for (const row of rows as Array<{ brandId?: unknown; event?: unknown; source?: unknown }>) {
    if (typeof row?.brandId !== "string" || typeof row?.event !== "string" || typeof row?.source !== "string") {
      throw new Error("[features-service] lead-service meeting-attribution: a meeting row has no brandId/event/source");
    }
    if ((row.event === "meeting_booked" || row.event === "meeting_attended") && isMeasuringMeetingFact(row)) ids.add(row.brandId);
  }
  return meetingReportingFrom(ids);
}

/** PURE: the population of a figure over these brands (each counted once; a null brand is never a reporting one). */
export function meetingPopulationOf(brandIds: Iterable<string | null>, reporting: MeetingReporting): MeetingPopulation {
  const all = new Set<string | null>(brandIds);
  let counted = 0;
  for (const b of all) if (reporting.reports(b)) counted += 1;
  return { rule: MEETING_POPULATION_RULE, brandsCounted: counted, brandsLeftOut: all.size - counted };
}

/** PURE: the items of reporting brands, and the population they make. */
export function splitByMeetingReporting<T extends { brandId: string | null }>(
  items: readonly T[],
  reporting: MeetingReporting,
): { counted: T[]; population: MeetingPopulation } {
  return {
    counted: items.filter((i) => reporting.reports(i.brandId)),
    population: meetingPopulationOf(items.map((i) => i.brandId), reporting),
  };
}

/** PURE: whether a pipe's leg (as the channel spells it) lands on a step only a client's report witnesses. */
export function legMeasuresMeetings(featureSlug: string, legKey: string): boolean {
  const leg = funnelLeg(pipeLegKeyOf(featureSlug, legKey)) ?? funnelLeg(legKey);
  return leg !== null && MEETING_STEPS.has(leg.toStep.key);
}
