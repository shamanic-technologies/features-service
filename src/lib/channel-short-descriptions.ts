/**
 * THE CARD CAPTION OF EVERY PUBLISHED CHANNEL — one plain line printed under the channel's name on the
 * small selectable cards (onboarding "Which channels may we use?", the offer's sales path page), so a
 * visitor knows what ticking it means. The channel twin of a step's `shortDescription`
 * (`acquisition-channels.ts`): the long `description` stays the marketing paragraph other surfaces read.
 *
 * Served as `/public/channels` `channels[].shortDescription`. Rules: about 8 words (10 at most), plain words, no
 * em/en dash, no model/workflow vocabulary, never "funnel". The three channels we run carry the owner's
 * approved copy VERBATIM (2026-10-06): change them only on the owner's words.
 *
 * Every published channel MUST have one: `channelShortDescription` throws on a slug with none, so a new
 * channel row fails the catalogue read loudly instead of rendering an empty card. Guard:
 * `channel-short-descriptions.test.ts` (every seeded channel has a caption that follows the rules).
 */

export const CHANNEL_SHORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // The three we run: owner-approved copy, verbatim.
  "sales-cold-email-outreach": "We find your buyers and email them for you.",
  "ai-meeting-booking": "Our AI answers replies and books the meeting.",
  "ai-instant-call": "A buyer says yes? We ring your rep right away.",

  // Outbound, one to one
  "pr-cold-email-outreach": "We pitch your story to the right journalists.",
  "pr-expert-quote-outreach": "We answer journalist requests to earn you press.",
  "sales-crm-email-outreach": "We email the contacts already in your CRM.",
  "feedback-request-cold-email-outreach": "We ask buyers for feedback, not a sale.",
  "cold-call-outreach": "We call your buyers to start a conversation.",
  "cold-sms-outreach": "We text your buyers to start a conversation.",
  "cold-whatsapp-outreach": "We message your buyers on WhatsApp.",
  "cold-linkedin-outreach": "We message your buyers on LinkedIn.",
  "cold-x-outreach": "We message your buyers on X.",
  "cold-instagram-outreach": "We message your buyers on Instagram.",
  "cold-reddit-outreach": "We message your buyers on Reddit.",

  // Paid reach
  "google-ads": "Ads shown when buyers search on Google.",
  "meta-ads": "Ads for your buyers on Facebook and Instagram.",
  "linkedin-ads": "LinkedIn ads aimed at your buyers' job titles.",
  "tiktok-ads": "Short video ads for your buyers on TikTok.",
  "youtube-ads": "Video ads for your buyers on YouTube.",
  "x-ads": "Ads for your buyers on X.",
  "reddit-ads": "Ads in the communities your buyers read.",
  "bing-ads": "Ads shown when buyers search on Bing.",
  "quora-ads": "Ads beside the questions your buyers ask.",
  "newsletter-sponsorships": "Your ad in newsletters your buyers read.",
  "podcast-sponsorships": "Your ad on podcasts your buyers hear.",
  "creator-sponsorships": "Creators your buyers follow show your product.",
  "paid-directory-listings": "A top spot in software directories.",

  // Earned
  "seo-content": "Articles that bring buyers in from search.",
  "press-placements": "Articles about you in real publications.",
  "podcast-guesting": "We book you as a guest on podcasts.",
  "affiliate-programme": "Partners send you buyers, paid on sales.",
  "organic-linkedin-publishing": "We post on LinkedIn in your name.",
  "organic-x-publishing": "We post on X in your name.",
  "organic-reddit-publishing": "We post where your buyers talk on Reddit.",
  "organic-youtube-publishing": "We publish videos your buyers search for.",

  // Conversion
  "agency-meeting-booking": "Our team turns replies into booked meetings.",
  "your-team-meeting-booking": "Your team answers replies and books meetings.",
  "agency-meeting-attendance": "Our team makes sure buyers show up.",
  "your-team-meeting-attendance": "Your team reminds buyers so they show up.",
  "agency-closing-calls": "Our closer runs your meetings and closes deals.",
  "your-team-closing-calls": "You run the meetings and close the deals.",
  "agency-signup-conversion": "Our team turns signups into paying clients.",
  "your-team-signup-conversion": "Your team turns signups into paying clients.",
};

export class MissingChannelShortDescriptionError extends Error {
  constructor(slug: string) {
    super(`Channel "${slug}" has no card caption in CHANNEL_SHORT_DESCRIPTIONS (lib/channel-short-descriptions.ts)`);
    this.name = "MissingChannelShortDescriptionError";
  }
}

/** The card caption of a published channel. FAIL LOUD on a slug with none: an empty card is a silent gap. */
export function channelShortDescription(slug: string): string {
  const caption = CHANNEL_SHORT_DESCRIPTIONS[slug];
  if (caption === undefined) throw new MissingChannelShortDescriptionError(slug);
  return caption;
}
