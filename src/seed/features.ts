/**
 * Canonical feature definitions — 5 features.
 * On cold start, these are upserted by slug into the DB.
 */

export interface SeedFeature {
  slug: string;
  name: string;
  description: string;
  icon: string;
  implemented: boolean;
  displayOrder: number;
  status: string;
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
    inputs: [
      { key: "targetAudience", type: "text", label: "Target Audience", extractKey: "targetAudience", description: "Who the campaign targets — ICP description (role, company size, industry). Be precise about job titles, industry vertical, company size range, and geography. Example: 'VP of Marketing at B2B SaaS companies with 50-200 employees in the US'. The LLM uses this to find matching leads and personalize outreach.", placeholder: "CTOs at SaaS startups with 10-50 employees" },
      { key: "targetOutcome", type: "text", label: "Target Outcome", extractKey: "callToAction", description: "The desired action from the recipient (book a call, sign up, reply, etc.). Should be a single, clear call-to-action. Examples: 'Book a 15-min demo call', 'Start a free trial', 'Schedule a discovery call'. The LLM uses this to craft the email CTA.", placeholder: "Book sales demos" },
      { key: "valueForTarget", type: "text", label: "Value for Target", extractKey: "valueProposition", description: "The core value proposition for the target audience — what they gain by engaging. Should be specific and quantified when possible. Examples: 'Cut infrastructure costs by 40%', 'Ship features 3x faster with our CI/CD platform'. The LLM uses this as the main selling point in the email body.", placeholder: "What do they gain from responding?" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "Time pressure to act — a deadline, event date, or expiring offer that motivates the recipient to respond quickly. Examples: 'Beta access closes Friday', 'Event is in 2 weeks', 'Pricing increases April 1st'. Leave empty if no urgency applies.", placeholder: "Limited-time offer ending March 1st" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "Limited availability that creates FOMO — spots, seats, inventory, or capacity constraints. Examples: 'Only 5 pilot slots left', 'Limited to 20 beta customers', 'First 50 sign-ups get lifetime pricing'. Leave empty if no scarcity applies.", placeholder: "Only 10 spots available" },
      { key: "riskReversal", type: "text", label: "Risk Reversal", extractKey: "riskReversal", description: "What reduces the perceived risk of responding — guarantees, free trials, or no-commitment offers. Examples: 'Free 14-day trial', '30-day money-back guarantee', 'No credit card required', 'Cancel anytime'. Helps overcome objections in the email.", placeholder: "Free trial, no commitment" },
      { key: "socialProof", type: "text", label: "Social Proof", extractKey: "socialProof", description: "Trust signals that build credibility — customer count, notable logos, testimonials, awards, or metrics. Examples: 'Trusted by 500+ SaaS companies', 'Featured in TechCrunch', 'NPS score of 72'. The LLM uses this to add credibility to the outreach.", placeholder: "500+ companies already onboarded" },
    ],
    outputs: [
      { key: "leadsServed", displayOrder: 1 },
      { key: "emailsGenerated", displayOrder: 2 },
      { key: "recipientsContacted", displayOrder: 3 },
      { key: "recipientsSent", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsClicked", displayOrder: 6 },
      { key: "recipientsRepliesPositive", displayOrder: 7 },
      { key: "recipientsRepliesNegative", displayOrder: 8 },
      { key: "recipientsRepliesNeutral", displayOrder: 9 },
      { key: "recipientPositiveReplyRate", displayOrder: 10 },
      { key: "recipientClickRate", displayOrder: 11 },
      { key: "costPerRecipientClickCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "leadsServed" }, { key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
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
      { key: "costPerRecipientOpenCents", displayOrder: 7 },
      { key: "recipientsRepliesPositive", displayOrder: 8 },
      { key: "recipientsRepliesNegative", displayOrder: 9 },
      { key: "recipientsRepliesNeutral", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 12, sortDirection: "asc" },
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
    inputs: [
      { key: "targetProfile", type: "textarea", label: "Target Candidate Profile", extractKey: "target_profile", description: "ICP description of the ideal candidate — role, seniority, skills, industry, geography. The LLM uses this to find matching leads and personalize outreach.", placeholder: "e.g. Senior Backend Engineer, 5+ years Go/Rust, startup experience, EU-based" },
      { key: "targetOutcome", type: "text", label: "Target Outcome", extractKey: "target_outcome", description: "The desired action from the candidate — should be a single, clear call-to-action. Examples: 'Book a 30-min intro call', 'Apply to the role', 'Schedule a discovery conversation'.", placeholder: "e.g. Book a 30-min intro call" },
      { key: "roleValueProp", type: "textarea", label: "Role Value Proposition", extractKey: "role_value_prop", description: "What makes the role and company attractive to the candidate — compensation, mission, growth, tech stack, remote policy, team culture. The LLM uses this as the main selling point.", placeholder: "e.g. Competitive comp, fully remote, Series B-backed, working on cutting-edge ML infrastructure" },
      { key: "urgency", type: "text", label: "Urgency", extractKey: "urgency", description: "Time pressure to act — a start date, hiring deadline, or closing window. Examples: 'Team onboarding in 6 weeks', 'Role closes Friday'. Leave empty if no urgency applies.", placeholder: "e.g. Role closes end of month, team starts Q3" },
      { key: "scarcity", type: "text", label: "Scarcity", extractKey: "scarcity", description: "Limited availability that creates FOMO — single position, small team, exclusive role. Examples: 'Only 1 opening', 'Founding engineer role — not publicly listed'. Leave empty if not applicable.", placeholder: "e.g. Only 1 seat open, small team of 4 engineers" },
      { key: "riskReversal", type: "text", label: "Risk Reversal", extractKey: "risk_reversal", description: "What reduces friction in responding — no commitment, confidential process, casual first chat. Examples: 'Just a conversation, no strings attached', 'Fully confidential process'. Helps overcome hesitation.", placeholder: "e.g. Just a conversation, no commitment required" },
      { key: "socialProof", type: "textarea", label: "Social Proof", extractKey: "social_proof", description: "Trust signals that build credibility — Glassdoor score, funding, press, notable team pedigree, culture awards. The LLM uses this to add credibility to the outreach.", placeholder: "e.g. 4.8 Glassdoor rating, $40M Series B, backed by a16z, team ex-Google/Stripe" },
    ],
    outputs: [
      { key: "leadsServed", displayOrder: 1 },
      { key: "emailsGenerated", displayOrder: 2 },
      { key: "recipientsContacted", displayOrder: 3 },
      { key: "recipientsSent", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientsClicked", displayOrder: 6 },
      { key: "recipientsRepliesPositive", displayOrder: 7 },
      { key: "recipientsRepliesNegative", displayOrder: 8 },
      { key: "recipientsRepliesNeutral", displayOrder: 9 },
      { key: "recipientPositiveReplyRate", displayOrder: 10 },
      { key: "recipientClickRate", displayOrder: 11 },
      { key: "costPerRecipientClickCents", displayOrder: 12 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 13, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Campaign Funnel", displayOrder: 1, steps: [{ key: "leadsServed" }, { key: "emailsGenerated" }, { key: "recipientsContacted" }, { key: "recipientsSent" }, { key: "recipientsOpened" }, { key: "recipientsClicked" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "leads", countKey: "leadsServed" },
      { name: "companies" },
      { name: "emails", countKey: "emailsGenerated" },
    ],
  },

  {
    slug: "pr-expert-quotes-outreach",
    name: "PR Expert Quotes Outreach",
    description: "Find relevant journalists, pitch your spokesperson as an expert source for quotes and commentary, and track engagement through the full outreach funnel.",
    icon: "quote",
    implemented: true,
    displayOrder: 4,
    status: "active",
    inputs: [
      { key: "targetOutlets", type: "text", label: "Target Outlets", extractKey: "targetOutlets", description: "Types of media outlets or specific publications to target. Be specific about outlet tier, beat, and format (online, print, podcast). Examples: 'Top-tier tech blogs (TechCrunch, The Verge)', 'B2B SaaS trade publications', 'Fintech newsletters with 10k+ subscribers'. The LLM uses this to find and prioritize matching journalists.", placeholder: "TechCrunch, Forbes, industry trade publications..." },
      { key: "expertiseTopics", type: "text", label: "Expertise Topics", extractKey: "expertiseTopics", description: "Topics the spokesperson can authoritatively comment on. Should be specific and tied to their experience. Examples: 'AI safety and alignment', 'B2B SaaS go-to-market', 'European fintech regulation'. The LLM uses this to match the spokesperson against journalist beats and ongoing stories.", placeholder: "AI safety, fintech regulation, developer productivity..." },
      { key: "spokesperson", type: "text", label: "Spokesperson", extractKey: "spokesperson", description: "Who is available for quotes and commentary. Include name, title, and notable credentials that establish authority. Examples: 'John Smith, CTO — ex-Google, published AI researcher, 15 years in ML', 'Sarah Chen, CEO — Forbes 30 Under 30, former McKinsey'. The LLM pitches them as a credible expert source.", placeholder: "Jane Doe, CEO — 15 years in fintech, ex-Stripe" },
      { key: "newsHook", type: "text", label: "News Hook", extractKey: "newsHook", description: "A timely event, trend, or news cycle that makes the expert's perspective relevant right now. Examples: 'Following new SEC crypto regulations', 'Ahead of OpenAI DevDay', 'During the recent banking crisis'. Helps the LLM frame the spokesperson as the right voice for current coverage.", placeholder: "Recent regulation change, industry event, breaking news..." },
      { key: "companyContext", type: "text", label: "Company Context", extractKey: "companyDescription", description: "Brief background on the company that gives the spokesperson their platform. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers, fastest-growing in category', 'Only platform certified for EU AI Act compliance'. Gives the LLM credibility context for the pitch.", placeholder: "What does your company do and why does the spokesperson have authority on this topic?" },
    ],
    outputs: [
      { key: "outletsDiscovered", displayOrder: 1 },
      { key: "emailsGenerated", displayOrder: 2 },
      { key: "journalistsContacted", displayOrder: 3 },
      { key: "recipientsSent", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientOpenRate", displayOrder: 6 },
      { key: "costPerRecipientOpenCents", displayOrder: 7 },
      { key: "recipientsRepliesPositive", displayOrder: 8 },
      { key: "recipientsRepliesNegative", displayOrder: 9 },
      { key: "recipientsRepliesNeutral", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 12, sortDirection: "asc" },
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
    slug: "outlet-database-discovery",
    name: "Outlet Database Discovery",
    description: "Discover relevant media outlets for your industry, geography, and PR angles using AI-powered search.",
    icon: "globe",
    implemented: true,
    displayOrder: 5,
    status: "active",
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
    displayOrder: 6,
    status: "active",
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
    name: "Expert Quote Outreach (Featured.com)",
    description: "Automatically respond to journalist quote requests on Featured.com to earn editorial backlinks.",
    icon: "award",
    implemented: true,
    displayOrder: 7,
    status: "active",
    inputs: [
      { key: "spokesperson", type: "text", label: "Spokesperson", extractKey: "spokesperson", description: "Who is available to provide expert quotes on Featured.com. Include name, title, and notable credentials that establish authority. Examples: 'John Smith, CTO — ex-Google, published AI researcher, 15 years in ML', 'Sarah Chen, CEO — Forbes 30 Under 30, former McKinsey'. Featured.com journalists evaluate the spokesperson's credibility before selecting a quote.", placeholder: "Jane Doe, CEO — 15 years in fintech, ex-Stripe" },
      { key: "expertiseTopics", type: "text", label: "Expertise Topics", extractKey: "expertiseTopics", description: "Topics the spokesperson can authoritatively comment on. Used to filter Featured.com quote requests for relevance. Be specific. Examples: 'AI safety and alignment', 'B2B SaaS go-to-market', 'European fintech regulation'. The matcher only routes requests that overlap with these topics to the spokesperson.", placeholder: "AI safety, fintech regulation, developer productivity..." },
      { key: "responseStyle", type: "textarea", label: "Response Style", extractKey: "responseStyle", description: "How the spokesperson speaks — voice, tone, length preferences, signature phrases. The LLM uses this to draft quote responses that sound authentic. Examples: 'Direct and data-driven, prefers short punchy quotes with a number or stat', 'Conversational, uses analogies, 2-3 sentences max'.", placeholder: "Direct, data-driven, 1-2 sentences with a stat" },
      { key: "companyContext", type: "text", label: "Company Context", extractKey: "companyDescription", description: "Brief background on the company that gives the spokesperson their platform. Include founding date, traction metrics, notable customers, or market position. Examples: 'Founded 2022, 500+ enterprise customers, fastest-growing in category', 'Only platform certified for EU AI Act compliance'. Provides credibility context to journalists.", placeholder: "What does your company do and why does the spokesperson have authority on this topic?" },
      { key: "valueProposition", type: "text", label: "Value Proposition", extractKey: "valueProposition", description: "What makes this expert source uniquely valuable for editorial coverage — proprietary data, contrarian view, first-hand experience. Examples: 'We see 200M+ B2B emails per month — unique sender-side data', 'Deployed AI agents at scale before most of the industry'. Helps the LLM differentiate the quote from generic responses.", placeholder: "Proprietary data, contrarian view, first-hand experience..." },
    ],
    outputs: [
      { key: "journalistsFound", displayOrder: 1 },
      { key: "emailsGenerated", displayOrder: 2 },
      { key: "journalistsContacted", displayOrder: 3 },
      { key: "recipientsSent", displayOrder: 4 },
      { key: "recipientsOpened", displayOrder: 5 },
      { key: "recipientOpenRate", displayOrder: 6 },
      { key: "costPerRecipientOpenCents", displayOrder: 7 },
      { key: "recipientsRepliesPositive", displayOrder: 8 },
      { key: "recipientsRepliesNegative", displayOrder: 9 },
      { key: "recipientsRepliesNeutral", displayOrder: 10 },
      { key: "recipientPositiveReplyRate", displayOrder: 11 },
      { key: "costPerRecipientPositiveReplyCents", defaultSort: true, displayOrder: 12, sortDirection: "asc" },
    ],
    charts: [
      { key: "funnel", type: "funnel-bar", title: "Quote Outreach Funnel", displayOrder: 1, steps: [{ key: "journalistsFound" }, { key: "emailsGenerated" }, { key: "journalistsContacted" }, { key: "recipientsSent" }, { key: "recipientsOpened" }, { key: "recipientsRepliesPositive" }] },
      { key: "replyBreakdown", type: "breakdown-bar", title: "Reply Breakdown", displayOrder: 2, segments: [{ key: "recipientsRepliesPositive", color: "green", sentiment: "positive" }, { key: "recipientsRepliesNeutral", color: "gray", sentiment: "neutral" }, { key: "recipientsRepliesNegative", color: "red", sentiment: "negative" }, { key: "recipientsRepliesAutoReply", color: "orange", sentiment: "neutral" }] },
    ],
    entities: [
      { name: "journalists", countKey: "journalistsContacted" },
      { name: "emails", countKey: "emailsGenerated" },
      { name: "articles" },
    ],
  },
];
