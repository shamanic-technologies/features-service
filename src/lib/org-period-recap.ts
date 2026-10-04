/**
 * ONE ORG, ONE WINDOW: what its outbound did and what it is expected to return — the figures billing-service
 * puts in the customer's "your month of credit is used up" email (`GET /internal/orgs/:orgId/period-recap`).
 *
 * billing owns the MOMENT and the send; it computes no performance figure. Every number below is computed
 * HERE, from the same producers the dashboard reads, so the email can never state a figure the dashboard
 * contradicts. Rules that are load-bearing:
 *
 *   - VOLUME is read per UTC DAY from email-gateway (`/orgs/stats?type=broadcast&groupBy=day`, the read
 *     behind the Overview's outreach bars, `lib/sequences-client.ts`) and summed over the window's days:
 *     `emailsSent` / `emailsDelivered` on the EMAIL grain (every step of every sequence), and
 *     `recipientsContacted` on the lead grain (the Outreach card's per-day series). The window is whole UTC
 *     days, both bounds inclusive.
 *   - CONTACTED IS NOT SENT. email-gateway's `contacted` counts a lead PUSHED INTO THE SENDING QUEUE (dated on
 *     the push); its `sent` counts a lead that got at least one email (dated on the send event). A brand whose
 *     mailboxes have not dispatched yet reads 302 contacted / 0 sent (Legistai, 2026-10-03). So the outbound
 *     block states both and a verdict: `recipientsEnrolled` (= `recipientsContacted`, lined up),
 *     `recipientsEmailed` (got ≥1 email in the window), `sendStatus` (`emails_sent` | `lined_up_not_sent` |
 *     `nothing_sent`). The two clocks differ, so no "queued = enrolled − emailed" subtraction is served.
 *   - DELIVERY RATE = delivered ÷ sent emails in the window. It is the WINDOW twin of the dashboard's
 *     whole-history `outcomes.sending.deliveryRatePct` (which is lead-grain): never relabel one as the other.
 *   - EXPECTED POSITIVE REPLIES = the window's contacted leads × a positive-reply rate per contacted lead.
 *     The rate is the brand's OWN MATURE rate when it has one (leads contacted on days before the
 *     `start_to_conversation` maturity cutoff, `lib/maturity.ts`, holding at least that leg's
 *     `outcomesRequired` positive replies); otherwise the FLEET rate the public onboarding quotes
 *     (`/public/stats/outcome-prices`, the best workflow's conversion on `start_to_conversation`). A brand a
 *     few days old is the NORMAL case: it is priced on the fleet rate and says so (`rateSource`).
 *   - THE RETURN IS THE DASHBOARD'S, READ NEVER RE-DERIVED (2026-10-04: Legistai's email
 *     said 5.9x while its Today page said 4.3x). `expectedReturn.roiMultiple` = the return the customer is
 *     shown for the scope that sent: `/offers/:offerId/revenue?pricing=net` (the Today page's read, the SAME
 *     Gold cell via `offerRevenueJson`) → `costEconomics.maturity` → `servedReturnOf` (`lib/served-return.ts`:
 *     mature half; not mature → to-date half when > 1x, else null `return_learning`). Every offer with
 *     channels of every brand that contacted someone in the window is a scope; they must state ONE value,
 *     else null + `return_differs_across_scopes` (never a blend, never a pick). `returnScopes` names each.
 *     The window's own reply-route valuation was a second formula for "return" and is gone: it divided the
 *     window's lined-up leads by a window spend most of whose send cost was not incurred yet, so it ran high.
 *   - The rest of the return block is that one multiple restated, so nothing in it can disagree with it:
 *     `expectedRevenueUsd` = roi × window spend, `expectedPaidClients` = that ÷ lifetime revenue per client.
 *   - LIFETIME REVENUE per client (`lifetimeRevenuePerClientUsd`, shown beside the return) is the one the
 *     customer STATED ON THEIR OFFER (brand-service `offer-economics`), never a brand/cross-brand average when
 *     one is stated: every offer states it and they agree → `offer_stated`; none does → the brand's effective
 *     economics (`brand_economics`, its `source` rides `economicsSource`); offers disagree or only some state
 *     one → null + `lifetime_revenue_differs_across_offers`.
 *   - SPEND = the org's whole COMMITTED spend in the window on the NET basis (runs-service dated
 *     `netTotalCostInUsdCents`, every brand, setup included) — what the month's credit was consumed by.
 *   - +$100 is LINEAR AT THE SERVED RETURN: `expectedAdditionalRevenueUsd` = 100 × roiMultiple exactly;
 *     `expectedAdditionalPositiveReplies` = 100 ÷ window spend × expected replies; `revenueMultiple` =
 *     (window spend + 100) ÷ window spend (revenue at the same return scales with spend);
 *     `expectedAdditionalRecipientsEnrolled` = 100 × enrolled ÷ spend, whole people (needs no rate or economics,
 *     so it has its own null reason). Nothing about diminishing or improving returns is claimed.
 *   - ACTUAL OUTCOMES (`actualOutcomes`, 2026-10-04, for billing's informational monthly email): the
 *     positive replies and meetings booked that HAPPENED in the window, read off the SAME dated series the
 *     dashboard draws (`recipientsRepliesPositive` / `meetingsBooked` on `/offers/:offerId/revenue`, dated on
 *     the outcome itself, the read `expectedReturn` already makes) and summed over the window's days, for every
 *     offer with campaigns of every brand the org holds (a reply can land in the window on an earlier send).
 *     A series that could not be read → null `outcomes_unavailable`; one holding an UNDATED outcome → null
 *     `undated_outcomes` (it may fall in the window or not). Never a recount here.
 *   - UNKNOWN IS NULL WITH A REASON, NEVER 0. A zero is served only where it is TRUE (nothing sent in the
 *     window ⇒ 0 emails, 0 expected replies).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { legMaturity, maturityCutoffIso } from "./maturity.js";
import { BrandOwnershipError, fetchEffectiveEconomics, type EffectiveEconomics } from "./sales-economics-client.js";
import type { MaturityPair } from "./maturity.js";
import { servedReturnOf, type ServedReturnHalf } from "./served-return.js";

export const POSITIVE_REPLY_LEG_KEY = "start_to_conversation";
export const BUDGET_INCREASE_USD = 100;
/** The widest window a recap answers: a subscription month, with room. */
export const MAX_WINDOW_DAYS = 93;

/** One UTC day of one brand's broadcast stats, as email-gateway buckets it. */
export interface RecapDay {
  date: string;
  emailsSent: number;
  emailsDelivered: number;
  /** Leads pushed into the sending queue that day (NOT necessarily emailed). */
  recipientsContacted: number;
  /** Leads that got at least one email that day. */
  recipientsEmailed: number;
  recipientsRepliesPositive: number;
}

/** The fleet's positive-reply rate, as the public onboarding quotes it. */
export interface FleetReplyRate {
  ratePct: number;
  basis: "mature" | "flash";
  workflowDynastySlug: string | null;
}

export type ReplyRateSource = "brand_mature" | "fleet";

export type RecapNullReason =
  /** Nothing was sent in the window: there is no denominator. */
  | "nothing_sent"
  /** The brand has no mature rate of its own and the fleet benchmark has not been computed yet. */
  | "reply_rate_unavailable"
  /** A brand that sent in the window has no economics (no lifetime revenue, no reply → paid rate). */
  | "economics_missing"
  /** The org spent nothing in the window: a per-dollar projection has no denominator. */
  | "no_spend_in_window"
  /** The scope is not mature and its to-date return is not above 1x: the dashboard reads Learning. */
  | "return_learning"
  /** No return is served for the scope (no pair, no offer with campaigns, brand not held): the dashboard reads —. */
  | "return_unavailable"
  /** The scopes that sent in the window are shown different returns: no one figure is true. */
  | "return_differs_across_scopes"
  /** Brands that sent in the window are valued at different lifetime revenues: no one figure is true. */
  | "lifetime_revenue_differs_across_brands"
  /** The brand's offers state different lifetime revenues (or only some state one): no one figure is true. */
  | "lifetime_revenue_differs_across_offers"
  /** An offer's dated outcome series could not be read: a sum missing it would understate. */
  | "outcomes_unavailable"
  /** An offer holds an outcome with no date: nobody knows whether it falls in the window. */
  | "undated_outcomes";

/** Where a brand's lifetime revenue per client was read. */
export type LifetimeRevenueSource = "offer_stated" | "brand_economics";

/** Window sending verdict: did anything actually go out, or is it only lined up in the sending queue? */
export type SendStatus = "emails_sent" | "lined_up_not_sent" | "nothing_sent";

export interface RecapBrand {
  brandId: string;
  emailsSent: number;
  emailsDelivered: number;
  recipientsContacted: number;
  recipientsEmailed: number;
  positiveReplyRatePct: number | null;
  rateSource: ReplyRateSource | null;
  /** The brand's own mature cohort the rate was (or would have been) read from. */
  matureCohort: { cutoffDate: string; recipientsContacted: number; recipientsRepliesPositive: number; outcomesRequired: number };
  expectedPositiveReplies: number | null;
  lifetimeRevenuePerClientUsd: number | null;
  lifetimeRevenueSource: LifetimeRevenueSource | null;
  /** The offer whose stated lifetime revenue is used (a one-offer brand), else null. */
  lifetimeRevenueOfferId: string | null;
  lifetimeRevenueStatedAt: string | null;
  economicsSource: EffectiveEconomics["source"];
  nullReason: RecapNullReason | null;
}

/** One offer's served return, as `/offers/:offerId/revenue?pricing=net` serves it (the dashboard's read). */
export interface OfferReturnRead {
  offerId: string;
  /** `costEconomics.maturity` (null = no pair served). */
  pair: MaturityPair<{ roiMultiple: number | null }> | null;
  /** `headline.totalPipelineUsd` and `costEconomics.committedCostUsd`: what the flash return divides. */
  pipelineUsd: number | null;
  committedCostUsd: number | null;
  /** The dashboard's dated outcome series on the same body (absent/null = not served: unknown, never 0). */
  outcomeSeries?: { positiveReplies: OutcomeSeries | null; meetingsBooked: OutcomeSeries | null };
}

/** One dated outcome series as the revenue body serves it (`buildSignalSeries`). */
export interface OutcomeSeries {
  total: number;
  daily: Array<{ date: string; count: number }>;
  undatedCount: number;
}

/** PURE. One outcome summed over the window across every scope read, or null with the reason (rule in the header). */
export function windowOutcomeCount(
  series: ReadonlyArray<OutcomeSeries | null | undefined>,
  days: ReadonlySet<string>,
): { count: number | null; nullReason: RecapNullReason | null } {
  let count = 0;
  for (const s of series) {
    if (!s) return { count: null, nullReason: "outcomes_unavailable" };
    if (s.undatedCount > 0) return { count: null, nullReason: "undated_outcomes" };
    for (const d of s.daily) if (days.has(d.date)) count += d.count;
  }
  return { count, nullReason: null };
}

/** A scope whose served return the recap states (provenance). */
export interface RecapReturnScope {
  brandId: string;
  /** null = the brand's return could not be read at all (brand not held / no offer with campaigns). */
  offerId: string | null;
  roiMultiple: number | null;
  half: ServedReturnHalf | null;
  isMature: boolean | null;
  flashRoiMultiple: number | null;
  matureRoiMultiple: number | null;
  pipelineUsd: number | null;
  committedCostUsd: number | null;
  nullReason: RecapNullReason | null;
}

export interface OrgPeriodRecap {
  orgId: string;
  window: { from: string; to: string; grain: "utc_day"; days: number };
  pricing: "net";
  costBasis: "committed";
  outbound: {
    emailsSent: number;
    emailsDelivered: number;
    /** Leads pushed into the sending queue in the window. Same number as `recipientsEnrolled`; NOT "emailed". */
    recipientsContacted: number;
    recipientsEnrolled: number;
    /** Leads that got at least one email in the window. */
    recipientsEmailed: number;
    sendStatus: SendStatus;
    deliveryRatePct: number | null;
    deliveryRateNullReason: RecapNullReason | null;
  };
  expectedPositiveReplies: number | null;
  expectedPositiveRepliesNullReason: RecapNullReason | null;
  /** What HAPPENED in the window, on the dashboard's own dated series (rule in the header). */
  actualOutcomes: {
    basis: "dashboard_dated_series";
    positiveReplies: number | null;
    positiveRepliesNullReason: RecapNullReason | null;
    meetingsBooked: number | null;
    meetingsBookedNullReason: RecapNullReason | null;
  };
  spendUsd: number;
  expectedReturn: {
    /** The dashboard's served return for the scope that sent (rule in the header). */
    basis: "served_return";
    /** `roiMultiple × spendUsd`. */
    expectedRevenueUsd: number | null;
    /** `expectedRevenueUsd ÷ lifetimeRevenuePerClientUsd`. */
    expectedPaidClients: number | null;
    /** EXACTLY the served figure (not rounded), so it compares to the dashboard's to the last digit. */
    roiMultiple: number | null;
    /** Which half of the served pair it is (`mature`, or `flash` for a not-mature scope above 1x). */
    returnHalf: ServedReturnHalf | null;
    returnScopes: RecapReturnScope[];
    lifetimeRevenuePerClientUsd: number | null;
    lifetimeRevenueSource: LifetimeRevenueSource | null;
    lifetimeRevenueNullReason: RecapNullReason | null;
    nullReason: RecapNullReason | null;
  };
  budgetIncrease: {
    amountUsd: number;
    basis: "linear_at_served_return";
    /** amountUsd × recipientsEnrolled ÷ spend, whole recipients: how many more leads the amount lines up. */
    expectedAdditionalRecipientsEnrolled: number | null;
    expectedAdditionalRecipientsEnrolledNullReason: RecapNullReason | null;
    expectedAdditionalPositiveReplies: number | null;
    /** `amountUsd × expectedReturn.roiMultiple`. */
    expectedAdditionalRevenueUsd: number | null;
    /** (window spend + amount) ÷ window spend: revenue at the same served return scales with spend. */
    revenueMultiple: number | null;
    nullReason: RecapNullReason | null;
  };
  brands: RecapBrand[];
  fleetPositiveReplyRate: FleetReplyRate | null;
}

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** PURE. Every UTC day of [from, to], both inclusive. */
export function windowDays(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** PURE. A real calendar day in `YYYY-MM-DD` (rejects `2026-02-31`, which `Date` would roll forward). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** An offer of the brand, as brand-service states it. */
export interface RecapOffer {
  offerId: string;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueStatedAt: string | null;
}

/** PURE. The lifetime revenue a brand's sends are valued at (rule in the header). */
export function resolveRecapLifetimeRevenue(
  offers: readonly RecapOffer[] | null,
  economics: EffectiveEconomics,
): { usd: number | null; source: LifetimeRevenueSource | null; offerId: string | null; statedAt: string | null; nullReason: RecapNullReason | null } {
  const stated = (offers ?? []).filter((o) => o.lifetimeRevenueUsd !== null);
  if (stated.length === 0) {
    const ltr = economics.economics && Number.isFinite(economics.economics.lifetimeRevenueUsd) ? economics.economics.lifetimeRevenueUsd : null;
    return { usd: ltr, source: ltr === null ? null : "brand_economics", offerId: null, statedAt: null, nullReason: ltr === null ? "economics_missing" : null };
  }
  const values = new Set(stated.map((o) => o.lifetimeRevenueUsd));
  if (stated.length !== offers!.length || values.size > 1) {
    return { usd: null, source: null, offerId: null, statedAt: null, nullReason: "lifetime_revenue_differs_across_offers" };
  }
  const only = stated.length === 1 ? stated[0] : null;
  return {
    usd: stated[0].lifetimeRevenueUsd,
    source: "offer_stated",
    offerId: only?.offerId ?? null,
    statedAt: only?.lifetimeRevenueStatedAt ?? null,
    nullReason: null,
  };
}

export interface RecapInputs {
  orgId: string;
  from: string;
  to: string;
  now: Date;
  /** `offers: null` = the org no longer holds the brand (no statements to read). */
  /** `returns: null` = the brand's served return could not be read; `[]` = no offer of it has campaigns. */
  brands: Array<{
    brandId: string;
    days: RecapDay[];
    economics: EffectiveEconomics;
    offers: RecapOffer[] | null;
    returns: OfferReturnRead[] | null;
  }>;
  /** The org's net committed spend per UTC day (absent day = 0). */
  spendByDay: Map<string, number>;
  fleetRate: FleetReplyRate | null;
}

/** PURE. The served returns of one brand that sent, as provenance rows (rule in the header). */
export function brandReturnScopes(brandId: string, returns: OfferReturnRead[] | null): RecapReturnScope[] {
  const unreadable = (): RecapReturnScope => ({
    brandId,
    offerId: null,
    roiMultiple: null,
    half: null,
    isMature: null,
    flashRoiMultiple: null,
    matureRoiMultiple: null,
    pipelineUsd: null,
    committedCostUsd: null,
    nullReason: "return_unavailable",
  });
  if (returns === null || returns.length === 0) return [unreadable()];
  return returns.map((r) => {
    const shown = servedReturnOf(r.pair);
    return {
      brandId,
      offerId: r.offerId,
      roiMultiple: shown.roiMultiple,
      half: shown.half,
      isMature: r.pair?.isMature ?? null,
      flashRoiMultiple: r.pair?.flash?.roiMultiple ?? null,
      matureRoiMultiple: r.pair?.mature?.roiMultiple ?? null,
      pipelineUsd: r.pipelineUsd,
      committedCostUsd: r.committedCostUsd,
      nullReason: shown.nullReason,
    };
  });
}

/** PURE. The whole recap from already-read inputs. */
export function buildOrgPeriodRecap(input: RecapInputs): OrgPeriodRecap {
  const days = new Set(windowDays(input.from, input.to));
  const rule = legMaturity(POSITIVE_REPLY_LEG_KEY);
  const cutoffDate = maturityCutoffIso(rule.durationDays, input.now).slice(0, 10);

  const brands = input.brands
    .map(({ brandId, days: series, economics, offers, returns }) => {
      let emailsSent = 0;
      let recipientsEmailed = 0;
      let emailsDelivered = 0;
      let recipientsContacted = 0;
      let matureContacted = 0;
      let matureReplies = 0;
      for (const d of series) {
        if (days.has(d.date)) {
          emailsSent += d.emailsSent;
          emailsDelivered += d.emailsDelivered;
          recipientsContacted += d.recipientsContacted;
          recipientsEmailed += d.recipientsEmailed;
        }
        if (d.date < cutoffDate) {
          matureContacted += d.recipientsContacted;
          matureReplies += d.recipientsRepliesPositive;
        }
      }
      const ownMature = matureContacted > 0 && matureReplies >= rule.outcomesRequired;
      const ratePct = ownMature ? (100 * matureReplies) / matureContacted : (input.fleetRate?.ratePct ?? null);
      const rateSource: ReplyRateSource | null = ownMature ? "brand_mature" : input.fleetRate ? "fleet" : null;

      let expectedPositiveReplies: number | null;
      let nullReason: RecapNullReason | null = null;
      if (recipientsContacted === 0) expectedPositiveReplies = 0;
      else if (ratePct === null) {
        expectedPositiveReplies = null;
        nullReason = "reply_rate_unavailable";
      } else expectedPositiveReplies = (recipientsContacted * ratePct) / 100;

      const lifetime = resolveRecapLifetimeRevenue(offers, economics);
      return {
        brandId,
        emailsSent,
        emailsDelivered,
        recipientsContacted,
        recipientsEmailed,
        positiveReplyRatePct: ratePct === null ? null : round(ratePct, 4),
        rateSource,
        matureCohort: {
          cutoffDate,
          recipientsContacted: matureContacted,
          recipientsRepliesPositive: matureReplies,
          outcomesRequired: rule.outcomesRequired,
        },
        expectedPositiveReplies: expectedPositiveReplies === null ? null : round(expectedPositiveReplies, 2),
        lifetimeRevenuePerClientUsd: lifetime.usd,
        lifetimeRevenueSource: lifetime.source,
        lifetimeRevenueOfferId: lifetime.offerId,
        lifetimeRevenueStatedAt: lifetime.statedAt,
        _ltrNullReason: lifetime.nullReason,
        economicsSource: economics.source,
        nullReason,
        _rawReplies: expectedPositiveReplies,
        _returns: returns,
      };
    })
    .sort((a, b) => (a.brandId < b.brandId ? -1 : 1));

  const emailsSent = brands.reduce((s, b) => s + b.emailsSent, 0);
  const emailsDelivered = brands.reduce((s, b) => s + b.emailsDelivered, 0);
  const recipientsContacted = brands.reduce((s, b) => s + b.recipientsContacted, 0);
  const recipientsEmailed = brands.reduce((s, b) => s + b.recipientsEmailed, 0);
  const sendStatus: SendStatus = emailsSent > 0 ? "emails_sent" : recipientsContacted > 0 ? "lined_up_not_sent" : "nothing_sent";
  let spendUsd = 0;
  for (const [day, usd] of input.spendByDay) if (days.has(day)) spendUsd += usd;

  // Org totals: the first unknown brand that SENT makes the total unknown (a partial sum would understate).
  const senders = brands.filter((b) => b.recipientsContacted > 0);
  const unknownReplies = senders.find((b) => b._rawReplies === null);
  const repliesReason: RecapNullReason | null = unknownReplies ? unknownReplies.nullReason ?? "reply_rate_unavailable" : null;
  const expectedReplies = repliesReason ? null : brands.reduce((s, b) => s + (b._rawReplies ?? 0), 0);

  // THE RETURN: the one the dashboard shows for every scope that sent, or null with the reason.
  const returnScopes = senders.flatMap((b) => brandReturnScopes(b.brandId, b._returns));
  let returnReason: RecapNullReason | null = null;
  let roiMultiple: number | null = null;
  let returnHalf: ServedReturnHalf | null = null;
  if (senders.length === 0) returnReason = "nothing_sent";
  else {
    const unshown = returnScopes.find((s) => s.roiMultiple === null);
    const values = new Set(returnScopes.map((s) => s.roiMultiple));
    if (unshown) returnReason = unshown.nullReason ?? "return_unavailable";
    else if (values.size > 1) returnReason = "return_differs_across_scopes";
    else {
      roiMultiple = returnScopes[0].roiMultiple;
      const halves = new Set(returnScopes.map((s) => s.half));
      returnHalf = halves.size === 1 ? returnScopes[0].half : null;
    }
  }

  const ltrs = new Set(senders.map((b) => b.lifetimeRevenuePerClientUsd));
  let lifetimeRevenuePerClientUsd: number | null = null;
  let lifetimeRevenueSource: LifetimeRevenueSource | null = null;
  let lifetimeRevenueNullReason: RecapNullReason | null = null;
  const unvalued = senders.find((b) => b.lifetimeRevenuePerClientUsd === null);
  if (senders.length === 0) lifetimeRevenueNullReason = "nothing_sent";
  else if (unvalued) lifetimeRevenueNullReason = unvalued._ltrNullReason ?? "economics_missing";
  else if (ltrs.size > 1) lifetimeRevenueNullReason = "lifetime_revenue_differs_across_brands";
  else {
    lifetimeRevenuePerClientUsd = [...ltrs][0];
    const sources = new Set(senders.map((b) => b.lifetimeRevenueSource));
    // Same value read from different places (one brand stated, another averaged): no one provenance is true.
    lifetimeRevenueSource = sources.size === 1 ? [...sources][0] : null;
  }

  // What happened: every offer read of every brand the org holds (a brand it no longer holds is shown nowhere).
  const outcomeScopes = brands.flatMap((b) => b._returns ?? []);
  const replies = windowOutcomeCount(outcomeScopes.map((r) => r.outcomeSeries?.positiveReplies), days);
  const meetings = windowOutcomeCount(outcomeScopes.map((r) => r.outcomeSeries?.meetingsBooked), days);

  const expectedRevenueUsd = roiMultiple === null ? null : roiMultiple * spendUsd;
  const expectedPaidClients =
    expectedRevenueUsd === null || lifetimeRevenuePerClientUsd === null || lifetimeRevenuePerClientUsd <= 0
      ? null
      : expectedRevenueUsd / lifetimeRevenuePerClientUsd;
  const hasSpend = spendUsd > 0;
  // Volume needs no rate and no economics: only something lined up and a spend that lined it up.
  const recipientsReason: RecapNullReason | null =
    recipientsContacted === 0 ? "nothing_sent" : spendUsd <= 0 ? "no_spend_in_window" : null;
  return {
    orgId: input.orgId,
    window: { from: input.from, to: input.to, grain: "utc_day", days: days.size },
    pricing: "net",
    costBasis: "committed",
    outbound: {
      emailsSent,
      emailsDelivered,
      recipientsContacted,
      recipientsEnrolled: recipientsContacted,
      recipientsEmailed,
      sendStatus,
      deliveryRatePct: emailsSent > 0 ? round((100 * emailsDelivered) / emailsSent, 2) : null,
      deliveryRateNullReason: emailsSent > 0 ? null : "nothing_sent",
    },
    expectedPositiveReplies: expectedReplies === null ? null : round(expectedReplies, 2),
    expectedPositiveRepliesNullReason: repliesReason,
    actualOutcomes: {
      basis: "dashboard_dated_series",
      positiveReplies: replies.count,
      positiveRepliesNullReason: replies.nullReason,
      meetingsBooked: meetings.count,
      meetingsBookedNullReason: meetings.nullReason,
    },
    spendUsd: round(spendUsd, 2),
    expectedReturn: {
      basis: "served_return",
      expectedRevenueUsd: expectedRevenueUsd === null ? null : round(expectedRevenueUsd, 2),
      expectedPaidClients: expectedPaidClients === null ? null : round(expectedPaidClients, 4),
      roiMultiple,
      returnHalf,
      returnScopes,
      lifetimeRevenuePerClientUsd,
      lifetimeRevenueSource,
      lifetimeRevenueNullReason,
      nullReason: returnReason,
    },
    budgetIncrease: {
      amountUsd: BUDGET_INCREASE_USD,
      basis: "linear_at_served_return",
      expectedAdditionalRecipientsEnrolled: recipientsReason ? null : Math.round((BUDGET_INCREASE_USD * recipientsContacted) / spendUsd),
      expectedAdditionalRecipientsEnrolledNullReason: recipientsReason,
      expectedAdditionalPositiveReplies:
        expectedReplies !== null && hasSpend ? round((BUDGET_INCREASE_USD * expectedReplies) / spendUsd, 2) : null,
      expectedAdditionalRevenueUsd: roiMultiple === null ? null : round(BUDGET_INCREASE_USD * roiMultiple, 2),
      revenueMultiple: roiMultiple !== null && hasSpend ? round((spendUsd + BUDGET_INCREASE_USD) / spendUsd, 2) : null,
      nullReason: returnReason ?? (hasSpend ? repliesReason : "no_spend_in_window"),
    },
    brands: brands.map(({ _rawReplies: _a, _returns: _b, _ltrNullReason: _d, ...rest }): RecapBrand => rest),
    fleetPositiveReplyRate: input.fleetRate,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

function emailGatewayConfig(): { url: string; apiKey: string } {
  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  return { url, apiKey };
}

type StatsGroup = {
  key?: unknown;
  broadcast?: {
    emailStats?: { sent?: unknown; delivered?: unknown };
    recipientStats?: { contacted?: unknown; sent?: unknown; repliesPositive?: unknown };
  };
};

const num = (v: unknown, what: string): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new Error(`email-gateway /orgs/stats group missing numeric ${what}`);
};

async function orgStatsGroups(orgId: string, params: URLSearchParams): Promise<StatsGroup[]> {
  const { url, apiKey } = emailGatewayConfig();
  const res = await fetchWithRetry(`${url}/orgs/stats?${params}`, { headers: { "x-api-key": apiKey, "x-org-id": orgId } });
  if (!res.ok) throw new Error(`email-gateway /orgs/stats failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { groups?: unknown };
  if (!Array.isArray(data.groups)) throw new Error("email-gateway /orgs/stats returned no groups array");
  return data.groups as StatsGroup[];
}

/** Every brand this org has ever broadcast for (org-scoped, api-key + x-org-id only). */
export async function fetchOrgBroadcastBrandIds(orgId: string): Promise<string[]> {
  const groups = await orgStatsGroups(orgId, new URLSearchParams({ type: "broadcast", groupBy: "brandId" }));
  return groups.map((g) => g.key).filter((k): k is string => typeof k === "string" && k.length > 0);
}

/** One brand's broadcast stats per UTC day, whole history. */
export async function fetchBrandBroadcastDays(orgId: string, brandId: string): Promise<RecapDay[]> {
  const groups = await orgStatsGroups(
    orgId,
    new URLSearchParams({ type: "broadcast", groupBy: "day", timezone: "UTC", brandId }),
  );
  return groups.map((g) => {
    if (typeof g.key !== "string") throw new Error("email-gateway day group missing key");
    const e = g.broadcast?.emailStats ?? {};
    const r = g.broadcast?.recipientStats ?? {};
    return {
      date: g.key,
      emailsSent: num(e.sent ?? 0, "emailStats.sent"),
      emailsDelivered: num(e.delivered ?? 0, "emailStats.delivered"),
      recipientsContacted: num(r.contacted ?? 0, "recipientStats.contacted"),
      recipientsEmailed: num(r.sent ?? 0, "recipientStats.sent"),
      recipientsRepliesPositive: num(r.repliesPositive ?? 0, "recipientStats.repliesPositive"),
    };
  });
}

/** The org's NET committed spend per UTC day (every brand, setup included). */
export async function fetchOrgNetSpendByDay(orgId: string): Promise<Map<string, number>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({ interval: "day", orgId });
  const res = await fetchWithRetry(`${url}/v1/stats/public/costs/timeseries?${params}`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`runs-service /v1/stats/public/costs/timeseries failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { buckets?: Array<{ period?: unknown; netTotalCostInUsdCents?: unknown }> };
  if (!Array.isArray(data.buckets)) throw new Error("runs-service costs/timeseries returned no buckets array");
  const byDay = new Map<string, number>();
  for (const b of data.buckets) {
    if (typeof b.period !== "string") throw new Error("runs-service costs/timeseries bucket missing period");
    // NET never falls back to gross (the frozen-net contract).
    const cents = Number(b.netTotalCostInUsdCents);
    if ((typeof b.netTotalCostInUsdCents !== "string" && typeof b.netTotalCostInUsdCents !== "number") || !Number.isFinite(cents)) {
      throw new Error("runs-service costs/timeseries bucket missing netTotalCostInUsdCents");
    }
    const day = b.period.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + cents / 100);
  }
  return byDay;
}

/**
 * The brand's offers with their stated lifetime revenue (brand-service `GET /internal/brands/:id/offer-economics`,
 * the read every wave-C1 surface prices on; `lifetimeRevenueStatedAt` is read straight off the same body).
 * FAIL-LOUD: a recap that cannot read what the customer stated 502s rather than value sends on an average.
 * 403/404 = the org no longer holds the brand (same refusal as `BrandOwnershipError`): null, its sends still count.
 */
export async function fetchBrandOffersForRecap(orgId: string, brandId: string): Promise<RecapOffer[] | null> {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${url}/internal/brands/${brandId}/offer-economics`, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`brand-service offer-economics failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { offers?: unknown };
  if (!Array.isArray(data.offers)) throw new Error("brand-service offer-economics returned no offers array");
  return (data.offers as Array<Record<string, unknown>>)
    .filter((o) => typeof o?.offerId === "string" && o.offerId !== "")
    .map((o) => ({
      offerId: o.offerId as string,
      lifetimeRevenueUsd: typeof o.lifetimeRevenueUsd === "number" && Number.isFinite(o.lifetimeRevenueUsd) ? o.lifetimeRevenueUsd : null,
      lifetimeRevenueStatedAt: typeof o.lifetimeRevenueStatedAt === "string" ? o.lifetimeRevenueStatedAt : null,
    }));
}

export interface RecapDeps {
  brandIds: (orgId: string) => Promise<string[]>;
  brandDays: (orgId: string, brandId: string) => Promise<RecapDay[]>;
  economics: (orgId: string, brandId: string) => Promise<EffectiveEconomics>;
  /** The brand's offers with their STATED lifetime revenue, for this org; null = the org no longer holds the brand. */
  offers: (orgId: string, brandId: string) => Promise<RecapOffer[] | null>;
  spendByDay: (orgId: string) => Promise<Map<string, number>>;
  /**
   * The offer's served return as `/offers/:offerId/revenue?pricing=net` serves it (the dashboard's read);
   * null = the offer has no campaign (no channel), so no page shows it a return.
   */
  offerReturn: (orgId: string, brandId: string, offerId: string) => Promise<OfferReturnRead | null>;
  fleetRate: () => FleetReplyRate | null;
  now: () => Date;
}

export const defaultRecapDeps = (
  fleetRate: () => FleetReplyRate | null,
  offerReturn: RecapDeps["offerReturn"],
): RecapDeps => ({
  brandIds: fetchOrgBroadcastBrandIds,
  brandDays: fetchBrandBroadcastDays,
  economics: async (orgId, brandId) => {
    try {
      return await fetchEffectiveEconomics(brandId, { orgId });
    } catch (error) {
      // A brand the org no longer holds has no economics FOR THIS ORG: its sends still count, its value is unknown.
      if (error instanceof BrandOwnershipError) return { economics: null, source: null };
      throw error;
    }
  },
  offers: fetchBrandOffersForRecap,
  spendByDay: fetchOrgNetSpendByDay,
  offerReturn,
  fleetRate,
  now: () => new Date(),
});

/** Read everything and build the recap. FAIL-LOUD: any producer failure throws (the route 502s). */
export async function computeOrgPeriodRecap(orgId: string, from: string, to: string, deps: RecapDeps): Promise<OrgPeriodRecap> {
  const [brandIds, spendByDay] = await Promise.all([deps.brandIds(orgId), deps.spendByDay(orgId)]);
  const brands = await mapWithConcurrency(brandIds, 4, async (brandId) => {
    const [days, economics, offers] = await Promise.all([
      deps.brandDays(orgId, brandId),
      deps.economics(orgId, brandId),
      deps.offers(orgId, brandId),
    ]);
    // Every offer of every brand the org holds is read: the RETURN only states the brands that contacted
    // someone in the window (`senders`), the ACTUAL OUTCOMES count every brand (a reply can land in the
    // window on an earlier send). A brand the org no longer holds has no offers to read it on (null).
    const returns = offers === null
      ? null
      : (await Promise.all(offers.map((o) => deps.offerReturn(orgId, brandId, o.offerId)))).filter(
          (r): r is OfferReturnRead => r !== null,
        );
    return { brandId, days, economics, offers, returns };
  });
  return buildOrgPeriodRecap({ orgId, from, to, now: deps.now(), brands, spendByDay, fleetRate: deps.fleetRate() });
}
