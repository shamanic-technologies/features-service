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
  visitToClosePct: number;
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
}

/** Global per-workflow unit costs (USD); null when the workflow has no clicks / replies. */
export interface ProjectionUnitCosts {
  clickUsd: number | null;
  replyUsd: number | null;
}

export interface ProjectedOutcomeCosts {
  costPerPurchaseUsd: number | null;
  costPerMeetingBookedUsd: number | null;
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

  return {
    costPerPurchaseUsd: closesPerBudget > 0 ? 1 / closesPerBudget : null,
    costPerMeetingBookedUsd: meetingsPerBudget > 0 ? 1 / meetingsPerBudget : null,
  };
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
