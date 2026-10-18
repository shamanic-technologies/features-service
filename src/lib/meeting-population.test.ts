import { describe, expect, it } from "vitest";
import {
  legMeasuresMeetings,
  meetingPopulationOf,
  meetingReportingOf,
  splitByMeetingReporting,
} from "./meeting-population.js";

const row = (brandId: string, total: number) => ({ orgId: "o", brandId, meetings: { total } });

describe("MEETING-POPULATION-1018: ONE rule for every meeting figure", () => {
  it("a brand reports meetings when lead-service holds at least one live meeting fact for it (prod 2026-10-18: a CRM brand and a tracker brand)", () => {
    const r = meetingReportingOf({ byBrand: [row("crm", 162), row("tracker", 8), row("silent", 0)] });
    expect(r.reportingBrandIds).toEqual(["crm", "tracker"]);
    expect(r.reports("crm")).toBe(true);
    expect(r.reports("silent")).toBe(false);
    expect(r.reports("never-seen")).toBe(false);
    expect(r.reports(null)).toBe(false);
  });

  it("a malformed producer row is an error, never a brand silently left out", () => {
    expect(() => meetingReportingOf({})).toThrow(/byBrand/);
    expect(() => meetingReportingOf({ byBrand: [{ brandId: "b" }] })).toThrow(/meetings.total/);
  });

  it("states who a figure was measured on, each brand once", () => {
    const r = meetingReportingOf({ byBrand: [row("a", 1)] });
    expect(meetingPopulationOf(["a", "a", "b", "c", null], r)).toEqual({ rule: "brands_reporting_meetings", brandsCounted: 1, brandsLeftOut: 3 });
    const split = splitByMeetingReporting(
      [
        { id: 1, brandId: "a" },
        { id: 2, brandId: "b" },
        { id: 3, brandId: "a" },
      ],
      r,
    );
    expect(split.counted.map((c) => c.id)).toEqual([1, 3]);
    expect(split.population).toEqual({ rule: "brands_reporting_meetings", brandsCounted: 1, brandsLeftOut: 1 });
  });

  it("applies to every leg landing on a meeting step, whatever the channel, and to no other", () => {
    expect(legMeasuresMeetings("ai-meeting-booking", "conversation_to_meeting_booked")).toBe(true);
    expect(legMeasuresMeetings("your-team-meeting-attendance", "meeting_booked_to_meeting_attended")).toBe(true);
    expect(legMeasuresMeetings("sales-cold-email-outreach", "lead_found_to_conversation")).toBe(false);
    expect(legMeasuresMeetings("sales-cold-email-outreach", "start_to_website_visit")).toBe(false);
    expect(legMeasuresMeetings("x", "not_a_leg")).toBe(false);
  });
});
