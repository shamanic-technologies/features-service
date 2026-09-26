/**
 * Fetch per-lead manual-qualification timestamps from email-gateway
 * GET /orgs/manual-qualifications (proxy to instantly-service).
 *
 * The endpoint returns the org's manual qualification HISTORY (one row per human-set
 * statement, append-only), sorted by `qualifiedAt` DESC — superseded statements and
 * withdrawn ones (`withdrawnAt` non-null) included. Only a statement that still STANDS
 * counts: per (instantlyCampaignId, lead), the LATEST row that is NOT withdrawn — the
 * producer's own definition (instantly-service `findStandingManualQualification`). So a
 * person restating a "meeting booked" lead as merely "interested", or withdrawing the
 * statement, takes the meeting back out of every figure built on it.
 *
 * What the standing statement says:
 *   - `lead_meeting_booked` → meetingBookedAt = its qualifiedAt.
 *   - `lead_closed` → closedAt = its qualifiedAt, and the meeting it progressed through
 *     stays: meetingBookedAt = the earliest non-withdrawn `lead_meeting_booked` row of the
 *     same pair at or before it (none stated ⇒ null).
 *   - any other kind (a plain reply kind, not interested, ...) → neither: the meeting is gone.
 * Across a lead's several campaigns the earliest date wins (MIN), as before.
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

import { fetchWithRetry } from "./fetch-retry.js";

const MAX_LIMIT = 500;

export type QualificationStatus =
  | "lead_interested"
  | "lead_meeting_booked"
  | "lead_closed"
  | "lead_not_interested"
  | "lead_wrong_person"
  | "lead_neutral"
  | "lead_out_of_office"
  | "auto_reply_received";

export interface QualificationRow {
  email: string;
  status: QualificationStatus;
  qualifiedAt: string;
  /** instantly-service's per-lead sequence id — the grain a statement stands on. */
  instantlyCampaignId?: string | null;
  campaignId?: string | null;
  /** Non-null ⇒ the statement was taken back and no longer stands. */
  withdrawnAt?: string | null;
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

  const response = await fetchWithRetry(`${url}/orgs/manual-qualifications?${params}`, { headers: reqHeaders });

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

  // Bucket by the brand's lead emails (org-wide history includes other brands' leads), then
  // keep only what each (campaign, lead) pair's STANDING statement says.
  const wanted = new Set(emails);
  const standingByPair = new Map<string, { email: string; rows: QualificationRow[] }>();
  for (const row of rows) {
    if (!wanted.has(row.email)) continue;
    if (row.withdrawnAt) continue;
    const pair = `${row.instantlyCampaignId ?? row.campaignId ?? ""}|${row.email}`;
    const bucket = standingByPair.get(pair) ?? { email: row.email, rows: [] };
    bucket.rows.push(row);
    standingByPair.set(pair, bucket);
  }

  for (const { email, rows: pairRows } of standingByPair.values()) {
    const dates = standingDates(pairRows);
    if (!dates.meetingBookedAt && !dates.closedAt) continue;
    const existing = result.get(email) ?? { meetingBookedAt: null, closedAt: null };
    existing.meetingBookedAt = minDate(existing.meetingBookedAt, dates.meetingBookedAt);
    existing.closedAt = minDate(existing.closedAt, dates.closedAt);
    result.set(email, existing);
  }

  return result;
}

/**
 * What ONE (campaign, lead) pair's standing statement says, given its non-withdrawn rows.
 * Exported for the unit test.
 */
export function standingDates(rows: QualificationRow[]): QualificationDates {
  if (rows.length === 0) return { meetingBookedAt: null, closedAt: null };
  const sorted = [...rows].sort((a, b) => (a.qualifiedAt < b.qualifiedAt ? -1 : a.qualifiedAt > b.qualifiedAt ? 1 : 0));
  const standing = sorted[sorted.length - 1];
  if (standing.status === "lead_meeting_booked") {
    return { meetingBookedAt: standing.qualifiedAt, closedAt: null };
  }
  if (standing.status === "lead_closed") {
    const booked = sorted.find((r) => r.status === "lead_meeting_booked" && r.qualifiedAt <= standing.qualifiedAt);
    return { meetingBookedAt: booked?.qualifiedAt ?? null, closedAt: standing.qualifiedAt };
  }
  return { meetingBookedAt: null, closedAt: null };
}
