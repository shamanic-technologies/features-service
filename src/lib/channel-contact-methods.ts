/**
 * HOW A CHANNEL REACHES A PERSON — the contact method(s) a person must carry for a one-to-one channel to write to them
 * (owner 2026-10-12: a serve made FOR a pipe never consumes a person that pipe cannot reach, one mechanism for every
 * channel and provider).
 *
 * Stated once here for every channel that writes to one person at a time; served on `/public/sourcing-origins`
 * `contactMethodsByChannel`. lead-service reads it to tell human-service / crm-service which people a serve may hand
 * out (`reachableBy`); nobody keeps a slug list of their own. A channel absent from this map states no method: its
 * serves pass no requirement (today's behaviour). ALL listed methods are required.
 *
 * `channel-contact-methods.test.ts` fails when an OUTBOUND channel (lib/channel-types.ts) states none.
 */

export const CONTACT_METHODS = ["email", "phone", "linkedin", "x", "instagram", "reddit"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export const CONTACT_METHODS_BY_CHANNEL: Readonly<Record<string, readonly ContactMethod[]>> = {
  // Email: the person must carry an address we write to.
  "sales-cold-email-outreach": ["email"],
  "feedback-request-cold-email-outreach": ["email"],
  "sales-crm-email-outreach": ["email"],
  "pr-cold-email-outreach": ["email"],
  "vc-cold-email-outreach": ["email"],
  "accelerators-cold-email-outreach": ["email"],
  "hiring-cold-email-outreach": ["email"],
  // A phone number: a call, a text, a WhatsApp message.
  "cold-call-outreach": ["phone"],
  "cold-sms-outreach": ["phone"],
  "cold-whatsapp-outreach": ["phone"],
  // A profile on the network the channel writes on.
  "cold-linkedin-outreach": ["linkedin"],
  "cold-x-outreach": ["x"],
  "cold-instagram-outreach": ["instagram"],
  "cold-reddit-outreach": ["reddit"],
};

/** The methods a channel needs, or null when it states none. */
export function contactMethodsOf(channelSlug: string): readonly ContactMethod[] | null {
  return CONTACT_METHODS_BY_CHANNEL[channelSlug] ?? null;
}
