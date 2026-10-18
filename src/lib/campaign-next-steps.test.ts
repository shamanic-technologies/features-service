import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { chooseTimeToReply, isReplyPipe, parseEmailSendQueue, TIME_TO_REPLY_MIN_SAMPLE } from "./campaign-next-steps.js";

const DAY = 86_400_000;
const metric = (sampleSize: number, medianDays: number | null, averageDays: number | null = medianDays) => ({
  sampleSize,
  medianMs: medianDays === null ? null : medianDays * DAY,
  averageMs: averageDays === null ? null : averageDays * DAY,
});

describe("isReplyPipe (CAMPAIGN-NEXT-STEPS-1018)", () => {
  it("a leg ending on a positive reply, in either spelling, is a reply pipe", () => {
    expect(isReplyPipe("lead_found_to_conversation")).toBe(true);
    expect(isReplyPipe("start_to_conversation")).toBe(true);
  });
  it("sourcing and closing legs are not", () => {
    expect(isReplyPipe("start_to_lead_found")).toBe(false);
    expect(isReplyPipe("conversation_to_paid_client")).toBe(false);
  });
});

describe("chooseTimeToReply", () => {
  it("states the campaign's own figure once it holds the bar", () => {
    const t = chooseTimeToReply({ hasReplyPipe: true, campaign: metric(TIME_TO_REPLY_MIN_SAMPLE, 4.25, 9), pipeFleet: metric(59, 5.3, 19.5) });
    expect(t).toMatchObject({ basis: "campaign", medianDays: 4.3, averageDays: 9, sampleSize: 10, learning: false, unavailableReason: null });
  });

  it("falls back to the same pipes across the fleet while the campaign is below the bar", () => {
    const t = chooseTimeToReply({ hasReplyPipe: true, campaign: metric(2, 1), pipeFleet: metric(59, 5.3, 19.5) });
    expect(t).toMatchObject({ basis: "pipe_fleet", medianDays: 5.3, averageDays: 19.5, sampleSize: 59, learning: false });
    expect(t.campaign).toMatchObject({ sampleSize: 2, medianDays: 1 });
  });

  it("learning when neither population reaches the bar: no number, never a default", () => {
    const t = chooseTimeToReply({ hasReplyPipe: true, campaign: metric(0, null), pipeFleet: metric(3, 2) });
    expect(t).toMatchObject({ basis: null, medianDays: null, learning: true, unavailableReason: "learning" });
    expect(t.pipeFleet).toMatchObject({ sampleSize: 3 });
  });

  it("names a campaign with no pipe ending on a positive reply", () => {
    expect(chooseTimeToReply({ hasReplyPipe: false, campaign: null, pipeFleet: null })).toMatchObject({ medianDays: null, learning: false, unavailableReason: "no_positive_reply_pipe" });
  });

  it("an unreadable latency is named, never learning", () => {
    expect(chooseTimeToReply({ hasReplyPipe: true, campaign: null, pipeFleet: null, unreadable: true })).toMatchObject({ medianDays: null, learning: false, unavailableReason: "reply_latency_unreadable" });
  });
});

describe("parseEmailSendQueue", () => {
  const body = {
    campaignIds: ["u1"],
    asOf: "2026-10-18T20:00:00.000Z",
    leadsAwaitingFirstEmail: 3,
    leadsWithFollowUpQueued: 1,
    queuedEmails: 9,
    firstEmailsFrom: "2026-10-19T05:00:00.000Z",
    sendWindow: { weekdays: ["monday"], startHour: 7, endHour: 19, timezoneRule: "lead_local" },
    timezones: [{ timezone: "Europe/Paris", timezoneIsDefault: false, leadsAwaitingFirstEmail: 3, windowOpensAt: "2026-10-19T05:00:00.000Z" }],
  };
  it("reads the sender's body", () => {
    expect(parseEmailSendQueue(body)).toMatchObject({ leadsAwaitingFirstEmail: 3, firstEmailsFrom: "2026-10-19T05:00:00.000Z", sendWindow: { startHour: 7 } });
  });
  it("throws on a missing count, never a silent zero", () => {
    expect(() => parseEmailSendQueue({ ...body, leadsAwaitingFirstEmail: undefined })).toThrow();
  });
});
