/**
 * AI MEETING BOOKING, BEFORE vs AFTER (amarillo-v2 2026-10-14; the owner told Doc Dinners on 2026-10-12 "the
 * auto-replier increased +50% booking rate versus before it was put online": a client email may only quote a SERVED
 * figure, so the claim is verified or corrected here).
 *
 * Per brand that turned AI Meeting Booking on (leg conversation_to_meeting_booked), the Positive reply -> Meeting booked
 * rate BEFORE it went live vs AFTER, both populations, plus the fleet roll-up. Read from lead-service
 * `GET /internal/meeting-attribution/before-after`, which owns go-live (the brand's FIRST AI Meeting Booking act, never
 * a creation date), the window of each person (their first positive reply) and the person-to-meeting rule.
 *
 * The CHANGE is taken on the SAME-HORIZON block (`withinDays`: people whose first positive reply is at least N days
 * old, booked within N days), never on the open windows: a recent replier has had less time to book, so the open
 * "after" window reads low by construction. It is served only once EACH window booked the leg's maturity bar
 * (`lib/maturity.ts`, `outcomesRequired`), else null + `not_enough_meetings` with both populations: a change over a
 * handful of meetings is noise, never a claim we make to a client. Unreadable producer = null + loud log, never a 502.
 *
 * Measured on the brands that REPORT meetings only (`lib/meeting-population.ts`, MEETING-POPULATION-1018): a brand
 * that never reported a meeting reads zero booked whatever happened, so its row says `reportsMeetings: false` with no
 * change (`brand_reports_no_meetings`), and the FLEET is the sum of the reporting brands' windows (lead-service's own
 * fleet roll-up sums every go-live brand: it is checked against the brands' sum, never served). `fleet.population`
 * names the brands counted and left out.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { legMaturity } from "./maturity.js";
import { MEETING_BOOKING_LEG } from "./meeting-booking-gain.js";
import {
  BRAND_REPORTS_NO_MEETINGS,
  meetingPopulationOf,
  NO_BRAND_REPORTS_MEETINGS,
  type MeetingPopulation,
  type MeetingReporting,
} from "./meeting-population.js";
import { getMeetingReporting } from "./meeting-reporting-client.js";

export interface MeetingBookingWindow {
  /** People whose FIRST positive reply is in this window (the rate's population). */
  positiveReplyPeople: number;
  /** Of them, people who booked a meeting at or after that reply, whoever booked it. */
  bookedPeople: number;
  /** bookedPeople / positiveReplyPeople x 100, 2 decimals; null when nobody. */
  ratePct: number | null;
  /** Who booked each booked person's first meeting. */
  bookedBy: { aiMeetingBooking: number; yourTeamMeetingBooking: number; other: number; unknown: number };
  /** Same horizon for both windows: replied at least `days` ago, booked within `days`. */
  sameHorizon: { days: number; positiveReplyPeople: number; bookedPeople: number; ratePct: number | null };
}

export interface MeetingBookingChange {
  /** After rate minus before rate (same horizon), in percentage points. */
  changePctPoints: number | null;
  /** (after rate / before rate - 1) x 100 (same horizon): the "+50%" kind of figure. Null when before is 0. */
  relativeChangePct: number | null;
  /** Meetings EACH window must have booked (same horizon) before the change is served. */
  bookedRequiredPerWindow: number;
  unavailableReason: "not_enough_meetings" | "no_before_history" | typeof BRAND_REPORTS_NO_MEETINGS | typeof NO_BRAND_REPORTS_MEETINGS | null;
}

export interface MeetingBookingBrandBeforeAfter extends MeetingBookingChange {
  brandId: string;
  /** When AI Meeting Booking went live for the brand (its first AI Meeting Booking act). */
  goLiveAt: string;
  /** The brand reports its meetings to us; false = left out of the fleet, no change served. */
  reportsMeetings: boolean;
  before: MeetingBookingWindow;
  after: MeetingBookingWindow;
}

export interface MeetingBookingBeforeAfter {
  legKey: typeof MEETING_BOOKING_LEG;
  basis: "positive_repliers_by_first_reply_vs_ai_go_live";
  /** Brands with a go-live (a brand whose AI never acted is in no comparison). */
  brands: MeetingBookingBrandBeforeAfter[] | null;
  /** The reporting brands' windows summed. `brandCount` = `population.brandsCounted`. */
  fleet: (MeetingBookingChange & { brandCount: number; population: MeetingPopulation; before: MeetingBookingWindow; after: MeetingBookingWindow }) | null;
  unavailableReason: "lead_service_unavailable" | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den === 0 ? null : round2((num / den) * 100));

function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`[features-service] lead-service meeting before-after: ${what} is not a count`);
  }
  return v;
}

function windowOf(raw: unknown, what: string): MeetingBookingWindow {
  const w = raw as {
    people?: unknown;
    booked?: unknown;
    bookedBy?: Record<string, unknown>;
    withinDays?: { days?: unknown; people?: unknown; booked?: unknown };
  } | null;
  if (!w || !w.bookedBy || !w.withinDays) throw new Error(`[features-service] lead-service meeting before-after: ${what} malformed`);
  const people = int(w.people, `${what}.people`);
  const booked = int(w.booked, `${what}.booked`);
  const hPeople = int(w.withinDays.people, `${what}.withinDays.people`);
  const hBooked = int(w.withinDays.booked, `${what}.withinDays.booked`);
  return {
    positiveReplyPeople: people,
    bookedPeople: booked,
    ratePct: pct(booked, people),
    bookedBy: {
      aiMeetingBooking: int(w.bookedBy.aiMeetingBooking, `${what}.bookedBy.aiMeetingBooking`),
      yourTeamMeetingBooking: int(w.bookedBy.yourTeamMeetingBooking, `${what}.bookedBy.yourTeamMeetingBooking`),
      other: int(w.bookedBy.other, `${what}.bookedBy.other`),
      unknown: int(w.bookedBy.unknown, `${what}.bookedBy.unknown`),
    },
    sameHorizon: { days: int(w.withinDays.days, `${what}.withinDays.days`), positiveReplyPeople: hPeople, bookedPeople: hBooked, ratePct: pct(hBooked, hPeople) },
  };
}

/** PURE: the change between two windows, on the same horizon, gated on the leg's maturity bar per window. */
export function meetingBookingChangeOf(before: MeetingBookingWindow, after: MeetingBookingWindow): MeetingBookingChange {
  const required = legMaturity(MEETING_BOOKING_LEG).outcomesRequired;
  const b = before.sameHorizon;
  const a = after.sameHorizon;
  if (before.positiveReplyPeople === 0) {
    return { changePctPoints: null, relativeChangePct: null, bookedRequiredPerWindow: required, unavailableReason: "no_before_history" };
  }
  if (b.bookedPeople < required || a.bookedPeople < required || b.ratePct === null || a.ratePct === null) {
    return { changePctPoints: null, relativeChangePct: null, bookedRequiredPerWindow: required, unavailableReason: "not_enough_meetings" };
  }
  return {
    changePctPoints: round2(a.ratePct - b.ratePct),
    relativeChangePct: b.ratePct === 0 ? null : round2((a.ratePct / b.ratePct - 1) * 100),
    bookedRequiredPerWindow: required,
    unavailableReason: null,
  };
}

/** PURE: windows added up (people are per brand, so the sum counts each person once). */
export function sumWindows(windows: readonly MeetingBookingWindow[], days: number): MeetingBookingWindow {
  const t = { people: 0, booked: 0, ai: 0, team: 0, other: 0, unknown: 0, hPeople: 0, hBooked: 0 };
  for (const w of windows) {
    if (w.sameHorizon.days !== days) throw new Error(`[features-service] meeting before-after: windows on two horizons (${w.sameHorizon.days} vs ${days} days)`);
    t.people += w.positiveReplyPeople;
    t.booked += w.bookedPeople;
    t.ai += w.bookedBy.aiMeetingBooking;
    t.team += w.bookedBy.yourTeamMeetingBooking;
    t.other += w.bookedBy.other;
    t.unknown += w.bookedBy.unknown;
    t.hPeople += w.sameHorizon.positiveReplyPeople;
    t.hBooked += w.sameHorizon.bookedPeople;
  }
  return {
    positiveReplyPeople: t.people,
    bookedPeople: t.booked,
    ratePct: pct(t.booked, t.people),
    bookedBy: { aiMeetingBooking: t.ai, yourTeamMeetingBooking: t.team, other: t.other, unknown: t.unknown },
    sameHorizon: { days, positiveReplyPeople: t.hPeople, bookedPeople: t.hBooked, ratePct: pct(t.hBooked, t.hPeople) },
  };
}

/** PURE: the served figure from lead-service's before-after body, over the brands that report meetings. */
export function meetingBookingBeforeAfterOf(body: unknown, reporting: MeetingReporting): MeetingBookingBeforeAfter {
  const b = body as {
    brands?: Array<{ brandId?: unknown; goLive?: { at?: unknown } | null; before?: unknown; after?: unknown }>;
    fleet?: { brands?: unknown; before?: unknown; after?: unknown };
  } | null;
  if (!b || !Array.isArray(b.brands) || !b.fleet) throw new Error("[features-service] lead-service meeting before-after has no brands/fleet");
  const brands: MeetingBookingBrandBeforeAfter[] = [];
  for (const row of b.brands) {
    if (!row.goLive) continue; // AI never acted: no comparison (lead-service keeps it out of `fleet` too)
    if (typeof row.brandId !== "string" || typeof row.goLive.at !== "string") {
      throw new Error("[features-service] lead-service meeting before-after: brand row without brandId/goLive.at");
    }
    const before = windowOf(row.before, `${row.brandId}.before`);
    const after = windowOf(row.after, `${row.brandId}.after`);
    const reportsMeetings = reporting.reports(row.brandId);
    const change: MeetingBookingChange = reportsMeetings
      ? meetingBookingChangeOf(before, after)
      : { changePctPoints: null, relativeChangePct: null, bookedRequiredPerWindow: legMaturity(MEETING_BOOKING_LEG).outcomesRequired, unavailableReason: BRAND_REPORTS_NO_MEETINGS };
    brands.push({ brandId: row.brandId, goLiveAt: row.goLive.at, reportsMeetings, before, after, ...change });
  }
  brands.sort((x, y) => y.before.positiveReplyPeople + y.after.positiveReplyPeople - (x.before.positiveReplyPeople + x.after.positiveReplyPeople) || x.brandId.localeCompare(y.brandId));
  // lead-service's own roll-up is every go-live brand: our sum over the same brands must equal it (a drift is a
  // contract change, never a figure we serve).
  const producerBefore = windowOf(b.fleet.before, "fleet.before");
  const producerAfter = windowOf(b.fleet.after, "fleet.after");
  const days = producerBefore.sameHorizon.days;
  const allBefore = sumWindows(brands.map((r) => r.before), days);
  const allAfter = sumWindows(brands.map((r) => r.after), days);
  if (
    int(b.fleet.brands, "fleet.brands") !== brands.length ||
    allBefore.positiveReplyPeople !== producerBefore.positiveReplyPeople ||
    allBefore.bookedPeople !== producerBefore.bookedPeople ||
    allAfter.positiveReplyPeople !== producerAfter.positiveReplyPeople ||
    allAfter.bookedPeople !== producerAfter.bookedPeople
  ) {
    throw new Error("[features-service] lead-service meeting before-after: fleet is not the sum of its go-live brands");
  }
  const counted = brands.filter((r) => r.reportsMeetings);
  const population = meetingPopulationOf(brands.map((r) => r.brandId), reporting);
  const fBefore = sumWindows(counted.map((r) => r.before), days);
  const fAfter = sumWindows(counted.map((r) => r.after), days);
  const change: MeetingBookingChange =
    counted.length === 0
      ? { changePctPoints: null, relativeChangePct: null, bookedRequiredPerWindow: legMaturity(MEETING_BOOKING_LEG).outcomesRequired, unavailableReason: NO_BRAND_REPORTS_MEETINGS }
      : meetingBookingChangeOf(fBefore, fAfter);
  return {
    legKey: MEETING_BOOKING_LEG,
    basis: "positive_repliers_by_first_reply_vs_ai_go_live",
    brands,
    fleet: { brandCount: population.brandsCounted, population, before: fBefore, after: fAfter, ...change },
    unavailableReason: null,
  };
}

export async function fetchMeetingBookingBeforeAfter(): Promise<MeetingBookingBeforeAfter> {
  try {
    const res = await fetchWithRetry(`${process.env.LEAD_SERVICE_URL}/internal/meeting-attribution/before-after`, {
      headers: { "x-api-key": process.env.LEAD_SERVICE_API_KEY! },
    });
    if (!res.ok) throw new Error(`lead-service /internal/meeting-attribution/before-after ${res.status}: ${await res.text()}`);
    const [body, reporting] = await Promise.all([res.json(), getMeetingReporting()]);
    return meetingBookingBeforeAfterOf(body, reporting);
  } catch (err) {
    console.error("[features-service] meeting booking before/after unreadable, served null:", err);
    return { legKey: MEETING_BOOKING_LEG, basis: "positive_repliers_by_first_reply_vs_ai_go_live", brands: null, fleet: null, unavailableReason: "lead_service_unavailable" };
  }
}
