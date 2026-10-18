/**
 * AI MEETING BOOKING GAIN (owner 2026-10-13, DefiniteJobs: "how many more meetings does your AI book than my team?").
 *
 * Fleet-wide, since inception, on the Positive reply -> Meeting booked leg: of the people who replied positively and
 * whose conversation AI Meeting Booking held, how many booked; same for the client's own team (Your Team Meeting
 * Booking). Read from lead-service `GET /internal/meeting-attribution` (MEETING-ATTRIBUTION-1013), which ties each
 * meeting to the answer that preceded it from positive facts only; a meeting it cannot place stays `unknown` and is
 * never given to a side here either. Served on `/public/channels` `meetingBookingGain`.
 *
 * Both rates and their populations are always served. The GAIN (AI rate minus team rate, in points) is served only
 * once EACH side has booked the leg's maturity bar of meetings (`lib/maturity.ts`, `outcomesRequired`), else null +
 * `not_enough_meetings`: a gain over a handful of meetings is noise, never a claim we make to a client.
 * Unreadable producer = every figure null + `lead_service_unavailable`, logged loud, never a 502 of the catalogue.
 *
 * Measured on the brands that REPORT meetings only (`lib/meeting-population.ts`, MEETING-POPULATION-1018): both arms
 * are summed over those brands' rows of `byBrand`, and `population` says how many brands were counted and left out.
 */
import { legMaturity } from "./maturity.js";
import { meetingPopulationOf, meetingReportingOf, NO_BRAND_REPORTS_MEETINGS, type MeetingPopulation } from "./meeting-population.js";
import { fetchMeetingAttributionBody, rememberMeetingReporting } from "./meeting-reporting-client.js";

export const MEETING_BOOKING_LEG = "conversation_to_meeting_booked";

export interface MeetingBookingArm {
  /** People who replied positively and whose conversation this side held. */
  handledPeople: number;
  /** Of them, people who booked a meeting. */
  bookedPeople: number;
  /** bookedPeople / handledPeople x 100, 2 decimals; null when nobody was handled. */
  ratePct: number | null;
}

export interface MeetingBookingGain {
  legKey: typeof MEETING_BOOKING_LEG;
  basis: "positive_repliers_since_inception";
  aiMeetingBooking: MeetingBookingArm | null;
  yourTeamMeetingBooking: MeetingBookingArm | null;
  /** AI rate minus team rate, in percentage points. Null with `unavailableReason`. */
  gainPctPoints: number | null;
  /** Meetings EACH side must have booked before the gain is served (the leg's maturity bar). */
  bookedRequiredPerSide: number;
  /** Who the rates were measured on (brands that report meetings). Null when lead-service was unreadable. */
  population: MeetingPopulation | null;
  unavailableReason: "not_enough_meetings" | typeof NO_BRAND_REPORTS_MEETINGS | "lead_service_unavailable" | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function armOf(raw: unknown, name: string): MeetingBookingArm {
  const a = raw as { handled?: unknown; booked?: unknown } | undefined;
  const handled = a?.handled;
  const booked = a?.booked;
  if (typeof handled !== "number" || typeof booked !== "number" || handled < 0 || booked < 0 || booked > handled) {
    throw new Error(`[features-service] lead-service meeting-attribution: arm ${name} has no valid handled/booked`);
  }
  return { handledPeople: handled, bookedPeople: booked, ratePct: handled === 0 ? null : round2((booked / handled) * 100) };
}

/** PURE: the served figure from lead-service's meeting-attribution body, over the brands that report meetings. */
export function meetingBookingGainOf(body: unknown): MeetingBookingGain {
  const byBrand = (body as { byBrand?: Array<{ brandId?: unknown; arms?: Record<string, unknown> }> } | null)?.byBrand;
  const reporting = meetingReportingOf(body);
  const sum = { ai: { handled: 0, booked: 0 }, team: { handled: 0, booked: 0 } };
  for (const row of byBrand!) {
    const brandId = row.brandId as string;
    const ai = armOf(row.arms?.aiMeetingBooking, `${brandId}.aiMeetingBooking`);
    const team = armOf(row.arms?.yourTeamMeetingBooking, `${brandId}.yourTeamMeetingBooking`);
    if (!reporting.reports(brandId)) continue;
    sum.ai.handled += ai.handledPeople;
    sum.ai.booked += ai.bookedPeople;
    sum.team.handled += team.handledPeople;
    sum.team.booked += team.bookedPeople;
  }
  const ai = armOf(sum.ai, "aiMeetingBooking");
  const team = armOf(sum.team, "yourTeamMeetingBooking");
  const population = meetingPopulationOf(byBrand!.map((r) => r.brandId as string), reporting);
  const required = legMaturity(MEETING_BOOKING_LEG).outcomesRequired;
  const enough = ai.bookedPeople >= required && team.bookedPeople >= required && ai.ratePct !== null && team.ratePct !== null;
  return {
    legKey: MEETING_BOOKING_LEG,
    basis: "positive_repliers_since_inception",
    aiMeetingBooking: ai,
    yourTeamMeetingBooking: team,
    gainPctPoints: enough ? round2(ai.ratePct! - team.ratePct!) : null,
    bookedRequiredPerSide: required,
    population,
    unavailableReason: enough ? null : population.brandsCounted === 0 ? NO_BRAND_REPORTS_MEETINGS : "not_enough_meetings",
  };
}

export async function fetchMeetingBookingGain(): Promise<MeetingBookingGain> {
  try {
    const body = await fetchMeetingAttributionBody();
    rememberMeetingReporting(meetingReportingOf(body));
    return meetingBookingGainOf(body);
  } catch (err) {
    console.error("[features-service] meeting booking gain unreadable, served null:", err);
    return {
      legKey: MEETING_BOOKING_LEG,
      basis: "positive_repliers_since_inception",
      aiMeetingBooking: null,
      yourTeamMeetingBooking: null,
      gainPctPoints: null,
      bookedRequiredPerSide: legMaturity(MEETING_BOOKING_LEG).outcomesRequired,
      population: null,
      unavailableReason: "lead_service_unavailable",
    };
  }
}
