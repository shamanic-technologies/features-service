import { describe, it, expect } from "vitest";
import { getFunnel, orP, projectOutcomeCosts, restrictPathsToDeclaredLegs, declaredLegSignals, singleStepRateDecimal, formSubmissionRatesDecimal, combinedSaleProbability } from "./funnel-registry.js";
import { SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10, // 0.20 × 0.10 = 0.02 = visitToClosePct
  visitToClosePct: 2,
};

describe("sales funnel — legs, milestones, and the declared-set restriction", () => {
  const funnel = getFunnel("sales-cold-email-outreach")!;
  const paths = funnel.resolvePaths({ economics: ECONOMICS });
  const byTag = Object.fromEntries(paths.map((p) => [p.tag, p]));

  it("emits ONLY the four funnel legs — no delivery stage is a path", () => {
    expect(paths).toHaveLength(4);
    expect(paths.map((p) => p.tag)).toEqual(["visit", "reply", "meeting", "closeWin"]);
  });

  it("contacted / sent / delivered / opened are MILESTONES, and a milestone has no revenue field", () => {
    expect(funnel.milestones.map((m) => m.tag)).toEqual(["contacted", "sent", "delivered", "opened"]);
    for (const milestone of funnel.milestones) {
      // Not "zeroed" and not "weighted down" — there is nothing on a milestone to price.
      expect(Object.keys(milestone).sort()).toEqual(["signal", "tag"]);
    }
    // …and no path claims one of their signals.
    const legSignals = paths.map((p) => p.signal);
    for (const milestone of funnel.milestones) expect(legSignals).not.toContain(milestone.signal);
  });

  it("click / reply EV come from sales-economics", () => {
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

  it("click + reply are independent engagement routes; meeting + closeWin are not", () => {
    expect(byTag.visit.engagementRoute).toBe(true);
    expect(byTag.reply.engagementRoute).toBe(true);
    expect(byTag.meeting.engagementRoute).toBeUndefined();
    expect(byTag.closeWin.engagementRoute).toBeUndefined();
  });

  it("legs are listed in ascending funnel order (visit < reply < meeting < closeWin)", () => {
    const tagOrder = paths.map((p) => p.tag);
    expect(tagOrder.indexOf("visit")).toBeLessThan(tagOrder.indexOf("reply"));
    expect(tagOrder.indexOf("reply")).toBeLessThan(tagOrder.indexOf("meeting"));
    expect(tagOrder.indexOf("meeting")).toBeLessThan(tagOrder.indexOf("closeWin"));
  });

  it("NO path carries a staleness window — nothing in this funnel expires", () => {
    // The windows (contacted 7d, sent 3d, delivered/open/reply 14d, meeting 30d) are gone, and so is
    // the field that carried them. Reading it back on every path proves no stage smuggles one in.
    for (const path of paths) {
      expect(path).not.toHaveProperty("staleAfterMs");
      expect(Object.keys(path).some((k) => /stale|decay|halflife|half_life|recency|freshness/i.test(k))).toBe(false);
    }
  });

  it("every path is itemised in the events ledger", () => {
    expect(paths.every((p) => p.ledger !== false)).toBe(true);
  });
});

describe("restrictPathsToDeclaredLegs — only a declared chain's legs carry value", () => {
  const funnel = getFunnel("sales-cold-email-outreach")!;
  const paths = funnel.resolvePaths({ economics: ECONOMICS });
  const tagsFor = (keys: SalesFunnelKey[]) => restrictPathsToDeclaredLegs(paths, keys).map((p) => p.tag);

  it("the conversation chain buys a reply, never a website visit", () => {
    expect(tagsFor(["sales_meetings_from_conversation"])).toEqual(["reply", "meeting", "closeWin"]);
  });

  it("the website meeting chain buys a visit, never a reply", () => {
    expect(tagsFor(["sales_meetings_from_website"])).toEqual(["visit", "meeting", "closeWin"]);
  });

  it("the visit-led self-serve chains buy a visit and the paid client, not a meeting", () => {
    expect(tagsFor(["website_purchases"])).toEqual(["visit", "closeWin"]);
    expect(tagsFor(["form_magnet"])).toEqual(["visit", "closeWin"]);
  });

  it("several declared chains are priced on the UNION of their legs", () => {
    // The conversation chain brings the reply (and the meeting); the purchase chain brings the visit.
    expect(tagsFor(["sales_meetings_from_conversation", "website_purchases"])).toEqual(["visit", "reply", "meeting", "closeWin"]);
    // Two visit-led self-serve chains union to a set that still buys neither a reply nor a meeting.
    expect(tagsFor(["website_purchases", "form_magnet"])).toEqual(["visit", "closeWin"]);
  });

  it("every chain terminates in a paid client, so closeWin is always a leg", () => {
    for (const key of SALES_FUNNEL_KEYS) expect(tagsFor([key])).toContain("closeWin");
  });

  it("declaredLegSignals never names a delivery milestone, for any chain", () => {
    const signals = declaredLegSignals(SALES_FUNNEL_KEYS);
    for (const milestone of funnel.milestones) expect(signals.has(milestone.signal)).toBe(false);
  });

  it("NO declaration ⇒ every conversion leg is priced (we do not know the chain, and never invent one)", () => {
    expect(tagsFor([])).toEqual(["visit", "reply", "meeting", "closeWin"]);
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
      costPerSaleUsd: null,
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
      costPerSaleUsd: null,
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

describe("COMBINED-sales goal — best-channel MIN cost (rank) vs per-lead probability (OR)", () => {
  // v2pc = 0.05 (visit→paid 5%), r2pc = 0.20 (reply→paid 20%)
  const econ = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04, v2pc: 0.05, r2pc: 0.2 };

  it("PROJECTION cost-per-sale = MIN(clickUsd/v2pc, replyUsd/r2pc) — the cheapest converting channel, NEVER below the best single path", () => {
    const clickUsd = 10;
    const replyUsd = 5;
    // visit path = 10/0.05 = 200 ; reply path = 5/0.20 = 25 → MIN = 25 (the best channel, reply)
    const { costPerSaleUsd, costPerVisitPaidClientUsd, costPerReplyPaidClientUsd } = projectOutcomeCosts(econ, { clickUsd, replyUsd });
    expect(costPerSaleUsd).toBeCloseTo(25, 6);
    expect(costPerSaleUsd).toBeCloseTo(Math.min(costPerVisitPaidClientUsd!, costPerReplyPaidClientUsd!), 10);
    // coherence: the combined cost is never CHEAPER than either single-path cost (the SUM bug read below both)
    expect(costPerSaleUsd!).toBeGreaterThanOrEqual(Math.min(200, 25) - 1e-9);
    expect(costPerSaleUsd!).toBeLessThanOrEqual(200 + 1e-9);
  });

  it("ranks the workflow with the BEST converting channel, not the one merely cheap on a low-conversion channel (features-service#630 repro)", () => {
    // Brand: visit→paid 0.5%, reply→paid 20% (the reply path is the real acquisition route).
    const brand = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04, v2pc: 0.005, r2pc: 0.2 };
    // Dawn: cheap clicks ($6.75) but only tied-good replies ($48). Granite: cheaper replies ($46).
    const dawn = projectOutcomeCosts(brand, { clickUsd: 6.75, replyUsd: 48 }).costPerSaleUsd!;
    const granite = projectOutcomeCosts(brand, { clickUsd: 20, replyUsd: 46 }).costPerSaleUsd!;
    expect(dawn).toBeCloseTo(240, 4); // 48/0.20 — its best channel (reply), NOT diluted below by cheap visits
    expect(granite).toBeCloseTo(230, 4); // 46/0.20 — the genuinely better reply workflow
    expect(granite).toBeLessThan(dawn); // Sales picks Granite (lower cost/sale), matching the positiveReply goal
  });

  it("cost-per-sale uses ONLY the click channel when there is no reply cost (and vice-versa)", () => {
    expect(projectOutcomeCosts(econ, { clickUsd: 10, replyUsd: null }).costPerSaleUsd).toBeCloseTo(10 / 0.05); // 200 (visit path only)
    expect(projectOutcomeCosts(econ, { clickUsd: null, replyUsd: 5 }).costPerSaleUsd).toBeCloseTo(5 / 0.2); // 25 (reply path only)
  });

  it("cost-per-sale null when neither channel funds a sale (zero-denominator gate, never a false $0)", () => {
    expect(projectOutcomeCosts(econ, { clickUsd: null, replyUsd: null }).costPerSaleUsd).toBeNull();
    const zeroRates = { ...econ, v2pc: 0, r2pc: 0 };
    expect(projectOutcomeCosts(zeroRates, { clickUsd: 10, replyUsd: 5 }).costPerSaleUsd).toBeNull();
    // legacy econ with no single-step rates → combined sale unbacked → null (never fabricated)
    const legacy = { r2m: 0.4, v2m: 0.05, m2c: 0.3, v2c: 0.02, v2s: 0.04 };
    expect(projectOutcomeCosts(legacy, { clickUsd: 10, replyUsd: 5 }).costPerSaleUsd).toBeNull();
  });

  it("PER-LEAD probability combines the two paths as an OR — WORKED EXAMPLE: OR < SUM and ≤ 1", () => {
    const v2pc = 0.05;
    const r2pc = 0.2;
    // clicked only → v2pc ; reply only → r2pc
    expect(combinedSaleProbability(v2pc, r2pc, true, false)).toBeCloseTo(0.05, 10);
    expect(combinedSaleProbability(v2pc, r2pc, false, true)).toBeCloseTo(0.2, 10);
    // both paths → orP(0.05, 0.20) = 1 − 0.95·0.80 = 0.24
    const both = combinedSaleProbability(v2pc, r2pc, true, true)!;
    expect(both).toBeCloseTo(0.24, 10);
    expect(both).toBeCloseTo(orP(v2pc, r2pc), 12);
    // THE CORE INVARIANTS the AC demands, proven numerically:
    expect(both).toBeLessThan(v2pc + r2pc); // OR (0.24) < SUM (0.25) — a lead cannot convert twice
    expect(both).toBeGreaterThan(Math.max(v2pc, r2pc)); // ≥ the stronger single path
    expect(both).toBeLessThanOrEqual(1); // never exceeds certainty (≤ 1×LTR once multiplied by LTR)
    // neither path reached → filtered out (null, never 0)
    expect(combinedSaleProbability(v2pc, r2pc, false, false)).toBeNull();
  });

  it("OR ≤ 1 even for extreme rates (both paths near-certain) — the sum would exceed 1", () => {
    const both = combinedSaleProbability(0.9, 0.8, true, true)!;
    expect(both).toBeCloseTo(1 - 0.1 * 0.2, 12); // 0.98
    expect(both).toBeLessThanOrEqual(1);
    expect(0.9 + 0.8).toBeGreaterThan(1); // the naive SUM (1.7) is an invalid probability — OR is correct
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
