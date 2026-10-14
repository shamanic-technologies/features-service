/**
 * EMAIL DELIVERY BY VERIFICATION VERDICT (amarillo-v2 2026-10-14: a client email quotes "how many of the emails we
 * send reach the inbox, by what our verifier said about the address"; the client copy may only quote SERVED figures).
 *
 * Every address is checked by BounceVerify (via apollo-service) before we send; this splits fleet delivery since
 * inception by the verdict the address had WHEN the first email left (valid / catch_all / unknown / invalid / risky /
 * a verification that returned no verdict / never verified before the send). Read from instantly-service
 * `GET /internal/delivery-by-verdict`, which owns the send population (unit = a SEQUENCE: one address emailed under one
 * campaign), the verdict history mirror and the reconciliation of buckets against its own total. Two views, both
 * served and named: AT SEND (what we knew when the email left; verification started 2026-09-25, so most of the history
 * is `never_verified`) and LATEST (the verdict on record today, verifications after the send included). Served on
 * `/public/channels` `emailDeliveryByVerdict` beside the email-grain fleet `emailDelivery` (two bases, both named).
 *
 * Unreadable producer = every figure null + `unavailableReason`, logged loud, never a guessed rate, never a 502 of the
 * catalogue it rides on.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export const VERDICT_BUCKETS = ["valid", "catch_all", "unknown", "invalid", "risky", "no_verdict", "never_verified"] as const;
export type VerdictBucket = (typeof VERDICT_BUCKETS)[number];

export interface DeliveryFigures {
  /** Sequences whose first real email left. */
  sent: number;
  /** Of them, sequences with no bounce on any step. */
  delivered: number;
  /** Of them, sequences where a step bounced. */
  bounced: number;
  /** delivered / sent x 100, 2 decimals; null when nothing was sent. */
  deliveryRatePct: number | null;
  /** bounced / sent x 100, 2 decimals; null when nothing was sent. */
  bounceRatePct: number | null;
}

export interface EmailDeliveryByVerdict {
  basis: "sequences";
  /** First real email of the earliest counted sequence. */
  since: string | null;
  /** Sequences first sent after this instant are not counted yet. */
  sentThrough: string | null;
  /** Earliest verification on record: sequences sent before it can only be `never_verified`. */
  verificationsSince: string | null;
  /** All 7 verdicts, always present, in a fixed order; they partition `total`. Null when unavailable. */
  byVerdictAtSend: Array<DeliveryFigures & { verdict: VerdictBucket }> | null;
  /** The SAME sequences by the verdict on record TODAY, verifications made after the send included: "how do addresses
   *  our verifier calls X fare", NOT "what we knew when sending". Same 7 verdicts, same total. */
  byLatestVerdict: Array<DeliveryFigures & { verdict: VerdictBucket }> | null;
  total: DeliveryFigures | null;
  unavailableReason: "instantly_service_unavailable" | "verification_history_not_synced" | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den === 0 ? null : round2((num / den) * 100));

function figuresOf(raw: unknown, what: string): DeliveryFigures {
  const r = raw as { sent?: unknown; delivered?: unknown; bounced?: unknown } | null;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!r || !ok(r.sent) || !ok(r.delivered) || !ok(r.bounced) || r.delivered + r.bounced !== r.sent) {
    throw new Error(`[features-service] instantly-service delivery-by-verdict: ${what} has no valid sent/delivered/bounced`);
  }
  return { sent: r.sent, delivered: r.delivered, bounced: r.bounced, deliveryRatePct: pct(r.delivered, r.sent), bounceRatePct: pct(r.bounced, r.sent) };
}

const unavailable = (reason: EmailDeliveryByVerdict["unavailableReason"]): EmailDeliveryByVerdict => ({
  basis: "sequences",
  since: null,
  sentThrough: null,
  verificationsSince: null,
  byVerdictAtSend: null,
  byLatestVerdict: null,
  total: null,
  unavailableReason: reason,
});

/** PURE: the served figure from instantly-service's body. Every verdict served, in order; buckets must sum to the total. */
export function emailDeliveryByVerdictOf(body: unknown): EmailDeliveryByVerdict {
  const b = body as {
    since?: unknown;
    sentThrough?: unknown;
    verificationsSince?: unknown;
    buckets?: Array<{ verdict?: unknown }>;
    bucketsByLatestVerdict?: Array<{ verdict?: unknown }>;
    total?: unknown;
  } | null;
  if (!b || !Array.isArray(b.buckets) || !Array.isArray(b.bucketsByLatestVerdict)) {
    throw new Error("[features-service] instantly-service delivery-by-verdict has no buckets");
  }
  const total = figuresOf(b.total, "total");
  const bucketsOf = (rows: Array<{ verdict?: unknown }>, view: string) => {
    const byVerdict = new Map<string, unknown>();
    for (const row of rows) byVerdict.set(String(row.verdict), row);
    const out = VERDICT_BUCKETS.map((verdict) => {
      if (!byVerdict.has(verdict)) throw new Error(`[features-service] instantly-service delivery-by-verdict: ${view} bucket ${verdict} missing`);
      return { verdict, ...figuresOf(byVerdict.get(verdict), `${view}.${verdict}`) };
    });
    const sum = out.reduce((s, x) => s + x.sent, 0);
    if (sum !== total.sent) throw new Error(`[features-service] instantly-service delivery-by-verdict: ${view} buckets sum ${sum} != total ${total.sent}`);
    return out;
  };
  const buckets = bucketsOf(b.buckets, "atSend");
  const latest = bucketsOf(b.bucketsByLatestVerdict, "latest");
  const iso = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    basis: "sequences",
    since: iso(b.since),
    sentThrough: iso(b.sentThrough),
    verificationsSince: iso(b.verificationsSince),
    byVerdictAtSend: buckets,
    byLatestVerdict: latest,
    total,
    unavailableReason: null,
  };
}

export async function fetchEmailDeliveryByVerdict(): Promise<EmailDeliveryByVerdict> {
  try {
    const res = await fetchWithRetry(`${process.env.INSTANTLY_SERVICE_URL}/internal/delivery-by-verdict`, {
      headers: { "x-api-key": process.env.INSTANTLY_SERVICE_API_KEY! },
    });
    if (res.status === 503) {
      console.error("[features-service] email delivery by verdict: instantly-service verification history not mirrored yet:", await res.text());
      return unavailable("verification_history_not_synced");
    }
    if (!res.ok) throw new Error(`instantly-service /internal/delivery-by-verdict ${res.status}: ${await res.text()}`);
    return emailDeliveryByVerdictOf(await res.json());
  } catch (err) {
    console.error("[features-service] email delivery by verdict unreadable, served null:", err);
    return unavailable("instantly_service_unavailable");
  }
}
