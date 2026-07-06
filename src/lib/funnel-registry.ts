import type { ResolvedPath } from "./revenue-engine.js";
import type { PlatformEmailRates } from "./platform-rates-client.js";

/**
 * Funnel registry — maps a featureSlug to its expected-revenue funnel.
 *
 * A funnel resolves its inputs (per-brand economics + platform-global email funnel rates)
 * into numeric `ResolvedPath[]`. Each path is a funnel stage: when a lead's furthest status
 * satisfies that stage's signal, the path contributes a precomputed expected revenue. The
 * engine takes the MAX over the paths a lead satisfies, so a lead earns expected revenue
 * from its FURTHEST reached stage — from Contacted onward, not only from a click / reply.
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
  /** Platform-global email funnel rates (contacted→sent→delivered→click/reply). */
  platformRates: PlatformEmailRates;
}

export type EconomicsSource = "sales-economics" | "cross-brand-average";

export interface FunnelDefinition {
  economicsSource: EconomicsSource;
  /** Signals the funnel reads off each lead (the engagement stages it scores). */
  signals: string[];
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

  return {
    costPerPurchaseUsd: closesPerBudget > 0 ? 1 / closesPerBudget : null,
    costPerMeetingBookedUsd: meetingsPerBudget > 0 ? 1 / meetingsPerBudget : null,
    costPerSignupUsd: signupsPerBudget > 0 ? 1 / signupsPerBudget : null,
    costPerVisitPaidClientUsd: visitPaidPerBudget > 0 ? 1 / visitPaidPerBudget : null,
    costPerReplyPaidClientUsd: replyPaidPerBudget > 0 ? 1 / replyPaidPerBudget : null,
    costPerFormSubmissionUsd: formSubmissionsPerBudget > 0 ? 1 / formSubmissionsPerBudget : null,
    costPerFormSubmissionPaidClientUsd: formSubmissionPaidPerBudget > 0 ? 1 / formSubmissionPaidPerBudget : null,
  };
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

// Global decay windows (not per-brand): a lead that reaches a stage and sits there past this
// window with no advance to the next stage is considered DEAD (stalled → no expected revenue).
// Phase 1 covers the pre-engagement stages (next stage observable from the email funnel). Phase 2
// extends decay PAST engagement using per-lead manual-qualification timestamps:
//   Positive Reply → Meeting Booked within 2 weeks, else dead
//   Meeting Booked → Close Win       within 1 month, else dead
//   Close Win                        = realized revenue (full LTR), never decays (terminal)
// A click (visit) has NO onward window — it stays a terminal, no decay.
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE = {
  contacted: 7 * DAY_MS,   // Contacted → Sent within 1 week
  sent: 3 * DAY_MS,        // Sent → Delivered within 3 days
  delivered: 14 * DAY_MS,  // Delivered → Open within 2 weeks
  open: 14 * DAY_MS,       // Open → Click / Positive Reply within 2 weeks
  reply: 14 * DAY_MS,      // Positive Reply → Meeting Booked within 2 weeks
  meeting: 30 * DAY_MS,    // Meeting Booked → Close Win within 1 month
} as const;

/**
 * Sales funnel — expected pipeline revenue from the lead's furthest reached stage.
 *
 *   pClose_click   = orP(visitToClose, visitToMeeting × meetingToClose)   (two independent click routes)
 *   pClose_reply   = replyToMeeting × meetingToClose                       (sales-economics)
 *   pClose_deliv   = orP( P(click|deliv)·pClose_click , P(posReply|deliv)·pClose_reply )
 *   pClose_sent    = P(deliv|sent)    · pClose_deliv
 *   pClose_contact = P(sent|contacted) · pClose_sent
 *
 * orP(a,b) = 1−(1−a)(1−b): independent-probability combine. A click can close self-serve AND via a
 * booked meeting; a delivered lead can click AND reply. These routes are non-exclusive, so we combine
 * them (never max — which silently drops the weaker route, undercounting the pipeline).
 *
 * Each path EV = LTR × pClose_stage. Delivery stages (contacted/sent/delivered) are `kind:
 * "delivery"` — listed in ascending order so the engine surfaces only the FURTHEST reached one
 * as the tag; visit/reply are `kind: "engagement"` (terminal, multi-tag). Every path is
 * itemised in the events ledger.
 */
const salesFunnel: FunnelDefinition = {
  economicsSource: "sales-economics",
  signals: ["contacted", "sent", "delivered", "open", "clicked", "positiveReply", "meeting", "closeWin"],
  resolvePaths: ({ economics: e, platformRates: r }) => {
    const ltr = e.lifetimeRevenueUsd;
    // A click closes via TWO independent (non-exclusive) routes: direct self-serve (visitToClose =
    // "buy without a meeting") OR via a booked meeting (visitToMeeting · meetingToClose). A lead can
    // do both → combine as independent probabilities (orP), bounded by 1. NOT max (drops the weaker
    // route) and NOT a naive sum (can exceed 1).
    const pCloseClick = orP(pct(e.visitToClosePct), pct(e.visitToMeetingPct) * pct(e.meetingToClosePct));
    const pCloseReply = pct(e.replyToMeetingPct) * pct(e.meetingToClosePct);
    const pCloseMeeting = pct(e.meetingToClosePct); // a booked meeting closes at the meeting→close rate
    // A delivered-but-not-yet-engaged lead can take the click route OR the reply route — independent,
    // non-exclusive shots at the same close → combine via orP (was max, which dropped the weaker route).
    const pCloseDeliv = orP(r.clickedPerDelivered * pCloseClick, r.positiveReplyPerDelivered * pCloseReply);
    const pCloseSent = r.deliveredPerSent * pCloseDeliv;
    const pCloseContact = r.sentPerContacted * pCloseSent;
    // `open` is a delivery milestone between delivered and click/reply: it carries the same
    // close probability as delivered (no platform open→close rate exists yet), so it adds no EV
    // — its role is the decay checkpoint (resets the stale clock to the open date) + the tag.
    //
    // Phase 2 post-engagement stages (per-lead manual-qualification timestamps drive the dates):
    //   reply    now carries a 14d onward window (reply → meeting booked).
    //   meeting  EV = LTR × P(close|meeting); 30d onward window (meeting → close win).
    //   closeWin = realized revenue (full LTR), no window → terminal, immune to decay.
    // All are `engagement` kind (multi-tag, monotonic EV: reply < meeting < closeWin).
    return [
      { tag: "contacted", signal: "contacted", expectedRevenueUsd: ltr * pCloseContact, kind: "delivery", staleAfterMs: STALE.contacted },
      { tag: "sent", signal: "sent", expectedRevenueUsd: ltr * pCloseSent, kind: "delivery", staleAfterMs: STALE.sent },
      { tag: "delivered", signal: "delivered", expectedRevenueUsd: ltr * pCloseDeliv, kind: "delivery", staleAfterMs: STALE.delivered },
      { tag: "opened", signal: "open", expectedRevenueUsd: ltr * pCloseDeliv, kind: "delivery", staleAfterMs: STALE.open },
      // click + reply are INDEPENDENT engagement routes to the same close (a lead can do both, and
      // at pre-engagement stages we don't yet know which fires) → `engagementRoute` so the engine
      // COMBINES them as independent probabilities bounded by 1 LTR, instead of MAX'ing. meeting and
      // closeWin below are convergence/terminal positions (mutually exclusive) → left to MAX.
      { tag: "visit", signal: "clicked", expectedRevenueUsd: ltr * pCloseClick, kind: "engagement", engagementRoute: true },
      { tag: "reply", signal: "positiveReply", expectedRevenueUsd: ltr * pCloseReply, kind: "engagement", engagementRoute: true, staleAfterMs: STALE.reply },
      { tag: "meeting", signal: "meeting", expectedRevenueUsd: ltr * pCloseMeeting, kind: "engagement", staleAfterMs: STALE.meeting },
      { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: ltr, kind: "engagement" },
    ];
  },
};

export const FUNNEL_REGISTRY: Record<string, FunnelDefinition> = {
  // Sales first. press / hiring / investors / vc / accelerators reuse the engine with
  // their own funnel + economics once defined — until then they return a null pipeline.
  "sales-cold-email-outreach": salesFunnel,
};

export function getFunnel(featureSlug: string): FunnelDefinition | null {
  return FUNNEL_REGISTRY[featureSlug] ?? null;
}
