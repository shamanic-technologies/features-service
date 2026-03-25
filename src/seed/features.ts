import type { UpsertFeatureBody } from "../lib/schemas.js";

/**
 * Feature catalog — registered at cold start via PUT /features.
 * Idempotent: signature-based upsert means safe to call on every boot.
 */
export const SEED_FEATURES: UpsertFeatureBody[] = [
  // ─── Sales Cold Email Outreach ──────────────────────────────────────────
  {
    name: "Sales Cold Email Outreach",
    description: "Find leads, generate personalized cold emails, send & optimize.",
    icon: "envelope",
    category: "sales",
    channel: "email",
    audienceType: "cold-outreach",
    implemented: true,
    displayOrder: 1,
    status: "active",
    defaultWorkflowName: "sales-email-cold-outreach",
    resultComponent: null,

    inputs: [
      {
        key: "targetAudience",
        label: "Target Audience",
        type: "text",
        placeholder: "CTOs at SaaS startups with 10-50 employees",
        description:
          "Who the campaign targets — ICP description (role, company size, industry). Be precise about job titles, industry vertical, company size range, and geography. Example: 'VP of Marketing at B2B SaaS companies with 50-200 employees in the US'. The LLM uses this to find matching leads and personalize outreach.",
        extractKey: "targetAudience",
      },
      {
        key: "targetOutcome",
        label: "Target Outcome",
        type: "text",
        placeholder: "Book sales demos",
        description:
          "The desired action from the recipient (book a call, sign up, reply, etc.). Should be a single, clear call-to-action. Examples: 'Book a 15-min demo call', 'Start a free trial', 'Schedule a discovery call'. The LLM uses this to craft the email CTA.",
        extractKey: "callToAction",
      },
      {
        key: "valueForTarget",
        label: "Value for Target",
        type: "text",
        placeholder: "What do they gain from responding?",
        description:
          "The core value proposition for the target audience — what they gain by engaging. Should be specific and quantified when possible. Examples: 'Cut infrastructure costs by 40%', 'Ship features 3x faster with our CI/CD platform'. The LLM uses this as the main selling point in the email body.",
        extractKey: "valueProposition",
      },
      {
        key: "urgency",
        label: "Urgency",
        type: "text",
        placeholder: "Limited-time offer ending March 1st",
        description:
          "Time pressure to act — a deadline, event date, or expiring offer that motivates the recipient to respond quickly. Examples: 'Beta access closes Friday', 'Event is in 2 weeks', 'Pricing increases April 1st'. Leave empty if no urgency applies.",
        extractKey: "urgency",
      },
      {
        key: "scarcity",
        label: "Scarcity",
        type: "text",
        placeholder: "Only 10 spots available",
        description:
          "Limited availability that creates FOMO — spots, seats, inventory, or capacity constraints. Examples: 'Only 5 pilot slots left', 'Limited to 20 beta customers', 'First 50 sign-ups get lifetime pricing'. Leave empty if no scarcity applies.",
        extractKey: "scarcity",
      },
      {
        key: "riskReversal",
        label: "Risk Reversal",
        type: "text",
        placeholder: "Free trial, no commitment",
        description:
          "What reduces the perceived risk of responding — guarantees, free trials, or no-commitment offers. Examples: 'Free 14-day trial', '30-day money-back guarantee', 'No credit card required', 'Cancel anytime'. Helps overcome objections in the email.",
        extractKey: "riskReversal",
      },
      {
        key: "socialProof",
        label: "Social Proof",
        type: "text",
        placeholder: "500+ companies already onboarded",
        description:
          "Trust signals that build credibility — customer count, notable logos, testimonials, awards, or metrics. Examples: 'Trusted by 500+ SaaS companies', 'Featured in TechCrunch', 'NPS score of 72'. The LLM uses this to add credibility to the outreach.",
        extractKey: "socialProof",
      },
    ],

    outputs: [
      {
        key: "leadsServed",
        label: "Leads",
        type: "count",
        displayOrder: 1,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 1,
      },
      {
        key: "emailsGenerated",
        label: "Generated",
        type: "count",
        displayOrder: 2,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 2,
      },
      {
        key: "emailsSent",
        label: "Sent",
        type: "count",
        displayOrder: 3,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 3,
      },
      {
        key: "emailsOpened",
        label: "Opened",
        type: "count",
        displayOrder: 4,
        showInCampaignRow: false,
        showInFunnel: true,
        funnelOrder: 4,
      },
      {
        key: "emailsReplied",
        label: "Replied",
        type: "count",
        displayOrder: 5,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 5,
      },
      {
        key: "positiveReplyRate",
        label: "Positive Reply Rate",
        type: "rate",
        displayOrder: 6,
        showInCampaignRow: false,
        showInFunnel: false,
        numeratorKey: "repliesWillingToMeet",
        denominatorKey: "emailsSent",
      },
    ],

    charts: [
      {
        key: "funnel",
        type: "funnel-bar",
        title: "Campaign Funnel",
        displayOrder: 1,
        steps: [
          { key: "leadsServed", label: "Leads", statsField: "leadsServed", rateBasedOn: null },
          { key: "emailsGenerated", label: "Generated", statsField: "emailsGenerated", rateBasedOn: "leadsServed" },
          { key: "emailsSent", label: "Sent", statsField: "emailsSent", rateBasedOn: "emailsGenerated" },
          { key: "emailsOpened", label: "Opened", statsField: "emailsOpened", rateBasedOn: "emailsSent" },
          { key: "emailsReplied", label: "Replied", statsField: "emailsReplied", rateBasedOn: "emailsSent" },
        ],
      },
      {
        key: "replyBreakdown",
        type: "breakdown-bar",
        title: "Reply Breakdown",
        displayOrder: 2,
        segments: [
          { key: "willingToMeet", label: "Willing to meet", statsField: "repliesWillingToMeet", color: "green", sentiment: "positive" },
          { key: "interested", label: "Interested", statsField: "repliesInterested", color: "blue", sentiment: "positive" },
          { key: "notInterested", label: "Not interested", statsField: "repliesNotInterested", color: "red", sentiment: "negative" },
          { key: "outOfOffice", label: "Out of office", statsField: "repliesOutOfOffice", color: "gray", sentiment: "neutral" },
          { key: "unsubscribe", label: "Unsubscribe", statsField: "repliesUnsubscribe", color: "orange", sentiment: "negative" },
        ],
      },
    ],

    workflowColumns: [
      {
        key: "replyRate",
        label: "% Replies",
        type: "rate",
        numeratorKey: "emailsReplied",
        denominatorKey: "emailsSent",
        sortDirection: "desc",
        displayOrder: 1,
      },
      {
        key: "costPerReplyCents",
        label: "$/Reply",
        type: "currency",
        numeratorKey: "totalCostInUsdCents",
        denominatorKey: "emailsReplied",
        sortDirection: "asc",
        displayOrder: 2,
        defaultSort: true,
      },
    ],
  },

  // ─── Outlet Database Discovery ──────────────────────────────────────────
  {
    name: "Outlet Database Discovery",
    description: "Discover relevant press outlets for your brand via AI-powered search and scoring.",
    icon: "globe",
    category: "outlets",
    channel: "database",
    audienceType: "discovery",
    implemented: true,
    displayOrder: 2,
    status: "active",
    defaultWorkflowName: null,
    resultComponent: "discovered-outlets",

    inputs: [
      {
        key: "industry",
        label: "Industry",
        type: "text",
        placeholder: "SaaS, AI, Fintech, Healthcare...",
        description:
          "The industry vertical to target for discovery. Be specific — this drives which media outlets are searched. Examples: 'Enterprise cybersecurity', 'Consumer fintech', 'Climate tech / clean energy'. The discovery engine uses this to generate targeted search queries.",
        extractKey: "industry",
      },
      {
        key: "angles",
        label: "PR Angles",
        type: "text",
        placeholder: "Fundraising announcement, product launch, thought leadership...",
        description:
          "Story hooks or editorial angles the outreach should pitch. Comma-separated. Examples: 'Series B funding announcement', 'New product launch for SMBs', 'Thought leadership on AI regulation'. Helps match outlets that cover these topics.",
        extractKey: "suggestedAngles",
      },
      {
        key: "targetGeo",
        label: "Geographic Focus",
        type: "text",
        placeholder: "US, Europe, Global...",
        description:
          "Geographic scope for finding targets — countries, regions, or cities. Examples: 'US and UK', 'DACH region', 'San Francisco Bay Area'. Determines whether to search local, national, or international outlets.",
        extractKey: "suggestedGeo",
      },
    ],

    outputs: [
      {
        key: "outletsDiscovered",
        label: "Outlets Found",
        type: "count",
        displayOrder: 1,
        showInCampaignRow: true,
        showInFunnel: false,
      },
      {
        key: "avgRelevanceScore",
        label: "Avg Relevance",
        type: "percentage",
        displayOrder: 2,
        showInCampaignRow: true,
        showInFunnel: false,
      },
      {
        key: "searchQueriesUsed",
        label: "Searches",
        type: "count",
        displayOrder: 3,
        showInCampaignRow: false,
        showInFunnel: false,
      },
    ],

    charts: [],
    workflowColumns: [],
  },

  // ─── PR Cold Email Outreach ─────────────────────────────────────────────
  {
    name: "PR Cold Email Outreach",
    description: "Pitch journalists and editors with personalized cold emails for press coverage.",
    icon: "megaphone",
    category: "pr",
    channel: "email",
    audienceType: "cold-outreach",
    implemented: true,
    displayOrder: 3,
    status: "active",
    defaultWorkflowName: "pr-email-cold-outreach",
    resultComponent: null,

    inputs: [
      {
        key: "targetOutlets",
        label: "Target Outlets",
        type: "text",
        placeholder: "TechCrunch, Forbes, industry trade publications...",
        description:
          "Types of media outlets or specific publications to target. Be specific about outlet tier, beat, and format (online, print, podcast). Examples: 'Top-tier tech blogs (TechCrunch, The Verge)', 'B2B SaaS trade publications', 'Fintech newsletters with 10k+ subscribers'. The LLM uses this to find and prioritize matching journalists.",
        extractKey: "targetOutlets",
      },
      {
        key: "prAngle",
        label: "PR Angle",
        type: "text",
        placeholder: "Series B funding announcement, product launch...",
        description:
          "The editorial hook or story angle to pitch. Should be newsworthy and specific. Examples: 'Series B funding of $25M led by Sequoia', 'Launch of AI-powered compliance platform', 'Industry report on developer productivity trends'. The LLM uses this as the core pitch in the outreach email.",
        extractKey: "suggestedAngles",
      },
      {
        key: "companyContext",
        label: "Company Context",
        type: "text",
        placeholder: "What does your company do and why is this relevant now?",
        description:
          "Brief background on the company and why this story matters now. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers, fastest-growing in category', 'Only platform certified for EU AI Act compliance'. Gives the LLM credibility context for the pitch.",
        extractKey: "companyDescription",
      },
      {
        key: "newsHook",
        label: "News Hook",
        type: "text",
        placeholder: "Ties into upcoming regulation changes, industry event...",
        description:
          "A timely event, trend, or news cycle that makes the pitch relevant right now. Examples: 'Ahead of CES 2026 announcement', 'Following new SEC crypto regulations', 'During cybersecurity awareness month'. Helps the LLM frame the pitch as timely and urgent for editors.",
        extractKey: "newsHook",
      },
      {
        key: "spokesperson",
        label: "Spokesperson",
        type: "text",
        placeholder: "Jane Doe, CEO — available for interviews",
        description:
          "Who is available for interviews or quotes. Include name, title, and any notable credentials. Examples: 'John Smith, CTO — ex-Google, published AI researcher', 'Sarah Chen, CEO — Forbes 30 Under 30'. The LLM includes this as a resource offer in the pitch.",
        extractKey: "spokesperson",
      },
    ],

    outputs: [
      {
        key: "journalistsContacted",
        label: "Contacted",
        type: "count",
        displayOrder: 1,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 1,
      },
      {
        key: "emailsGenerated",
        label: "Generated",
        type: "count",
        displayOrder: 2,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 2,
      },
      {
        key: "emailsSent",
        label: "Sent",
        type: "count",
        displayOrder: 3,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 3,
      },
      {
        key: "emailsOpened",
        label: "Opened",
        type: "count",
        displayOrder: 4,
        showInCampaignRow: false,
        showInFunnel: true,
        funnelOrder: 4,
      },
      {
        key: "emailsReplied",
        label: "Replied",
        type: "count",
        displayOrder: 5,
        showInCampaignRow: true,
        showInFunnel: true,
        funnelOrder: 5,
      },
      {
        key: "coverageRate",
        label: "Coverage Rate",
        type: "rate",
        displayOrder: 6,
        showInCampaignRow: false,
        showInFunnel: false,
        numeratorKey: "repliesInterested",
        denominatorKey: "emailsSent",
      },
    ],

    charts: [
      {
        key: "funnel",
        type: "funnel-bar",
        title: "Outreach Funnel",
        displayOrder: 1,
        steps: [
          { key: "journalistsContacted", label: "Contacted", statsField: "journalistsContacted", rateBasedOn: null },
          { key: "emailsGenerated", label: "Generated", statsField: "emailsGenerated", rateBasedOn: "journalistsContacted" },
          { key: "emailsSent", label: "Sent", statsField: "emailsSent", rateBasedOn: "emailsGenerated" },
          { key: "emailsOpened", label: "Opened", statsField: "emailsOpened", rateBasedOn: "emailsSent" },
          { key: "emailsReplied", label: "Replied", statsField: "emailsReplied", rateBasedOn: "emailsSent" },
        ],
      },
      {
        key: "replyBreakdown",
        type: "breakdown-bar",
        title: "Reply Breakdown",
        displayOrder: 2,
        segments: [
          { key: "interested", label: "Interested", statsField: "repliesInterested", color: "green", sentiment: "positive" },
          { key: "moreInfo", label: "Wants more info", statsField: "repliesMoreInfo", color: "blue", sentiment: "positive" },
          { key: "notInterested", label: "Not interested", statsField: "repliesNotInterested", color: "red", sentiment: "negative" },
          { key: "outOfOffice", label: "Out of office", statsField: "repliesOutOfOffice", color: "gray", sentiment: "neutral" },
          { key: "wrongContact", label: "Wrong contact", statsField: "repliesWrongContact", color: "orange", sentiment: "negative" },
        ],
      },
    ],

    workflowColumns: [
      {
        key: "replyRate",
        label: "% Replies",
        type: "rate",
        numeratorKey: "emailsReplied",
        denominatorKey: "emailsSent",
        sortDirection: "desc",
        displayOrder: 1,
      },
      {
        key: "costPerReplyCents",
        label: "$/Reply",
        type: "currency",
        numeratorKey: "totalCostInUsdCents",
        denominatorKey: "emailsReplied",
        sortDirection: "asc",
        displayOrder: 2,
        defaultSort: true,
      },
    ],
  },
];
