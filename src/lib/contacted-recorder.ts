/**
 * WHO RECORDS THAT A PIPE WROTE TO A PERSON (WA-CONTACTED-1014, owner rule: the infra is homogeneous).
 *
 * "Contacted" = a message actually went out to the person (owner 2026-10-12). For a channel that writes by
 * EMAIL, the sender's own aggregate states it: email-gateway `recipientStats.sent`, read per workflow slug by
 * every grain here, byte-unchanged. A channel that writes on anything else (WhatsApp, SMS, a call, a profile
 * message) never reaches email-gateway, so its per-slug figure was 0 there whatever it sent: campaign 4af21454
 * "Valued" (cold WhatsApp) wrote to 9 people on 2026-10-12 and every workflow grain of the channel read 0
 * contacted, so cost per contacted, ROI and the channel's workflow ranking were all computed over a zero.
 *
 * For those channels the fact lives on lead-service's SERVED ROWS: lead-service asks the channel's own sender
 * (crm-service's send record for WhatsApp) and folds a `sent` send of the campaign into the row's delivery
 * overlay (`withChannelSend`, lead-service v0.83.94), so the person reads `sent` there. This repo never
 * reconstructs a send: it counts the deduped persons lead-service states were sent to (`signals.contacted`,
 * `leads-client.ts`), per workflow slug, and REPLACES email-gateway's per-slug contacted with that count.
 *
 * WHICH channel takes which source is decided by the channel's own contact methods
 * (`lib/channel-contact-methods.ts`, the fact lead-service's `poolSenderOf` reads too): email among them, or
 * none stated = email-gateway; anything else = lead-service. Never a slug list, never a channel branch.
 */
import { contactMethodsOf } from "./channel-contact-methods.js";
import type { EnginePerson } from "./revenue-engine.js";
import { creditedSignal } from "./serving-row-credit.js";

export type ContactedRecorder = "email-gateway" | "lead-service";

/**
 * PURE. Who records the contacted people of `featureSlugs` (one slug, or a comma-separated lineage). A
 * lineage takes lead-service only when EVERY slug of it writes on a non-email channel: a mix keeps
 * email-gateway, today's answer.
 */
export function contactedRecorderOf(featureSlugs: string): ContactedRecorder {
  const slugs = featureSlugs.split(",").map((s) => s.trim()).filter(Boolean);
  if (slugs.length === 0) return "email-gateway";
  const writesByEmail = (slug: string) => {
    const methods = contactMethodsOf(slug);
    return !methods || methods.length === 0 || methods.includes("email");
  };
  return slugs.some(writesByEmail) ? "email-gateway" : "lead-service";
}

/**
 * PURE. Deduped persons lead-service states were contacted, per workflow slug (the slug of the row each
 * person survived dedup on). `campaignIds` narrows to persons served under those campaigns (a leg, a
 * campaign identity); omitted = every person.
 */
export function contactedPersonsBySlug(
  persons: readonly EnginePerson[],
  campaignIds?: ReadonlySet<string> | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of persons) {
    // Only a row whose campaign acted on the person counts it (lib/serving-row-credit.ts).
    if (!creditedSignal(p, "contacted") || !p.workflowSlug) continue;
    if (campaignIds && (!p.campaignId || !campaignIds.has(p.campaignId))) continue;
    out.set(p.workflowSlug, (out.get(p.workflowSlug) ?? 0) + 1);
  }
  return out;
}

/**
 * REPLACE every slug's contacted (and sent: on these channels the two are one fact, a message left) with
 * `counts`, IN PLACE. A slug absent from `counts` reads 0; a slug only `counts` knows is added. The one write
 * every grain uses, so no two grains can disagree on how.
 */
export function setContactedCountsOnSlugStats(
  statsBySlug: Map<string, Record<string, number>>,
  counts: ReadonlyMap<string, number>,
): void {
  for (const stats of statsBySlug.values()) {
    stats.recipientsContacted = 0;
    stats.recipientsSent = 0;
  }
  for (const [slug, n] of counts) {
    const existing = statsBySlug.get(slug) ?? {};
    existing.recipientsContacted = n;
    existing.recipientsSent = n;
    statsBySlug.set(slug, existing);
  }
}
