/**
 * Fetch per-lead manual-qualification timestamps from email-gateway
 * GET /orgs/manual-qualifications (proxy to instantly-service).
 *
 * The endpoint returns the org's manual qualification history (one row per human-set
 * qualification), sorted by `qualifiedAt` DESC. We read the two terminal statuses the
 * revenue funnel cares about — `lead_meeting_booked` and `lead_closed` — and reduce them
 * to first-occurrence (MIN qualifiedAt) per email, mirroring how email-status-client maps
 * `firstOpenedAt` etc.: a known timestamp IS the signal.
 *
 * Source of truth is the customer's own manual qualification ("if the customer doesn't tell
 * us it closed-won, it didn't").
 *
 * Scoping:
 *   - campaign-scoped (campaignId given) → `?campaign_id=` filters server-side (bounded).
 *   - brand-scoped (no campaignId) → the endpoint has NO brandId filter, so we fetch the
 *     org-wide history (`?limit=500`) and bucket by the brand's lead emails. The 500-row cap
 *     is a real limit: if it is hit, some older qualifications may be truncated — we LOG A
 *     WARNING rather than silently under-reporting. (Escalation if regularly hit: page by the
 *     lead emails we already have, one `?email=` call each.)
 *
 * Fails loud on any transport / non-OK error — the caller decides whether to degrade (these
 * timestamps are a secondary enrichment; the pre-engagement pipeline total does not depend
 * on them).
 */

const MAX_LIMIT = 500;

type QualificationStatus =
  | "lead_interested"
  | "lead_meeting_booked"
  | "lead_closed"
  | "lead_not_interested"
  | "lead_wrong_person"
  | "lead_neutral"
  | "lead_out_of_office"
  | "auto_reply_received";

interface QualificationRow {
  email: string;
  status: QualificationStatus;
  qualifiedAt: string;
}

export interface QualificationDates {
  /** First time this lead was manually qualified meeting-booked (MIN qualifiedAt); null if never. */
  meetingBookedAt: string | null;
  /** First time this lead was manually qualified closed-won (MIN qualifiedAt); null if never. */
  closedAt: string | null;
}

const minDate = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
};

export async function fetchQualifications(
  brandId: string,
  campaignId: string | undefined,
  emails: string[],
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<Map<string, QualificationDates>> {
  const result = new Map<string, QualificationDates>();
  if (emails.length === 0) return result;

  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const params = new URLSearchParams({ limit: String(MAX_LIMIT) });
  if (campaignId) params.set("campaign_id", campaignId);

  const response = await fetch(`${url}/orgs/manual-qualifications?${params}`, { headers: reqHeaders });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /orgs/manual-qualifications failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { qualifications: QualificationRow[] };
  const rows = data.qualifications;

  // No silent truncation: a full page means the org-wide history may exceed the cap and some
  // meeting/close dates could be missing. Surface it; don't pretend the data is complete.
  if (rows.length >= MAX_LIMIT) {
    console.warn(
      `[features-service] manual-qualifications hit ${MAX_LIMIT}-row cap (org-wide history may be truncated; some meeting/close dates could be missing). brandId=${brandId} campaignId=${campaignId ?? "none"}`,
    );
  }

  // Bucket by the brand's lead emails (org-wide history includes other brands' leads). MIN
  // qualifiedAt per status = first occurrence — the date the lead first reached that stage.
  const wanted = new Set(emails);
  for (const row of rows) {
    if (!wanted.has(row.email)) continue;
    if (row.status !== "lead_meeting_booked" && row.status !== "lead_closed") continue;
    const existing = result.get(row.email) ?? { meetingBookedAt: null, closedAt: null };
    if (row.status === "lead_meeting_booked") existing.meetingBookedAt = minDate(existing.meetingBookedAt, row.qualifiedAt);
    else existing.closedAt = minDate(existing.closedAt, row.qualifiedAt);
    result.set(row.email, existing);
  }

  return result;
}
