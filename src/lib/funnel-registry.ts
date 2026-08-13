import type { FunnelMilestone, ResolvedPath } from "./revenue-engine.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

/**
 * Funnel registry — maps a featureSlug to its expected-revenue funnel.
 *
 * A funnel resolves a brand's economics into numeric `ResolvedPath[]`. Each path is a LEG of a sales
 * funnel a brand can declare: when a lead fired that leg's signal, the path contributes a precomputed
 * expected revenue.
 *
 * ── ONLY A DECLARED FUNNEL'S LEGS CARRY VALUE ─────────────────────────────────────────────────────
 *
 * A lead used to earn expected revenue from its FURTHEST reached stage, from Contacted onward — an
 * email that merely LANDED was worth a slice of a lifetime contract, chained down through the
 * platform-global open/click/reply rates. On one prod brand that made 5,122 merely-delivered
 * organisations worth $8,772 of a $23,547 pipeline (37%), on a brand whose ONE declared funnel is
 * `Positive reply → Meeting booked → Meeting attended → Paid client`, where neither a delivery nor a
 * click is a step at all.
 *
 * An outreach that produced no conversion carries no value. So:
 *
 *  - **contacted / sent / delivered / opened are MILESTONES, not paths.** They are a step of NO funnel
 *    in brand-service's catalogue, for any brand, so they carry no revenue field to price — see
 *    `FunnelMilestone`. That is why the platform-global email rates left this module entirely: they
 *    existed only to chain a delivery down to a close, and nothing chains down from a delivery now.
 *  - **a conversion leg prices a brand only when one of its DECLARED funnels contains it** —
 *    `restrictPathsToDeclaredLegs`. A website visit prices a brand that declared a website-led chain
 *    and prices nothing for a brand that declared only the conversation chain.
 *
 * Sales is wired first. press / hiring / investors plug in here with their own funnel once
 * their economics exist (brand-service will generalise sales-economics → feature-economics).
 */

/** Sales conversion economics — brand-service GET /orgs/brands/{brandId}/sales-economics. */
export interface SalesEconomics {
  lifetimeRevenueUsd: number;
  replyToMeetingPct: number;
  visitToMeetingPct: number;
  meetingToClosePct: number;
  /** Website-click → signup rate (brand-service decomposes visitToClose = visitToSignup × signupToPaidClient). */
  visitToSignupPct: number;
  /** Signup → paying-client rate. */
  signupToPaidClientPct: number;
  visitToClosePct: number;
  /**
   * SINGLE-STEP rates for the `website_visits` / `positive_replies` optimization goals — brand-service
   * serves both on the sales-economics + effective (gold) layers (always present there once the brand
   * has economics). Optional here because the LEGACY multi-step goals never read them and older
   * fixtures / cold-start bodies omit them; a single-step goal that finds one ABSENT fails loud at
   * compute time (singleStepRatePct) rather than silently substituting zero.
   */
  visitToPaidClientPct?: number;
  replyToPaidClientPct?: number;
  /**
   * TWO-STEP self-serve rates for the `form_submissions` optimization goal (website visit → form
   * submission → paid client) — brand-service serves both on the sales-economics + effective layers
   * once the brand has economics. Optional here for the same reason as the single-step rates: the
   * legacy goals never read them and cold-start bodies omit them; the form_submissions goal fails loud
   * at compute time (formSubmissionRatesDecimal) when a rate is genuinely absent.
   */
  visitToFormSubmissionPct?: number;
  formSubmissionToPaidClientPct?: number;
}

export interface FunnelInputs {
  economics: SalesEconomics;
}

export type EconomicsSource = "sales-economics" | "cross-brand-average";

export interface FunnelDefinition {
  economicsSource: EconomicsSource;
  /** Signals the funnel reads off each lead (the milestones it tags + the legs it scores). */
  signals: string[];
  /**
   * The pre-funnel delivery markers, ascending. They are a step of no declared chain, so they carry
   * no revenue field and can contribute nothing — they only tag a lead's position and keep it in the
   * `leads[]` snapshot the Overview count series are built from.
   */
  milestones: readonly FunnelMilestone[];
  resolvePaths: (inputs: FunnelInputs) => ResolvedPath[];
}

const pct = (n: number): number => n / 100;

/**
 * Combine INDEPENDENT (non-exclusive) close probabilities into one: P(any) = 1 − Π(1 − pᵢ).
 * ≥ max(pᵢ), ≤ Σpᵢ, always ≤ 1 — loses no route, never double-counts past one close. Mirrors the
 * revenue-engine `combineIndependent` (which combines in EV/dollars); this one combines in probabilities.
 */
export const orP = (...ps: number[]): number => 1 - ps.reduce((survive, p) => survive * (1 - p), 1);

// ── Projected cost-per-outcome (expected, not tracked) ───────────────────────
//
// Given a workflow's GLOBAL unit costs (cost per click / per positive reply) and a brand's
// conversion economics, project the EXPECTED dollars to produce one PURCHASE and one MEETING
// BOOKED. Same EV funnel as the revenue engine / workflow-projection's `project()`:
//
//   pCloseClick      = orP(v2c, v2m·m2c)            // self-serve OR click→meeting→close
//   pCloseReply      = r2m·m2c
//   closesPerBudget  = (1/clickUsd)·pCloseClick + (1/replyUsd)·pCloseReply   // ADD: linearity of expectation
//   costPerPurchase  = 1 / closesPerBudget
//
//   meetingsPerBudget    = (1/clickUsd)·v2m + (1/replyUsd)·r2m   // same channels, stop one stage earlier (drop ·m2c)
//   costPerMeetingBooked = 1 / meetingsPerBudget
//
// No forced ordering between the two costs: when self-serve v2c is high, purchases bypass meetings,
// so cost-per-meeting can exceed cost-per-purchase — correct, not a bug. A route with a null unit
// cost contributes 0; a perBudget ≤ 0 (no usable data) yields null for that metric.

/** Brand conversion economics as decimals (brand-service stores percentages 0–100). */
export interface ProjectionEconomics {
  r2m: number; // P(meeting | positive reply)
  v2m: number; // P(meeting | click/visit)
  m2c: number; // P(close | meeting)
  v2c: number; // P(close | click/visit) — direct, self-serve path
  v2s: number; // P(signup | click/visit) — self-serve signup (visitToClose = v2s × signupToPaidClient)
  // Signup → paying-client rate (signupToPaidClientPct). Feeds the SIGNUP goal's cost-per-paid-client
  // (visit → signup → paid). Optional: only the signup/self-serve goal reads it (see projectOutcomeCosts);
  // undefined ⟹ that cost is null. m2c above doubles as the MEETING goal's meeting→paid rate.
  s2pc?: number; // P(paid client | signup)
  // SINGLE-STEP paid-client rates for the website_visits / positive_replies goals. Optional: only the
  // single-step goals read them (see projectOutcomeCosts); undefined ⟹ that single-step cost is null.
  v2pc?: number; // P(paid client | click/visit) — direct single step (visitToPaidClientPct)
  r2pc?: number; // P(paid client | positive reply) — direct single step (replyToPaidClientPct)
  // TWO-STEP self-serve rates for the form_submissions goal (visit → form submission → paid). Optional:
  // only the form_submissions goal reads them (see projectOutcomeCosts); undefined ⟹ those costs null.
  v2fs?: number; // P(form submission | click/visit) — self-serve micro-conversion (visitToFormSubmissionPct)
  fs2pc?: number; // P(paid client | form submission) (formSubmissionToPaidClientPct)
}

/** Global per-workflow unit costs (USD); null when the workflow has no clicks / replies. */
export interface ProjectionUnitCosts {
  clickUsd: number | null;
  replyUsd: number | null;
}

export interface ProjectedOutcomeCosts {
  costPerPurchaseUsd: number | null;
  costPerMeetingBookedUsd: number | null;
  /** Cost per self-serve signup. Signups come from the CLICK route only (visitToSignupPct); a
   * positive reply leads to a meeting → paying close (the "purchase" outcome), not a direct
   * signup, so the reply channel does not fund signups here. Null when there is no click cost. */
  costPerSignupUsd: number | null;
  /** SIGNUP goal CLOSE metric: cost per paying client via the signup route (visit → signup → paid).
   * A budget spent on clicks yields (1/clickUsd)·v2s·s2pc paid clients. costPerSignupPaidClientUsd =
   * clickUsd / (v2s·s2pc) = costPerSignupUsd / s2pc, so it is ALWAYS ≥ costPerSignupUsd (a paid client
   * is downstream of a signup). Drives costPerPaidClient + ROI for the signup goal — NOT the multi-step
   * purchase funnel (which would incoherently read BELOW costPerSignup via the meeting/close routes).
   * Null when there is no click cost OR v2s/s2pc is unset / 0 (zero-denominator gate). CLICK route only. */
  costPerSignupPaidClientUsd: number | null;
  /** MEETING-BOOKED goal CLOSE metric: cost per paying client via the MEETING routes only (no direct
   * self-serve v2c). A budget yields (1/clickUsd)·v2m·m2c + (1/replyUsd)·r2m·m2c paid clients =
   * m2c · meetingsPerBudget, so costPerMeetingPaidClientUsd = costPerMeetingBookedUsd / m2c ≥
   * costPerMeetingBookedUsd (a paid client is downstream of a booked meeting). Drives costPerPaidClient
   * + ROI for the meeting-booked goal. Null when neither channel funds a meeting-close (v2m·m2c and
   * r2m·m2c both 0, or both unit costs null) — zero-denominator gate, never a false $0. */
  costPerMeetingPaidClientUsd: number | null;
  /** SINGLE-STEP goal `website_visits`: cost per paid client via the visit→paid rate. A budget spent
   * on clicks yields (1/clickUsd)·v2pc paid clients. costPerVisitPaidClientUsd = clickUsd / v2pc.
   * Null when there is no click cost OR v2pc is unset / 0 (zero-denominator gate). ONLY the click
   * route funds it — the single-step visit→paid conversion, NOT the multi-step purchase funnel. */
  costPerVisitPaidClientUsd: number | null;
  /** SINGLE-STEP goal `positive_replies`: cost per paid client via the reply→paid rate. A budget
   * spent on replies yields (1/replyUsd)·r2pc paid clients. costPerReplyPaidClientUsd = replyUsd /
   * r2pc. Null when there is no reply cost OR r2pc is unset / 0. ONLY the reply route funds it. */
  costPerReplyPaidClientUsd: number | null;
  /** TWO-STEP goal `form_submissions` OPTIMIZATION metric: cost per form submission. Form submissions
   * come from the CLICK route only (visitToFormSubmissionPct); a budget spent on clicks yields
   * (1/clickUsd)·v2fs form submissions. costPerFormSubmissionUsd = clickUsd / v2fs. Null when there is
   * no click cost OR v2fs is unset / 0. Mirrors costPerSignupUsd exactly (its 2-step sibling). */
  costPerFormSubmissionUsd: number | null;
  /** TWO-STEP goal `form_submissions` CLOSE metric: cost per paying client via the form route
   * (visit → form submission → paid). A budget spent on clicks yields (1/clickUsd)·v2fs·fs2pc paid
   * clients. costPerFormSubmissionPaidClientUsd = clickUsd / (v2fs·fs2pc). Drives costPerCloseUsd + ROI
   * for the form_submissions goal. Null when there is no click cost OR v2fs/fs2pc is unset / 0. */
  costPerFormSubmissionPaidClientUsd: number | null;
  /**
   * COMBINED-SALES goal (`sales`): cost per SALE — a paying client (valued at CLTV) won via the
   * BEST-converting channel: the website-visit path (click → paid, v2pc) OR the positive-reply path
   * (reply → paid, r2pc), whichever is CHEAPER per sale.
   *
   * BEST-CHANNEL combination (MIN, NOT sum) — the combined cost per sale = the cheaper of the two
   * single-step paid-client costs:
   *   visitSaleUsd = clickUsd / v2pc   (= costPerVisitPaidClientUsd)
   *   replySaleUsd = replyUsd / r2pc   (= costPerReplyPaidClientUsd)
   *   costPerSaleUsd = min(visitSaleUsd, replySaleUsd) = 1 / max(visitPaidPerBudget, replyPaidPerBudget)
   * The combined goal means "acquire a paying client via whatever path works best", so its cost is the
   * BEST single channel's cost — and thus can NEVER read below either single-path cost.
   *
   * Why MIN, not the population-SUM `(1/clickUsd)·v2pc + (1/replyUsd)·r2pc`: the SUM adds the two
   * channels' sales-per-budget, so a workflow that is merely CHEAP on a near-zero-conversion channel
   * (e.g. clicks at 0.5% visit→paid) has its cost-per-sale DILUTED DOWN below its real, higher-converting
   * channel — rewarding a workflow that is cheap-on-visits over one that is genuinely good at converting.
   * The SUM also let the combined headline read BELOW every per-audience row (incoherent) and ranked the
   * wrong workflow best. MIN ties combined-sales to the BEST of its two single-step goals, so it is
   * coherent by construction (≥ the best channel, matches whichever single-step goal wins for the brand)
   * and ranks on REAL paid-client acquisition on the meaningful path (features-service#630).
   *
   * This is DISTINCT from the per-LEAD probability of a sale (revenue lens, `combinedSaleProbability`),
   * which ORs the two paths (`orP`) because a single lead converts at most once (P ≤ 1) — that is a
   * per-lead EV question, not a cost-ranking one; do NOT conflate the two.
   *
   * For the combined-sales goal the OUTCOME *is* the paying client, so cost-per-outcome == cost-per-paid
   * client == costPerSaleUsd (coherent — the visit/reply→paid rate is already baked into each channel's
   * cost). ROI = CLTV / costPerSaleUsd. Null when neither channel funds a sale (both perBudget
   * contributions 0 — zero-denominator gate), never a false $0. */
  costPerSaleUsd: number | null;
}

export function projectOutcomeCosts(
  econ: ProjectionEconomics,
  costs: ProjectionUnitCosts,
): ProjectedOutcomeCosts {
  const pCloseClick = orP(econ.v2c, econ.v2m * econ.m2c);
  const pCloseReply = econ.r2m * econ.m2c;

  const closesPerBudget =
    (costs.clickUsd != null ? (1 / costs.clickUsd) * pCloseClick : 0) +
    (costs.replyUsd != null ? (1 / costs.replyUsd) * pCloseReply : 0);

  const meetingsPerBudget =
    (costs.clickUsd != null ? (1 / costs.clickUsd) * econ.v2m : 0) +
    (costs.replyUsd != null ? (1 / costs.replyUsd) * econ.r2m : 0);

  // Signups are a click-route (self-serve) outcome: a budget spent on clicks yields v2s signups
  // per click. The reply route closes via meetings (purchases), not direct signups.
  const signupsPerBudget = costs.clickUsd != null ? (1 / costs.clickUsd) * econ.v2s : 0;

  // SIGNUP goal paid-client — chains the signup's OWN funnel (visit → signup → paid), CLICK route only:
  //   paid clients per budget = (1/clickUsd)·v2s·s2pc   ⟹ costPerSignupPaidClient = costPerSignup / s2pc.
  // Coherent BY CONSTRUCTION: always ≥ costPerSignup. Do NOT reuse costPerPurchase (meeting/close funnel)
  // for the signup goal — its rates are unrelated to the signup step and can read incoherently below it.
  const signupPaidPerBudget =
    costs.clickUsd != null && econ.s2pc != null ? (1 / costs.clickUsd) * econ.v2s * econ.s2pc : 0;

  // MEETING-BOOKED goal paid-client — the two MEETING routes only (visit→meeting→paid + reply→meeting→paid),
  // NOT the direct self-serve v2c (that's the purchase goal). = m2c · meetingsPerBudget ⟹
  // costPerMeetingPaidClient = costPerMeetingBooked / m2c, always ≥ costPerMeetingBooked.
  const meetingPaidPerBudget =
    (costs.clickUsd != null ? (1 / costs.clickUsd) * econ.v2m * econ.m2c : 0) +
    (costs.replyUsd != null ? (1 / costs.replyUsd) * econ.r2m * econ.m2c : 0);

  // SINGLE-STEP goals — one rate applied to ONE channel (no funnel chaining):
  //   website_visits  → click channel only: (1/clickUsd)·v2pc paid clients per budget.
  //   positive_replies→ reply channel only: (1/replyUsd)·r2pc paid clients per budget.
  const visitPaidPerBudget =
    costs.clickUsd != null && econ.v2pc != null ? (1 / costs.clickUsd) * econ.v2pc : 0;
  const replyPaidPerBudget =
    costs.replyUsd != null && econ.r2pc != null ? (1 / costs.replyUsd) * econ.r2pc : 0;

  // TWO-STEP form_submissions goal — CLICK route only, like signups:
  //   form submissions per budget = (1/clickUsd)·v2fs
  //   paid clients via form route  = (1/clickUsd)·v2fs·fs2pc  (visit → form submission → paid)
  const formSubmissionsPerBudget =
    costs.clickUsd != null && econ.v2fs != null ? (1 / costs.clickUsd) * econ.v2fs : 0;
  const formSubmissionPaidPerBudget =
    costs.clickUsd != null && econ.v2fs != null && econ.fs2pc != null
      ? (1 / costs.clickUsd) * econ.v2fs * econ.fs2pc
      : 0;

  // COMBINED-SALES goal — a sale won via the BEST-converting channel: cost per sale = the CHEAPER of the
  // two single-step paid-client costs (visit→paid, reply→paid), i.e. 1 / max(visitPaidPerBudget,
  // replyPaidPerBudget). MIN not SUM: the SUM adds the channels' sales-per-budget, diluting the cost
  // below the best single channel and rewarding a workflow merely cheap on a low-conversion side channel
  // (features-service#630). Reuses the single-step per-budget rates already computed above.
  const bestSalePerBudget = Math.max(visitPaidPerBudget, replyPaidPerBudget);

  return {
    costPerPurchaseUsd: closesPerBudget > 0 ? 1 / closesPerBudget : null,
    costPerMeetingBookedUsd: meetingsPerBudget > 0 ? 1 / meetingsPerBudget : null,
    costPerSignupUsd: signupsPerBudget > 0 ? 1 / signupsPerBudget : null,
    costPerSignupPaidClientUsd: signupPaidPerBudget > 0 ? 1 / signupPaidPerBudget : null,
    costPerMeetingPaidClientUsd: meetingPaidPerBudget > 0 ? 1 / meetingPaidPerBudget : null,
    costPerVisitPaidClientUsd: visitPaidPerBudget > 0 ? 1 / visitPaidPerBudget : null,
    costPerReplyPaidClientUsd: replyPaidPerBudget > 0 ? 1 / replyPaidPerBudget : null,
    costPerFormSubmissionUsd: formSubmissionsPerBudget > 0 ? 1 / formSubmissionsPerBudget : null,
    costPerFormSubmissionPaidClientUsd: formSubmissionPaidPerBudget > 0 ? 1 / formSubmissionPaidPerBudget : null,
    costPerSaleUsd: bestSalePerBudget > 0 ? 1 / bestSalePerBudget : null,
  };
}

/**
 * The per-LEAD probability that a single lead becomes a SALE for the COMBINED-sales goal — the
 * probabilistic OR of the two paths available to THAT lead. A lead converts at most once, so the
 * two paths combine via `orP` (P ≤ 1), NEVER a sum (a sum can exceed 1 and double-counts the both-paths
 * lead). This is a per-lead EV question (revenue lens), DISTINCT from the cost-ranking `costPerSaleUsd`
 * (the best-channel MIN) — do not conflate the two combinations:
 *   clicked only          → v2pc
 *   positive-reply only   → r2pc
 *   clicked AND replied   → orP(v2pc, r2pc) = 1 − (1 − v2pc)(1 − r2pc)   (> max, < sum, ≤ 1)
 * Returns null when the lead reached NEITHER engagement channel (no path → filtered from the lens).
 */
export function combinedSaleProbability(v2pc: number, r2pc: number, clicked: boolean, positiveReply: boolean): number | null {
  if (!clicked && !positiveReply) return null;
  if (clicked && positiveReply) return orP(v2pc, r2pc);
  return clicked ? v2pc : r2pc;
}

/**
 * Read the SINGLE-STEP paid-client rate (0..100) a single-step goal needs off a brand's economics —
 * `visitToPaidClientPct` for `websiteVisit`, `replyToPaidClientPct` for `positiveReply`.
 *
 * FAIL LOUD when the field is genuinely absent on the wire (undefined / non-finite): brand-service
 * OWNS these fields on its sales-economics + effective layers and must serve them; a single-step goal
 * that cannot find its rate is a producer gap, not a zero to substitute (a `0` rate IS valid and
 * passes through — it gates the downstream cost to null, never a false $0). Returns the decimal 0..1.
 */
export function singleStepRateDecimal(economics: SalesEconomics, goal: "websiteVisit" | "positiveReply"): number {
  const field = goal === "websiteVisit" ? "visitToPaidClientPct" : "replyToPaidClientPct";
  const pctValue = economics[field];
  if (typeof pctValue !== "number" || !Number.isFinite(pctValue)) {
    throw new Error(
      `brand economics is missing ${field} (required for the ${goal} single-step goal) — brand-service must serve it on the sales-economics / effective layer`,
    );
  }
  return pct(pctValue);
}

/**
 * Read the TWO-STEP form-submission rates (0..100) the `form_submissions` goal needs off a brand's
 * economics — `visitToFormSubmissionPct` (visit→form) + `formSubmissionToPaidClientPct` (form→paid).
 *
 * FAIL LOUD when either field is genuinely absent (undefined / non-finite): brand-service OWNS both on
 * its sales-economics + effective layers and must serve them; a form_submissions goal that cannot find
 * its rates is a producer gap, not a zero to substitute (a `0` rate IS valid and passes through — it
 * gates the downstream cost to null, never a false $0). Returns the decimals 0..1.
 */
export function formSubmissionRatesDecimal(economics: SalesEconomics): { v2fs: number; fs2pc: number } {
  const read = (field: "visitToFormSubmissionPct" | "formSubmissionToPaidClientPct"): number => {
    const pctValue = economics[field];
    if (typeof pctValue !== "number" || !Number.isFinite(pctValue)) {
      throw new Error(
        `brand economics is missing ${field} (required for the form_submissions goal) — brand-service must serve it on the sales-economics / effective layer`,
      );
    }
    return pct(pctValue);
  };
  return { v2fs: read("visitToFormSubmissionPct"), fs2pc: read("formSubmissionToPaidClientPct") };
}

// NO DECAY. A stage a lead reached is a thing that HAPPENED, and it stays counted however long ago
// it happened. This funnel used to carry per-stage staleness windows (contacted→sent 7d,
// reply→meeting 14d, meeting→close 30d …) that zeroed a lead's expected value once its furthest
// stage sat past its window. That made the pipeline a trailing-window numerator while the spend it
// is divided by stayed lifetime, so ROI fell below 1 purely by ageing — a brand with 15 positive
// replies read 13 of them at $0. Do NOT reintroduce it under another name: no freshness weight, no
// half-life, no recency multiplier.

/**
 * The pre-funnel delivery markers, ascending. `open` sits between delivered and the first funnel leg.
 * None of them is a step of any chain in `SALES_FUNNELS`, so none carries a revenue field.
 */
const SALES_MILESTONES: readonly FunnelMilestone[] = [
  { tag: "contacted", signal: "contacted" },
  { tag: "sent", signal: "sent" },
  { tag: "delivered", signal: "delivered" },
  { tag: "opened", signal: "open" },
];

/**
 * Sales funnel — expected pipeline revenue from the funnel legs a lead reached.
 *
 *   pClose_click   = orP(visitToClose, visitToMeeting × meetingToClose)   (two independent click routes)
 *   pClose_reply   = replyToMeeting × meetingToClose                       (sales-economics)
 *   pClose_meeting = meetingToClose
 *
 * orP(a,b) = 1−(1−a)(1−b): independent-probability combine. A click can close self-serve AND via a
 * booked meeting. These routes are non-exclusive, so we combine them (never max — which silently
 * drops the weaker route, undercounting the pipeline).
 *
 * Each path EV = LTR × pClose_leg, and every path is itemised in the events ledger. The four legs
 * below are the union of what the catalogue's chains buy; which of them actually prices a given brand
 * is decided by `restrictPathsToDeclaredLegs` from that brand's OWN declaration.
 */
const salesFunnel: FunnelDefinition = {
  economicsSource: "sales-economics",
  signals: ["contacted", "sent", "delivered", "open", "clicked", "positiveReply", "meeting", "closeWin"],
  milestones: SALES_MILESTONES,
  resolvePaths: ({ economics: e }) => {
    const ltr = e.lifetimeRevenueUsd;
    // A click closes via TWO independent (non-exclusive) routes: direct self-serve (visitToClose =
    // "buy without a meeting") OR via a booked meeting (visitToMeeting · meetingToClose). A lead can
    // do both → combine as independent probabilities (orP), bounded by 1. NOT max (drops the weaker
    // route) and NOT a naive sum (can exceed 1).
    const pCloseClick = orP(pct(e.visitToClosePct), pct(e.visitToMeetingPct) * pct(e.meetingToClosePct));
    const pCloseReply = pct(e.replyToMeetingPct) * pct(e.meetingToClosePct);
    const pCloseMeeting = pct(e.meetingToClosePct); // a booked meeting closes at the meeting→close rate
    // Post-engagement legs (per-lead manual-qualification timestamps drive the dates):
    //   meeting  EV = LTR × P(close|meeting).
    //   closeWin = realized revenue (full LTR) — the terminal every chain ends at.
    // Monotonic EV up the chain: reply < meeting < closeWin.
    return [
      // click + reply are INDEPENDENT engagement routes to the same close (a lead can do both, and
      // we don't yet know which fires) → `engagementRoute` so the engine COMBINES them as independent
      // probabilities bounded by 1 LTR, instead of MAX'ing. meeting and closeWin below are
      // convergence/terminal positions (mutually exclusive) → left to MAX.
      { tag: "visit", signal: "clicked", expectedRevenueUsd: ltr * pCloseClick, engagementRoute: true },
      { tag: "reply", signal: "positiveReply", expectedRevenueUsd: ltr * pCloseReply, engagementRoute: true },
      { tag: "meeting", signal: "meeting", expectedRevenueUsd: ltr * pCloseMeeting },
      { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: ltr },
    ];
  },
};

/**
 * WHICH SIGNAL BUYS WHICH STEP of each declared chain — the whole content of "a signal that is not a
 * step of a declared funnel contributes nothing".
 *
 * Read straight off `SALES_FUNNELS[key].steps`, one entry per step that a lead signal can evidence:
 *
 *   Positive reply → `positiveReply`   Website visit → `clicked`
 *   Meeting booked → `meeting`         Signup        → `signup`      Form filled → `formSubmission`
 *   Paid client    → `closeWin`
 *
 * "Meeting attended" has no signal of its own — it is folded into the booked→paid rate
 * (`meetingChainCloseRate`), so it needs no entry. `signup` / `formSubmission` are listed because they
 * ARE legs of their chains; no path scores them today (they are per-lead display outcomes), and if one
 * is ever added it prices exactly the brands whose chain contains it, with no further change here.
 */
const FUNNEL_LEG_SIGNALS: Record<SalesFunnelKey, readonly string[]> = {
  sales_meetings_from_conversation: ["positiveReply", "meeting", "closeWin"],
  sales_meetings_from_website: ["clicked", "meeting", "closeWin"],
  website_purchases: ["clicked", "signup", "closeWin"],
  form_magnet: ["clicked", "formSubmission", "closeWin"],
};

/** Every signal the given declared funnels buy a step with — the union of their legs. */
export function declaredLegSignals(keys: readonly SalesFunnelKey[]): Set<string> {
  const signals = new Set<string>();
  for (const key of keys) for (const signal of FUNNEL_LEG_SIGNALS[key]) signals.add(signal);
  return signals;
}

/**
 * Keep only the paths that are a leg of one of the funnels being priced.
 *
 * A brand that declared SEVERAL funnels is priced on ALL of their legs (the union). A read narrowed to
 * ONE funnel — a caller's `?funnel=`, or the funnel a campaign itself states — is priced on that
 * chain's legs alone, because that is the chain being sold.
 *
 * `[]` in ⇒ paths unchanged. An empty set means the brand declared nothing we could read, and we do
 * not know which chain it sells; inventing one to narrow against would be the same fiction the
 * defaulted goal produced. That brand keeps today's behaviour on every conversion leg — it simply no
 * longer earns anything from a delivery, which is a step of no chain for anybody.
 */
export function restrictPathsToDeclaredLegs(
  paths: ResolvedPath[],
  keys: readonly SalesFunnelKey[],
): ResolvedPath[] {
  if (keys.length === 0) return paths;
  const signals = declaredLegSignals(keys);
  return paths.filter((path) => signals.has(path.signal));
}

export const FUNNEL_REGISTRY: Record<string, FunnelDefinition> = {
  // Sales first. press / hiring / investors / vc / accelerators reuse the engine with
  // their own funnel + economics once defined — until then they return a null pipeline.
  "sales-cold-email-outreach": salesFunnel,
};

export function getFunnel(featureSlug: string): FunnelDefinition | null {
  return FUNNEL_REGISTRY[featureSlug] ?? null;
}
