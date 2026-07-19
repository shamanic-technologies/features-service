import { fetchWithRetry } from "./fetch-retry.js";

/**
 * REAL per-brand attributed conversion counts BROKEN DOWN BY UTC CALENDAR DAY, from lead-service
 * `GET /internal/brands/{brandId}/conversion-counts-by-day` — the conversion-tracker source of truth,
 * deduped + attributed at write. Same set of events as `/conversion-counts`, just placed on the day
 * each conversion was received (received_at AT TIME ZONE 'UTC'), so features-service can draw a
 * truthful per-day OBSERVED series instead of a `clicks × rate` projection.
 *
 * `byDay[event]` maps `YYYY-MM-DD -> count` (a day key is present only when its count > 0). `undated[event]`
 * counts conversions whose day genuinely can't be determined (received_at IS NULL — 0 in practice, but
 * ALWAYS present and NEVER fabricated). For every event, `sum(byDay values) + undated === the
 * /conversion-counts total`. All four event keys are ALWAYS present (empty `byDay` object / `0` undated).
 */
export interface ConversionCountsByDay {
  byDay: {
    signup: Record<string, number>;
    meeting_booked: Record<string, number>;
    form_submission: Record<string, number>;
    // Terminal paying-client event — RENAMED from `purchase` to `sale` (lead-service slice).
    sale: Record<string, number>;
  };
  undated: {
    signup: number;
    meeting_booked: number;
    form_submission: number;
    sale: number;
  };
}

type EventKey = keyof ConversionCountsByDay["byDay"];
const EVENT_KEYS: EventKey[] = ["signup", "meeting_booked", "form_submission", "sale"];

function parseByDay(raw: unknown, event: string): Record<string, number> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`lead-service conversion-counts-by-day byDay.${event} is not an object`);
  }
  const out: Record<string, number> = {};
  for (const [day, count] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isFinite(count)) {
      throw new Error(`lead-service conversion-counts-by-day byDay.${event}.${day} is not a finite number`);
    }
    out[day] = count;
  }
  return out;
}

/**
 * Fetch the brand's real attributed conversion counts broken down by day from lead-service
 * `GET /internal/brands/{brandId}/conversion-counts-by-day` (service-auth: x-api-key + x-service-name).
 *
 * Org-less internal read — the brand is in the path, so no x-org-id / user identity is forwarded
 * (mirrors conversion-counts-client). features-service consumes the counts verbatim; it does NOT own or
 * default them. Fails loud on missing config / transport / non-OK / malformed — a swallowed error would
 * fake a count. The caller (`fetchConversionCountsByDaySoft`) decides whether to degrade the display
 * series to "absent" vs propagate, exactly as the Overview does for `/conversion-counts` + `sequences`.
 */
export async function fetchConversionCountsByDay(brandId: string): Promise<ConversionCountsByDay> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/conversion-counts-by-day`,
    { headers: { "x-api-key": apiKey, "x-service-name": "features-service" } },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `lead-service /internal/brands/:brandId/conversion-counts-by-day failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as { byDay?: unknown; undated?: unknown };
  const rawByDay = data.byDay;
  const rawUndated = data.undated;
  if (!rawByDay || typeof rawByDay !== "object" || !rawUndated || typeof rawUndated !== "object") {
    throw new Error("lead-service conversion-counts-by-day returned malformed byDay/undated");
  }

  const byDayObj = rawByDay as Record<string, unknown>;
  const undatedObj = rawUndated as Record<string, unknown>;
  const byDay = {} as ConversionCountsByDay["byDay"];
  const undated = {} as ConversionCountsByDay["undated"];
  for (const event of EVENT_KEYS) {
    byDay[event] = parseByDay(byDayObj[event], event);
    const u = undatedObj[event];
    if (typeof u !== "number" || !Number.isFinite(u)) {
      throw new Error(`lead-service conversion-counts-by-day undated.${event} is not a finite number`);
    }
    undated[event] = u;
  }
  return { byDay, undated };
}
