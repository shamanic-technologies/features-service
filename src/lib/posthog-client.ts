import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Per-ORGANIZATION dashboard-return-frequency signal, read from PostHog.
 *
 * "Return frequency" = how often the org's users come BACK to the dashboard — the disengagement signal
 * the Customer Success board needs to flag paying-but-absent customers. We measure it as distinct
 * dashboard SESSIONS (a return = a session) over two trailing windows, plus recent pageview volume and
 * last-seen recency. All grains are UI-facing display enrichment; nothing here bills or persists.
 *
 * KEYED ON THE CLERK ORG ID. PostHog stamps `person.properties.org_id` with the Clerk org id
 * (`org_...`) — the SAME value the health row carries as `orgExternalId` (NOT the internal org UUID).
 * So the returned map keys on the Clerk org id and the board joins each row via `account.orgExternalId`.
 */
export interface DashboardReturnSignal {
  /** Distinct dashboard sessions in the trailing 7 days. */
  sessions7d: number;
  /** Distinct dashboard sessions in the trailing 30 days. */
  sessions30d: number;
  /** Dashboard pageviews in the trailing 7 days. */
  pageviews7d: number;
  /** Dashboard pageviews in the trailing 30 days. */
  pageviews30d: number;
  /** ISO timestamp of the org's most recent dashboard pageview in the 30-day window. null when none. */
  lastSeen: string | null;
  /** Whole days between `lastSeen` and the board's `now`. null when lastSeen is null. */
  daysSinceLastSeen: number | null;
}

/** Trailing window (days) the 30-day aggregate scans; the 7-day figures are a sub-window of it. */
const WINDOW_DAYS = 30;
/** Defensive row cap — the paying fleet is dozens of orgs; a much larger count means a query/scope bug. */
const MAX_ORGS = 2000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * HogQL — one fleet-wide scan of dashboard pageviews, grouped by the Clerk org id carried on the
 * person. Session count uses `$session_id` (a "return" = a distinct session). The 7-day figures are
 * computed as a conditional sub-window of the same 30-day scan, so the whole board costs ONE query.
 */
const RETURNS_HOGQL = `
SELECT
  person.properties.org_id AS org_id,
  uniqIf(properties.$session_id, timestamp > now() - INTERVAL 7 DAY) AS sessions_7d,
  uniq(properties.$session_id) AS sessions_30d,
  countIf(timestamp > now() - INTERVAL 7 DAY) AS pageviews_7d,
  count() AS pageviews_30d,
  max(timestamp) AS last_seen
FROM events
WHERE event = '$pageview'
  AND timestamp > now() - INTERVAL ${WINDOW_DAYS} DAY
  AND person.properties.org_id != ''
  AND person.properties.org_id IS NOT NULL
GROUP BY org_id
ORDER BY sessions_30d DESC
LIMIT ${MAX_ORGS}
`.trim();

/** Raw PostHog `/query/` response — a positional `results` matrix aligned with the SELECT above. */
interface PostHogQueryResponse {
  results?: unknown[][];
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`posthog: expected numeric cell, got ${JSON.stringify(v)}`);
  return Math.trunc(n);
}

/**
 * Fetch the per-org dashboard-return signal for the WHOLE fleet in one PostHog query.
 *
 * FAILS LOUD — missing config, transport error, non-OK, or a malformed matrix all throw. The Customer
 * Success board wraps this soft (a PostHog blip degrades `dashboardReturnFrequency` to null on every
 * row, never a fabricated count), exactly like the board's other display enrichments. Returns a map
 * keyed on the Clerk org id (`org_...`), joined to each row via `orgExternalId`.
 *
 * @param now the board's reference time — used ONLY to derive `daysSinceLastSeen` (the window itself is
 *            anchored on PostHog's server `now()` inside the query, so a small clock skew is harmless).
 */
export async function fetchDashboardReturnsByOrg(now: Date): Promise<Map<string, DashboardReturnSignal>> {
  const host = process.env.POSTHOG_API_HOST;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!host || !projectId || !apiKey) {
    throw new Error("POSTHOG_API_HOST, POSTHOG_PROJECT_ID or POSTHOG_PERSONAL_API_KEY not configured");
  }

  const url = `${host.replace(/\/$/, "")}/api/projects/${encodeURIComponent(projectId)}/query/`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: RETURNS_HOGQL } }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`posthog /query/ failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as PostHogQueryResponse;
  const rows = data.results;
  if (!Array.isArray(rows)) {
    throw new Error("posthog /query/ returned no results matrix");
  }
  if (rows.length >= MAX_ORGS) {
    console.warn(`[features-service] posthog returns query hit the ${MAX_ORGS}-org cap — some orgs may be dropped`);
  }

  const nowMs = now.getTime();
  const map = new Map<string, DashboardReturnSignal>();
  for (const row of rows) {
    const orgId = row[0];
    if (typeof orgId !== "string" || orgId.length === 0) continue; // skip un-attributed rows, do not fabricate
    const lastSeenRaw = row[5];
    let lastSeen: string | null = null;
    let daysSinceLastSeen: number | null = null;
    if (typeof lastSeenRaw === "string" && lastSeenRaw.length > 0) {
      const t = Date.parse(lastSeenRaw);
      if (Number.isFinite(t)) {
        lastSeen = new Date(t).toISOString();
        daysSinceLastSeen = Math.max(0, Math.floor((nowMs - t) / MS_PER_DAY));
      }
    }
    map.set(orgId, {
      sessions7d: toInt(row[1]),
      sessions30d: toInt(row[2]),
      pageviews7d: toInt(row[3]),
      pageviews30d: toInt(row[4]),
      lastSeen,
      daysSinceLastSeen,
    });
  }
  return map;
}
