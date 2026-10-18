/**
 * The brands that report meetings to us (`lib/meeting-population.ts`), read from lead-service
 * `GET /internal/meeting-attribution` and held per process, stale-while-revalidate (5 min fresh / 6 h stale,
 * single-flight): a brand's first reported meeting reaches every meeting figure within minutes. A cold read that fails
 * THROWS (a population we could not read never widens to every brand nor narrows to none); a failed background
 * refresh keeps the last answer, loudly.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { meetingReportingOf, type MeetingReporting } from "./meeting-population.js";

const FRESH_MS = 5 * 60_000;
const STALE_MS = 6 * 60 * 60_000;

let cell: { value: MeetingReporting; at: number } | null = null;
let inFlight: Promise<MeetingReporting> | null = null;

/** lead-service's meeting attribution body, verbatim (fail-loud). */
export async function fetchMeetingAttributionBody(): Promise<unknown> {
  const res = await fetchWithRetry(`${process.env.LEAD_SERVICE_URL}/internal/meeting-attribution`, {
    headers: { "x-api-key": process.env.LEAD_SERVICE_API_KEY! },
  });
  if (!res.ok) throw new Error(`lead-service /internal/meeting-attribution ${res.status}: ${await res.text()}`);
  return res.json();
}

function refresh(): Promise<MeetingReporting> {
  if (!inFlight) {
    inFlight = fetchMeetingAttributionBody()
      .then((body) => {
        const value = meetingReportingOf(body);
        cell = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Remember an answer read elsewhere off the same body (the AI Meeting Booking gain reads it anyway). */
export function rememberMeetingReporting(value: MeetingReporting): void {
  cell = { value, at: Date.now() };
}

export async function getMeetingReporting(): Promise<MeetingReporting> {
  const age = cell ? Date.now() - cell.at : Infinity;
  if (cell && age < FRESH_MS) return cell.value;
  if (cell && age < STALE_MS) {
    refresh().catch((err) => console.error(`[features-service] meeting reporting refresh failed (serving the last answer): ${(err as Error).message}`));
    return cell.value;
  }
  return refresh();
}

/** Test seam. */
export function __resetMeetingReporting(): void {
  cell = null;
  inFlight = null;
}
