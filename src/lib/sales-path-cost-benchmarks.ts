/**
 * THE CATALOGUE COMBINATORY OF AN OFFER'S SALES PATHS — which channels it crosses, and the MARKET
 * BENCHMARK a (leg, channel) is priced on when nothing of ours measured it.
 *
 * Owner 2026-10-04: "Given the full list of potential channels, list the full combinatory in this
 * section Sales paths. Assume marketing benchmarks for the conversion rates and costs we miss." Then the
 * owner SHORTLISTED the channels below. This widens the 2026-09-29 "only the three we manage" rule for
 * the `?scope=catalogue` listing ONLY: the default read (what campaign-service funds, what onboarding
 * launches first) still crosses the managed channels alone (`MANAGED_CHANNEL_SLUGS`).
 *
 * To change the shortlist, edit `SALES_PATH_CATALOGUE_CHANNEL_SLUGS`; the guard in
 * `sales-path-cost-benchmarks.test.ts` then fails until every (non-managed channel, leg it publishes)
 * pair has a benchmark below.
 *
 * ── THE BENCHMARKS ────────────────────────────────────────────────────────────────────────────────
 *
 * Net USD per outcome of the leg's TO step, keyed `${legKey}|${channelSlug}` (`priceKey`). Each states
 * its source in words the dashboard can show. Every figure is taken at the EXPENSIVE end of what the
 * source reports (B2B / business services where the source splits it), never the flattering one, and a
 * derived figure says what it was derived from. They price a leg only when neither a workflow nor the
 * fleet's real spend does (`costSource: "benchmark"`).
 *
 * The customer's own team ("your-team-*") is priced on its TIME, so a path run by the customer's team
 * does not read as free beside one we run:
 *   SDR $31/h = SalesHive's fully loaded SDR at $250/day (8 h);
 *   AE  $75/h = a $150k fully loaded account executive over 2,000 h a year.
 */

/** The owner's shortlist (2026-10-04), slugs as served by `GET /public/channels`. No agency-* channel on purpose. */
export const SALES_PATH_CATALOGUE_CHANNEL_SLUGS: ReadonlySet<string> = new Set([
  // Entry
  "sales-cold-email-outreach",
  "cold-linkedin-outreach",
  "cold-call-outreach",
  "google-ads",
  "linkedin-ads",
  "meta-ads",
  "seo-content",
  // Middle / closing
  "ai-meeting-booking",
  "ai-instant-call",
  "your-team-meeting-booking",
  "your-team-meeting-attendance",
  "your-team-closing-calls",
  "your-team-signup-conversion",
]);

export interface SalesPathCostBenchmark {
  costPerOutcomeUsd: number;
  /** Where the figure comes from, in words a reader can check. */
  source: string;
}

const WORDSTREAM_GOOGLE = "WordStream, Google Ads Benchmarks 2025/2026 (https://www.wordstream.com/blog/2026-google-ads-benchmarks)";
const METADATA_LINKEDIN = "Metadata.io, What LinkedIn Ads Cost in 2025, 138 B2B advertisers (https://metadata.io/resources/blog/what-linkedin-ads-cost)";
const WORDSTREAM_META = "WordStream, Facebook Ads Benchmarks 2025 (https://www.wordstream.com/blog/facebook-ads-benchmarks-2025)";
const OVERLOOP_LINKEDIN = "Overloop, LinkedIn Outreach Benchmarks (https://overloop.com/blog/linkedin-outreach-benchmarks)";
const SALESHIVE_CALLS = "SalesHive, Cold Calling Benchmarks for B2B Sales Teams (https://saleshive.com/blog/b2b-sales-cold-calling-benchmarks-teams-2025)";
const FPS_SEO = "First Page Sage, B2B SaaS organic & SEO median cost per lead $164";

export const SALES_PATH_COST_BENCHMARKS: ReadonlyMap<string, SalesPathCostBenchmark> = new Map([
  // ── Google Ads: B2B & business services ──
  ["start_to_website_visit|google-ads", { costPerOutcomeUsd: 5.87, source: `B2B & business services cost per click $5.87 (highest of the 2025/2026 figures). ${WORDSTREAM_GOOGLE}` }],
  ["start_to_form_submitted|google-ads", { costPerOutcomeUsd: 105.64, source: `B2B & business services cost per lead $105.64 (highest of the 2025/2026 figures). ${WORDSTREAM_GOOGLE}` }],

  // ── LinkedIn Ads ──
  ["start_to_website_visit|linkedin-ads", { costPerOutcomeUsd: 9.39, source: `Average LinkedIn cost per click in 2025, $9.39. ${METADATA_LINKEDIN}` }],
  ["start_to_form_submitted|linkedin-ads", { costPerOutcomeUsd: 202, source: `Average LinkedIn cost per lead in 2025, $202. ${METADATA_LINKEDIN}` }],
  ["start_to_meeting_booked|linkedin-ads", { costPerOutcomeUsd: 808, source: `Derived: LinkedIn cost per lead $202 ÷ 25% of B2B leads booking a meeting (assumption). ${METADATA_LINKEDIN}` }],

  // ── Meta Ads ──
  ["start_to_website_visit|meta-ads", { costPerOutcomeUsd: 0.7, source: `Traffic campaigns, business services cost per click $0.70. ${WORDSTREAM_META}` }],
  ["start_to_form_submitted|meta-ads", { costPerOutcomeUsd: 27.66, source: `Lead campaigns, average cost per lead $27.66. ${WORDSTREAM_META}` }],
  ["start_to_meeting_booked|meta-ads", { costPerOutcomeUsd: 110.64, source: `Derived: Meta cost per lead $27.66 ÷ 25% of B2B leads booking a meeting (assumption). ${WORDSTREAM_META}` }],

  // ── SEO content: the published cost per lead, spread over visits at our own visit → form rate (0.5%),
  //    so a path reading visits back to leads lands on the published $164 ──
  ["start_to_website_visit|seo-content", { costPerOutcomeUsd: 0.82, source: `Derived: ${FPS_SEO} × 0.5% (our visit → form benchmark), so one lead still costs $164.` }],

  // ── Cold LinkedIn outreach: one sender's tools over what one sender produces ──
  ["start_to_conversation|cold-linkedin-outreach", { costPerOutcomeUsd: 30, source: `Derived: ~$180/month of tools per sender (Sales Navigator + a sending tool) over 440 requests × 28% accepted × 10.4% reply × 48% positive = ~6 positive replies, rounded up. ${OVERLOOP_LINKEDIN}` }],
  ["start_to_website_visit|cold-linkedin-outreach", { costPerOutcomeUsd: 14, source: `Derived: ~$180/month of tools per sender over 440 requests × 28% accepted × 10.4% clicking (click rate assumed equal to the reply rate) = ~13 visits. ${OVERLOOP_LINKEDIN}` }],

  // ── Cold calls: a fully loaded in-house SDR ──
  ["start_to_conversation|cold-call-outreach", { costPerOutcomeUsd: 250, source: `Derived: in-house SDR cost per booked meeting $821 (low end of $821-1,150) × 30% (our positive conversation → meeting benchmark), rounded up. ${SALESHIVE_CALLS}` }],

  // ── The customer's own team, priced on its time (SDR $31/h, AE $75/h, see above) ──
  ["conversation_to_meeting_booked|your-team-meeting-booking", { costPerOutcomeUsd: 16, source: `Derived: 30 min of SDR time per meeting booked off a reply at $31/h. ${SALESHIVE_CALLS}` }],
  ["website_visit_to_meeting_booked|your-team-meeting-booking", { costPerOutcomeUsd: 8, source: `Derived: 15 min of SDR time to qualify and confirm a meeting a visitor booked, at $31/h. ${SALESHIVE_CALLS}` }],
  ["meeting_booked_to_meeting_attended|your-team-meeting-attendance", { costPerOutcomeUsd: 10, source: `Derived: 15 min of SDR reminders per booked meeting at $31/h, over a 75% show-up rate. ${SALESHIVE_CALLS}` }],
  ["meeting_attended_to_paid_client|your-team-closing-calls", { costPerOutcomeUsd: 750, source: "Derived: 2 h of account executive time per held meeting (call + follow-up) at $75/h ($150k fully loaded over 2,000 h), over a 20% close rate." }],
  ["signup_to_paid_client|your-team-signup-conversion", { costPerOutcomeUsd: 155, source: `Derived: 30 min of SDR follow-up per signup at $31/h, over a 10% signup → paid rate. ${SALESHIVE_CALLS}` }],
  ["form_submitted_to_paid_client|your-team-signup-conversion", { costPerOutcomeUsd: 155, source: `Derived: 30 min of SDR follow-up per form at $31/h, over a 10% form → paid rate. ${SALESHIVE_CALLS}` }],
]);
