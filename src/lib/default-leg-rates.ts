/**
 * EVERY LEG ALWAYS HAS A CONVERSION RATE — the per-leg DEFAULT, the fourth and last source.
 *
 * Owner rule (2026-09-29): "100% des taux de conversion doivent etre prefilled, aucun ne peut etre
 * vide". An arrow resolves measured (the brand's own leads) > manual (the brand stated it) > DEFAULT (no
 * fleet median since 2026-10-14: a brand is never priced on other clients' rates), and the default is what this file seeds: an industry benchmark per leg,
 * served with its own provenance (`source: "default"`) so a reader always sees it is not the brand's
 * number. No leg of the catalogue is ever served as "no rate".
 *
 * Keyed by the LEG (our two step keys), never by a funnel: a brand states one rate per leg, shared by
 * every funnel that reads it, and a default is the same kind of figure. Guarded in
 * `default-leg-rates.test.ts`: every arrow of every catalogue funnel has an entry, each in (0, 100], so
 * a funnel or a step added later fails loudly until somebody seeds its default.
 *
 * A default is NEVER used to CHOOSE a brand's path (`reading-funnels.ts` scores paths on the brand's own
 * measured or stated rates only); it prices a leg nothing better prices.
 */
import type { ChannelStepKey } from "./acquisition-channels.js";

/** `<fromStep>><toStep>` — the same shape `legPairKey` produces for our step keys. */
type LegPair = `${ChannelStepKey}>${ChannelStepKey}`;

/** Industry benchmarks, in percent (0..100]. Deliberately conservative: a default that flatters a path
 *  would read as a promise nobody measured. */
export const DEFAULT_LEG_RATE_PCT: Readonly<Partial<Record<LegPair, number>>> = {
  // Reply-led meetings: roughly a third of positive replies become a booked meeting.
  "conversation>meeting_booked": 30,
  // A sale closed straight out of the conversation, with no meeting in between.
  "conversation>paid_client": 5,
  // The booking call: the rep reaches the buyer on most calls placed the moment they replied...
  "conversation>booking_call": 60,
  // ...and books a meeting on a minority of those calls.
  "booking_call>meeting_booked": 40,
  // Show-up rate of a booked B2B meeting.
  "meeting_booked>meeting_attended": 75,
  // Close rate of a held sales meeting.
  "meeting_attended>paid_client": 20,
  // Website traffic. Every website visit we produce is a CLICK IN A COLD EMAIL, never a motivated inbound
  // visitor, so the benchmark is not a site-wide average (~2-3%). Value: 0.2% on EVERY leg leaving the
  // visit, purchase included, owner-stated 2026-10-14 ("je veux que tu remplaces tous les benchmarks par des
  // 0.2%"; was 0.5% since 2026-10-03, 2% on purchase): distribute.you fleet experience, 0 of 461 cold-email
  // clickers converted on a form. Upper reference: First Page Sage, "B2B SaaS Funnel Conversion Benchmarks"
  // (2025-06-11, https://firstpagesage.com/seo-blog/b2b-saas-funnel-conversion-benchmarks-fc/), EMAIL
  // visitor-to-lead 1.3%, the loosest conversion across all email (warm lists included).
  "website_visit>meeting_booked": 0.2,
  "website_visit>signup": 0.2,
  "website_visit>form_submitted": 0.2,
  "website_visit>purchase": 0.2,
  // A signup or a submitted form that becomes a paying client.
  "signup>paid_client": 10,
  "form_submitted>paid_client": 10,
  // A completed checkout IS a paying client, bar refunds and failed payments.
  "purchase>paid_client": 95,
};

/**
 * The last rung of an ENTRY leg's conversion (out of Contacted / Lead found): share of people reaching the entry
 * step on a cold email, used only when the fleet has measured none. Conservative cold-email benchmarks: ~1% reply
 * positively, ~2% click through to the website. Read by the offer ladder's contacted row (`lib/expected-conversion.ts`)
 * and the catalogue's expected funnel figures (`lib/agent-catalogue.ts`).
 */
export const DEFAULT_ENTRY_RATE_PCT: Readonly<Partial<Record<ChannelStepKey, number>>> = {
  conversation: 1,
  website_visit: 2,
};

/** The default for the leg between two of our step keys, or null when none is seeded (a guard failure). */
export function defaultLegRatePct(from: ChannelStepKey, to: ChannelStepKey): number | null {
  return DEFAULT_LEG_RATE_PCT[`${from}>${to}` as LegPair] ?? DECLARED_LEG_RATE_PCT.get(`${from}>${to}`) ?? null;
}

/**
 * The stated rate of a leg the seeded defaults do not cover (a leg touching a step declared at run time,
 * `declared_leg_rates`), registered by every catalogue load (`lib/catalogue-declarations-store.ts`). A seeded
 * default always wins: a declaration never re-rates a coded leg.
 */
const DECLARED_LEG_RATE_PCT = new Map<string, number>();

export function registerDeclaredLegRates(rates: ReadonlyArray<{ fromStep: string; toStep: string; ratePct: number }>): void {
  for (const r of rates) DECLARED_LEG_RATE_PCT.set(`${r.fromStep}>${r.toStep}`, r.ratePct);
}
