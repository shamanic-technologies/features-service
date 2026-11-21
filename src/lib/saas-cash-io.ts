/**
 * The reads behind `GET /internal/stats/saas-cash` (SAAS-CASH-1121; pure compose in `saas-cash.ts`).
 *
 * - billing's gross + net cash per org per UTC day, fleet-wide, with its fleet gross + net totals (ONE call).
 * - billing `GET /internal/absorbed-costs` (ONE call): the own-org verdict per org.
 * - the stated monthly amounts (agency orgs), read FAIL-LOUD: a SaaS figure that cannot remove the
 *   agency side would be wrong, so an unreadable store is a 502, never "no agency".
 *
 * Held in memory: a body under 5 min answers as is; up to 1 h it answers and ONE rebuild runs behind;
 * older (or none) waits for a build. A failed rebuild keeps the last body.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { parseCustomerStatuses } from "./customer-status-client.js";
import { agencyOrgIdsOf } from "./agency-self-serve-compute.js";
import { listStatedAmounts } from "./stated-monthly-amounts-store.js";
import { computeSaasCash, type FleetCashByDay, type OrgDayCash, type OrgVerdict, type SaasCashBody } from "./saas-cash.js";

export const SAAS_CASH_FRESH_MS = 5 * 60_000;
export const SAAS_CASH_STALE_MS = 60 * 60_000;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[features-service] ${name} not configured`);
  return v;
}

function text(v: unknown, what: string): string {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new Error(`[features-service] billing cash by day: ${what} is not a decimal: ${JSON.stringify(v)}`);
}

/** Parse billing's net-cash-per-org-per-day body. Fails loud on a shape it does not recognise. */
export function parseFleetCashByDay(body: unknown): FleetCashByDay {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new Error("[features-service] billing cash by day: body is not an object");
  const rows = b.rows;
  if (!Array.isArray(rows)) throw new Error("[features-service] billing cash by day: body carries no rows[]");
  if (typeof b.as_of !== "string") throw new Error("[features-service] billing cash by day: as_of is not a string");
  return {
    asOf: b.as_of,
    totalGrossCents: text(b.total_gross_cents, "total_gross_cents"),
    totalNetCents: text(b.total_net_cents, "total_net_cents"),
    rows: rows.map((raw, i): OrgDayCash => {
      const r = raw as Record<string, unknown>;
      if (r.org_id !== null && typeof r.org_id !== "string") {
        throw new Error(`[features-service] billing cash by day: rows[${i}].org_id is neither a string nor null`);
      }
      if (typeof r.day !== "string") throw new Error(`[features-service] billing cash by day: rows[${i}].day is not a string`);
      return {
        orgId: r.org_id,
        day: r.day,
        grossCents: text(r.gross_cents, `rows[${i}].gross_cents`),
        netCents: text(r.net_cents, `rows[${i}].net_cents`),
      };
    }),
  };
}

async function getJson(path: string, what: string): Promise<unknown> {
  const res = await fetchWithRetry(`${env("BILLING_SERVICE_URL")}${path}`, {
    headers: { "x-api-key": env("BILLING_SERVICE_API_KEY") },
  });
  if (!res.ok) throw new Error(`[features-service] ${what} failed (${res.status}): ${await res.text().catch(() => "")}`);
  return res.json();
}

export async function fetchFleetCashByDay(): Promise<FleetCashByDay> {
  return parseFleetCashByDay(await getJson(BILLING_CASH_BY_DAY_PATH, `billing GET ${BILLING_CASH_BY_DAY_PATH}`));
}

/** billing's route serving net cash per org per UTC day (SAAS-CASH-1121-BILLING). */
export const BILLING_CASH_BY_DAY_PATH = "/internal/cash/by-org-day";

export async function fetchOwnOrgVerdicts(): Promise<Map<string, OrgVerdict>> {
  const statuses = parseCustomerStatuses(await getJson("/internal/absorbed-costs", "billing GET /internal/absorbed-costs"));
  const out = new Map<string, OrgVerdict>();
  for (const [orgId, s] of statuses) out.set(orgId, { orgName: s.orgName, ownOrg: s.ownOrg, ownOrgReason: s.ownOrgReason });
  return out;
}

export async function buildSaasCash(now: () => Date = () => new Date()): Promise<SaasCashBody> {
  const [cash, verdicts, stated] = await Promise.all([fetchFleetCashByDay(), fetchOwnOrgVerdicts(), listStatedAmounts()]);
  return computeSaasCash({ cash, verdicts, agencyOrgIds: new Set(agencyOrgIdsOf(stated)), now: now() });
}

let held: { body: SaasCashBody; at: number } | null = null;
let inFlight: Promise<SaasCashBody> | null = null;

function rebuild(): Promise<SaasCashBody> {
  if (!inFlight) {
    inFlight = buildSaasCash()
      .then((body) => {
        held = { body, at: Date.now() };
        return body;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export async function readSaasCash(): Promise<SaasCashBody> {
  const age = held ? Date.now() - held.at : Infinity;
  if (held && age < SAAS_CASH_FRESH_MS) return held.body;
  if (held && age < SAAS_CASH_STALE_MS) {
    rebuild().catch((err) => console.error("[features-service] saas-cash background rebuild failed (last body kept):", err));
    return held.body;
  }
  return rebuild();
}

export function __resetSaasCashForTest(): void {
  held = null;
  inFlight = null;
}
