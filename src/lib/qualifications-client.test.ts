import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchQualifications, standingDates, type QualificationRow } from "./qualifications-client.js";

const ALLEN = "drlawrence@allenlawrencemd.com";
const OTHER = "booked@example.com";

function row(p: Partial<QualificationRow> & Pick<QualificationRow, "email" | "status" | "qualifiedAt">): QualificationRow {
  return { instantlyCampaignId: "ic-1", campaignId: "c-1", withdrawnAt: null, ...p };
}

describe("standingDates — only the statement that still stands counts", () => {
  it("a meeting restated as merely interested is gone (Doc Dinners, 2026-09-26)", () => {
    expect(
      standingDates([
        row({ email: ALLEN, status: "lead_meeting_booked", qualifiedAt: "2026-06-11T10:00:00.000Z" }),
        row({ email: ALLEN, status: "lead_interested", qualifiedAt: "2026-09-26T12:44:00.000Z" }),
      ]),
    ).toEqual({ meetingBookedAt: null, closedAt: null });
  });

  it("a meeting whose latest statement is still meeting booked counts", () => {
    expect(
      standingDates([
        row({ email: OTHER, status: "lead_interested", qualifiedAt: "2026-06-01T00:00:00.000Z" }),
        row({ email: OTHER, status: "lead_meeting_booked", qualifiedAt: "2026-06-11T00:00:00.000Z" }),
      ]),
    ).toEqual({ meetingBookedAt: "2026-06-11T00:00:00.000Z", closedAt: null });
  });

  it("a close keeps the meeting it progressed through", () => {
    expect(
      standingDates([
        row({ email: OTHER, status: "lead_meeting_booked", qualifiedAt: "2026-06-11T00:00:00.000Z" }),
        row({ email: OTHER, status: "lead_closed", qualifiedAt: "2026-07-01T00:00:00.000Z" }),
      ]),
    ).toEqual({ meetingBookedAt: "2026-06-11T00:00:00.000Z", closedAt: "2026-07-01T00:00:00.000Z" });
  });
});

describe("fetchQualifications — reads the standing statement per (campaign, lead)", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.EMAIL_GATEWAY_SERVICE_URL = "http://gw";
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function serve(rows: QualificationRow[]) {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ qualifications: rows }), { status: 200 })) as never;
  }

  it("drops a superseded meeting and a withdrawn one, keeps a standing one", async () => {
    serve([
      // DESC order, as the producer serves it
      row({ email: ALLEN, status: "lead_interested", qualifiedAt: "2026-09-26T12:44:00.000Z" }),
      row({ email: "w@x.com", status: "lead_meeting_booked", qualifiedAt: "2026-08-01T00:00:00.000Z", withdrawnAt: "2026-08-02T00:00:00.000Z" }),
      row({ email: OTHER, status: "lead_meeting_booked", qualifiedAt: "2026-07-01T00:00:00.000Z" }),
      row({ email: ALLEN, status: "lead_meeting_booked", qualifiedAt: "2026-06-11T10:00:00.000Z" }),
    ]);
    const out = await fetchQualifications("b", undefined, [ALLEN, OTHER, "w@x.com"], { orgId: "o" });
    expect(out.get(ALLEN)).toBeUndefined();
    expect(out.get("w@x.com")).toBeUndefined();
    expect(out.get(OTHER)).toEqual({ meetingBookedAt: "2026-07-01T00:00:00.000Z", closedAt: null });
  });

  it("a withdrawn latest statement lets the earlier standing one answer, per the producer's rule", async () => {
    serve([
      row({ email: OTHER, status: "lead_interested", qualifiedAt: "2026-08-01T00:00:00.000Z", withdrawnAt: "2026-08-01T01:00:00.000Z" }),
      row({ email: OTHER, status: "lead_meeting_booked", qualifiedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    const out = await fetchQualifications("b", undefined, [OTHER], { orgId: "o" });
    expect(out.get(OTHER)?.meetingBookedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("statements on two campaigns stand independently; the earliest standing date wins", async () => {
    serve([
      row({ email: OTHER, status: "lead_interested", qualifiedAt: "2026-09-01T00:00:00.000Z", instantlyCampaignId: "ic-2" }),
      row({ email: OTHER, status: "lead_meeting_booked", qualifiedAt: "2026-08-01T00:00:00.000Z", instantlyCampaignId: "ic-2" }),
      row({ email: OTHER, status: "lead_meeting_booked", qualifiedAt: "2026-08-15T00:00:00.000Z", instantlyCampaignId: "ic-1" }),
    ]);
    const out = await fetchQualifications("b", undefined, [OTHER], { orgId: "o" });
    expect(out.get(OTHER)?.meetingBookedAt).toBe("2026-08-15T00:00:00.000Z");
  });
});
