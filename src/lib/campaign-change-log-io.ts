/**
 * CAMPAIGN-CHANGE-LOG-1119, IO. Every input of a campaign's change log, read from its OWNER through its route (never
 * another service's database):
 *  - runs-service `script-reach` by version: the script decisions run for the campaign's units, by version and day;
 *  - campaign-service `/sales-funnel-campaigns/:id/change-history`: every unit it ever had, their status transitions,
 *    the changes of its brief / Target / follows-its-plan, its plan changes;
 *  - billing-service `.../campaigns/:id/cap-changes`: every change of the caps it is held to;
 *  - ours: the strategy kept per (unit, Engine) history, Silver's fleet transitions (the step and its delay).
 */
import { readRunsLedgerJson } from "./runs-ledger-read.js";
import { readSilverStats } from "./outcome-silver-io.js";
import { FLEET_SCOPE_ID } from "./outcome-silver.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { type CapChangeRecord, type FleetTransition, type PlanChangeRecord, type ScriptDayRow, type SettingChangeRecord, type StatusTransitionRecord } from "./campaign-change-log.js";
import type { SalesFunnelCampaignRow } from "./sales-funnel-campaigns-client.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** PURE. runs-service's script-reach body grouped by version, as one row per script version and day. FAIL-LOUD. */
export function parseVersionReach(body: unknown): { builtAt: string; rows: ScriptDayRow[] } {
  if (!isRecord(body) || !Array.isArray(body.groups) || typeof body.builtAt !== "string") throw new Error("[features-service] campaign changes: script-reach served no groups or no builtAt");
  const merged = new Map<string, { engine: string; dynasty: string; version: string; day: string; decisions: number; reached: Record<string, number>; produced: Record<string, number> }>();
  for (const g of body.groups) {
    if (!isRecord(g) || typeof g.scriptSlug !== "string" || typeof g.day !== "string" || typeof g.runs !== "number" || !Array.isArray(g.reachedOutcomes) || !Array.isArray(g.producedOutcomes)) throw new Error("[features-service] campaign changes: a script-reach group lacks scriptSlug, day, runs or its outcomes");
    const parts = g.scriptSlug.split("/");
    if (parts.length !== 3 || parts.some((p) => p === "")) throw new Error(`[features-service] campaign changes: ${JSON.stringify(g.scriptSlug)} is not <outcome>/<dynasty>/<version>`);
    const [engine, dynasty, version] = parts as [string, string, string];
    const k = `${g.scriptSlug}\u0000${g.day}`;
    const row = merged.get(k) ?? merged.set(k, { engine, dynasty, version, day: g.day, decisions: 0, reached: {}, produced: {} }).get(k)!;
    row.decisions += g.runs;
    for (const o of new Set(g.producedOutcomes.filter((x): x is string => typeof x === "string"))) row.produced[o] = (row.produced[o] ?? 0) + g.runs;
    for (const o of new Set([...g.reachedOutcomes, ...g.producedOutcomes].filter((x): x is string => typeof x === "string" && x !== engine))) row.reached[o] = (row.reached[o] ?? 0) + g.runs;
  }
  return { builtAt: body.builtAt, rows: [...merged.values()] };
}

/** The decisions run FOR these unit campaigns since a UTC day, by script version and day. Held 60 s. No campaign = no read. */
export async function readCampaignVersionReach(unitCampaignIds: readonly string[], since: string): Promise<{ builtAt: string | null; rows: ScriptDayRow[] }> {
  const ids = [...new Set(unitCampaignIds)].sort();
  if (ids.length === 0) return { builtAt: null, rows: [] };
  return parseVersionReach(await readRunsLedgerJson(`/internal/stats/outcome-chains/script-reach?groupBy=version&campaignIds=${ids.map(encodeURIComponent).join(",")}&since=${since}`, 60_000));
}

/** Silver's stored fleet transitions with a measured delay (the steps a change can be measured on, and their delays). */
export async function readFleetTransitions(): Promise<FleetTransition[]> {
  const out: FleetTransition[] = [];
  for (const r of await readSilverStats("fleet", FLEET_SCOPE_ID)) {
    if (r.body.kind !== "transition" || r.body.stat.delay === null) continue;
    out.push({ fromKey: r.fromKey, toKey: r.toKey, pairs: r.body.stat.delay.n, medianHours: r.body.stat.delay.medianHours, p90Hours: r.body.stat.delay.p90Hours });
  }
  return out;
}

export interface CampaignChangeHistory {
  units: Array<{ campaignId: string }>;
  statusTransitions: StatusTransitionRecord[];
  settingChanges: SettingChangeRecord[];
  planChanges: PlanChangeRecord[];
  settingsRecordedSince: string;
}

interface OwnerHeaders {
  orgId: string;
  userId?: string;
  runId?: string;
}

const ownerHeaders = (apiKey: string, h: OwnerHeaders, brandId: string): Record<string, string> => {
  const out: Record<string, string> = { "x-api-key": apiKey, "x-org-id": h.orgId, "x-brand-id": brandId };
  if (h.userId) out["x-user-id"] = h.userId;
  if (h.runId) out["x-run-id"] = h.runId;
  return out;
};

/** PURE. campaign-service's change history body. FAIL-LOUD on a missing list. */
export function parseChangeHistory(body: unknown): CampaignChangeHistory {
  if (!isRecord(body) || !Array.isArray(body.units) || !Array.isArray(body.statusTransitions) || !Array.isArray(body.settingChanges) || !Array.isArray(body.planChanges) || typeof body.settingsRecordedSince !== "string")
    throw new Error("[features-service] campaign changes: campaign-service change-history lacks units, statusTransitions, settingChanges, planChanges or settingsRecordedSince");
  return body as unknown as CampaignChangeHistory;
}

/** campaign-service: everything it dated about one funnel campaign. FAIL-LOUD. */
export async function readCampaignChangeHistory(row: SalesFunnelCampaignRow, h: OwnerHeaders): Promise<CampaignChangeHistory> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[features-service] CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${url}/sales-funnel-campaigns/${encodeURIComponent(row.id)}/change-history?brandId=${encodeURIComponent(row.brandId)}`, { headers: ownerHeaders(apiKey, h, row.brandId) });
  if (!res.ok) throw new Error(`[features-service] campaign-service change-history ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseChangeHistory(await res.json());
}

/**
 * A campaign naming NO offer (DISTRY-CALL-IS-CAMPAIGN-1121): billing-service keys its caps on the offer today, and its
 * offer-less caps routes are not served yet. Its cap changes are then "not available yet", stated, never asked at an
 * `/offers/null/...` path and never invented.
 */
export const CAP_CHANGES_NO_OFFER_REASON = "campaign_names_no_offer_caps_not_served_yet" as const;

/** billing-service: every change of the caps this funnel campaign is held to. FAIL-LOUD. */
export async function readCampaignCapChanges(
  row: SalesFunnelCampaignRow,
  h: OwnerHeaders,
): Promise<{ changes: CapChangeRecord[]; unavailableReason: typeof CAP_CHANGES_NO_OFFER_REASON | null }> {
  if (row.offerId === null) return { changes: [], unavailableReason: CAP_CHANGES_NO_OFFER_REASON };
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[features-service] BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  const path = `/internal/brands/${encodeURIComponent(row.brandId)}/offers/${encodeURIComponent(row.offerId)}/sales-funnels/${encodeURIComponent(row.salesFunnelId)}/campaigns/${encodeURIComponent(row.id)}/cap-changes`;
  const res = await fetchWithRetry(`${url}${path}`, { headers: ownerHeaders(apiKey, h, row.brandId) });
  if (!res.ok) throw new Error(`[features-service] billing-service cap-changes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as unknown;
  if (!isRecord(body) || !Array.isArray(body.changes)) throw new Error("[features-service] campaign changes: billing-service cap-changes served no changes");
  return { changes: body.changes as CapChangeRecord[], unavailableReason: null };
}
