/**
 * EVERY LEG ALWAYS HAS A CONVERSION RATE — the per-leg DEFAULT, the fourth and last source.
 *
 * Owner rule (2026-09-29): "100% des taux de conversion doivent etre prefilled, aucun ne peut etre
 * vide". An arrow resolves measured (the brand's own leads) > manual (the brand stated it) > median (the
 * fleet's statements) > DEFAULT, and the default is what this file seeds: an industry benchmark per leg,
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
  // visitor, so the benchmark is not a site-wide average (~2-3%). Value: 0.5%, owner-stated 2026-10-03
  // (distribute.you fleet experience: a cold-email clicker signs up, fills a form or books a meeting at
  // about 0.5%). Upper reference: First Page Sage, "B2B SaaS Funnel Conversion Benchmarks" (2025-06-11,
  // https://firstpagesage.com/seo-blog/b2b-saas-funnel-conversion-benchmarks-fc/), EMAIL visitor-to-lead
  // 1.3%, the loosest conversion across all email (warm lists included), so a cold click sits below it.
  // The old 2% described the inbound visitor and ranked a visit→meeting path first.
  "website_visit>meeting_booked": 0.5,
  "website_visit>signup": 0.5,
  "website_visit>form_submitted": 0.5,
  "website_visit>purchase": 2,
  // A signup or a submitted form that becomes a paying client.
  "signup>paid_client": 10,
  "form_submitted>paid_client": 10,
  // A completed checkout IS a paying client, bar refunds and failed payments.
  "purchase>paid_client": 95,
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
