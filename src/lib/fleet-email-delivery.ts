/**
 * FLEET EMAIL DELIVERY (owner 2026-10-13, DefiniteJobs: "what share of the emails you send reach the inbox?").
 *
 * One fleet-wide figure, served on `/public/channels` `emailDelivery` and never computed by a consumer: of every
 * email our sending inboxes sent since inception, the share the recipient's server ACCEPTED (bounces excluded).
 * Email-grain (follow-ups included), from email-gateway's own counters (`/public/stats` `broadcast.emailStats`,
 * no feature filter = every channel that sends from our inboxes, Sales Cold Email Outreach included). Product /
 * transactional email (Postmark) is NOT our sending fleet and is left out. A channel with no history of its own
 * yet (Email Sending, 2026-10-13) reads this basis, and the basis says so.
 *
 * Unreadable producer = every figure null + `unavailableReason`, logged loud: never a guessed rate, and never a
 * reason to 502 the catalogue it rides on.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface FleetEmailDelivery {
  sentEmails: number | null;
  deliveredEmails: number | null;
  bouncedEmails: number | null;
  /** deliveredEmails / sentEmails x 100, 2 decimals. Null when nothing was sent or the producer is unreadable. */
  deliveryRatePct: number | null;
  basis: "every_email_our_sending_inboxes_sent";
  unavailableReason: "email_gateway_unavailable" | "no_email_sent" | null;
}

const BASIS = "every_email_our_sending_inboxes_sent" as const;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** PURE: the figure from email-gateway's `/public/stats` body. */
export function fleetEmailDeliveryOf(body: unknown): FleetEmailDelivery {
  const stats = (body as { broadcast?: { emailStats?: Record<string, unknown> } } | null)?.broadcast?.emailStats;
  const sent = count(stats?.sent);
  const delivered = count(stats?.delivered);
  const bounced = count(stats?.bounced);
  if (sent === null || delivered === null || bounced === null) {
    throw new Error(`[features-service] email-gateway /public/stats has no broadcast.emailStats sent/delivered/bounced`);
  }
  if (sent === 0) return { sentEmails: 0, deliveredEmails: delivered, bouncedEmails: bounced, deliveryRatePct: null, basis: BASIS, unavailableReason: "no_email_sent" };
  return {
    sentEmails: sent,
    deliveredEmails: delivered,
    bouncedEmails: bounced,
    deliveryRatePct: Math.round((delivered / sent) * 10_000) / 100,
    basis: BASIS,
    unavailableReason: null,
  };
}

export async function fetchFleetEmailDelivery(): Promise<FleetEmailDelivery> {
  try {
    const res = await fetchWithRetry(`${process.env.EMAIL_GATEWAY_SERVICE_URL}/public/stats`, {
      headers: { "x-api-key": process.env.EMAIL_GATEWAY_SERVICE_API_KEY! },
    });
    if (!res.ok) throw new Error(`email-gateway /public/stats ${res.status}: ${await res.text()}`);
    return fleetEmailDeliveryOf(await res.json());
  } catch (err) {
    console.error("[features-service] fleet email delivery unreadable, served null:", err);
    return { sentEmails: null, deliveredEmails: null, bouncedEmails: null, deliveryRatePct: null, basis: BASIS, unavailableReason: "email_gateway_unavailable" };
  }
}
