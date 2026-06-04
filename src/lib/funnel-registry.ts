import type { ResolvedPath } from "./revenue-engine.js";

/**
 * Funnel registry — maps a featureSlug to its expected-revenue funnel.
 *
 * A funnel declares:
 *   - which economics provider feeds its rates + terminal LTR (`economicsSource`)
 *   - how to turn that economics payload into numeric `ResolvedPath[]` (`resolvePaths`)
 *
 * Sales is wired first. press / hiring / investors plug in here with their own funnel
 * once their economics exist (brand-service will generalise sales-economics →
 * feature-economics). The revenue-engine itself is funnel-agnostic.
 */

/** Sales conversion economics — brand-service GET /orgs/brands/{brandId}/sales-economics. */
export interface SalesEconomics {
  lifetimeRevenueUsd: number;
  replyToMeetingPct: number;
  visitToMeetingPct: number;
  meetingToClosePct: number;
  visitToClosePct: number;
}

export type EconomicsSource = "sales-economics";

export interface FunnelDefinition {
  economicsSource: EconomicsSource;
  /** Signals the funnel reads off each person (documentation / future leads-client scoping). */
  signals: string[];
  /** Resolve the economics payload into numeric expected-revenue paths. */
  resolvePaths: (economics: SalesEconomics) => ResolvedPath[];
}

const pct = (n: number): number => n / 100;

/**
 * Sales funnel — expected pipeline revenue per person, MAX across paths.
 *   visit path (clicked / website visit):
 *     LTR × max(visitToClose, visitToMeeting × meetingToClose)
 *   reply path (positive reply):
 *     LTR × replyToMeeting × meetingToClose
 */
const salesFunnel: FunnelDefinition = {
  economicsSource: "sales-economics",
  signals: ["clicked", "positiveReply"],
  resolvePaths: (e) => {
    const ltr = e.lifetimeRevenueUsd;
    const visitEv = ltr * Math.max(pct(e.visitToClosePct), pct(e.visitToMeetingPct) * pct(e.meetingToClosePct));
    const replyEv = ltr * pct(e.replyToMeetingPct) * pct(e.meetingToClosePct);
    return [
      { tag: "visit", signal: "clicked", expectedRevenueUsd: visitEv },
      { tag: "reply", signal: "positiveReply", expectedRevenueUsd: replyEv },
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
