/**
 * lead-service's "Disqualified" MARK, read and applied to the engine's persons in ONE place.
 *
 * Since lead-service v0.83.59 (owner 2026-10-13) "Disqualified" is its own mark beside the standing,
 * never a standing. A marked person is RULED OUT for value (owner 2026-10-13): the Deals card reads $0
 * `ruled_out`, and the pipeline / Hot / Lost engine must say the same thing about the same person, so
 * every priced population carries the mark (`EnginePerson.disqualified`) and the engine prices it.
 * The mark is READ, never re-derived. The read FAILS LOUD: an empty set on a failed read would price
 * (and list as Hot) people somebody ruled out.
 */
import type { EnginePerson } from "./revenue-engine.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * The ids of the brand's leads lead-service holds a live "Disqualified" MARK on (lead-service
 * `GET /orgs/leads/disqualifications?brandId=[&offerId=]`, v0.83.59): its own mark beside the standing,
 * never a standing (the standing `disqualified` is always empty since 2026-10-13). With an offer: the
 * people disqualified for it (its own mark, or a brand-wide one); without: every marked person of the
 * brand. Read whole (the list is unpaged), fail loud: a swallowed read would price a ruled-out lead.
 *
 * A mark can also sit on the lead's COMPANY ("not our target", lead-service v0.83.65, owner 2026-10-13):
 * listed under `companies`, it covers every lead of that company. lead-service names the leads each
 * company mark covers (`companies[].leadIds`), and they are ruled out exactly like a lead's own mark.
 * Company membership is lead-service's (its company key), never rebuilt here from names or domains.
 */
export async function fetchDisqualifiedLeadIds(
  brandId: string,
  offerId: string | null,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<Set<string>> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({ brandId });
  if (offerId) params.set("offerId", offerId);
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  const data = await (async () => {
    const response = await fetchWithRetry(`${url}/orgs/leads/disqualifications?${params}`, { headers: reqHeaders }, { timeoutMs: 30_000 });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`lead-service /orgs/leads/disqualifications failed (${response.status}): ${text}`);
    }
    return (await response.json()) as { leads?: unknown; companies?: unknown };
  })();
  if (!Array.isArray(data.leads)) throw new Error("lead-service /orgs/leads/disqualifications returned no leads array");
  const ids = new Set<string>();
  for (const row of data.leads as Array<{ leadId?: unknown }>) {
    if (typeof row?.leadId !== "string" || row.leadId === "") {
      throw new Error("lead-service /orgs/leads/disqualifications returned a row without a leadId");
    }
    ids.add(row.leadId);
  }
  if (!Array.isArray(data.companies)) throw new Error("lead-service /orgs/leads/disqualifications returned no companies array");
  for (const company of data.companies as Array<{ companyKey?: unknown; leadIds?: unknown }>) {
    if (!Array.isArray(company?.leadIds)) {
      throw new Error(`lead-service /orgs/leads/disqualifications returned company ${String(company?.companyKey)} without leadIds`);
    }
    for (const leadId of company.leadIds as unknown[]) {
      if (typeof leadId !== "string" || leadId === "") {
        throw new Error("lead-service /orgs/leads/disqualifications returned a company lead without an id");
      }
      ids.add(leadId);
    }
  }
  return ids;
}

/** PURE. Marks every person whose lead lead-service disqualified. Never un-marks. */
export function applyDisqualifiedMarks(persons: EnginePerson[], disqualified: ReadonlySet<string>): void {
  if (disqualified.size === 0) return;
  for (const p of persons) if (disqualified.has(p.leadId)) p.disqualified = true;
}


/**
 * Start a fail-loud read now, throw its failure only where it is awaited. Lets the read ride beside a
 * batch of fail-soft reads without an unhandled rejection while that batch settles.
 */
export function deferLoud<T>(p: Promise<T>): () => Promise<T> {
  const settled = p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return async () => {
    const r = await settled;
    if (!r.ok) throw r.error;
    return r.value;
  };
}
