/**
 * WHETHER AN ORG IS STILL A CUSTOMER: billing-service's verdict, read, never re-derived
 * (CUSTOMER-HEALTH-OOM-1023).
 *
 * billing's staff absorbed-costs read (`GET /internal/absorbed-costs`) states one `customerStatus` per org:
 * `current` (a campaign running now), `churned` (paid before, nothing running), `never_paid` (never paid,
 * nothing running), null (billing could not read it). It also flags our OWN orgs (`ownOrg`, with the
 * recorded reason). The customer-health board tabs on that verdict, so two staff pages can never show two
 * different "churned": this module copies billing's fields and decides nothing.
 *
 * Fails loud; the board's caller degrades an unreadable read to null + a reason on every org.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export type CustomerStatus = "current" | "churned" | "never_paid";

export interface OrgCustomerStatus {
  orgId: string;
  orgName: string | null;
  /** billing's verdict; null = billing could not read it. */
  customerStatus: CustomerStatus | null;
  ownOrg: boolean;
  /** Why billing calls the org ours (`platform_org` | `staff_billing_contact`), null when it is a customer. */
  ownOrgReason: string | null;
  /** billing's flag: the org was deleted (its verdict is null on purpose). */
  orgDeleted: boolean;
}

const STATUSES: ReadonlySet<string> = new Set(["current", "churned", "never_paid"]);

/** Parse billing's absorbed-costs body down to the per-org verdict. Fails loud on a shape it does not recognise. */
export function parseCustomerStatuses(body: unknown): Map<string, OrgCustomerStatus> {
  const customers = (body as { customers?: unknown } | null)?.customers;
  if (!Array.isArray(customers)) throw new Error("[features-service] billing absorbed-costs: body carries no customers[]");
  const out = new Map<string, OrgCustomerStatus>();
  for (const raw of customers) {
    const c = raw as Record<string, unknown>;
    if (typeof c.orgId !== "string") throw new Error("[features-service] billing absorbed-costs: customers[].orgId is not a string");
    const status = c.customerStatus;
    if (status !== null && (typeof status !== "string" || !STATUSES.has(status))) {
      throw new Error(`[features-service] billing absorbed-costs: unknown customerStatus ${JSON.stringify(status)} for org ${c.orgId}`);
    }
    if (typeof c.ownOrg !== "boolean") throw new Error(`[features-service] billing absorbed-costs: ownOrg is not a boolean for org ${c.orgId}`);
    out.set(c.orgId, {
      orgId: c.orgId,
      orgName: typeof c.orgName === "string" ? c.orgName : null,
      customerStatus: status as CustomerStatus | null,
      ownOrg: c.ownOrg,
      ownOrgReason: typeof c.ownOrgReason === "string" ? c.ownOrgReason : null,
      orgDeleted: c.orgDeleted === true,
    });
  }
  return out;
}

/** billing's per-org customer verdict. Fails loud. */
export async function fetchCustomerStatuses(): Promise<Map<string, OrgCustomerStatus>> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[features-service] BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${url}/internal/absorbed-costs`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) {
    throw new Error(`[features-service] billing GET /internal/absorbed-costs: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return parseCustomerStatuses(await res.json());
}
