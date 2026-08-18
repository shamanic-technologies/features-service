/**
 * Canonical feature definitions.
 * On cold start, these are upserted by slug into the DB.
 */

import { SALES_FUNNEL_KEYS, type SalesFunnelKey } from "../lib/sales-funnels.js";

/**
 * WHICH SALES FUNNELS A FEATURE MAY BE SOLD THROUGH — stated on EVERY feature, never omitted.
 *
 * The dashboard offers only valid (funnel, feature) pairs and campaign-service refuses to provision an
 * invalid one; both read the answer from here, because it is a product statement about the feature and
 * this service owns the feature catalogue. Hardcoding the matrix in each consumer was rejected — that
 * is how one product fact becomes four drifting copies.
 *
 * The keys are brand-service's (`SALES_FUNNEL_KEYS`), unchanged: nothing here invents a funnel, and a
 * feature can only be sold through a chain a brand actually declares.
 *
 * "SELLS THROUGH NONE" AND "SELLS THROUGH ALL" ARE DIFFERENT STATEMENTS, and both are written out. A
 * non-sales feature (PR, hiring, VC, accelerators, AI visibility, press kit, outlet discovery, expert
 * quotes) states `[]` — it is not sold through a sales funnel at all. A sales feature sold through every
 * declared chain states all four keys. Nothing is left unstated, so a consumer never has to decide what
 * an absent answer means; the column's `[]` default only ever covers a row this seed has not reached,
 * and reads as the restrictive side.
 */
const ALL_SALES_FUNNELS: readonly SalesFunnelKey[] = Object.freeze([...SALES_FUNNEL_KEYS]);
const NO_SALES_FUNNEL: readonly SalesFunnelKey[] = Object.freeze([]);
/**
 * The reply-to-meeting chain alone — brand-service's "Sales Meeting from Conversation". The feedback
 * request buys a CONVERSATION, and the conversation is what becomes the meeting; there is no website
 * step in that offer, so the three click-driven chains are not things it can be sold through.
 */
const CONVERSATION_MEETING_ONLY: readonly SalesFunnelKey[] = Object.freeze(["sales_meetings_from_conversation" as SalesFunnelKey]);

export interface SeedFeature {
  slug: string;
  name: string;
  description: string;
  icon: string;
  implemented: boolean;
  displayOrder: number;
  status: string;
  /** The sales funnels this feature may be sold through — see `ALL_SALES_FUNNELS` above. Never omitted. */
  salesFunnels: readonly SalesFunnelKey[];
  inputs: unknown[];
  outputs: unknown[];
  charts: unknown[];
  entities: unknown[];
}

export const SEED_FEATURES: SeedFeature[] = [
  {
    slug: "sales-cold-email-outreach",
    name: "Sales Cold Email Outreach",
    description: "Find leads matching your ICP, generate personalized cold emails, and track engagement through the full outreach funnel.",
    icon: "envelope",
    implemented: true,
    displayOrder: 1,
    status: "active",
    salesFunnels: ALL_SALES_FUNNELS,
    inputs: [
      { key: "targetAudience", type: "text", label: "Target Audience", extractKey: "targetAudience", description: "Who the campaign targets — ICP description (role, company size, industry). Be precise about job titles, industry vertical, company size range, and geography. Example: 'VP of Marketing at B2B SaaS companies with 50-200 employees in the US'. The LLM uses this to find matching leads and personalize outreach.", placeholder: "CTOs at SaaS startups with 10-50 employees" },
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
    slug: "sales-feedback-request-cold-email-outreach",
    name: "Sales Feedback Request Cold Email Outreach",
    description: "Ask buyers for feedback on the problem you solve instead of pitching them, then turn the replies into sales meetings. Same cold email sending, tracked through the same funnel.",
    icon: "message-square",
    implemented: true,
    displayOrder: 12,
    status: "active",
    salesFunnels: CONVERSATION_MEETING_ONLY,
    inputs: [
      { key: "targetAudience", type: "text", label: "Target Audience", extractKey: "targetAudience", description: "Who the campaign targets — ICP description (role, company size, industry). Be precise about job titles, industry vertical, company size range, and geography. Example: 'VP of Marketing at B2B SaaS companies with 50-200 employees in the US'. The LLM uses this to find matching leads and personalize the feedback request.", placeholder: "CTOs at SaaS startups with 10-50 employees" },
      { key: "problemToValidate", type: "text", label: "Problem to Validate", extractKey: "problemStatement", description: "The problem the product solves, stated the way the recipient would experience it — this is what the email asks them for feedback on, so it must be a problem they recognize in their own work, not a product description. Examples: 'Sales reps spend half their week researching accounts instead of selling', 'Compliance reviews block every release by two weeks'. The LLM builds the feedback question from this.", placeholder: "Which part of this problem is real for you?" },
      { key: "targetOutcome", type: "text", label: "Target Outcome", extractKey: "callToAction", description: "What the conversation should lead to once the recipient replies. This offer converts through the reply, so the call-to-action is a low-friction ask for their view, and the meeting is proposed after they answer. Examples: 'Two-line reply on whether this problem is real, then a 15-min call', 'Their take on how they solve this today'. The LLM uses this to craft the ask.", placeholder: "A short reply, then a 15-min call" },
      { key: "valueForTarget", type: "text", label: "Value for Target", extractKey: "valueProposition", description: "Why answering is worth the recipient's time — what they get back for the two minutes it costs them. Examples: 'Early access to the benchmark we build from these answers', 'A summary of how 40 peers solve this'. The LLM uses this to justify the ask.", placeholder: "What do they get back for replying?" },
      { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Trust signals that make the request credible — who else answered, customer count, notable logos, or published results. Examples: 'Already heard from 40 heads of RevOps', 'Trusted by 500+ SaaS companies'. The LLM uses this to establish standing before asking.", placeholder: "40 peers have already answered" },
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
    salesFunnels: ALL_SALES_FUNNELS,
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
    salesFunnels: NO_SALES_FUNNEL,
    inputs: [
      { key: "targetOutlets", type: "text", label: "Target Outlets", extractKey: "targetOutlets", description: "Types of media outlets or specific publications to target. Be specific about outlet tier, beat, and format (online, print, podcast). Examples: 'Top-tier tech blogs (TechCrunch, The Verge)', 'B2B SaaS trade publications', 'Fintech newsletters with 10k+ subscribers'. The LLM uses this to find and prioritize matching journalists.", placeholder: "TechCrunch, Forbes, industry trade publications..." },
      { key: "prAngle", type: "text", label: "PR Angle", extractKey: "suggestedAngles", description: "The editorial hook or story angle to pitch. Should be newsworthy and specific. Examples: 'Series B funding of $25M led by Sequoia', 'Launch of AI-powered compliance platform', 'Industry report on developer productivity trends'. The LLM uses this as the core pitch in the outreach email.", placeholder: "Series B funding announcement, product launch..." },
      { key: "companyContext", type: "text", label: "Company Context", extractKey: "companyDescription", description: "Brief background on the company and why this story matters now. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers, fastest-growing in category', 'Only platform certified for EU AI Act compliance'. Gives the LLM credibility context for the pitch.", placeholder: "What does your company do and why is this relevant now?" },
      { key: "newsHook", type: "text", label: "News Hook", extractKey: "newsHook", description: "A timely event, trend, or news cycle that makes the pitch relevant right now. Examples: 'Ahead of CES 2026 announcement', 'Following new SEC crypto regulations', 'During cybersecurity awareness month'. Helps the LLM frame the pitch as timely and urgent for editors.", placeholder: "Ties into upcoming regulation changes, industry event..." },
      { key: "spokesperson", type: "text", label: "Spokesperson", extractKey: "spokesperson", description: "Who is available for interviews or quotes. Include name, title, and any notable credentials. Examples: 'John Smith, CTO — ex-Google, published AI researcher', 'Sarah Chen, CEO — Forbes 30 Under 30'. The LLM includes this as a resource offer in the pitch.", placeholder: "Jane Doe, CEO — available for interviews" },
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
    salesFunnels: NO_SALES_FUNNEL,
    inputs: [
      { key: "targetProfile", type: "textarea", label: "Target Candidate Profile", extractKey: "target_profile", description: "ICP description of the ideal candidate — role, seniority, skills, industry, geography. The LLM uses this to find matching leads and personalize outreach.", placeholder: "e.g. Senior Backend Engineer, 5+ years Go/Rust, startup experience, EU-based" },
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
    salesFunnels: NO_SALES_FUNNEL,
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
    salesFunnels: NO_SALES_FUNNEL,
    inputs: [
      { key: "prAngle", type: "text", label: "PR Angle", extractKey: "suggestedAngles", description: "The editorial hook or story angle for the press kit. Should be newsworthy and specific. Examples: 'Series B funding of $25M led by Sequoia', 'Launch of AI-powered compliance platform'. The LLM uses this as the core narrative for the press kit.", placeholder: "Series B funding announcement, product launch..." },
      { key: "companyContext", type: "text", label: "Company Context", extractKey: "companyDescription", description: "Brief background on the company. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers', 'Only platform certified for EU AI Act compliance'. Gives the LLM credibility context for the press kit content.", placeholder: "What does your company do and why is this relevant now?" },
      { key: "spokesperson", type: "text", label: "Spokesperson", extractKey: "spokesperson", description: "Who is available for interviews or quotes. Include name, title, and any notable credentials. Examples: 'John Smith, CTO — ex-Google, published AI researcher'. The LLM includes this in the press kit's contact section.", placeholder: "Jane Doe, CEO — available for interviews" },
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
    salesFunnels: NO_SALES_FUNNEL,
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
    salesFunnels: NO_SALES_FUNNEL,
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
    salesFunnels: NO_SALES_FUNNEL,
    inputs: [
      { key: "targetInvestorProfile", type: "text", label: "Target Investor Profile", extractKey: "targetInvestorProfile", description: "ICP description of the ideal VC — stage, sector thesis, geography, typical check size, fund size. Be precise about investment stage (pre-seed/seed/Series A), focus sectors, and ticket range. Example: 'Pre-seed and seed B2B SaaS funds, US and EU, $250k-$2M initial checks'. The LLM uses this to find matching VC partners and personalize outreach.", placeholder: "Pre-seed B2B SaaS funds, US+EU, $250k-$2M checks" },
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
    salesFunnels: NO_SALES_FUNNEL,
    inputs: [
      { key: "targetAcceleratorProfile", type: "text", label: "Target Accelerator Profile", extractKey: "targetAcceleratorProfile", description: "ICP description of the ideal accelerator — stage focus, sector thesis, geography, cohort cadence, equity/ticket terms. Be precise about program stage (pre-seed/seed), focus verticals, batch model (cohort vs rolling), and typical deal terms. Example: 'Top-tier US accelerators for pre-seed B2B SaaS, $125k-$500k for 5-7% equity, batch model, AI/dev-tools focus'. The LLM uses this to find matching programs and personalize outreach.", placeholder: "Top US accelerators, pre-seed B2B SaaS, $125k-$500k for 5-7%" },
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
    salesFunnels: NO_SALES_FUNNEL,
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
