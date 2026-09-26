/**
 * A BRAND'S FUNNEL REACH OVER ITS WHOLE CRM — how many distinct CRM contacts ever reached each step.
 *
 * crm-service `GET /internal/gohighlevel/funnel-reach?brandId=&orgId=` (x-api-key only, org-less twin
 * of `/orgs/gohighlevel/funnel-reach`, crm-service#37). Shape conforms to what crm-service DEPLOYS;
 * nothing here is authored by features-service:
 *
 *   { brandId, available: true, steps: [{ step, contacts, contactsAtOrBeyond, bySource }], coverage }
 *   { brandId, available: false, reason: "no_connection" | "not_synced" | "stage_meanings_pending", coverage | null }
 *
 * `contacts` is DIRECT evidence of the step; `contactsAtOrBeyond` also counts contacts evidenced at a
 * later step (GoHighLevel keeps no stage history). The producer says to divide `contactsAtOrBeyond`.
 *
 * FAIL-LOUD: any transport / non-OK / malformed answer throws. The caller decides the degrade (the
 * effective-rates measurement falls back to today's lead-only behaviour, visibly).
 */
import { fetchWithRetry } from "./fetch-retry.js";

export const CRM_REACH_STEPS = [
  "form_submitted",
  "meeting_booked",
  "meeting_attended",
  "meeting_not_held",
  "sale",
  "deal_lost",
] as const;
export type CrmReachStep = (typeof CRM_REACH_STEPS)[number];

export interface CrmReachStepCount {
  step: CrmReachStep;
  /** Contacts carrying DIRECT evidence of this step. */
  contacts: number;
  /** Contacts evidenced at this step OR a later one — the figure a rate divides. */
  contactsAtOrBeyond: number;
}

export type CrmReachUnavailableReason = "no_connection" | "not_synced" | "stage_meanings_pending";

export type CrmFunnelReach =
  | {
      available: true;
      steps: CrmReachStepCount[];
      totalContacts: number | null;
      lastSyncedAt: string | null;
    }
  | { available: false; reason: CrmReachUnavailableReason };

const UNAVAILABLE_REASONS: readonly string[] = ["no_connection", "not_synced", "stage_meanings_pending"];

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** PURE: parse the deployed body. Throws on anything the contract does not describe. */
export function parseCrmFunnelReach(body: unknown): CrmFunnelReach {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || typeof b.available !== "boolean") {
    throw new Error("crm-service funnel-reach: malformed body (no `available`)");
  }
  if (!b.available) {
    if (typeof b.reason !== "string" || !UNAVAILABLE_REASONS.includes(b.reason)) {
      throw new Error(`crm-service funnel-reach: unrecognised unavailable reason ${JSON.stringify(b.reason)}`);
    }
    return { available: false, reason: b.reason as CrmReachUnavailableReason };
  }
  if (!Array.isArray(b.steps)) throw new Error("crm-service funnel-reach: available but no `steps`");
  const steps: CrmReachStepCount[] = [];
  for (const raw of b.steps as Array<Record<string, unknown>>) {
    // A step this service does not know is skipped, not fatal: the producer may grow its vocabulary.
    if (!(CRM_REACH_STEPS as readonly string[]).includes(raw?.step as string)) continue;
    if (!isCount(raw.contacts) || !isCount(raw.contactsAtOrBeyond)) {
      throw new Error(`crm-service funnel-reach: step ${String(raw.step)} carries no integer counts`);
    }
    steps.push({ step: raw.step as CrmReachStep, contacts: raw.contacts, contactsAtOrBeyond: raw.contactsAtOrBeyond });
  }
  const coverage = (b.coverage ?? null) as Record<string, unknown> | null;
  return {
    available: true,
    steps,
    totalContacts: coverage && isCount(coverage.totalContacts) ? coverage.totalContacts : null,
    lastSyncedAt: coverage && typeof coverage.lastSyncedAt === "string" ? coverage.lastSyncedAt : null,
  };
}

export async function fetchCrmFunnelReach(brandId: string, orgId: string): Promise<CrmFunnelReach> {
  const base = process.env.CRM_SERVICE_URL;
  const apiKey = process.env.CRM_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("CRM_SERVICE_URL or CRM_SERVICE_API_KEY not configured");
  const qs = new URLSearchParams({ brandId });
  // The org is sent so a brand two orgs connect resolves to the caller's connection, never a 409.
  if (orgId) qs.set("orgId", orgId);
  const res = await fetchWithRetry(`${base}/internal/gohighlevel/funnel-reach?${qs}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`crm-service GET /internal/gohighlevel/funnel-reach: ${res.status} ${text.slice(0, 200)}`);
  }
  return parseCrmFunnelReach(await res.json());
}
