/**
 * EVERY CAMPAIGN, ACROSS EVERY ORG, THAT PERFORMS ONE LEG OF ONE CHANNEL — the population a
 * leg-scoped fleet workflow curve (`/public/stats/workflow-return-history?leg=`) is restricted to.
 *
 * A campaign identity is (org, brand, offer, LEG, channel), and campaign-service owns it: the leg a
 * campaign performs is its own stated `legKey`, read here verbatim, never inferred. A row stating no
 * leg (the pre-leg ancestors) performs no leg and is in no leg's population.
 *
 * ONE call (`GET /campaigns/list`, every org's rows), filtered locally — a per-brand read would be one
 * round trip per pair for the same answer. FAIL-LOUD: a leg population we could not read must never
 * silently widen to the fleet or narrow to nobody.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { matchFunnelLegKey } from "./funnel-legs.js";

export interface FleetLegCampaign {
  campaignId: string;
  orgId: string;
  /** The brand it funds, or null for a legacy row naming none (it still carries spend). */
  brandId: string | null;
  /** The workflow the campaign runs (campaign-service's own field); null when it states none. */
  workflowSlug?: string | null;
  /** The offer it sells (campaign-service's own field); null when it states none. */
  offerId?: string | null;
}

/** PURE: keep the rows of `featureSlug` whose stated leg IS `legKey` (canonical). */
export function filterLegCampaigns(rows: unknown[], featureSlug: string, legKey: string): FleetLegCampaign[] {
  return rows.flatMap((raw) => {
    const c = raw as { id?: unknown; orgId?: unknown; featureSlug?: unknown; legKey?: unknown; brandId?: unknown; brandIds?: unknown; workflowSlug?: unknown; offerId?: unknown };
    if (typeof c.id !== "string" || typeof c.orgId !== "string") return [];
    if (c.featureSlug !== featureSlug) return [];
    // A leg the funnel table spells (or its legacy twin), else the stated key verbatim: the sourcing leg Start -> Lead
    // found is a leg of every source unit but no row of the funnel-leg table, and its on-demand pipe is measured on
    // those units (`lib/on-demand-pipe-fleet.ts`).
    if (typeof c.legKey !== "string" || (matchFunnelLegKey(c.legKey) ?? c.legKey) !== legKey) return [];
    const first = Array.isArray(c.brandIds) ? c.brandIds[0] : undefined;
    const brandId = typeof first === "string" ? first : typeof c.brandId === "string" ? c.brandId : null;
    return [{ campaignId: c.id, orgId: c.orgId, brandId, workflowSlug: typeof c.workflowSlug === "string" ? c.workflowSlug : null, offerId: typeof c.offerId === "string" ? c.offerId : null }];
  });
}

export async function fetchFleetLegCampaigns(featureSlug: string, legKey: string): Promise<FleetLegCampaign[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { campaigns?: unknown };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");
  return filterLegCampaigns(data.campaigns, featureSlug, legKey);
}

/** The campaigns of several pipe groups from ONE campaign list read: per group, the union over its (slug, leg) pipes. */
export async function fetchFleetLegCampaignsFor(
  groups: ReadonlyArray<ReadonlyArray<{ channelSlug: string; computedLegKey: string }>>,
): Promise<FleetLegCampaign[][]> {
  if (groups.every((g) => g.length === 0)) return groups.map(() => []);
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { campaigns?: unknown };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");
  const rows = data.campaigns;
  return groups.map((g) => {
    const byId = new Map<string, FleetLegCampaign>();
    for (const p of g) for (const c of filterLegCampaigns(rows, p.channelSlug, p.computedLegKey)) byId.set(c.campaignId, c);
    return [...byId.values()];
  });
}

// ── Which campaigns run a sales funnel or a trigger (CATALOGUE-RETIRE-1016) ──────────────────────────────────────────

/** A campaign of any org, any status, named by what it is: what a catalogue retire refusal quotes. */
export interface FleetCampaignRef {
  campaignId: string;
  orgId: string;
  status: string | null;
}

const refOf = (raw: unknown): (FleetCampaignRef & { salesFunnelId: string | null; runsOnTriggerId: string | null }) | null => {
  const c = raw as { id?: unknown; orgId?: unknown; status?: unknown; salesFunnelId?: unknown; runsOnTriggerId?: unknown };
  if (typeof c.id !== "string" || typeof c.orgId !== "string") return null;
  return {
    campaignId: c.id,
    orgId: c.orgId,
    status: typeof c.status === "string" ? c.status : null,
    salesFunnelId: typeof c.salesFunnelId === "string" ? c.salesFunnelId : null,
    runsOnTriggerId: typeof c.runsOnTriggerId === "string" ? c.runsOnTriggerId : null,
  };
};
const plainRef = ({ campaignId, orgId, status }: FleetCampaignRef): FleetCampaignRef => ({ campaignId, orgId, status });

/** PURE: every campaign (unit) born on one of `funnelIds` (campaign-service's own `salesFunnelId`, verbatim), any status. */
export function campaignsRunningFunnel(rows: unknown[], funnelIds: readonly string[]): FleetCampaignRef[] {
  const ids = new Set(funnelIds);
  return rows.flatMap((raw) => {
    const c = refOf(raw);
    return c && c.salesFunnelId !== null && ids.has(c.salesFunnelId) ? [plainRef(c)] : [];
  });
}

/** PURE: every campaign that runs on `triggerId` (a unit stating it, or a unit of a funnel it heads), any status. */
export function campaignsOnTrigger(rows: unknown[], triggerId: string): FleetCampaignRef[] {
  const head = `trigger:${triggerId}+`;
  return rows.flatMap((raw) => {
    const c = refOf(raw);
    return c && (c.runsOnTriggerId === triggerId || (c.salesFunnelId !== null && c.salesFunnelId.startsWith(head))) ? [plainRef(c)] : [];
  });
}

/** Every campaign row of every org (`GET /campaigns/list`), verbatim. FAIL-LOUD: an unreadable list never reads as none. */
export async function fetchFleetCampaignRows(): Promise<unknown[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { campaigns?: unknown };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");
  return data.campaigns;
}

// ── One campaign's sales funnel, by its id alone (BEST-TPL-LLM-1022: a run knows its campaign, not its org) ─────────

const LIST_SHARE_MS = 60_000;
let listShared: { at: number; value: Promise<unknown[]> } | null = null;

/** Every campaign row of every org, shared 60 s (a run-time reader calls it once per send). FAIL-LOUD. */
function readCampaignList(): Promise<unknown[]> {
  if (listShared && Date.now() - listShared.at < LIST_SHARE_MS) return listShared.value;
  const value = (async () => {
    const url = process.env.CAMPAIGN_SERVICE_URL;
    const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
    if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
    const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
    if (!response.ok) throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { campaigns?: unknown };
    if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");
    return data.campaigns;
  })();
  listShared = { at: Date.now(), value };
  value.catch(() => {
    if (listShared?.value === value) listShared = null;
  });
  return value;
}

/**
 * The sales funnel a campaign UNIT states (its own `salesFunnelId`, the leg ladder's rule), null when it states none.
 * `found:false` = campaign-service lists no such campaign.
 */
export async function fetchCampaignSalesFunnelId(campaignId: string): Promise<{ found: boolean; salesFunnelId: string | null }> {
  const row = (await readCampaignList()).find((raw) => (raw as { id?: unknown }).id === campaignId) as { salesFunnelId?: unknown } | undefined;
  if (!row) return { found: false, salesFunnelId: null };
  return { found: true, salesFunnelId: typeof row.salesFunnelId === "string" && row.salesFunnelId ? row.salesFunnelId : null };
}

/** Test seam. */
export function __resetCampaignListShareForTest(): void {
  listShared = null;
}
