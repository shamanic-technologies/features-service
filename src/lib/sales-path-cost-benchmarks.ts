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
 * The customer's own team ("your-team-*") has NO benchmark: its legs carry a rate and cost nothing to
 * us, exactly as in the default read, so one combination reads ONE price in both scopes (requester
 * melbourne-v13, 2026-10-04: Victory read $770 ticked vs $1,560 catalogue). Pricing the team's time is
 * an open owner decision, and would move both scopes at once.
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
  // Owner 2026-10-07: "In Channels add a new 'Linkedin Posting' card, Contact us on GA, and activable on Staff mode." Not managed.
  "organic-linkedin-publishing",
  // seo-content: off the shortlist "for now" (owner 2026-10-04); its benchmark ($164/lead, First Page Sage) is in git history.
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
const METADATA_META = "Metadata.io, Meta Ads for B2B, $57.6M of 2025 spend (https://metadata.io/resources/blog/fb-ad-strategies)";
const OVERLOOP_LINKEDIN = "Overloop, LinkedIn Outreach Benchmarks (https://overloop.com/blog/linkedin-outreach-benchmarks)";
const VIRALBRAIN_GHOSTWRITING = "ViralBrain, LinkedIn Ghostwriting Pricing 2026 (https://www.viralbrain.ai/blog/linkedin-ghostwriting-pricing)";
const SOCIALINSIDER_LINKEDIN = "Socialinsider, 2025 LinkedIn Benchmarks (https://www.socialinsider.io/social-media-benchmarks/linkedin)";
const SALESHIVE_CALLS = "SalesHive, Cold Calling Benchmarks for B2B Sales Teams (https://saleshive.com/blog/b2b-sales-cold-calling-benchmarks-teams-2025)";

export const SALES_PATH_COST_BENCHMARKS: ReadonlyMap<string, SalesPathCostBenchmark> = new Map([
  // ── Google Ads: B2B & business services ──
  ["start_to_website_visit|google-ads", { costPerOutcomeUsd: 5.87, source: `B2B & business services cost per click $5.87 (highest of the 2025/2026 figures). ${WORDSTREAM_GOOGLE}` }],
  ["start_to_form_submitted|google-ads", { costPerOutcomeUsd: 105.64, source: `B2B & business services cost per lead $105.64 (highest of the 2025/2026 figures). ${WORDSTREAM_GOOGLE}` }],

  // ── LinkedIn Ads ──
  ["start_to_website_visit|linkedin-ads", { costPerOutcomeUsd: 9.39, source: `Average LinkedIn cost per click in 2025, $9.39. ${METADATA_LINKEDIN}` }],
  ["start_to_form_submitted|linkedin-ads", { costPerOutcomeUsd: 202, source: `Average LinkedIn cost per lead in 2025, $202. ${METADATA_LINKEDIN}` }],
  ["start_to_meeting_booked|linkedin-ads", { costPerOutcomeUsd: 808, source: `Derived: LinkedIn cost per lead $202 ÷ 25% of B2B leads booking a meeting (assumption). ${METADATA_LINKEDIN}` }],

  // ── Meta Ads ──
  // A LEAD-objective click, never a traffic-campaign one ($0.70 buys junk clicks), and the B2B cold-audience lead.
  ["start_to_website_visit|meta-ads", { costPerOutcomeUsd: 1.92, source: `Lead campaigns, average cost per click $1.92 (traffic-campaign clicks at $0.70 are not counted: they rarely convert). ${WORDSTREAM_META}` }],
  ["start_to_form_submitted|meta-ads", { costPerOutcomeUsd: 166, source: `B2B cost per lead on Facebook cold audiences, $166. ${METADATA_META}` }],
  ["start_to_meeting_booked|meta-ads", { costPerOutcomeUsd: 664, source: `Derived: B2B Facebook cost per lead $166 ÷ 25% of B2B leads booking a meeting (assumption). ${METADATA_META}` }],

  // ── Cold LinkedIn outreach: one sender's tools over what one sender produces ──
  ["start_to_conversation|cold-linkedin-outreach", { costPerOutcomeUsd: 30, source: `Derived: ~$180/month of tools per sender (Sales Navigator + a sending tool) over 440 requests × 28% accepted × 10.4% reply × 48% positive = ~6 positive replies, rounded up. ${OVERLOOP_LINKEDIN}` }],
  ["start_to_website_visit|cold-linkedin-outreach", { costPerOutcomeUsd: 14, source: `Derived: ~$180/month of tools per sender over 440 requests × 28% accepted × 10.4% clicking (click rate assumed equal to the reply rate) = ~13 visits. ${OVERLOOP_LINKEDIN}` }],

  // ── Organic LinkedIn posting ("LinkedIn Posting"): a mid-tier ghostwriter's retainer over what ~20 posts a month earn ──
  ["start_to_conversation|organic-linkedin-publishing", { costPerOutcomeUsd: 300, source: `Derived: mid-tier ghostwriter retainer $3,000/month (top of $2,000-4,000 for daily posts) over ~10 conversations opened by ~20 posts a month (assumption). ${VIRALBRAIN_GHOSTWRITING}` }],
  ["start_to_website_visit|organic-linkedin-publishing", { costPerOutcomeUsd: 15, source: `Derived: $3,000/month retainer over 20 posts × 1,000 impressions (low end of the 500-2,000 median) × 1% link clicks (below the 2-3% organic CTR) = 200 visits. ${VIRALBRAIN_GHOSTWRITING}; ${SOCIALINSIDER_LINKEDIN}` }],

  // ── Cold calls: a fully loaded in-house SDR ──
  ["start_to_conversation|cold-call-outreach", { costPerOutcomeUsd: 250, source: `Derived: in-house SDR cost per booked meeting $821 (low end of $821-1,150) × 30% (our positive conversation → meeting benchmark), rounded up. ${SALESHIVE_CALLS}` }],

]);
