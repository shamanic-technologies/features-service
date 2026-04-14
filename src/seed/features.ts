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
      { key: "leadsServed",              displayOrder: 1 },
      { key: "emailsGenerated",          displayOrder: 2 },
      { key: "emailsSent",              displayOrder: 3 },
      { key: "emailsOpened",            displayOrder: 4 },
      { key: "repliesPositive",          displayOrder: 5 },
      { key: "repliesNegative",          displayOrder: 6 },
      { key: "repliesNeutral",           displayOrder: 7 },
      { key: "positiveReplyRate",        displayOrder: 8 },
      { key: "costPerPositiveReplyCents", displayOrder: 9, defaultSort: true, sortDirection: "asc" },
    ],

    charts: [
      {
        key: "funnel",
        type: "funnel-bar",
        title: "Campaign Funnel",
        displayOrder: 1,
        steps: [
          { key: "leadsServed" },
          { key: "emailsGenerated" },
          { key: "emailsSent" },
          { key: "emailsOpened" },
          { key: "repliesPositive" },
        ],
      },
      {
        key: "replyBreakdown",
        type: "breakdown-bar",
        title: "Reply Breakdown",
        displayOrder: 2,
        segments: [
          { key: "repliesPositive",  color: "green",  sentiment: "positive" },
          { key: "repliesNeutral",   color: "gray",   sentiment: "neutral" },
          { key: "repliesNegative",  color: "red",    sentiment: "negative" },
          { key: "repliesAutoReply", color: "orange", sentiment: "neutral" },
        ],
      },
    ],

    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  // ─── Hiring Cold Email Outreach ─────────────────────────────────────────
  {
    name: "Hiring Cold Email Outreach",
    description: "Find candidates, generate personalized cold outreach emails, send & optimize for hiring.",
    icon: "user-plus",
    category: "recruiting",
    channel: "email",
    audienceType: "cold-outreach",
    implemented: true,
    displayOrder: 0,
    status: "active",

    inputs: [
      {
        key: "targetProfile",
        label: "Target Candidate Profile",
        type: "textarea",
        placeholder: "e.g. Senior Backend Engineer, 5+ years Go/Rust, startup experience, EU-based",
        description:
          "ICP description of the ideal candidate — role, seniority, skills, industry, geography. The LLM uses this to find matching leads and personalize outreach.",
        extractKey: "target_profile",
      },
      {
        key: "targetOutcome",
        label: "Target Outcome",
        type: "text",
        placeholder: "e.g. Book a 30-min intro call",
        description:
          "The desired action from the candidate — should be a single, clear call-to-action. Examples: 'Book a 30-min intro call', 'Apply to the role', 'Schedule a discovery conversation'.",
        extractKey: "target_outcome",
      },
      {
        key: "roleValueProp",
        label: "Role Value Proposition",
        type: "textarea",
        placeholder: "e.g. Competitive comp, fully remote, Series B-backed, working on cutting-edge ML infrastructure",
        description:
          "What makes the role and company attractive to the candidate — compensation, mission, growth, tech stack, remote policy, team culture. The LLM uses this as the main selling point.",
        extractKey: "role_value_prop",
      },
      {
        key: "urgency",
        label: "Urgency",
        type: "text",
        placeholder: "e.g. Role closes end of month, team starts Q3",
        description:
          "Time pressure to act — a start date, hiring deadline, or closing window. Examples: 'Team onboarding in 6 weeks', 'Role closes Friday'. Leave empty if no urgency applies.",
        extractKey: "urgency",
      },
      {
        key: "scarcity",
        label: "Scarcity",
        type: "text",
        placeholder: "e.g. Only 1 seat open, small team of 4 engineers",
        description:
          "Limited availability that creates FOMO — single position, small team, exclusive role. Examples: 'Only 1 opening', 'Founding engineer role — not publicly listed'. Leave empty if not applicable.",
        extractKey: "scarcity",
      },
      {
        key: "riskReversal",
        label: "Risk Reversal",
        type: "text",
        placeholder: "e.g. Just a conversation, no commitment required",
        description:
          "What reduces friction in responding — no commitment, confidential process, casual first chat. Examples: 'Just a conversation, no strings attached', 'Fully confidential process'. Helps overcome hesitation.",
        extractKey: "risk_reversal",
      },
      {
        key: "socialProof",
        label: "Social Proof",
        type: "textarea",
        placeholder: "e.g. 4.8 Glassdoor rating, $40M Series B, backed by a16z, team ex-Google/Stripe",
        description:
          "Trust signals that build credibility — Glassdoor score, funding, press, notable team pedigree, culture awards. The LLM uses this to add credibility to the outreach.",
        extractKey: "social_proof",
      },
    ],

    outputs: [
      { key: "leadsServed",              displayOrder: 1 },
      { key: "emailsGenerated",          displayOrder: 2 },
      { key: "emailsSent",              displayOrder: 3 },
      { key: "emailsOpened",            displayOrder: 4 },
      { key: "repliesPositive",          displayOrder: 5 },
      { key: "repliesNegative",          displayOrder: 6 },
      { key: "repliesNeutral",           displayOrder: 7 },
      { key: "positiveReplyRate",        displayOrder: 8 },
      { key: "costPerPositiveReplyCents", displayOrder: 9, defaultSort: true, sortDirection: "asc" },
    ],

    charts: [
      {
        key: "funnel",
        type: "funnel-bar",
        title: "Campaign Funnel",
        displayOrder: 1,
        steps: [
          { key: "leadsServed" },
          { key: "emailsGenerated" },
          { key: "emailsSent" },
          { key: "emailsOpened" },
          { key: "repliesPositive" },
        ],
      },
      {
        key: "replyBreakdown",
        type: "breakdown-bar",
        title: "Reply Breakdown",
        displayOrder: 2,
        segments: [
          { key: "repliesPositive",  color: "green",  sentiment: "positive" },
          { key: "repliesNeutral",   color: "gray",   sentiment: "neutral" },
          { key: "repliesNegative",  color: "red",    sentiment: "negative" },
          { key: "repliesAutoReply", color: "orange", sentiment: "neutral" },
        ],
      },
    ],

    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
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
      { key: "outletsDiscovered",  displayOrder: 1 },
      { key: "avgRelevanceScore",  displayOrder: 2 },
      { key: "searchQueriesUsed",  displayOrder: 3 },
      { key: "costPerOutletCents", displayOrder: 4, defaultSort: true, sortDirection: "asc" },
    ],

    charts: [
      {
        key: "discoveryFunnel",
        type: "funnel-bar",
        title: "Discovery Funnel",
        displayOrder: 1,
        steps: [
          { key: "searchQueriesUsed" },
          { key: "outletsDiscovered" },
        ],
      },
      {
        key: "qualityBreakdown",
        type: "breakdown-bar",
        title: "Relevance Breakdown",
        displayOrder: 2,
        segments: [
          { key: "outletsDiscovered", color: "green", sentiment: "positive" },
          { key: "searchQueriesUsed", color: "blue",  sentiment: "neutral" },
        ],
      },
    ],

    entities: [
      { name: "outlets", countKey: "outletsDiscovered" },
    ],
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
      { key: "journalistsFound",        displayOrder: 1 },
      { key: "emailsGenerated",         displayOrder: 2 },
      { key: "journalistsContacted",    displayOrder: 3 },
      { key: "emailsSent",              displayOrder: 4 },
      { key: "emailsOpened",            displayOrder: 5 },
      { key: "repliesPositive",          displayOrder: 6 },
      { key: "repliesNegative",          displayOrder: 7 },
      { key: "repliesNeutral",           displayOrder: 8 },
      { key: "positiveReplyRate",        displayOrder: 9 },
      { key: "costPerPositiveReplyCents", displayOrder: 10, defaultSort: true, sortDirection: "asc" },
    ],

    charts: [
      {
        key: "funnel",
        type: "funnel-bar",
        title: "Campaign Funnel",
        displayOrder: 1,
        steps: [
          { key: "journalistsFound" },
          { key: "emailsGenerated" },
          { key: "journalistsContacted" },
          { key: "emailsSent" },
          { key: "emailsOpened" },
          { key: "repliesPositive" },
        ],
      },
      {
        key: "replyBreakdown",
        type: "breakdown-bar",
        title: "Reply Breakdown",
        displayOrder: 2,
        segments: [
          { key: "repliesPositive",  color: "green",  sentiment: "positive" },
          { key: "repliesNeutral",   color: "gray",   sentiment: "neutral" },
          { key: "repliesNegative",  color: "red",    sentiment: "negative" },
          { key: "repliesAutoReply", color: "orange", sentiment: "neutral" },
        ],
      },
    ],

    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "journalists", countKey: "journalistsFound" },
      { name: "emails", countKey: "emailsGenerated" },
      { name: "press-kits" },
    ],
  },

  // ─── PR Cold Email Outreach Sophia (fork) ────────────────────────────────
  {
    name: "PR Cold Email Outreach Sophia",
    description: "Pitch journalists and editors with personalized cold emails for press coverage.",
    icon: "megaphone",
    category: "pr",
    channel: "email",
    audienceType: "cold-outreach",
    implemented: true,
    displayOrder: 3,
    status: "active",

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
      { key: "journalistsContacted",    displayOrder: 1 },
      { key: "emailsGenerated",         displayOrder: 2 },
      { key: "emailsSent",              displayOrder: 3 },
      { key: "emailsOpened",            displayOrder: 4 },
      { key: "openRate",                displayOrder: 5 },
      { key: "costPerOpenCents",        displayOrder: 6 },
      { key: "repliesPositive",          displayOrder: 7 },
      { key: "repliesNegative",          displayOrder: 8 },
      { key: "repliesNeutral",           displayOrder: 9 },
      { key: "positiveReplyRate",        displayOrder: 10 },
      { key: "costPerPositiveReplyCents", displayOrder: 11, defaultSort: true, sortDirection: "asc" },
    ],

    charts: [
      {
        key: "funnel",
        type: "funnel-bar",
        title: "Outreach Funnel",
        displayOrder: 1,
        steps: [
          { key: "journalistsContacted" },
          { key: "emailsGenerated" },
          { key: "emailsSent" },
          { key: "emailsOpened" },
          { key: "repliesPositive" },
        ],
      },
      {
        key: "replyBreakdown",
        type: "breakdown-bar",
        title: "Reply Breakdown",
        displayOrder: 2,
        segments: [
          { key: "repliesPositive",  color: "green",  sentiment: "positive" },
          { key: "repliesNeutral",   color: "gray",   sentiment: "neutral" },
          { key: "repliesNegative",  color: "red",    sentiment: "negative" },
          { key: "repliesAutoReply", color: "orange", sentiment: "neutral" },
        ],
      },
    ],

    entities: [
      { name: "outlets" },
      { name: "journalists", countKey: "journalistsContacted" },
      { name: "emails", countKey: "emailsGenerated" },
      { name: "articles" },
    ],
  },

  // ─── Press Kit Page Generation ────────────────────────────────────────────
  {
    name: "Press Kit Page Generation",
    description: "Generate and publish branded press kit pages with AI-powered content.",
    icon: "file-text",
    category: "pr",
    channel: "page",
    audienceType: "content-generation",
    implemented: true,
    displayOrder: 4,
    status: "active",

    inputs: [
      {
        key: "prAngle",
        label: "PR Angle",
        type: "text",
        placeholder: "Series B funding announcement, product launch...",
        description:
          "The editorial hook or story angle for the press kit. Should be newsworthy and specific. Examples: 'Series B funding of $25M led by Sequoia', 'Launch of AI-powered compliance platform'. The LLM uses this as the core narrative for the press kit.",
        extractKey: "suggestedAngles",
      },
      {
        key: "companyContext",
        label: "Company Context",
        type: "text",
        placeholder: "What does your company do and why is this relevant now?",
        description:
          "Brief background on the company. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers', 'Only platform certified for EU AI Act compliance'. Gives the LLM credibility context for the press kit content.",
        extractKey: "companyDescription",
      },
      {
        key: "spokesperson",
        label: "Spokesperson",
        type: "text",
        placeholder: "Jane Doe, CEO — available for interviews",
        description:
          "Who is available for interviews or quotes. Include name, title, and any notable credentials. Examples: 'John Smith, CTO — ex-Google, published AI researcher'. The LLM includes this in the press kit's contact section.",
        extractKey: "spokesperson",
      },
    ],

    outputs: [
      { key: "pressKitsGenerated",        displayOrder: 1 },
      { key: "pressKitViews",             displayOrder: 2 },
      { key: "pressKitUniqueVisitors",    displayOrder: 3 },
      { key: "costPerPressKitCents",      displayOrder: 4, defaultSort: true, sortDirection: "asc" },
      { key: "costPerPressKitViewCents",  displayOrder: 5 },
    ],

    charts: [
      {
        key: "pressKitFunnel",
        type: "funnel-bar",
        title: "Press Kit Funnel",
        displayOrder: 1,
        steps: [
          { key: "pressKitsGenerated" },
          { key: "pressKitViews" },
          { key: "pressKitUniqueVisitors" },
        ],
      },
      {
        key: "viewsBreakdown",
        type: "breakdown-bar",
        title: "Views Breakdown",
        displayOrder: 2,
        segments: [
          { key: "pressKitViews",          color: "blue",  sentiment: "neutral" },
          { key: "pressKitUniqueVisitors", color: "green", sentiment: "positive" },
        ],
      },
    ],

    entities: [
      { name: "press-kits", countKey: "pressKitsGenerated" },
    ],
  },
];
