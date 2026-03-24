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
        type: "textarea",
        placeholder: "CTOs at SaaS startups with 10-50 employees",
        description:
          "The specific audience segment this campaign targets. Be precise about job titles, industry vertical, company size range, and geography. Example: 'VP of Marketing at B2B SaaS companies with 50-200 employees in the US'. The LLM uses this to find matching leads and personalize outreach.",
        extractKey: "targetAudience",
      },
      {
        key: "targetOutcome",
        label: "Target Outcome",
        type: "text",
        placeholder: "Book a product demo",
        description:
          "The desired action you want the prospect to take after reading the email. Should be a single, clear call-to-action. Examples: 'Book a 15-min demo call', 'Start a free trial', 'Schedule a discovery call'. The LLM uses this to craft the email CTA.",
        extractKey: "targetOutcome",
      },
      {
        key: "valueForTarget",
        label: "Value for Target",
        type: "textarea",
        placeholder: "Reduce hiring time by 50% with AI-powered screening",
        description:
          "The core value proposition for the target audience — what they gain by engaging. Should be specific and quantified when possible. Examples: 'Cut infrastructure costs by 40%', 'Ship features 3x faster with our CI/CD platform'. The LLM uses this as the main selling point in the email body.",
        extractKey: "valueProposition",
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
    category: "pr",
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
        placeholder: "B2B SaaS, Developer Tools",
        description:
          "The industry or vertical the brand operates in. Be specific — this drives which media outlets are searched. Examples: 'Enterprise cybersecurity', 'Consumer fintech', 'Climate tech / clean energy'. The discovery engine uses this to generate targeted search queries.",
        extractKey: "industry",
      },
      {
        key: "targetGeo",
        label: "Target Geography",
        type: "text",
        placeholder: "United States, Europe",
        description:
          "The geographic regions where the brand wants press coverage. Can be countries, regions, or cities. Examples: 'US and UK', 'DACH region', 'San Francisco Bay Area'. Determines whether to search local, national, or international outlets.",
        extractKey: "targetGeo",
      },
      {
        key: "targetAudience",
        label: "Target Audience",
        type: "textarea",
        placeholder: "Technical decision-makers at mid-market companies",
        description:
          "Who the brand wants to reach through press coverage. This helps identify outlets whose readership matches. Examples: 'Enterprise CTOs evaluating security tools', 'Startup founders raising Series A-B', 'HR leaders at Fortune 500 companies'.",
        extractKey: "targetAudience",
      },
      {
        key: "angles",
        label: "PR Angles",
        type: "textarea",
        placeholder: "Product launch, funding announcement, thought leadership on AI in hiring",
        description:
          "The editorial angles or story hooks the brand wants to pitch. Comma-separated or one per line. Examples: 'Series B funding announcement', 'New product launch for SMBs', 'Thought leadership on AI regulation'. Helps match outlets that cover these topics.",
        extractKey: "prAngles",
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
];
