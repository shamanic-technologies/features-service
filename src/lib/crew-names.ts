/**
 * THE CREW NAME of a leg a channel performs — the teammate name a customer sees in the product
 * (dashboard v2 "Crew"): "Herald brought 12 positive replies", "Scout brought 40 visits".
 *
 * Published on `/public/channels` (`channels[].stepTransitions[].crewName`) so every surface — the
 * dashboard, billing-service's staff budget email, anything later — names a crew from ONE source
 * instead of keeping its own copy that drifts.
 *
 * Resolution, byte-equal with the dashboard's original `lib/v2/crews.ts`:
 *   1. a (channel, landing step) pair with its own name;
 *   2. else the channel's one name for all of its legs;
 *   3. else null — a channel nobody named has NO crew name, and none is invented here (a consumer
 *      falls back to the channel's own `name`).
 *
 * Only the NAME lives here; a crew's colour and glyph are a dashboard concern.
 */

/** `<channel slug>|<landing step key>` → name. */
const LEG_CREW_NAMES: Readonly<Record<string, string>> = {
  "sales-cold-email-outreach|website_visit": "Scout",
  "sales-cold-email-outreach|conversation": "Herald",
  "feedback-request-cold-email-outreach|conversation": "Echo",
  "feedback-request-cold-email-outreach|website_visit": "Relay",
  "pr-expert-quote-outreach|website_visit": "Quill",
  "sales-crm-email-outreach|conversation": "Anchor",
  "sales-crm-email-outreach|website_visit": "Beacon",
};

/** Channel slug → the one name all of its legs carry when the pair has none of its own. */
const CHANNEL_CREW_NAMES: Readonly<Record<string, string>> = {
  "ai-meeting-booking": "Pilot",
  "pr-cold-email-outreach": "Scribe",
  "pr-expert-quote-outreach": "Quill",
  "pr-expert-quote-opportunities": "Ledger",
  "google-ads": "Signal",
};

/** The crew name of the leg `channelSlug` performs landing on `toStep`, or null when nobody named it. */
export function crewNameFor(channelSlug: string, toStep: string): string | null {
  return LEG_CREW_NAMES[`${channelSlug}|${toStep}`] ?? CHANNEL_CREW_NAMES[channelSlug] ?? null;
}
