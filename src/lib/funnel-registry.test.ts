import { describe, it, expect } from "vitest";
import { getFunnel, orP, projectOutcomeCosts, singleStepRateDecimal, formSubmissionRatesDecimal } from "./funnel-registry.js";

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10, // 0.20 × 0.10 = 0.02 = visitToClosePct
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
    expect(byTag.visit.expectedRevenueUsd).toBeCloseTo(34.7); // 1000·orP(0.02, 0.05·0.30) = 1000·(1−0.98·0.985)
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
    // pClose_deliv = orP(0.1·0.0347, 0.1·0.12) = 1−(1−0.00347)(1−0.012) = 0.0154284 → 15.4284 ; ×1 ×1 upstream
    expect(byTag.delivered.expectedRevenueUsd).toBeCloseTo(15.4284);
    expect(byTag.sent.expectedRevenueUsd).toBeCloseTo(15.4284);
    expect(byTag.contacted.expectedRevenueUsd).toBeCloseTo(15.4284);
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
    expect(t.delivered.expectedRevenueUsd).toBeCloseTo(15.4284); // unaffected by upstream
    expect(t.sent.expectedRevenueUsd).toBeCloseTo(7.7142); // ×0.5 delivered|sent
    expect(t.contacted.expectedRevenueUsd).toBeCloseTo(3.8571); // ×0.5 ×0.5
  });
});

describe("projectOutcomeCosts — expected cost per purchase / meeting", () => {
  // decimals of ECONOMICS above
  const econ = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04 };

  it("purchase cost = 1 / closesPerBudget (same formula as workflow-projection)", () => {
    const clickUsd = 10;
    const replyUsd = 5;
    const pCloseClick = orP(econ.v2c, econ.v2m * econ.m2c);
    const pCloseReply = econ.r2m * econ.m2c;
    const closesPerBudget = (1 / clickUsd) * pCloseClick + (1 / replyUsd) * pCloseReply;
    const { costPerPurchaseUsd } = projectOutcomeCosts(econ, { clickUsd, replyUsd });
    expect(costPerPurchaseUsd).toBeCloseTo(1 / closesPerBudget);
  });

  it("meeting cost = 1 / ((1/clickUsd)·v2m + (1/replyUsd)·r2m)", () => {
    const clickUsd = 10;
    const replyUsd = 5;
    const meetingsPerBudget = (1 / clickUsd) * econ.v2m + (1 / replyUsd) * econ.r2m;
    const { costPerMeetingBookedUsd } = projectOutcomeCosts(econ, { clickUsd, replyUsd });
    expect(costPerMeetingBookedUsd).toBeCloseTo(1 / meetingsPerBudget);
  });

  it("a null unit cost contributes 0 — metric still computed from the other leg", () => {
    const { costPerPurchaseUsd, costPerMeetingBookedUsd } = projectOutcomeCosts(econ, { clickUsd: null, replyUsd: 5 });
    expect(costPerPurchaseUsd).toBeCloseTo(1 / ((1 / 5) * econ.r2m * econ.m2c));
    expect(costPerMeetingBookedUsd).toBeCloseTo(1 / ((1 / 5) * econ.r2m));
  });

  it("both unit costs null → no usable data → both null", () => {
    expect(projectOutcomeCosts(econ, { clickUsd: null, replyUsd: null })).toEqual({
      costPerPurchaseUsd: null,
      costPerMeetingBookedUsd: null,
      costPerSignupUsd: null,
      costPerSignupPaidClientUsd: null,
      costPerMeetingPaidClientUsd: null,
      costPerVisitPaidClientUsd: null,
      costPerReplyPaidClientUsd: null,
      costPerFormSubmissionUsd: null,
      costPerFormSubmissionPaidClientUsd: null,
    });
  });

  it("zero conversion rates → perBudget 0 → all null", () => {
    const dead = { r2m: 0, v2m: 0, m2c: 0, v2c: 0, v2s: 0, s2pc: 0, v2pc: 0, r2pc: 0, v2fs: 0, fs2pc: 0 };
    expect(projectOutcomeCosts(dead, { clickUsd: 10, replyUsd: 5 })).toEqual({
      costPerPurchaseUsd: null,
      costPerMeetingBookedUsd: null,
      costPerSignupUsd: null,
      costPerSignupPaidClientUsd: null,
      costPerMeetingPaidClientUsd: null,
      costPerVisitPaidClientUsd: null,
      costPerReplyPaidClientUsd: null,
      costPerFormSubmissionUsd: null,
      costPerFormSubmissionPaidClientUsd: null,
    });
  });

  it("signup cost = 1 / ((1/clickUsd)·v2s) — click route only", () => {
    const { costPerSignupUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: 5 });
    expect(costPerSignupUsd).toBeCloseTo(1 / ((1 / 10) * econ.v2s)); // 1/0.004 = 250
  });

  it("signup cost null when there is no click cost (replies do not fund signups)", () => {
    const { costPerSignupUsd } = projectOutcomeCosts(econ, { clickUsd: null, replyUsd: 5 });
    expect(costPerSignupUsd).toBeNull();
  });
});

describe("projectOutcomeCosts — per-goal paid-client cost is COHERENT with the goal's outcome cost", () => {
  // s2pc = 0.20 (signup→paid 20%) added to the legacy econ.
  const econ = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04, s2pc: 0.2 };

  it("SIGNUP paid-client = costPerSignup / s2pc, and is ALWAYS ≥ costPerSignup", () => {
    const { costPerSignupUsd, costPerSignupPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: 5 });
    // clickUsd/(v2s·s2pc) = 10/(0.04·0.2) = 1250; costPerSignup = 10/0.04 = 250; 1250 = 250/0.2 ✓
    expect(costPerSignupPaidClientUsd).toBeCloseTo(10 / (econ.v2s * econ.s2pc));
    expect(costPerSignupPaidClientUsd!).toBeCloseTo(costPerSignupUsd! / econ.s2pc);
    expect(costPerSignupPaidClientUsd!).toBeGreaterThanOrEqual(costPerSignupUsd!);
  });

  it("SIGNUP paid-client null when there is no click cost (replies do not fund signups)", () => {
    const { costPerSignupPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: null, replyUsd: 5 });
    expect(costPerSignupPaidClientUsd).toBeNull();
  });

  it("SIGNUP paid-client null when s2pc is unset (legacy econ without the rate) — zero-denom gate", () => {
    const noS2pc = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04 };
    expect(projectOutcomeCosts(noS2pc, { clickUsd: 10, replyUsd: 5 }).costPerSignupPaidClientUsd).toBeNull();
  });

  it("MEETING-BOOKED paid-client = the two meeting→paid routes = costPerMeetingBooked / m2c, ≥ it", () => {
    const clickUsd = 10;
    const replyUsd = 5;
    const meetingPaidPerBudget = (1 / clickUsd) * econ.v2m * econ.m2c + (1 / replyUsd) * econ.r2m * econ.m2c;
    const { costPerMeetingBookedUsd, costPerMeetingPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd, replyUsd });
    expect(costPerMeetingPaidClientUsd).toBeCloseTo(1 / meetingPaidPerBudget);
    expect(costPerMeetingPaidClientUsd!).toBeCloseTo(costPerMeetingBookedUsd! / econ.m2c);
    expect(costPerMeetingPaidClientUsd!).toBeGreaterThanOrEqual(costPerMeetingBookedUsd!);
  });

  it("MEETING-BOOKED paid-client does NOT include the self-serve v2c route (that is the purchase goal)", () => {
    // costPerPurchase includes orP(v2c, v2m·m2c) → strictly cheaper (more routes) than the meeting-only cost.
    const { costPerPurchaseUsd, costPerMeetingPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: 5 });
    expect(costPerMeetingPaidClientUsd!).toBeGreaterThan(costPerPurchaseUsd!);
  });

  it("MEETING-BOOKED paid-client null when both meeting routes are 0 (r2m=v2m=0) — never a false $0", () => {
    const noMeetings = { r2m: 0, v2m: 0, m2c: 0.3, v2c: 0.02, v2s: 0.04, s2pc: 0.2 };
    expect(projectOutcomeCosts(noMeetings, { clickUsd: 10, replyUsd: 5 }).costPerMeetingPaidClientUsd).toBeNull();
  });
});

describe("projectOutcomeCosts — SINGLE-STEP goals (visit→paid / reply→paid)", () => {
  // v2pc = 0.05 (visit→paid 5%), r2pc = 0.20 (reply→paid 20%)
  const econ = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04, v2pc: 0.05, r2pc: 0.2 };

  it("website_visits cost = clickUsd / v2pc — click route ONLY (single step)", () => {
    const { costPerVisitPaidClientUsd, costPerReplyPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: 5 });
    expect(costPerVisitPaidClientUsd).toBeCloseTo(10 / 0.05); // 200
    // reply cost also computed here, but website_visits routes read costPerVisitPaidClientUsd only.
    expect(costPerReplyPaidClientUsd).toBeCloseTo(5 / 0.2); // 25
  });

  it("website_visits cost null when there is no click cost (reply channel does not fund it)", () => {
    const { costPerVisitPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: null, replyUsd: 5 });
    expect(costPerVisitPaidClientUsd).toBeNull();
  });

  it("positive_replies cost = replyUsd / r2pc — reply route ONLY (single step)", () => {
    const { costPerReplyPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: 8 });
    expect(costPerReplyPaidClientUsd).toBeCloseTo(8 / 0.2); // 40
  });

  it("positive_replies cost null when there is no reply cost", () => {
    const { costPerReplyPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: null });
    expect(costPerReplyPaidClientUsd).toBeNull();
  });

  it("rate 0 → zero-denominator gate → null (never a false $0)", () => {
    const zeroRates = { ...econ, v2pc: 0, r2pc: 0 };
    const out = projectOutcomeCosts(zeroRates, { clickUsd: 10, replyUsd: 5 });
    expect(out.costPerVisitPaidClientUsd).toBeNull();
    expect(out.costPerReplyPaidClientUsd).toBeNull();
  });

  it("unset single-step rate contributes null (legacy goal econ, no v2pc/r2pc)", () => {
    const legacy = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04 };
    const out = projectOutcomeCosts(legacy, { clickUsd: 10, replyUsd: 5 });
    expect(out.costPerVisitPaidClientUsd).toBeNull();
    expect(out.costPerReplyPaidClientUsd).toBeNull();
    // legacy metrics unaffected
    expect(out.costPerPurchaseUsd).not.toBeNull();
  });
});

describe("projectOutcomeCosts — TWO-STEP form_submissions goal (visit→form→paid)", () => {
  // v2fs = 0.10 (visit→form 10%), fs2pc = 0.25 (form→paid 25%)
  const econ = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04, v2fs: 0.1, fs2pc: 0.25 };

  it("form-submission cost = clickUsd / v2fs — click route ONLY (mirrors signup)", () => {
    const { costPerFormSubmissionUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: 5 });
    expect(costPerFormSubmissionUsd).toBeCloseTo(10 / 0.1); // 100
  });

  it("form-submission PAID (close) cost = clickUsd / (v2fs·fs2pc)", () => {
    const { costPerFormSubmissionPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: 5 });
    expect(costPerFormSubmissionPaidClientUsd).toBeCloseTo(10 / (0.1 * 0.25)); // 400
  });

  it("both form costs null when there is no click cost (reply channel does not fund them)", () => {
    const out = projectOutcomeCosts(econ, { clickUsd: null, replyUsd: 5 });
    expect(out.costPerFormSubmissionUsd).toBeNull();
    expect(out.costPerFormSubmissionPaidClientUsd).toBeNull();
  });

  it("rate 0 → zero-denominator gate → null (never a false $0)", () => {
    const zeroV2fs = { ...econ, v2fs: 0 };
    const out = projectOutcomeCosts(zeroV2fs, { clickUsd: 10, replyUsd: 5 });
    expect(out.costPerFormSubmissionUsd).toBeNull();
    expect(out.costPerFormSubmissionPaidClientUsd).toBeNull();
  });

  it("unset form-submission rates contribute null (legacy goal econ, no v2fs/fs2pc)", () => {
    const legacy = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04 };
    const out = projectOutcomeCosts(legacy, { clickUsd: 10, replyUsd: 5 });
    expect(out.costPerFormSubmissionUsd).toBeNull();
    expect(out.costPerFormSubmissionPaidClientUsd).toBeNull();
    expect(out.costPerPurchaseUsd).not.toBeNull();
  });
});

describe("formSubmissionRatesDecimal — fail loud on genuinely-absent rate", () => {
  const base = { ...ECONOMICS };

  it("returns both decimal rates when present", () => {
    const out = formSubmissionRatesDecimal({ ...base, visitToFormSubmissionPct: 10, formSubmissionToPaidClientPct: 25 });
    expect(out.v2fs).toBeCloseTo(0.1);
    expect(out.fs2pc).toBeCloseTo(0.25);
  });

  it("a 0 rate is valid (passes through — gates cost to null downstream)", () => {
    const out = formSubmissionRatesDecimal({ ...base, visitToFormSubmissionPct: 0, formSubmissionToPaidClientPct: 0 });
    expect(out.v2fs).toBe(0);
    expect(out.fs2pc).toBe(0);
  });

  it("throws when either required rate field is absent (producer gap, not a zero to substitute)", () => {
    expect(() => formSubmissionRatesDecimal({ ...base, formSubmissionToPaidClientPct: 25 })).toThrow(/visitToFormSubmissionPct/);
    expect(() => formSubmissionRatesDecimal({ ...base, visitToFormSubmissionPct: 10 })).toThrow(/formSubmissionToPaidClientPct/);
  });
});

describe("singleStepRateDecimal — fail loud on genuinely-absent rate", () => {
  const base = { ...ECONOMICS };

  it("returns the decimal rate when present", () => {
    expect(singleStepRateDecimal({ ...base, visitToPaidClientPct: 5 }, "websiteVisit")).toBeCloseTo(0.05);
    expect(singleStepRateDecimal({ ...base, replyToPaidClientPct: 20 }, "positiveReply")).toBeCloseTo(0.2);
  });

  it("a 0 rate is valid (passes through — gates cost to null downstream)", () => {
    expect(singleStepRateDecimal({ ...base, visitToPaidClientPct: 0 }, "websiteVisit")).toBe(0);
  });

  it("throws when the required rate field is absent (producer gap, not a zero to substitute)", () => {
    expect(() => singleStepRateDecimal(base, "websiteVisit")).toThrow(/visitToPaidClientPct/);
    expect(() => singleStepRateDecimal(base, "positiveReply")).toThrow(/replyToPaidClientPct/);
  });
});
