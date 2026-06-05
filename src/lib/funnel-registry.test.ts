import { describe, it, expect } from "vitest";
import { getFunnel } from "./funnel-registry.js";

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToClosePct: 2,
};

// sent/contacted=1, delivered/sent=1, clicked/delivered=0.1, posReply/delivered=0.1
const RATES = {
  sentPerContacted: 1,
  deliveredPerSent: 1,
  clickedPerDelivered: 0.1,
  positiveReplyPerDelivered: 0.1,
};

describe("sales funnel — resolvePaths", () => {
  const funnel = getFunnel("sales-cold-email-outreach")!;
  const paths = funnel.resolvePaths({ economics: ECONOMICS, platformRates: RATES });
  const byTag = Object.fromEntries(paths.map((p) => [p.tag, p]));

  it("emits the 8 stage paths (incl. opened, meeting, closeWin)", () => {
    expect(paths).toHaveLength(8);
    expect(Object.keys(byTag).sort()).toEqual(["closeWin", "contacted", "delivered", "meeting", "opened", "reply", "sent", "visit"]);
  });

  it("click / reply EV come from sales-economics (rate-independent)", () => {
    expect(byTag.visit.expectedRevenueUsd).toBeCloseTo(20); // 1000·max(0.02, 0.05·0.30)
    expect(byTag.reply.expectedRevenueUsd).toBeCloseTo(120); // 1000·0.40·0.30
  });

  it("meeting EV = LTR × P(close|meeting); closeWin EV = full LTR (realized)", () => {
    expect(byTag.meeting.expectedRevenueUsd).toBeCloseTo(300); // 1000·0.30
    expect(byTag.closeWin.expectedRevenueUsd).toBeCloseTo(1000); // full LTR
  });

  it("EV is monotonic up the post-engagement chain: reply < meeting < closeWin", () => {
    expect(byTag.reply.expectedRevenueUsd).toBeLessThan(byTag.meeting.expectedRevenueUsd);
    expect(byTag.meeting.expectedRevenueUsd).toBeLessThan(byTag.closeWin.expectedRevenueUsd);
  });

  it("delivered / sent / contacted chain the platform rates down to close", () => {
    // pClose_deliv = max(0.1·0.02, 0.1·0.12) = 0.012 → 12 ; ×1 ×1 upstream
    expect(byTag.delivered.expectedRevenueUsd).toBeCloseTo(12);
    expect(byTag.sent.expectedRevenueUsd).toBeCloseTo(12);
    expect(byTag.contacted.expectedRevenueUsd).toBeCloseTo(12);
  });

  it("tags delivery stages as delivery (ascending order) and visit/reply/meeting/closeWin as engagement", () => {
    expect(byTag.contacted.kind).toBe("delivery");
    expect(byTag.sent.kind).toBe("delivery");
    expect(byTag.delivered.kind).toBe("delivery");
    expect(byTag.opened.kind).toBe("delivery");
    expect(byTag.visit.kind).toBe("engagement");
    expect(byTag.reply.kind).toBe("engagement");
    expect(byTag.meeting.kind).toBe("engagement");
    expect(byTag.closeWin.kind).toBe("engagement");
    // delivery stages must be in ascending funnel order (engine picks the last fired)
    const order = paths.filter((p) => p.kind === "delivery").map((p) => p.tag);
    expect(order).toEqual(["contacted", "sent", "delivered", "opened"]);
  });

  it("post-engagement stages are listed after engagement in ascending funnel order (reply < meeting < closeWin)", () => {
    const tagOrder = paths.map((p) => p.tag);
    expect(tagOrder.indexOf("reply")).toBeLessThan(tagOrder.indexOf("meeting"));
    expect(tagOrder.indexOf("meeting")).toBeLessThan(tagOrder.indexOf("closeWin"));
    expect(tagOrder.indexOf("visit")).toBeLessThan(tagOrder.indexOf("reply"));
  });

  it("opened carries the delivered close-probability (decay checkpoint, no extra EV)", () => {
    expect(byTag.opened.expectedRevenueUsd).toBeCloseTo(byTag.delivered.expectedRevenueUsd);
  });

  it("decay windows: pre-engagement + reply(14d)/meeting(30d) carry one; click & closeWin terminal (none)", () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(byTag.contacted.staleAfterMs).toBe(7 * DAY);
    expect(byTag.sent.staleAfterMs).toBe(3 * DAY);
    expect(byTag.delivered.staleAfterMs).toBe(14 * DAY);
    expect(byTag.opened.staleAfterMs).toBe(14 * DAY);
    // Phase 2: reply → meeting (14d), meeting → close (30d).
    expect(byTag.reply.staleAfterMs).toBe(14 * DAY);
    expect(byTag.meeting.staleAfterMs).toBe(30 * DAY);
    // Terminals never decay: a click has no onward window; close-win is realized revenue (immune).
    expect(byTag.visit.staleAfterMs).toBeUndefined();
    expect(byTag.closeWin.staleAfterMs).toBeUndefined();
  });

  it("every path is itemised in the events ledger", () => {
    expect(paths.every((p) => p.ledger !== false)).toBe(true);
  });

  it("upstream rates scale the stage EVs down", () => {
    const paths2 = funnel.resolvePaths({
      economics: ECONOMICS,
      platformRates: { ...RATES, sentPerContacted: 0.5, deliveredPerSent: 0.5 },
    });
    const t = Object.fromEntries(paths2.map((p) => [p.tag, p]));
    expect(t.delivered.expectedRevenueUsd).toBeCloseTo(12); // unaffected by upstream
    expect(t.sent.expectedRevenueUsd).toBeCloseTo(6); // ×0.5 delivered|sent
    expect(t.contacted.expectedRevenueUsd).toBeCloseTo(3); // ×0.5 ×0.5
  });
});
