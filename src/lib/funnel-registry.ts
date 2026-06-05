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

export type EconomicsSource = "sales-economics";

export interface FunnelDefinition {
  economicsSource: EconomicsSource;
  /** Signals the funnel reads off each lead (the engagement stages it scores). */
  signals: string[];
  resolvePaths: (inputs: FunnelInputs) => ResolvedPath[];
}

const pct = (n: number): number => n / 100;

/**
 * Sales funnel — expected pipeline revenue from the lead's furthest reached stage.
 *
 *   pClose_click   = max(visitToClose, visitToMeeting × meetingToClose)   (sales-economics)
 *   pClose_reply   = replyToMeeting × meetingToClose                       (sales-economics)
 *   pClose_deliv   = max( P(click|deliv)·pClose_click , P(posReply|deliv)·pClose_reply )
 *   pClose_sent    = P(deliv|sent)    · pClose_deliv
 *   pClose_contact = P(sent|contacted) · pClose_sent
 *
 * Each path EV = LTR × pClose_stage. Delivery-stage paths (contacted/sent/delivered) drive
 * EV + dates + the time-series but are NOT itemised in the events ledger (`ledger:false`) —
 * only the click/reply engagement events are (avoids a row-per-lead-per-stage ledger).
 */
const salesFunnel: FunnelDefinition = {
  economicsSource: "sales-economics",
  signals: ["contacted", "sent", "delivered", "clicked", "positiveReply"],
  resolvePaths: ({ economics: e, platformRates: r }) => {
    const ltr = e.lifetimeRevenueUsd;
    const pCloseClick = Math.max(pct(e.visitToClosePct), pct(e.visitToMeetingPct) * pct(e.meetingToClosePct));
    const pCloseReply = pct(e.replyToMeetingPct) * pct(e.meetingToClosePct);
    const pCloseDeliv = Math.max(r.clickedPerDelivered * pCloseClick, r.positiveReplyPerDelivered * pCloseReply);
    const pCloseSent = r.deliveredPerSent * pCloseDeliv;
    const pCloseContact = r.sentPerContacted * pCloseSent;
    return [
      { tag: "contacted", signal: "contacted", expectedRevenueUsd: ltr * pCloseContact, ledger: false },
      { tag: "sent", signal: "sent", expectedRevenueUsd: ltr * pCloseSent, ledger: false },
      { tag: "delivered", signal: "delivered", expectedRevenueUsd: ltr * pCloseDeliv, ledger: false },
      { tag: "visit", signal: "clicked", expectedRevenueUsd: ltr * pCloseClick, ledger: true },
      { tag: "reply", signal: "positiveReply", expectedRevenueUsd: ltr * pCloseReply, ledger: true },
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
