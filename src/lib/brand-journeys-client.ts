/**
 * lead-service's brand-wide TIMELINE read (`GET /internal/brands/:brandId/timeline-journeys`, x-org-id
 * scoped): every person x offer of the brand with its timeline facts (label, when, campaign, ours or not,
 * stated amount) and the acts of our campaigns on them (sends and follow-ups, first time). The input of the
 * lived sales paths (`lib/lived-sales-paths.ts`). FAIL-LOUD: a short or unreadable body would read as
 * people who did nothing, so the closing `count` is checked against the journeys parsed.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { Journey } from "./lived-sales-paths.js";

interface RawFact {
  label?: unknown;
  source?: unknown;
  occurredAt?: unknown;
  campaignId?: unknown;
  attributable?: unknown;
  valueCents?: unknown;
  screened?: unknown;
  sourceRef?: unknown;
}
interface RawAct {
  campaignId?: unknown;
  firstAt?: unknown;
  kind?: unknown;
}
interface RawEmailSend {
  campaignId?: unknown;
  workflowSlug?: unknown;
  firstSentAt?: unknown;
  lastSentAt?: unknown;
  transports?: Array<{ transport?: unknown }>;
}
interface RawJourney {
  leadId?: unknown;
  offerId?: unknown;
  facts?: RawFact[];
  acts?: RawAct[];
  emailSends?: RawEmailSend[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** PURE: one producer journey as the lived-path engine reads it. */
export function toJourney(raw: RawJourney): Journey {
  const leadId = str(raw.leadId);
  if (!leadId) throw new Error("lead-service timeline-journeys: a journey carries no leadId");
  return {
    leadId,
    offerId: str(raw.offerId),
    facts: (raw.facts ?? []).map((f) => {
      const label = str(f.label);
      if (!label) throw new Error(`lead-service timeline-journeys: a fact of lead ${leadId} carries no label`);
      const source = str(f.source);
      const sourceRef = str(f.sourceRef);
      return {
        label,
        ...(source ? { source } : {}),
        occurredAt: str(f.occurredAt),
        campaignId: str(f.campaignId),
        attributable: typeof f.attributable === "boolean" ? f.attributable : null,
        valueCents: typeof f.valueCents === "number" && Number.isFinite(f.valueCents) ? f.valueCents : null,
        // A click: recorded by our tracker (judged human) or reported by the provider (unscreened).
        ...(typeof f.screened === "boolean" ? { screened: f.screened } : {}),
        ...(sourceRef ? { sourceRef } : {}),
      };
    }),
    acts: (raw.acts ?? []).map((a) => {
      const kind = str(a.kind);
      return { campaignId: str(a.campaignId), firstActedAt: str(a.firstAt), ...(kind ? { kind } : {}) };
    }),
    // Absent stays absent (never `[]`): "no send stated" must not read as "never emailed".
    ...(Array.isArray(raw.emailSends)
      ? {
          emailSends: raw.emailSends.map((e) => ({
            campaignId: str(e.campaignId),
            workflowSlug: str(e.workflowSlug),
            firstSentAt: str(e.firstSentAt),
            lastSentAt: str(e.lastSentAt),
            // Through our own transport (`smtp`, lead-service's verbatim outreach transport): a click on it is screened.
            // Absent split = not stated (the attribution read refuses that).
            ...(Array.isArray(e.transports) ? { screenable: e.transports.some((t) => t.transport === "smtp") } : {}),
          })),
        }
      : {}),
  };
}

export async function fetchBrandJourneys(brandId: string, headers: { orgId: string; userId?: string; runId?: string }): Promise<Journey[]> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  if (!headers.orgId) throw new Error("timeline-journeys read requires the org (x-org-id)");
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  const response = await fetchWithRetry(`${url}/internal/brands/${encodeURIComponent(brandId)}/timeline-journeys`, { headers: reqHeaders });
  if (!response.ok) throw new Error(`lead-service timeline-journeys failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { journeys?: RawJourney[]; count?: unknown };
  if (!Array.isArray(data.journeys)) throw new Error("lead-service timeline-journeys returned no journeys array");
  if (typeof data.count === "number" && data.count !== data.journeys.length) {
    throw new Error(`lead-service timeline-journeys read ${data.journeys.length} journeys of ${data.count}`);
  }
  return data.journeys.map(toJourney);
}
