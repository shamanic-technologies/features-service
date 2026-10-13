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
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { legMaturity } from "./maturity.js";

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
  unavailableReason: "not_enough_meetings" | "lead_service_unavailable" | null;
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

/** PURE: the served figure from lead-service's meeting-attribution body. */
export function meetingBookingGainOf(body: unknown): MeetingBookingGain {
  const arms = (body as { summary?: { arms?: Record<string, unknown> } } | null)?.summary?.arms;
  if (!arms) throw new Error("[features-service] lead-service meeting-attribution has no summary.arms");
  const ai = armOf(arms.aiMeetingBooking, "aiMeetingBooking");
  const team = armOf(arms.yourTeamMeetingBooking, "yourTeamMeetingBooking");
  const required = legMaturity(MEETING_BOOKING_LEG).outcomesRequired;
  const enough = ai.bookedPeople >= required && team.bookedPeople >= required && ai.ratePct !== null && team.ratePct !== null;
  return {
    legKey: MEETING_BOOKING_LEG,
    basis: "positive_repliers_since_inception",
    aiMeetingBooking: ai,
    yourTeamMeetingBooking: team,
    gainPctPoints: enough ? round2(ai.ratePct! - team.ratePct!) : null,
    bookedRequiredPerSide: required,
    unavailableReason: enough ? null : "not_enough_meetings",
  };
}

export async function fetchMeetingBookingGain(): Promise<MeetingBookingGain> {
  try {
    const res = await fetchWithRetry(`${process.env.LEAD_SERVICE_URL}/internal/meeting-attribution`, {
      headers: { "x-api-key": process.env.LEAD_SERVICE_API_KEY! },
    });
    if (!res.ok) throw new Error(`lead-service /internal/meeting-attribution ${res.status}: ${await res.text()}`);
    return meetingBookingGainOf(await res.json());
  } catch (err) {
    console.error("[features-service] meeting booking gain unreadable, served null:", err);
    return {
      legKey: MEETING_BOOKING_LEG,
      basis: "positive_repliers_since_inception",
      aiMeetingBooking: null,
      yourTeamMeetingBooking: null,
      gainPctPoints: null,
      bookedRequiredPerSide: legMaturity(MEETING_BOOKING_LEG).outcomesRequired,
      unavailableReason: "lead_service_unavailable",
    };
  }
}
