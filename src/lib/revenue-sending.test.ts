import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { buildRevenueOutcomes, buildRevenueSending } from "./revenue-outcomes.js";
import type { EnginePerson } from "./revenue-engine.js";

function person(leadId: string, signals: Record<string, boolean>): EnginePerson {
  return { leadId, orgId: null, orgName: null, signals, signalDates: {} } as unknown as EnginePerson;
}

// Shaped like brand 75d7e3e8 in prod: most sent+delivered, some bounced, some delivered-then-bounced,
// a few contacted but never sent, one bounce with no recorded send, repliers of every class.
const PERSONS: EnginePerson[] = [
  person("a", { contacted: true, sent: true, delivered: true }),
  person("b", { contacted: true, sent: true, delivered: true, replied: true, positiveReply: true }),
  person("c", { contacted: true, sent: true, delivered: true, replied: true, negativeReply: true }),
  person("d", { contacted: true, sent: true, delivered: true, bounced: true }),
  person("e", { contacted: true, sent: true, bounced: true }),
  person("f", { contacted: true, sent: true }),
  person("g", { contacted: true }),
  person("h", { contacted: true, bounced: true }),
  // the same lead served twice counts once
  person("a", { contacted: true, sent: true, delivered: true }),
  // unclassified reply still a reply
  person("i", { contacted: true, sent: true, delivered: true, replied: true }),
];

describe("sending block", () => {
  it("delivered + bounced + awaiting = sent, a delivered-then-bounced lead counts as bounced once", () => {
    const s = buildRevenueSending([...new Map(PERSONS.map((p) => [p.leadId, p])).values()]);
    expect(s.recipientsSent).toBe(7);
    expect(s.recipientsDelivered).toBe(4);
    expect(s.recipientsBounced).toBe(2);
    expect(s.recipientsAwaitingDelivery).toBe(1);
    expect(s.recipientsDelivered + s.recipientsBounced + s.recipientsAwaitingDelivery).toBe(s.recipientsSent);
    expect(s.recipientsReplied).toBe(3);
    expect(s.recipientsRepliedPositive).toBe(1);
    expect(s.deliveryRatePct).toBeCloseTo((100 * 4) / 7);
    expect(s.bounceRatePct).toBeCloseTo((100 * 2) / 7);
    expect(s.replyRatePct).toBeCloseTo((100 * 3) / 7);
    expect(s.positiveReplyRatePct).toBeCloseTo(100 / 7);
  });

  it("rides the outcomes block, deduped, beside the reach counts it is a subset of", () => {
    const o = buildRevenueOutcomes(PERSONS, { committedCents: 1000, actualCents: 900 } as never);
    expect(o.recipientsContacted).toBe(9);
    expect(o.sending.recipientsSent).toBe(7);
    // outcomes.recipientsBounced also counts the bounce with no recorded send
    expect(o.recipientsBounced).toBe(3);
    expect(o.sending.recipientsBounced).toBe(2);
    expect(o.sending.recipientsRepliedPositive).toBe(o.recipientsRepliesPositive);
  });

  it("nothing sent → every rate null (no denominator), counts a measured 0", () => {
    const s = buildRevenueSending([person("g", { contacted: true })]);
    expect(s.recipientsSent).toBe(0);
    expect(s.deliveryRatePct).toBeNull();
    expect(s.replyRatePct).toBeNull();
    const zero = buildRevenueSending([person("a", { contacted: true, sent: true })]);
    expect(zero.deliveryRatePct).toBe(0);
    expect(zero.replyRatePct).toBe(0);
  });
});
