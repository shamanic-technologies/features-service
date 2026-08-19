/**
 * Canonical feature definitions.
 * On cold start, these are upserted by slug into the DB.
 */

import { type SalesFunnelKey } from "../lib/sales-funnels.js";
import { sellableFunnelsFor, type AcquisitionChannel, type ProducibleStepKey } from "../lib/acquisition-channels.js";

/**
 * WHICH SALES FUNNELS A FEATURE MAY BE SOLD THROUGH — stated on EVERY feature, never omitted, and
 * DERIVED rather than typed out twice.
 *
 * The dashboard offers only valid (funnel, feature) pairs and campaign-service refuses to provision an
 * invalid one; both read the answer from here, because it is a product statement about the feature and
 * this service owns the feature catalogue. Hardcoding the matrix in each consumer was rejected — that
 * is how one product fact becomes four drifting copies.
 *
 * The one fact a feature STATES is its `acquisitionChannel`, and inside it, WHICH STEPS THE CHANNEL CAN
 * PRODUCE. A sales funnel states what step STARTS it, so which pairings are possible falls out of the
 * join (`sellableFunnelsFor`) instead of being a second list somebody keeps in sync. The keys are still
 * brand-service's; nothing here invents a funnel.
 *
 * "SELLS THROUGH NONE" AND "SELLS THROUGH ALL" ARE STILL DIFFERENT STATEMENTS, and both are still
 * written out — they are now written as what the channel can produce. A feature that is NOT an
 * acquisition channel at all (hiring, investor and accelerator outreach, outlet discovery, press-kit
 * generation, AI visibility) states `acquisitionChannel: null` and sells through nothing. A channel that
 * produces both a conversation and a website visit sells through all four chains. Nothing is left
 * unstated, so a consumer never has to decide what an absent answer means; the column's `[]` default
 * only ever covers a row this seed has not reached, and reads as the restrictive side.
 */
const CONVERSATION_AND_VISIT: readonly ProducibleStepKey[] = ["conversation", "website_visit"];
const CONVERSATION_ONLY: readonly ProducibleStepKey[] = ["conversation"];
const VISIT_ONLY: readonly ProducibleStepKey[] = ["website_visit"];
const VISIT_AND_IN_AD_FORM: readonly ProducibleStepKey[] = ["website_visit", "in_ad_form_submission"];
const VISIT_AND_IN_AD_STEPS: readonly ProducibleStepKey[] = [
  "website_visit",
  "in_ad_form_submission",
  "in_ad_booked_meeting",
];

/** Commercial terms, written the way they are set: a daily operating cost in whole cents, a minimum
 *  booking in days, and the promise on how long until the channel starts producing. */
const terms = (
  dailyOperatingCostCents: number,
  minimumCommitmentDays: number,
  maxDaysToFirstProduction: number,
): AcquisitionChannel["terms"] => ({ dailyOperatingCostCents, minimumCommitmentDays, maxDaysToFirstProduction });

/**
 * NO FREE-TEXT ICP INPUT ON A FEATURE WHOSE RECIPIENTS COME FROM THE AUDIENCE BANDIT.
 *
 * Audiences are first-class: they are saved entities owned by human-service, a campaign points at
 * them, and a bandit picks ONE audience per run. A free-text "who we target" field typed once on the
 * feature form therefore does not merely DUPLICATE the audience, it CONTRADICTS it: the run is
 * addressing the bandit-selected audience while the prompt carries a single static ICP describing a
 * different set of people.
 *
 * So the field is gone from every bandit-fed channel: sales, feedback request, VC, accelerators,
 * hiring. It is KEPT on the two features where it is not a duplicate of anything:
 *   - `ai-visibility-scoring` contacts nobody. Its `audienceProfile` frames the questions put to the
 *     LLMs from a realistic buyer's point of view; there is no audience entity and no lead in play.
 *   - `pr-cold-email-outreach` takes its recipients from journalists-service, not from the audience
 *     entity, so there is no second source of truth to contradict.
 *
 * Removing the input does NOT strip the corresponding key from brand extraction: the extracted brand
 * blob is assembled from field keys the workflow DAG asks brand-service for, independently of this
 * catalogue. The blast radius is the customer-facing form and its prefill, nothing else.
 * (Set 2026-08-19.)
 */
export interface SeedFeatureDef {
  slug: string;
  name: string;
  description: string;
  icon: string;
  implemented: boolean;
  displayOrder: number;
  status: string;
  /**
   * The acquisition channel this feature IS, or `null` said out loud when the feature is not one.
   * Carries the commercial terms a buyer needs before booking and the steps the channel can produce.
   */
  acquisitionChannel: AcquisitionChannel | null;
  /**
   * THE SLUG THAT REPLACED THIS ONE, or `null` said out loud when this slug is the current one.
   *
   * A retired slug is not deleted and not renamed — live campaigns, live budgets and the cost ledger
   * reference it, so the row and every authenticated read of it keep working exactly as before. The
   * one thing retirement changes is that the slug stops being PUBLISHED: the public catalogue skips
   * it, so the offering is listed once, under the spelling that is current. Stated on every row so a
   * missing answer can never be mistaken for a retirement nobody declared.
   */
  supersededBySlug: string | null;
  inputs: unknown[];
  outputs: unknown[];
  charts: unknown[];
  entities: unknown[];
}

export interface SeedFeature extends SeedFeatureDef {
  /** DERIVED from `acquisitionChannel.producibleSteps` — see the block above. Never hand-written. */
  salesFunnels: readonly SalesFunnelKey[];
}

const SEED_FEATURE_DEFS: SeedFeatureDef[] = [
  {
    slug: "sales-cold-email-outreach",
    name: "Sales Cold Email Outreach",
    description: "Find leads matching your ICP, generate personalized cold emails, and track engagement through the full outreach funnel.",
    icon: "envelope",
    implemented: true,
    displayOrder: 1,
    status: "active",
    acquisitionChannel: { family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT, terms: terms(800, 30, 14) },
    supersededBySlug: null,
    inputs: [
      // NO free-text ICP input. Recipients come from the AUDIENCE BANDIT (a saved human-service
      // audience picked per run), so a static ICP typed here would describe a different set of people
      // than the run is actually addressing — a contradiction, not a duplicate. See AUDIENCE_BANDIT_NOTE.
      { key: "targetOutcome", type: "text", label: "Target Outcome", extractKey: "callToAction", description: "The desired action from the recipient (book a call, sign up, reply, etc.). Should be a single, clear call-to-action. Examples: 'Book a 15-min demo call', 'Start a free trial', 'Schedule a discovery call'. The LLM uses this to craft the email CTA.", placeholder: "Book sales demos" },
      { key: "valueForTarget", type: "text", label: "Value for Target", extractKey: "valueProposition", description: "The core value proposition for the target audience — what they gain by engaging. Should be specific and quantified when possible. Examples: 'Cut infrastructure costs by 40%', 'Ship features 3x faster with our CI/CD platform'. The LLM uses this as the main selling point in the email body.", placeholder: "What do they gain from responding?" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "Time pressure to act — a deadline, event date, or expiring offer that motivates the recipient to respond quickly. Examples: 'Beta access closes Friday', 'Event is in 2 weeks', 'Pricing increases April 1st'. Leave empty if no urgency applies.", placeholder: "Limited-time offer ending March 1st" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "Limited availability that creates FOMO — spots, seats, inventory, or capacity constraints. Examples: 'Only 5 pilot slots left', 'Limited to 20 beta customers', 'First 50 sign-ups get lifetime pricing'. Leave empty if no scarcity applies.", placeholder: "Only 10 spots available" },
      { key: "riskReversal", type: "text", label: "Risk Reversal", extractKey: "riskReversal", description: "What reduces the perceived risk of responding — guarantees, free trials, or no-commitment offers. Examples: 'Free 14-day trial', '30-day money-back guarantee', 'No credit card required', 'Cancel anytime'. Helps overcome objections in the email.", placeholder: "Free trial, no commitment" },
      { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Trust signals that build credibility — customer count, notable logos, testimonials, awards, or metrics. Examples: 'Trusted by 500+ SaaS companies', 'Featured in TechCrunch', 'NPS score of 72'. The LLM uses this to add credibility to the outreach.", placeholder: "500+ companies already onboarded" },
    ],
    // DIS-114: ranked leaderboard (groupBy=workflow) surfaces the populated
    // recipients* family (email-gateway), mirroring pr-cold-email-outreach. The
    // leads*/companies* family is 0/null per-workflow until lead-service emits
    // byOutreachStatus(Companies) in the ranked aggregation (DIS-10, DIS-48).
    outputs: [
      { key: "emailsGenerated", displayOrder: 1 },
      { key: "recipientsContacted", displayOrder: 2 },
      { key: "recipientsSent", displayOrder: 3 },
      { key: "recipientsDelivered", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsRepliesPositive", displayOrder: 6 },
      { key: "recipientsRepliesNegative", displayOrder: 7 },
      { key: "recipientsRepliesNeutral", displayOrder: 8 },
      { key: "recipientOpenRate", displayOrder: 9 },
      { key: "recipientClickRate", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientOpenCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsDelivered" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  /**
   * SECOND ACQUISITION CHANNEL, SAME MEDIUM, DIFFERENT OFFER.
   *
   * A channel IS a feature slug in this fleet's vocabulary; there is no separate channel concept and
   * none is introduced here. This one sends cold email over the same infrastructure as
   * `sales-cold-email-outreach` and is measured by the same funnel, outputs, charts and entities — the
   * only thing that differs is what the email ASKS FOR. Instead of pitching, it asks a buyer for
   * feedback on the problem we solve, and the conversation it opens is what becomes the sales meeting.
   *
   * So it is sold through EXACTLY ONE chain: `sales_meetings_from_conversation`. The other three chains
   * buy their first step with a website CLICK, and a feedback request has no website step to sell.
   * That single-funnel restriction is the whole reason the per-feature answer exists.
   */
  {
    slug: "feedback-request-cold-email-outreach",
    name: "Sales Feedback Request Cold Email Outreach",
    description: "Ask buyers for feedback on the problem you solve instead of pitching them, then turn the replies into sales meetings. Same cold email sending, tracked through the same funnel.",
    icon: "message-square",
    implemented: true,
    displayOrder: 12,
    status: "active",
    acquisitionChannel: { family: "outbound_one_to_one", producibleSteps: CONVERSATION_ONLY, terms: terms(800, 30, 14) },
    supersededBySlug: null,
    // THE OFFER HAS TWO HALVES, AND THE CUSTOMER STATES BOTH.
    //
    // This channel does not pitch. It gives something away (a gift) and asks for feedback in return,
    // so Hormozi's value equation runs on BOTH sides at once: the prospect pays in EFFORT rather than
    // money, which makes the FORM OF FEEDBACK the price tag of the offer rather than a config detail.
    // A public video testimonial and a Google Maps rating are wildly different prices.
    //
    //     (value of the GIFT) x (credibility they will actually get it)
    //     -------------------------------------------------------------
    //     (delay before they get it) x (effort of the FEEDBACK asked)
    //
    // Hence exactly eight inputs: the two halves of the offer (gift, its anchored value), its price
    // (form of feedback, effort asked), and the four persuasion levers. There is no target-audience
    // field (the audience bandit owns that, see AUDIENCE_BANDIT_NOTE above), and no problem-to-validate
    // or target-outcome field: the gift and its value already say what is on the table and what the
    // relationship becomes afterwards.
    //
    // `feedbackForm` would ideally be a multiple choice. It is deliberately plain text whose
    // placeholder enumerates the options: no new input TYPE is introduced in this iteration, and a
    // select/multi-select must not be added for it.
    inputs: [
      { key: "gift", type: "text", label: "The Gift", extractKey: "gift", description: "What the recipient gets, before they give anything back. This offer leads with a gift instead of a pitch: a free trial, the product at cost, a service done for them, or early access. Examples: '3 months on the full plan, free', 'We run the migration for you at no cost', 'Early access to the beta'. The LLM opens the email with this.", placeholder: "3 months on the full plan, free" },
      { key: "giftValue", type: "text", label: "Value of the Gift", extractKey: "giftValue", description: "What the gift normally costs, and what the relationship becomes once the feedback is given. Free is worth nothing without a price next to it, so anchor it. Examples: 'Normally 200 EUR per month, and they keep the workspace afterwards', 'A 2,000 EUR audit, yours at no charge, then a normal paid engagement if it helps'. The LLM uses this to make the offer concrete.", placeholder: "Normally 200 EUR per month" },
      { key: "feedbackForm", type: "text", label: "Form of Feedback", extractKey: "feedbackForm", description: "What they give back. This is the price of the offer, so name the exact form: a written testimonial (private or public), a video testimonial (private or public), a call, or a review on a public platform such as G2, Google Maps, Trustpilot or Capterra. A public video costs the recipient far more than a private note, and the email has to ask for one specific thing.", placeholder: "Written or video testimonial (private or public), a call, or a public review on G2, Google Maps, Trustpilot, Capterra" },
      { key: "feedbackEffort", type: "text", label: "Effort Asked", extractKey: "feedbackEffort", description: "How much of their time it takes, stated concretely so the price feels small and knowable. Examples: '15 minutes on a video call', 'Three questions in writing', 'A 60-second video'. The LLM uses this to size the ask in the email.", placeholder: "15 minutes on a video call" },
      { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Trust signals that make the offer credible: who already took it, customer count, notable logos, or published results. Examples: 'Already running with 40 heads of RevOps', 'Trusted by 500+ SaaS companies'. The LLM uses this to establish standing before offering.", placeholder: "40 testers already onboard" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "How few tester seats there are. This offer is naturally scarce: giving the product away costs you something, so the number of people who can take it is limited, and saying the number makes the gift feel earned. Examples: 'Only 10 tester seats', '5 free audits this quarter'. Leave empty if no scarcity applies.", placeholder: "Only 10 tester seats" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "The deadline or closing cohort that makes replying this week better than replying next month. Examples: 'Tester cohort closes Friday', 'Free access ends March 1st'. Leave empty if no urgency applies.", placeholder: "Tester cohort closes Friday" },
      { key: "riskReversal", type: "text", label: "Risk Reversal", extractKey: "riskReversal", description: "What removes the catch. A gift invites suspicion, so say plainly what the recipient is not signing up for. Examples: 'No commitment, no credit card', 'Cancel any time, we delete the data on request', 'No sales call unless they ask for one'. The LLM uses this to answer the unspoken objection.", placeholder: "No commitment, no credit card" },
    ],
    // Byte-identical measurement to sales-cold-email-outreach: same medium, same recipients* family
    // from email-gateway, same ranked leaderboard. The offer changed, not what is counted.
    outputs: [
      { key: "emailsGenerated", displayOrder: 1 },
      { key: "recipientsContacted", displayOrder: 2 },
      { key: "recipientsSent", displayOrder: 3 },
      { key: "recipientsDelivered", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsRepliesPositive", displayOrder: 6 },
      { key: "recipientsRepliesNegative", displayOrder: 7 },
      { key: "recipientsRepliesNeutral", displayOrder: 8 },
      { key: "recipientOpenRate", displayOrder: 9 },
      { key: "recipientClickRate", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientOpenCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsDelivered" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  {
    slug: "sales-crm-email-outreach",
    name: "Sales CRM Email Outreach",
    description: "Find leads matching your ICP, generate personalized CRM-driven sales emails, and track engagement through the full outreach funnel.",
    icon: "contact",
    implemented: true,
    displayOrder: 11,
    status: "active",
    acquisitionChannel: { family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT, terms: terms(800, 30, 7) },
    supersededBySlug: null,
    inputs: [
      { key: "targetAudience", type: "text", label: "Target Audience", extractKey: "targetAudience", description: "Who the campaign targets — ICP description (role, company size, industry). Be precise about job titles, industry vertical, company size range, and geography. Example: 'VP of Marketing at B2B SaaS companies with 50-200 employees in the US'. The LLM uses this to find matching leads and personalize outreach.", placeholder: "CTOs at SaaS startups with 10-50 employees" },
      { key: "targetOutcome", type: "text", label: "Target Outcome", extractKey: "callToAction", description: "The desired action from the recipient (book a call, sign up, reply, etc.). Should be a single, clear call-to-action. Examples: 'Book a 15-min demo call', 'Start a free trial', 'Schedule a discovery call'. The LLM uses this to craft the email CTA.", placeholder: "Book sales demos" },
      { key: "valueForTarget", type: "text", label: "Value for Target", extractKey: "valueProposition", description: "The core value proposition for the target audience — what they gain by engaging. Should be specific and quantified when possible. Examples: 'Cut infrastructure costs by 40%', 'Ship features 3x faster with our CI/CD platform'. The LLM uses this as the main selling point in the email body.", placeholder: "What do they gain from responding?" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "Time pressure to act — a deadline, event date, or expiring offer that motivates the recipient to respond quickly. Examples: 'Beta access closes Friday', 'Event is in 2 weeks', 'Pricing increases April 1st'. Leave empty if no urgency applies.", placeholder: "Limited-time offer ending March 1st" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "Limited availability that creates FOMO — spots, seats, inventory, or capacity constraints. Examples: 'Only 5 pilot slots left', 'Limited to 20 beta customers', 'First 50 sign-ups get lifetime pricing'. Leave empty if no scarcity applies.", placeholder: "Only 10 spots available" },
      { key: "riskReversal", type: "text", label: "Risk Reversal", extractKey: "riskReversal", description: "What reduces the perceived risk of responding — guarantees, free trials, or no-commitment offers. Examples: 'Free 14-day trial', '30-day money-back guarantee', 'No credit card required', 'Cancel anytime'. Helps overcome objections in the email.", placeholder: "Free trial, no commitment" },
      { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Trust signals that build credibility — customer count, notable logos, testimonials, awards, or metrics. Examples: 'Trusted by 500+ SaaS companies', 'Featured in TechCrunch', 'NPS score of 72'. The LLM uses this to add credibility to the outreach.", placeholder: "500+ companies already onboarded" },
    ],
    // Mirrors sales-cold-email-outreach: ranked leaderboard (groupBy=workflow)
    // surfaces the populated recipients* family (email-gateway). The
    // leads*/companies* family is 0/null per-workflow until lead-service emits
    // byOutreachStatus(Companies) in the ranked aggregation (DIS-10, DIS-48).
    outputs: [
      { key: "emailsGenerated", displayOrder: 1 },
      { key: "recipientsContacted", displayOrder: 2 },
      { key: "recipientsSent", displayOrder: 3 },
      { key: "recipientsDelivered", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsRepliesPositive", displayOrder: 6 },
      { key: "recipientsRepliesNegative", displayOrder: 7 },
      { key: "recipientsRepliesNeutral", displayOrder: 8 },
      { key: "recipientOpenRate", displayOrder: 9 },
      { key: "recipientClickRate", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientOpenCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsDelivered" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  {
    slug: "pr-cold-email-outreach",
    name: "PR Cold Email Outreach",
    description: "Find relevant journalists, generate personalized pitch emails, and track engagement through the full PR outreach funnel.",
    icon: "megaphone",
    implemented: true,
    displayOrder: 2,
    status: "active",
    acquisitionChannel: { family: "earned", producibleSteps: VISIT_ONLY, terms: terms(800, 30, 21) },
    supersededBySlug: null,
    inputs: [
      { key: "targetOutlets", type: "text", label: "Target Outlets", extractKey: "targetOutlets", description: "Types of media outlets or specific publications to target. Be specific about outlet tier, beat, and format (online, print, podcast). Examples: 'Top-tier tech blogs (TechCrunch, The Verge)', 'B2B SaaS trade publications', 'Fintech newsletters with 10k+ subscribers'. The LLM uses this to find and prioritize matching journalists.", placeholder: "TechCrunch, Forbes, industry trade publications..." },
      { key: "prAngle", type: "text", label: "PR Angle", extractKey: "suggestedAngles", description: "The editorial hook or story angle to pitch. Should be newsworthy and specific. Examples: 'Series B funding of $25M led by Sequoia', 'Launch of AI-powered compliance platform', 'Industry report on developer productivity trends'. The LLM uses this as the core pitch in the outreach email.", placeholder: "Series B funding announcement, product launch..." },
      { key: "companyContext", type: "text", label: "Company Context", extractKey: "companyDescription", description: "Brief background on the company and why this story matters now. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers, fastest-growing in category', 'Only platform certified for EU AI Act compliance'. Gives the LLM credibility context for the pitch.", placeholder: "What does your company do and why is this relevant now?" },
      { key: "newsHook", type: "text", label: "News Hook", extractKey: "newsHook", description: "A timely event, trend, or news cycle that makes the pitch relevant right now. Examples: 'Ahead of CES 2026 announcement', 'Following new SEC crypto regulations', 'During cybersecurity awareness month'. Helps the LLM frame the pitch as timely and urgent for editors.", placeholder: "Ties into upcoming regulation changes, industry event..." },
      { key: "spokesperson", type: "text", label: "Spokesperson", extractKey: "spokesperson", description: "Who is available for interviews or quotes. Include name, title, and any notable credentials. Examples: 'John Smith, CTO — ex-Google, published AI researcher', 'Sarah Chen, CEO — Forbes 30 Under 30'. The LLM includes this as a resource offer in the pitch.", placeholder: "Jane Doe, CEO, available for interviews" },
    ],
    outputs: [
      { key: "outletsDiscovered", displayOrder: 1 },
      { key: "emailsGenerated", displayOrder: 2 },
      { key: "journalistsContacted", displayOrder: 3 },
      { key: "recipientsSent", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientOpenRate", displayOrder: 6 },
      { key: "recipientClickRate", displayOrder: 7 },
      { key: "costPerRecipientOpenCents", displayOrder: 8 },
      { key: "recipientsRepliesPositive", displayOrder: 9 },
      { key: "recipientsRepliesNegative", displayOrder: 10 },
      { key: "recipientsRepliesNeutral", displayOrder: 11 },
      { key: "recipientPositiveReplyRate", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Outreach Funnel", displayOrder: 1, steps: [{ key: "outletsDiscovered" }, { key: "emailsGenerated" }, { key: "journalistsContacted" }, { key: "recipientsSent" }, { key: "recipientsOpened" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "outlets", countKey: "outletsDiscovered" },
      { name: "journalists", countKey: "journalistsContacted" },
      { name: "emails", countKey: "emailsGenerated" },
      { name: "articles" },
    ],
  },

  {
    slug: "hiring-cold-email-outreach",
    name: "Hiring Cold Email Outreach",
    description: "Find candidates matching your profile, generate personalized recruiting emails, and track engagement through the full hiring outreach funnel.",
    icon: "user-plus",
    implemented: true,
    displayOrder: 3,
    status: "active",
    acquisitionChannel: null,
    supersededBySlug: null,
    inputs: [
      // No candidate-profile input: recipients come from the audience bandit (AUDIENCE_BANDIT_NOTE).
      { key: "targetOutcome", type: "text", label: "Target Outcome", extractKey: "target_outcome", description: "The desired action from the candidate — should be a single, clear call-to-action. Examples: 'Book a 30-min intro call', 'Apply to the role', 'Schedule a discovery conversation'.", placeholder: "e.g. Book a 30-min intro call" },
      { key: "roleValueProp", type: "textarea", label: "Role Value Proposition", extractKey: "role_value_prop", description: "What makes the role and company attractive to the candidate — compensation, mission, growth, tech stack, remote policy, team culture. The LLM uses this as the main selling point.", placeholder: "e.g. Competitive comp, fully remote, Series B-backed, working on cutting-edge ML infrastructure" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "Time pressure to act — a start date, hiring deadline, or closing window. Examples: 'Team onboarding in 6 weeks', 'Role closes Friday'. Leave empty if no urgency applies.", placeholder: "e.g. Role closes end of month, team starts Q3" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "Limited availability that creates FOMO — single position, small team, exclusive role. Examples: 'Only 1 opening', 'Founding engineer role — not publicly listed'. Leave empty if not applicable.", placeholder: "e.g. Only 1 seat open, small team of 4 engineers" },
      { key: "riskReversal", type: "text", label: "Risk Reversal", extractKey: "risk_reversal", description: "What reduces friction in responding — no commitment, confidential process, casual first chat. Examples: 'Just a conversation, no strings attached', 'Fully confidential process'. Helps overcome hesitation.", placeholder: "e.g. Just a conversation, no commitment required" },
      { key: "socialProof", type: "textarea", label: "Social Proof", extractKey: "social_proof", description: "Trust signals that build credibility — Glassdoor score, funding, press, notable team pedigree, culture awards. The LLM uses this to add credibility to the outreach.", placeholder: "e.g. 4.8 Glassdoor rating, $40M Series B, backed by a16z, team ex-Google/Stripe" },
    ],
    // DIS-114: ranked leaderboard (groupBy=workflow) surfaces the populated
    // recipients* family (email-gateway), mirroring pr-cold-email-outreach. The
    // leads*/companies* family is 0/null per-workflow until lead-service emits
    // byOutreachStatus(Companies) in the ranked aggregation (DIS-10, DIS-48).
    outputs: [
      { key: "emailsGenerated", displayOrder: 1 },
      { key: "recipientsContacted", displayOrder: 2 },
      { key: "recipientsSent", displayOrder: 3 },
      { key: "recipientsDelivered", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsRepliesPositive", displayOrder: 6 },
      { key: "recipientsRepliesNegative", displayOrder: 7 },
      { key: "recipientsRepliesNeutral", displayOrder: 8 },
      { key: "recipientOpenRate", displayOrder: 9 },
      { key: "recipientClickRate", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientOpenCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsDelivered" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  {
    slug: "outlet-database-discovery",
    name: "Outlet Database Discovery",
    description: "Discover relevant media outlets for your industry, geography, and PR angles using AI-powered search.",
    icon: "globe",
    implemented: true,
    displayOrder: 4,
    status: "active",
    acquisitionChannel: null,
    supersededBySlug: null,
    inputs: [
      { key: "industry", type: "text", label: "Industry", extractKey: "industry", description: "The industry vertical to target for discovery. Be specific — this drives which media outlets are searched. Examples: 'Enterprise cybersecurity', 'Consumer fintech', 'Climate tech / clean energy'. The discovery engine uses this to generate targeted search queries.", placeholder: "SaaS, AI, Fintech, Healthcare..." },
      { key: "angles", type: "text", label: "PR Angles", extractKey: "suggestedAngles", description: "Story hooks or editorial angles the outreach should pitch. Comma-separated. Examples: 'Series B funding announcement', 'New product launch for SMBs', 'Thought leadership on AI regulation'. Helps match outlets that cover these topics.", placeholder: "Fundraising announcement, product launch, thought leadership..." },
      { key: "targetGeo", type: "text", label: "Geographic Focus", extractKey: "suggestedGeo", description: "Geographic scope for finding targets — countries, regions, or cities. Examples: 'US and UK', 'DACH region', 'San Francisco Bay Area'. Determines whether to search local, national, or international outlets.", placeholder: "US, Europe, Global..." },
    ],
    outputs: [
      { key: "outletsDiscovered", displayOrder: 1 },
      { key: "avgRelevanceScore", displayOrder: 2 },
      { key: "searchQueriesUsed", displayOrder: 3 },
      { key: "costPerOutletCents", defaultSort: true, displayOrder: 4, sortDirection: "asc" },
    ],
    charts: [
      { key: "discoveryFunnel", type: "funnel-bar", title: "Discovery Funnel", displayOrder: 1, steps: [{ key: "searchQueriesUsed" }, { key: "outletsDiscovered" }] },
      { key: "qualityBreakdown", type: "breakdown-bar", title: "Relevance Breakdown", displayOrder: 2, segments: [{ key: "outletsDiscovered", color: "green", sentiment: "positive" }, { key: "searchQueriesUsed", color: "blue", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "outlets", countKey: "outletsDiscovered" },
    ],
  },

  {
    slug: "press-kit-page-generation",
    name: "Press Kit Page Generation",
    description: "Generate professional press kit pages with company info, media assets, and PR materials for journalist access.",
    icon: "file-text",
    implemented: true,
    displayOrder: 5,
    status: "active",
    acquisitionChannel: null,
    supersededBySlug: null,
    inputs: [
      { key: "prAngle", type: "text", label: "PR Angle", extractKey: "suggestedAngles", description: "The editorial hook or story angle for the press kit. Should be newsworthy and specific. Examples: 'Series B funding of $25M led by Sequoia', 'Launch of AI-powered compliance platform'. The LLM uses this as the core narrative for the press kit.", placeholder: "Series B funding announcement, product launch..." },
      { key: "companyContext", type: "text", label: "Company Context", extractKey: "companyDescription", description: "Brief background on the company. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers', 'Only platform certified for EU AI Act compliance'. Gives the LLM credibility context for the press kit content.", placeholder: "What does your company do and why is this relevant now?" },
      { key: "spokesperson", type: "text", label: "Spokesperson", extractKey: "spokesperson", description: "Who is available for interviews or quotes. Include name, title, and any notable credentials. Examples: 'John Smith, CTO — ex-Google, published AI researcher'. The LLM includes this in the press kit's contact section.", placeholder: "Jane Doe, CEO, available for interviews" },
    ],
    outputs: [
      { key: "pressKitsGenerated", displayOrder: 1 },
      { key: "pressKitViews", displayOrder: 2 },
      { key: "pressKitUniqueVisitors", displayOrder: 3 },
      { key: "costPerPressKitCents", defaultSort: true, displayOrder: 4, sortDirection: "asc" },
      { key: "costPerPressKitViewCents", displayOrder: 5 },
    ],
    charts: [
      { key: "pressKitFunnel", type: "funnel-bar", title: "Press Kit Funnel", displayOrder: 1, steps: [{ key: "pressKitsGenerated" }, { key: "pressKitViews" }, { key: "pressKitUniqueVisitors" }] },
      { key: "viewsBreakdown", type: "breakdown-bar", title: "Views Breakdown", displayOrder: 2, segments: [{ key: "pressKitViews", color: "blue", sentiment: "neutral" }, { key: "pressKitUniqueVisitors", color: "green", sentiment: "positive" }] },
    ],
    entities: [
      { name: "press-kits", countKey: "pressKitsGenerated" },
    ],
  },

  {
    slug: "pr-expert-quote-outreach",
    name: "PR Expert Quote Outreach",
    description: "Automatically respond to journalist quote requests on Featured.com to earn editorial backlinks.",
    icon: "award",
    implemented: true,
    displayOrder: 6,
    status: "active",
    acquisitionChannel: { family: "earned", producibleSteps: VISIT_ONLY, terms: terms(800, 30, 21) },
    supersededBySlug: null,
    inputs: [
      { key: "expertName", type: "text", label: "Expert Name", extractKey: "spokespersonName", description: "Full name of the brand's primary public spokesperson — the founder, CEO, or designated expert who will be quoted. Auto-extracted from the brand's site (about / team / leadership pages); edit if the wrong person is picked. Featured.com journalists attribute the published quote to this name verbatim.", placeholder: "Jane Doe" },
      { key: "expertTitle", type: "text", label: "Title / Role", extractKey: "spokespersonTitle", description: "Job title or role of the spokesperson at the company (e.g. 'CEO', 'CTO', 'Head of Research'). Printed next to the quote to establish authority. Auto-extracted from the brand's about / team page.", placeholder: "CEO" },
      { key: "expertPhotoUrl", type: "text", label: "Headshot URL", extractKey: "spokespersonHeadshotUrl", description: "Direct URL to the spokesperson's professional headshot photo. Many outlets publish the photo alongside the quote. Auto-extracted from the brand's team / about page when available — otherwise paste a link to a high-resolution headshot.", placeholder: "https://…/headshot.jpg" },
      { key: "expertLinkedIn", type: "text", label: "LinkedIn URL", extractKey: "spokespersonLinkedinUrl", description: "URL of the spokesperson's personal LinkedIn profile. Journalists use it to verify the expert's identity and credentials before quoting. Auto-extracted from the brand's site when linked — otherwise paste the profile URL.", placeholder: "https://www.linkedin.com/in/janedoe" },
    ],
    outputs: [
      { key: "quoteRequestsFound", displayOrder: 1 },
      { key: "quotePitchesSubmitted", displayOrder: 2 },
      { key: "quotesSelected", displayOrder: 3 },
      { key: "quotesPublished", displayOrder: 4 },
      { key: "pitchSelectionRate", displayOrder: 5 },
      { key: "pitchPublishRate", displayOrder: 6 },
      { key: "costPerQuotePublishedCents", defaultSort: true, displayOrder: 7, sortDirection: "asc" },
    ],
    charts: [
      { key: "quoteFunnel", type: "funnel-bar", title: "Quote Pitch Funnel", displayOrder: 1, steps: [{ key: "quoteRequestsFound" }, { key: "quotePitchesSubmitted" }, { key: "quotesSelected" }, { key: "quotesPublished" }] },
      { key: "pitchOutcomes", type: "breakdown-bar", title: "Pitch Outcomes", displayOrder: 2, segments: [{ key: "quotesPublished", color: "green", sentiment: "positive" }, { key: "quotesSelected", color: "blue", sentiment: "neutral" }, { key: "quotesNotSelected", color: "red", sentiment: "negative" }] },
    ],
    entities: [
      { name: "quote-requests", countKey: "quoteRequestsFound" },
      { name: "quote-pitches", countKey: "quotePitchesSubmitted" },
    ],
  },

  {
    slug: "ai-visibility-scoring",
    name: "AI Visibility Scoring",
    description: "Audit how your brand appears in answers from ChatGPT, Claude, Perplexity, and Gemini. Track mention rate, ranking, and share-of-voice against competitors across a curated prompt set.",
    icon: "sparkles",
    implemented: true,
    displayOrder: 7,
    status: "active",
    acquisitionChannel: null,
    supersededBySlug: null,
    inputs: [
      { key: "brandName", type: "text", label: "Brand Name", extractKey: "brandName", description: "The brand or company name to audit. Used as the primary entity to detect in LLM answers. Examples: 'Stripe', 'Linear', 'Vercel'. Detection is exact-match plus close variants (case-insensitive, common suffix stripping).", placeholder: "Stripe" },
      { key: "competitors", type: "textarea", label: "Competitors", extractKey: "competitors", description: "Competitor brands to score against. Comma- or newline-separated. Used to compute share-of-voice and ranking comparisons. Examples: 'Adyen, Checkout.com, Braintree'. Aim for 3-7 direct competitors for meaningful share-of-voice metrics.", placeholder: "Adyen, Checkout.com, Braintree" },
      { key: "topics", type: "textarea", label: "Topics", extractKey: "topics", description: "Topic areas where the brand wants to be visible. Comma- or newline-separated. Drives the prompt set used for the audit. Examples: 'developer-friendly payment APIs, subscription billing, fraud prevention'. The more specific, the more targeted the audit.", placeholder: "developer-friendly payment APIs, subscription billing, fraud prevention" },
      { key: "targetGeo", type: "text", label: "Geographic Focus", extractKey: "suggestedGeo", description: "Geographic scope for the audit — countries, regions, or cities. Some prompts are geo-specific. Examples: 'US', 'EU', 'UK and Ireland', 'Global'. Leave empty for global.", placeholder: "US, Europe, Global..." },
      { key: "audienceProfile", type: "textarea", label: "Audience Profile", extractKey: "targetAudience", description: "Who is asking these LLM questions — the buyer persona. Used to frame prompts from a realistic user perspective. Examples: 'CTOs at Series A SaaS startups', 'Marketing leads at e-commerce brands doing $5M-$50M GMV'. Helps surface prompts your real buyers ask.", placeholder: "CTOs at Series A SaaS startups" },
    ],
    outputs: [
      { key: "visibilityScore", defaultSort: true, displayOrder: 1, sortDirection: "desc" },
      { key: "shareOfVoice", displayOrder: 2 },
      { key: "brandMentionRate", displayOrder: 3 },
      { key: "citationRate", displayOrder: 4 },
      { key: "netSentiment", displayOrder: 5 },
      { key: "avgPosition", displayOrder: 6, sortDirection: "asc" },
    ],
    charts: [
      {
        key: "visibilityOverTime",
        type: "line-chart",
        title: "Visibility Over Time",
        displayOrder: 1,
        xAxis: "completedAt",
        series: [
          { key: "visibilityScore" },
          { key: "shareOfVoice" },
          { key: "brandMentionRate" },
          { key: "citationRate" },
        ],
      },
    ],
    entities: [
      { name: "visibility-runs" },
      { name: "prompts" },
      { name: "competitors" },
    ],
  },

  {
    slug: "vc-cold-email-outreach",
    name: "VC Cold Email Outreach",
    description: "Find VC partners matching your fundraising stage and thesis, generate personalized outreach emails, and track engagement through the full investor pipeline.",
    icon: "trending-up",
    implemented: true,
    displayOrder: 8,
    status: "active",
    acquisitionChannel: null,
    supersededBySlug: null,
    inputs: [
      // No investor-profile input: recipients come from the audience bandit (AUDIENCE_BANDIT_NOTE).
      { key: "fundingAsk", type: "text", label: "Funding Ask", extractKey: "fundingAsk", description: "Round size, instrument, and headline terms. Should be specific and clear. Examples: 'Raising $3M seed on SAFE post-money cap $25M', 'Series A $10M priced round, 20% allocation for lead'. The LLM uses this as the core ask in the email body.", placeholder: "Raising $3M seed on SAFE, $25M post-money cap" },
      { key: "traction", type: "text", label: "Traction", extractKey: "traction", description: "Key metrics that prove momentum — revenue, growth rate, customers, retention, key logos. Be quantified and recent. Examples: '$1.2M ARR, 18% MoM growth, 120 paying customers, 95% logo retention', '50k WAU, 30% MoM growth'. The LLM leads with this to grab investor attention.", placeholder: "$1.2M ARR, 18% MoM growth, 120 paying customers" },
      { key: "valueForVC", type: "text", label: "Value for Investor", extractKey: "valueProposition", description: "Why this is a strong deal for the VC — market size, moat, returns potential, fit with their thesis. Examples: '$50B TAM, network-effects moat, fits your dev-tools thesis', 'Category-defining company in a market growing 40% YoY'. The LLM uses this to frame the investment opportunity.", placeholder: "$50B TAM, network-effects moat, fits your thesis" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "Time pressure on the round — lead commitment, closing date, demo day. Examples: 'Lead committed, closing in 3 weeks', 'Round closes end of Q2', 'Demo Day in 2 weeks'. Leave empty if no urgency applies.", placeholder: "Lead committed, closing in 3 weeks" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "Limited round allocation that creates FOMO — remaining ticket space, oversubscription signal, capped allocation. Examples: '$500k allocation remaining', 'Round 70% subscribed', 'Only 2 institutional slots left'. Leave empty if not applicable.", placeholder: "$500k allocation remaining, round 70% subscribed" },
      { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Existing investors, advisors, and notable customers that build credibility. Examples: 'Backed by Sequoia Scout, advised by ex-Stripe CFO, customers include Notion and Vercel', 'YC W24, $500k from angels including Naval and Calvin'. The LLM uses this for credibility in the pitch.", placeholder: "Backed by YC + Sequoia Scout, advisors ex-Stripe" },
      { key: "founderContext", type: "text", label: "Founder Context", extractKey: "founderContext", description: "Founder background, prior exits, domain expertise, why this team. Should establish founder-market fit. Examples: 'CEO ex-Stripe payments lead, CTO published Anthropic researcher, 2nd-time founders with prior $80M exit', 'Domain expert with 12 years in healthcare ops, repeat founder'. The LLM uses this to humanize the pitch.", placeholder: "Repeat founder, ex-Stripe payments lead, prior $80M exit" },
    ],
    // DIS-114: ranked leaderboard (groupBy=workflow) surfaces the populated
    // recipients* family (email-gateway), mirroring pr-cold-email-outreach. The
    // leads*/companies* family is 0/null per-workflow until lead-service emits
    // byOutreachStatus(Companies) in the ranked aggregation (DIS-10, DIS-48).
    outputs: [
      { key: "emailsGenerated", displayOrder: 1 },
      { key: "recipientsContacted", displayOrder: 2 },
      { key: "recipientsSent", displayOrder: 3 },
      { key: "recipientsDelivered", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsRepliesPositive", displayOrder: 6 },
      { key: "recipientsRepliesNegative", displayOrder: 7 },
      { key: "recipientsRepliesNeutral", displayOrder: 8 },
      { key: "recipientOpenRate", displayOrder: 9 },
      { key: "recipientClickRate", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientOpenCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsDelivered" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  {
    slug: "accelerators-cold-email-outreach",
    name: "Accelerators Cold Email Outreach",
    description: "Find startup accelerators matching your stage and sector, generate personalized outreach emails to assess program fit, and track engagement to decide which programs are worth applying to.",
    icon: "rocket",
    implemented: true,
    displayOrder: 9,
    status: "active",
    acquisitionChannel: null,
    supersededBySlug: null,
    inputs: [
      // No accelerator-profile input: recipients come from the audience bandit (AUDIENCE_BANDIT_NOTE).
      { key: "programAsk", type: "text", label: "Program Ask", extractKey: "programAsk", description: "What you want from the accelerator and which batch/cohort you're targeting. Should be specific. Examples: 'Applying to W26 batch, seeking $500k + mentorship + network', 'Rolling admission, looking for sector-specific mentors and US market entry support'. The LLM uses this as the core ask in the email body.", placeholder: "Applying to W26 batch, seeking $500k + mentor network" },
      { key: "traction", type: "text", label: "Traction", extractKey: "traction", description: "Key metrics that prove momentum — revenue, growth rate, customers, retention, key logos. Be quantified and recent. Examples: '$1.2M ARR, 18% MoM growth, 120 paying customers, 95% logo retention', '50k WAU, 30% MoM growth'. The LLM leads with this to demonstrate readiness for the program.", placeholder: "$1.2M ARR, 18% MoM growth, 120 paying customers" },
      { key: "valueForAccelerator", type: "text", label: "Value for Accelerator", extractKey: "valueProposition", description: "Why this startup is a strong fit for THEIR cohort/portfolio — sector match, returns potential, alumni network synergy, demo day appeal. Examples: '$50B TAM, fits your AI infra thesis, will headline demo day', 'Strong fit with your fintech vertical and 2024 cohort theme'. The LLM uses this to frame why the accelerator should care.", placeholder: "$50B TAM, fits your AI infra thesis, demo-day-ready" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "Time pressure on the application — batch deadline, decision timeline, alternative offers. Examples: 'W26 application closes in 2 weeks', 'Have competing offer from another program, deciding by Friday'. Leave empty if no urgency applies.", placeholder: "W26 application closes in 2 weeks" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "Differentiation signals that create FOMO — limited applicant slots from your sector, unusual founder profile, exclusive deal access. Examples: 'Only B2B AI infra applicant from EU this batch', 'Already have term sheet from top-tier VC'. Leave empty if not applicable.", placeholder: "Already have lead investor lined up" },
      { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Existing investors, advisors, alumni connections, and notable customers that build credibility. Examples: 'Backed by Sequoia Scout, advised by ex-Stripe CFO, customers include Notion and Vercel', '2 YC alum advisors, $500k from angels including Naval'. The LLM uses this for credibility.", placeholder: "Backed by Sequoia Scout, advisors include YC alums" },
      { key: "founderContext", type: "text", label: "Founder Context", extractKey: "founderContext", description: "Founder background, prior exits, domain expertise, why this team. Should establish founder-market fit. Examples: 'CEO ex-Stripe payments lead, CTO published Anthropic researcher, 2nd-time founders with prior $80M exit', 'Domain expert with 12 years in healthcare ops, repeat founder'. The LLM uses this to humanize the pitch.", placeholder: "Repeat founder, ex-Stripe payments lead, prior $80M exit" },
    ],
    // DIS-114: ranked leaderboard (groupBy=workflow) surfaces the populated
    // recipients* family (email-gateway), mirroring pr-cold-email-outreach. The
    // leads*/companies* family is 0/null per-workflow until lead-service emits
    // byOutreachStatus(Companies) in the ranked aggregation (DIS-10, DIS-48).
    outputs: [
      { key: "emailsGenerated", displayOrder: 1 },
      { key: "recipientsContacted", displayOrder: 2 },
      { key: "recipientsSent", displayOrder: 3 },
      { key: "recipientsDelivered", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsRepliesPositive", displayOrder: 6 },
      { key: "recipientsRepliesNegative", displayOrder: 7 },
      { key: "recipientsRepliesNeutral", displayOrder: 8 },
      { key: "recipientOpenRate", displayOrder: 9 },
      { key: "recipientClickRate", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientOpenCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsDelivered" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  {
    slug: "pr-expert-quote-opportunities",
    name: "PR Expert Quote Opportunities",
    description: "Review a ranked queue of Featured.com journalist quote requests relevant to your brand, then generate, edit, and send expert quotes manually with AI assistance.",
    icon: "inbox",
    implemented: true,
    displayOrder: 10,
    status: "active",
    acquisitionChannel: { family: "earned", producibleSteps: VISIT_ONLY, terms: terms(800, 30, 21) },
    // RETIRED SPELLING of the expert-quote channel — the same offering, on byte-identical terms, is
    // sold as `pr-expert-quote-outreach`. The row stays, because live campaigns, live budgets and the
    // cost ledger reference this slug and every authenticated read of it must keep answering; what
    // this states is only that it is no longer PUBLISHED, so the public catalogue lists the offering
    // once and nobody can book the dead spelling.
    supersededBySlug: "pr-expert-quote-outreach",
    inputs: [
      { key: "expertName", type: "text", label: "Expert Name", extractKey: "spokespersonName", description: "Full name of the brand's primary public spokesperson — the founder, CEO, or designated expert who will be quoted. Auto-extracted from the brand's site (about / team / leadership pages); edit if the wrong person is picked. Featured.com journalists attribute the published quote to this name verbatim.", placeholder: "Jane Doe" },
      { key: "expertTitle", type: "text", label: "Title / Role", extractKey: "spokespersonTitle", description: "Job title or role of the spokesperson at the company (e.g. 'CEO', 'CTO', 'Head of Research'). Printed next to the quote to establish authority. Auto-extracted from the brand's about / team page.", placeholder: "CEO" },
      { key: "expertPhotoUrl", type: "text", label: "Headshot URL", extractKey: "spokespersonHeadshotUrl", description: "Direct URL to the spokesperson's professional headshot photo. Many outlets publish the photo alongside the quote. Auto-extracted from the brand's team / about page when available — otherwise paste a link to a high-resolution headshot.", placeholder: "https://…/headshot.jpg" },
      { key: "expertLinkedIn", type: "text", label: "LinkedIn URL", extractKey: "spokespersonLinkedinUrl", description: "URL of the spokesperson's personal LinkedIn profile. Journalists use it to verify the expert's identity and credentials before quoting. Auto-extracted from the brand's site when linked — otherwise paste the profile URL.", placeholder: "https://www.linkedin.com/in/janedoe" },
    ],
    outputs: [
      { key: "quoteRequestsFound", displayOrder: 1 },
      { key: "quotePitchesSubmitted", displayOrder: 2 },
      { key: "quotesSelected", displayOrder: 3 },
      { key: "quotesPublished", displayOrder: 4 },
      { key: "pitchSelectionRate", displayOrder: 5 },
      { key: "pitchPublishRate", displayOrder: 6 },
      { key: "costPerQuotePublishedCents", defaultSort: true, displayOrder: 7, sortDirection: "asc" },
    ],
    charts: [
      { key: "quoteFunnel", type: "funnel-bar", title: "Quote Opportunity Funnel", displayOrder: 1, steps: [{ key: "quoteRequestsFound" }, { key: "quotePitchesSubmitted" }, { key: "quotesSelected" }, { key: "quotesPublished" }] },
      { key: "pitchOutcomes", type: "breakdown-bar", title: "Pitch Outcomes", displayOrder: 2, segments: [{ key: "quotesPublished", color: "green", sentiment: "positive" }, { key: "quotesSelected", color: "blue", sentiment: "neutral" }, { key: "quotesNotSelected", color: "red", sentiment: "negative" }] },
    ],
    entities: [
      { name: "quote-requests", countKey: "quoteRequestsFound" },
      { name: "quote-pitches", countKey: "quotePitchesSubmitted" },
    ],
  },
];

/**
 * THE PUBLISHED ACQUISITION CHANNELS BEYOND THE THREE EMAIL ONES.
 *
 * Every one of these is BOOKABLE from day one — that is why none of them carries an availability flag.
 * A channel we are slower to deliver says so through its own commercial terms: a specialist-run channel
 * carries that salary in `dailyOperatingCostCents`, a channel that needs an account warmed or a
 * placement booked carries that wait in `maxDaysToFirstProduction`, and a channel whose economics only
 * make sense over a quarter carries that in `minimumCommitmentDays`.
 *
 * ── WHY THEIR `outputs` / `charts` / `entities` ARE EMPTY ─────────────────────────────────────────
 *
 * Those three fields are the MEASUREMENT surface — which stat families this service renders for the
 * feature — and this service measures email today. A cold-call channel declaring `recipientsOpened`
 * would report 0 for ever, and a measured-looking zero is precisely the fabricated figure the brief
 * forbids. Empty says the honest thing: we do not measure this channel's steps yet. It is NOT a
 * bookability statement, and the public per-pair economics read answers "not enough data" for these
 * channels from the same absence, out loud.
 */

/**
 * The offer questions every channel asks, whatever medium it runs on.
 *
 * NO free-text ICP field here either, for the reason stated above: who a channel addresses is the
 * audience entity the bandit selects, and a static "who we target" string typed once on the form would
 * contradict it rather than duplicate it.
 */
const OFFER_INPUTS: unknown[] = [
  { key: "targetOutcome", type: "text", label: "Target Outcome", extractKey: "callToAction", description: "The single action you want from the person this channel reaches. Should be one clear call-to-action. Examples: 'Book a 15-min demo call', 'Start a free trial', 'Reply with their view'. This becomes the ask.", placeholder: "Book sales demos" },
  { key: "valueForTarget", type: "text", label: "Value for Target", extractKey: "valueProposition", description: "The core value proposition for the audience — what they gain by engaging. Specific and quantified where possible. Examples: 'Cut infrastructure costs by 40%', 'Ship features 3x faster'. This is the main selling point.", placeholder: "What do they gain from responding?" },
  { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Trust signals that build credibility — customer count, notable logos, testimonials, awards, or metrics. Examples: 'Trusted by 500+ SaaS companies', 'Featured in TechCrunch', 'NPS of 72'. Used to establish standing before the ask.", placeholder: "500+ companies already onboarded" },
];

/** What a paid-reach channel additionally needs: the creative angle and where the click lands. */
const PAID_REACH_INPUTS: unknown[] = [
  ...OFFER_INPUTS,
  { key: "creativeAngle", type: "text", label: "Creative Angle", extractKey: "creativeAngle", description: "The hook the ad leads with — the one line that makes the audience stop. Should name the problem or the result, not the product. Examples: 'Your CI pipeline is why releases slip', 'Close books in 2 days, not 2 weeks'. Drives every creative variant.", placeholder: "The line that makes them stop scrolling" },
  { key: "landingUrl", type: "text", label: "Landing Page", extractKey: "landingUrl", description: "The exact URL the ad sends people to. Should be the page that matches the creative angle, not the homepage. Everything measured as a website visit for this channel lands here.", placeholder: "https://example.com/pricing" },
];

/** What an earned channel additionally needs: why anyone should cover or rank you. */
const EARNED_INPUTS: unknown[] = [
  ...OFFER_INPUTS,
  { key: "topicAuthority", type: "text", label: "Topic Authority", extractKey: "topicAuthority", description: "The subjects this brand can speak on with real standing, and what backs that standing — data you hold, work you have shipped, years in the field. Examples: 'Payment fraud rates, from 4bn processed transactions', 'EU AI Act compliance, first certified platform'. Editors, hosts and ranking systems all read this.", placeholder: "What can you speak on that others cannot?" },
  { key: "newsHook", type: "text", label: "News Hook", extractKey: "newsHook", description: "A timely event, trend or news cycle that makes this relevant right now. Examples: 'Ahead of the CES announcement', 'Following the new SEC rules', 'During cybersecurity awareness month'. Leave empty if the topic is evergreen.", placeholder: "Ties into an upcoming regulation change" },
];

interface ChannelSeed {
  slug: string;
  name: string;
  description: string;
  icon: string;
  displayOrder: number;
  family: AcquisitionChannel["family"];
  producibleSteps: readonly ProducibleStepKey[];
  terms: AcquisitionChannel["terms"];
  inputs: unknown[];
}

const PUBLISHED_CHANNELS: ChannelSeed[] = [
  // ── Outbound, one to one ────────────────────────────────────────────────────────────────────────
  // A person is reached individually. A conversation is what these buy; several also carry a link, so
  // they can produce a website visit too. Cold calling cannot: there is no link in a phone call.
  { slug: "cold-call-outreach", name: "Cold Call Outreach", displayOrder: 13, icon: "phone", family: "outbound_one_to_one", producibleSteps: CONVERSATION_ONLY,
    // A person is on the line for the whole day whether or not anyone picks up, which is the entire
    // reason this channel's daily operating cost is two orders of magnitude above cold email's.
    terms: terms(24000, 30, 5),
    description: "Reach buyers by phone, one call at a time, and open the conversation that becomes the meeting.",
    inputs: OFFER_INPUTS },
  { slug: "cold-sms-outreach", name: "Cold SMS Outreach", displayOrder: 14, icon: "message-circle", family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(1500, 30, 7),
    description: "Reach buyers by text message and turn the replies into conversations, with a link for the ones who would rather read first.",
    inputs: OFFER_INPUTS },
  { slug: "cold-whatsapp-outreach", name: "Cold WhatsApp Outreach", displayOrder: 15, icon: "message-square", family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(1500, 30, 10),
    description: "Reach buyers on WhatsApp where replies are quick, and carry the ones who want detail through to your site.",
    inputs: OFFER_INPUTS },
  { slug: "cold-linkedin-outreach", name: "Cold LinkedIn Outreach", displayOrder: 16, icon: "linkedin", family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT,
    // The sending account has to be aged and warmed before it can send at volume without restriction.
    terms: terms(1200, 30, 14),
    description: "Reach buyers through LinkedIn messages and connection requests, and turn the replies into conversations.",
    inputs: OFFER_INPUTS },
  { slug: "cold-x-outreach", name: "Cold X Outreach", displayOrder: 17, icon: "at-sign", family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(1000, 30, 14),
    description: "Reach buyers through X direct messages and replies, and turn the ones who answer into conversations.",
    inputs: OFFER_INPUTS },
  { slug: "cold-instagram-outreach", name: "Cold Instagram Outreach", displayOrder: 18, icon: "instagram", family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(1000, 30, 14),
    description: "Reach buyers through Instagram direct messages and turn the ones who answer into conversations.",
    inputs: OFFER_INPUTS },
  { slug: "cold-reddit-outreach", name: "Cold Reddit Outreach", displayOrder: 19, icon: "message-square", family: "outbound_one_to_one", producibleSteps: CONVERSATION_AND_VISIT,
    // Reddit accounts need standing before they can message at all, so this one starts slowest.
    terms: terms(1000, 30, 21),
    description: "Reach buyers through Reddit direct messages, from an account with enough standing in their communities to be read.",
    inputs: OFFER_INPUTS },

  // ── Paid reach ──────────────────────────────────────────────────────────────────────────────────
  // Bought impressions. Most of these platforms also host a form the buyer fills without leaving, and
  // two of them can take a booking straight from the ad, which is why the steps differ across a family
  // that otherwise looks uniform.
  { slug: "google-ads", name: "Google Ads", displayOrder: 20, icon: "search", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_FORM,
    terms: terms(5000, 30, 3),
    description: "Buy the searches your buyers already run, and the clicks and lead forms that come from them.",
    inputs: PAID_REACH_INPUTS },
  { slug: "meta-ads", name: "Meta Ads", displayOrder: 21, icon: "facebook", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_STEPS,
    terms: terms(5000, 30, 3),
    description: "Buy reach on Facebook and Instagram, with lead forms and appointment booking that happen inside the platform.",
    inputs: PAID_REACH_INPUTS },
  { slug: "linkedin-ads", name: "LinkedIn Ads", displayOrder: 22, icon: "linkedin", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_STEPS,
    // LinkedIn imposes its own daily floor per campaign; the terms carry it rather than hiding it.
    terms: terms(10000, 30, 3),
    description: "Buy reach against job title, company and seniority, with lead gen forms filled without leaving LinkedIn.",
    inputs: PAID_REACH_INPUTS },
  { slug: "tiktok-ads", name: "TikTok Ads", displayOrder: 23, icon: "video", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_FORM,
    terms: terms(5000, 30, 5),
    description: "Buy short-video reach and the clicks and instant forms it produces.",
    inputs: PAID_REACH_INPUTS },
  { slug: "youtube-ads", name: "YouTube Ads", displayOrder: 24, icon: "youtube", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_FORM,
    terms: terms(5000, 30, 5),
    description: "Buy video reach on YouTube and the clicks and lead forms it produces.",
    inputs: PAID_REACH_INPUTS },
  { slug: "x-ads", name: "X Ads", displayOrder: 25, icon: "at-sign", family: "paid_reach", producibleSteps: VISIT_ONLY,
    description: "Buy reach on X against interests and followings, and the clicks through to your site.",
    terms: terms(3000, 30, 3),
    inputs: PAID_REACH_INPUTS },
  { slug: "reddit-ads", name: "Reddit Ads", displayOrder: 26, icon: "message-square", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_FORM,
    terms: terms(3000, 30, 3),
    description: "Buy reach inside the communities where your buyers discuss the problem, with forms filled on Reddit itself.",
    inputs: PAID_REACH_INPUTS },
  { slug: "bing-ads", name: "Bing Ads", displayOrder: 27, icon: "search", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_FORM,
    terms: terms(3000, 30, 3),
    description: "Buy the searches your buyers run on Bing, and the clicks and lead forms that come from them.",
    inputs: PAID_REACH_INPUTS },
  { slug: "quora-ads", name: "Quora Ads", displayOrder: 28, icon: "help-circle", family: "paid_reach", producibleSteps: VISIT_AND_IN_AD_FORM,
    terms: terms(3000, 30, 5),
    description: "Buy reach against the questions your buyers ask, and the clicks and lead forms they produce.",
    inputs: PAID_REACH_INPUTS },
  { slug: "newsletter-sponsorships", name: "Newsletter Sponsorships", displayOrder: 29, icon: "mail", family: "paid_reach", producibleSteps: VISIT_ONLY,
    // A placement is booked into a future issue, so the wait is the publisher's calendar, not ours.
    terms: terms(6000, 30, 30),
    description: "Buy placements in the newsletters your buyers already read, and the clicks through to your site.",
    inputs: PAID_REACH_INPUTS },
  { slug: "podcast-sponsorships", name: "Podcast Sponsorships", displayOrder: 30, icon: "mic", family: "paid_reach", producibleSteps: VISIT_ONLY,
    terms: terms(8000, 60, 45),
    description: "Buy read spots on the podcasts your buyers listen to, and the visits they send.",
    inputs: PAID_REACH_INPUTS },
  { slug: "creator-sponsorships", name: "Creator Sponsorships", displayOrder: 31, icon: "users", family: "paid_reach", producibleSteps: VISIT_ONLY,
    terms: terms(8000, 60, 30),
    description: "Pay creators your buyers follow to show your product to them, and measure the visits it sends.",
    inputs: PAID_REACH_INPUTS },
  { slug: "paid-directory-listings", name: "Paid Software Directory Listings", displayOrder: 32, icon: "list", family: "paid_reach", producibleSteps: VISIT_ONLY,
    terms: terms(4000, 90, 14),
    description: "Buy placement in the software directories buyers shortlist from, and the visits that follow.",
    inputs: PAID_REACH_INPUTS },

  // ── Earned ──────────────────────────────────────────────────────────────────────────────────────
  // Nothing here buys an impression; it earns one. That is why these carry the longest starts: an
  // article has to be published and indexed, an editor has to choose you, a host has to book you.
  { slug: "seo-content", name: "SEO Content", displayOrder: 33, icon: "file-text", family: "earned", producibleSteps: VISIT_ONLY,
    // Publishing and ranking is a quarter's work before it produces, and it is worth nothing bought by
    // the week — which is what the 90-day minimum says out loud.
    terms: terms(12000, 90, 90),
    description: "Publish content that ranks for what your buyers search, and earn the visits it brings every month after.",
    inputs: EARNED_INPUTS },
  { slug: "press-placements", name: "Press Placements", displayOrder: 34, icon: "newspaper", family: "earned", producibleSteps: VISIT_ONLY,
    terms: terms(8000, 30, 30),
    description: "Place guaranteed articles about your brand in real publications, and earn the visits and authority they carry.",
    inputs: EARNED_INPUTS },
  { slug: "podcast-guesting", name: "Podcast Guesting", displayOrder: 35, icon: "mic", family: "earned", producibleSteps: VISIT_ONLY,
    terms: terms(6000, 60, 45),
    description: "Get your spokesperson booked on the podcasts your buyers listen to, and earn the visits each episode sends.",
    inputs: EARNED_INPUTS },
  { slug: "affiliate-programme", name: "Affiliate Programme", displayOrder: 36, icon: "share-2", family: "earned", producibleSteps: VISIT_ONLY,
    terms: terms(4000, 90, 45),
    description: "Recruit partners who send you buyers and get paid on what closes, and measure the visits they send.",
    inputs: EARNED_INPUTS },
  { slug: "organic-linkedin-publishing", name: "Organic LinkedIn Publishing", displayOrder: 37, icon: "linkedin", family: "earned", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(10000, 90, 30),
    description: "Publish on LinkedIn under your spokesperson's name, and earn both the replies it opens and the visits it sends.",
    inputs: EARNED_INPUTS },
  { slug: "organic-x-publishing", name: "Organic X Publishing", displayOrder: 38, icon: "at-sign", family: "earned", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(8000, 90, 30),
    description: "Publish on X under your spokesperson's name, and earn both the replies it opens and the visits it sends.",
    inputs: EARNED_INPUTS },
  { slug: "organic-reddit-publishing", name: "Organic Reddit Publishing", displayOrder: 39, icon: "message-square", family: "earned", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(8000, 90, 45),
    description: "Post in the communities where your buyers discuss the problem, and earn the replies and visits it produces.",
    inputs: EARNED_INPUTS },
  { slug: "organic-youtube-publishing", name: "Organic YouTube Publishing", displayOrder: 40, icon: "youtube", family: "earned", producibleSteps: CONVERSATION_AND_VISIT,
    terms: terms(12000, 90, 60),
    description: "Publish video that answers what your buyers search on YouTube, and earn the comments and visits it brings.",
    inputs: EARNED_INPUTS },
];

for (const channel of PUBLISHED_CHANNELS) {
  SEED_FEATURE_DEFS.push({
    slug: channel.slug,
    name: channel.name,
    description: channel.description,
    icon: channel.icon,
    // BOOKABLE, like every other published channel. There is no half-published state to express here.
    implemented: true,
    displayOrder: channel.displayOrder,
    status: "active",
    acquisitionChannel: {
      family: channel.family,
      producibleSteps: channel.producibleSteps,
      terms: channel.terms,
    },
    // Every slug published here is the current one — a channel introduced by this catalogue has no
    // earlier spelling to retire.
    supersededBySlug: null,
    inputs: channel.inputs,
    // Empty on purpose — see the block above. This service measures email today, and a stat family a
    // channel cannot produce would report a measured-looking zero for ever.
    outputs: [],
    charts: [],
    entities: [],
  });
}

/**
 * The catalogue as every consumer reads it: the definitions above with `salesFunnels` DERIVED from what
 * each channel can produce. A feature that is not an acquisition channel sells through nothing, which is
 * the same statement it made before this join existed.
 */
export const SEED_FEATURES: SeedFeature[] = SEED_FEATURE_DEFS.map((def) => ({
  ...def,
  salesFunnels: def.acquisitionChannel ? sellableFunnelsFor(def.acquisitionChannel.producibleSteps) : [],
}));
