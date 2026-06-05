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

  it("emits the 5 stage paths", () => {
    expect(paths).toHaveLength(5);
    expect(Object.keys(byTag).sort()).toEqual(["contacted", "delivered", "reply", "sent", "visit"]);
  });

  it("click / reply EV come from sales-economics (rate-independent)", () => {
    expect(byTag.visit.expectedRevenueUsd).toBeCloseTo(20); // 1000·max(0.02, 0.05·0.30)
    expect(byTag.reply.expectedRevenueUsd).toBeCloseTo(120); // 1000·0.40·0.30
  });

  it("delivered / sent / contacted chain the platform rates down to close", () => {
    // pClose_deliv = max(0.1·0.02, 0.1·0.12) = 0.012 → 12 ; ×1 ×1 upstream
    expect(byTag.delivered.expectedRevenueUsd).toBeCloseTo(12);
    expect(byTag.sent.expectedRevenueUsd).toBeCloseTo(12);
    expect(byTag.contacted.expectedRevenueUsd).toBeCloseTo(12);
  });

  it("tags delivery stages as delivery (ascending order) and visit/reply as engagement", () => {
    expect(byTag.contacted.kind).toBe("delivery");
    expect(byTag.sent.kind).toBe("delivery");
    expect(byTag.delivered.kind).toBe("delivery");
    expect(byTag.visit.kind).toBe("engagement");
    expect(byTag.reply.kind).toBe("engagement");
    // delivery stages must be in ascending funnel order (engine picks the last fired)
    const order = paths.filter((p) => p.kind === "delivery").map((p) => p.tag);
    expect(order).toEqual(["contacted", "sent", "delivered"]);
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
