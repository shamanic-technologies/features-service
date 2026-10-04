/**
 * The MINIMUM monthly budget a customer commits per (channel × leg) item, and whether a leg is REACTIVE
 * (owner 2026-10-04: the customer activates several sales paths per offer and budgets each channel × leg
 * item; billing-service enforces the minimum, the dashboard renders it, nobody hard-codes it).
 *
 * - A leg is REACTIVE when it moves a lead out of a step the lead already reached (`fromStep` set), and
 *   PROACTIVE when it starts from nothing (an entry leg). Read from the leg catalogue, never per channel.
 * - A channel the customer's own team works (`operatedBy: customer`) costs us nothing: $0.
 * - A channel we do not run yet: $1,500/month on every leg ("we only code it if enough money comes in").
 * - A channel we run, on a PROACTIVE leg: $99/month (cold email's website-visit and conversation entries).
 * - A channel we run, on a REACTIVE leg (AI meeting booking, AI instant call): $0. Its spend follows the
 *   leads the earlier legs deliver, so billing cannot hold a monthly floor against it; a floor it cannot
 *   enforce would be a figure nobody keeps.
 */
/** The ONLY channels the platform manages today. A leg nothing here publishes is the customer's team. */
export const MANAGED_CHANNEL_SLUGS: ReadonlySet<string> = new Set([
  "sales-cold-email-outreach",
  "ai-meeting-booking",
  "ai-instant-call",
]);

export const MANAGED_PROACTIVE_MINIMUM_MONTHLY_CENTS = 9_900;
export const NOT_RUN_YET_MINIMUM_MONTHLY_CENTS = 150_000;

/** PURE: the minimum monthly budget of one (channel × leg) item, in whole cents. `reactive` = the leg has a from step. */
export function channelLegMinimumMonthlyCents(
  channel: { slug: string; operatedBy: "platform" | "customer" },
  reactive: boolean,
): number {
  if (channel.operatedBy === "customer") return 0;
  if (!MANAGED_CHANNEL_SLUGS.has(channel.slug)) return NOT_RUN_YET_MINIMUM_MONTHLY_CENTS;
  return reactive ? 0 : MANAGED_PROACTIVE_MINIMUM_MONTHLY_CENTS;
}
