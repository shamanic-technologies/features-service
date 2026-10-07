/**
 * WHERE AN OFFER'S LEADS COME FROM, WHAT EACH SOURCE COST, AND WHAT IT PAID BACK — and, per campaign,
 * "[sourcing] -> [outreach channel]" with each half's share of the cost.
 *
 * The origins and the transition rule live in `lib/sourcing-origins.ts`. This module is the money.
 *
 * ── THE SPLIT, AND WHY IT ADDS UP TO THE CENT ───────────────────────────────────────────────────
 *   campaign total (campaign)  committed spend of the campaign's runs, on the SAME read every campaign
 *                           money figure rides (runs `/v1/stats/costs`, groupBy campaignId), its channel
 *                           slug PLUS every origin slug (both labelling states, a run counted once).
 *   sourcing (campaign)     Σ committed SUBTREE cost of the campaign's `lead-service:lead-serve` runs
 *                           (runs `/v1/runs?include=subtreeCost`): attribution by parent link, never a
 *                           cost-name list. Every run of a serve subtree carries the serve's campaign
 *                           (measured 2026-10-07), so sourcing ⊆ campaign total.
 *   outreach (campaign)     total − sourcing, exact on the producer's decimal text. The serves are read
 *                           BEFORE the campaign total, so a cost written between the two reads lands in the
 *                           campaign total (outreach), never makes outreach negative. A negative remainder is a
 *                           broken premise: the campaign's outreach is null with a reason, logged loud.
 * So sourcing + outreach = campaign total exactly, in either labelling state.
 *
 * ── PER ORIGIN (rows NOT additive across origins when a lead came from two) ─────────────────────
 *   sourcingCostUsd     Σ subtree cost of the serves from that origin (run slug, else audience kind).
 *   leadsServed         distinct leads lead-service tags with an audience of that origin.
 *   positiveReplies     those leads with a positive reply (same per-lead signal as the outcome reads).
 *   outreachCostUsd     each campaign's outreach shared over the origins by the leads it served from
 *                       each (`outreachAllocation`): an outreach run writes to one lead, the cost of a
 *                       lead's emails is not split per origin anywhere upstream.
 *   endToEndCostUsd        sourcing + allocated outreach: what the origin's leads cost end to end.
 *   roi                 positive replies × value of a positive reply (offer terms) ÷ end-to-end cost.
 * Serves and leads whose origin is unknown sit in `unattributed`, never spread.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { addDecimals, decimalCentsToUsd, sumDecimalStrings } from "./decimal.js";
import { mapWithConcurrency } from "./concurrency.js";
import { runsCostsUrl, selectCostCentsString, type Pricing } from "./pricing.js";
import {
  SOURCING_ORIGINS,
  originOfServe,
  sourcingOriginOfList,
  withSourcingSlugs,
  type SourcingOrigin,
} from "./sourcing-origins.js";

/** One serve run of the offer's campaigns and its subtree's committed cost (cents, decimal text). */
export interface ServeCost {
  runId: string;
  campaignId: string;
  audienceId: string | null;
  featureSlug: string | null;
  cents: string;
}

/** One lead row as served under one campaign (pre-dedup). */
export interface SourcedLead {
  leadId: string;
  campaignId: string | null;
  audienceId: string | null;
  positiveReply: boolean;
}

export interface SourcingCampaignInput {
  id: string;
  featureSlug: string;
  channelName: string;
  legKey: string | null;
  status: string | null;
}

export interface OriginStats {
  slug: string | null;
  name: string | null;
  family: SourcingOrigin["family"] | null;
  description: string | null;
  live: boolean | null;
  used: boolean;
  audienceIds: string[];
  serveCount: number;
  leadsServed: number;
  sourcingCostUsd: number;
  costPerLeadUsd: number | null;
  positiveReplies: number;
  sourcingCostPerPositiveReplyUsd: number | null;
  outreachCostUsd: number;
  endToEndCostUsd: number;
  endToEndCostPerPositiveReplyUsd: number | null;
  roi: number | null;
  roiUnavailableReason: "no_positive_reply_value" | "nothing_spent" | null;
}

export interface CampaignSourcingSplit {
  campaignId: string;
  featureSlug: string;
  channelName: string;
  legKey: string | null;
  status: string | null;
  sources: Array<{ slug: string | null; name: string | null; sourcingCostUsd: number; serveCount: number; leadsServed: number }>;
  serveCount: number;
  leadsServed: number;
  positiveReplies: number;
  sourcingCostUsd: number;
  outreachCostUsd: number | null;
  totalCostUsd: number;
  outreachUnavailableReason: "sourcing_exceeds_campaign_total" | null;
  costPerPositiveReply: { sourcingUsd: number | null; outreachUsd: number | null; totalUsd: number | null };
}

export interface OfferSourcing {
  origins: OriginStats[];
  unattributed: OriginStats;
  campaigns: CampaignSourcingSplit[];
  totals: { sourcingCostUsd: number; outreachCostUsd: number | null; totalCostUsd: number };
}

const perUnit = (usd: number, n: number): number | null => (n > 0 ? usd / n : null);

/** Exact a − b on decimal text. */
function subDecimals(a: string, b: string): string {
  const neg = b.startsWith("-") ? b.slice(1) : `-${b}`;
  return addDecimals(a, neg);
}

interface OriginAcc {
  origin: SourcingOrigin | null;
  audienceIds: Set<string>;
  serveCount: number;
  cents: string[];
  leads: Set<string>;
  replied: Set<string>;
  outreachUsd: number;
}

/** PURE: the per-origin and per-campaign figures. */
export function computeOfferSourcing(input: {
  campaigns: readonly SourcingCampaignInput[];
  serves: readonly ServeCost[];
  totalCentsByCampaign: ReadonlyMap<string, string>;
  listOfAudience: ReadonlyMap<string, string | null>;
  leads: readonly SourcedLead[];
  valuePerPositiveReplyUsd: number | null;
}): OfferSourcing {
  const campaignIds = new Set(input.campaigns.map((c) => c.id));
  const accs = new Map<string, OriginAcc>();
  const UNKNOWN = "__unattributed__";
  const acc = (origin: SourcingOrigin | null): OriginAcc => {
    const key = origin?.slug ?? UNKNOWN;
    let a = accs.get(key);
    if (!a) {
      a = { origin, audienceIds: new Set(), serveCount: 0, cents: [], leads: new Set(), replied: new Set(), outreachUsd: 0 };
      accs.set(key, a);
    }
    return a;
  };
  for (const o of SOURCING_ORIGINS) acc(o);
  acc(null);

  // Per campaign: serve cents per origin, leads per origin.
  interface CampAcc {
    cents: string[];
    byOrigin: Map<string, { origin: SourcingOrigin | null; cents: string[]; serves: number; leads: Set<string> }>;
    leads: Set<string>;
    replied: Set<string>;
    serves: number;
  }
  const camps = new Map<string, CampAcc>();
  const camp = (id: string): CampAcc => {
    let c = camps.get(id);
    if (!c) {
      c = { cents: [], byOrigin: new Map(), leads: new Set(), replied: new Set(), serves: 0 };
      camps.set(id, c);
    }
    return c;
  };
  const campOrigin = (c: CampAcc, origin: SourcingOrigin | null) => {
    const key = origin?.slug ?? UNKNOWN;
    let e = c.byOrigin.get(key);
    if (!e) {
      e = { origin, cents: [], serves: 0, leads: new Set() };
      c.byOrigin.set(key, e);
    }
    return e;
  };

  for (const s of input.serves) {
    if (!campaignIds.has(s.campaignId)) continue;
    const origin = originOfServe({ runFeatureSlug: s.featureSlug, audienceId: s.audienceId, listOfAudience: input.listOfAudience });
    const a = acc(origin);
    a.serveCount += 1;
    a.cents.push(s.cents);
    if (s.audienceId) a.audienceIds.add(s.audienceId);
    const c = camp(s.campaignId);
    c.cents.push(s.cents);
    c.serves += 1;
    const co = campOrigin(c, origin);
    co.cents.push(s.cents);
    co.serves += 1;
  }

  for (const l of input.leads) {
    if (!l.campaignId || !campaignIds.has(l.campaignId)) continue;
    const origin = l.audienceId ? sourcingOriginOfList(input.listOfAudience.get(l.audienceId) ?? null) : null;
    const a = acc(origin);
    a.leads.add(l.leadId);
    if (l.audienceId) a.audienceIds.add(l.audienceId);
    if (l.positiveReply) a.replied.add(l.leadId);
    const c = camp(l.campaignId);
    c.leads.add(l.leadId);
    if (l.positiveReply) c.replied.add(l.leadId);
    campOrigin(c, origin).leads.add(l.leadId);
  }

  const campaigns: CampaignSourcingSplit[] = [];
  const sourcingTotal: string[] = [];
  const campaignTotal: string[] = [];
  const outreachTotal: string[] = [];
  let outreachKnown = true;
  for (const meta of input.campaigns) {
    const c = camps.get(meta.id) ?? camp(meta.id);
    const sourcingCents = sumDecimalStrings(c.cents);
    const totalCents = input.totalCentsByCampaign.get(meta.id) ?? "0";
    const outreachCents = subDecimals(totalCents, sourcingCents);
    const negative = outreachCents.startsWith("-") && Number(outreachCents) < 0;
    if (negative) {
      console.error(
        `[features-service] offer sourcing: campaign ${meta.id} sourcing ${sourcingCents}c exceeds its campaign total ${totalCents}c — outreach share withheld`,
      );
      outreachKnown = false;
    } else {
      outreachTotal.push(outreachCents);
      // Share the campaign's outreach over its origins by the leads it served from each.
      const outreachUsd = decimalCentsToUsd(outreachCents);
      const totalLeads = c.leads.size;
      if (totalLeads === 0) acc(null).outreachUsd += outreachUsd;
      else for (const e of c.byOrigin.values()) acc(e.origin).outreachUsd += (outreachUsd * e.leads.size) / totalLeads;
    }
    sourcingTotal.push(sourcingCents);
    campaignTotal.push(totalCents);
    const sourcingUsd = decimalCentsToUsd(sourcingCents);
    const outreachUsd = negative ? null : decimalCentsToUsd(outreachCents);
    const totalUsd = decimalCentsToUsd(totalCents);
    const replies = c.replied.size;
    campaigns.push({
      campaignId: meta.id,
      featureSlug: meta.featureSlug,
      channelName: meta.channelName,
      legKey: meta.legKey,
      status: meta.status,
      sources: [...c.byOrigin.values()]
        .map((e) => ({
          slug: e.origin?.slug ?? null,
          name: e.origin?.name ?? null,
          sourcingCostUsd: decimalCentsToUsd(sumDecimalStrings(e.cents)),
          serveCount: e.serves,
          leadsServed: e.leads.size,
        }))
        .sort((x, y) => y.sourcingCostUsd - x.sourcingCostUsd || (x.slug ?? "~").localeCompare(y.slug ?? "~")),
      serveCount: c.serves,
      leadsServed: c.leads.size,
      positiveReplies: replies,
      sourcingCostUsd: sourcingUsd,
      outreachCostUsd: outreachUsd,
      totalCostUsd: totalUsd,
      outreachUnavailableReason: negative ? "sourcing_exceeds_campaign_total" : null,
      costPerPositiveReply: {
        sourcingUsd: perUnit(sourcingUsd, replies),
        outreachUsd: outreachUsd === null ? null : perUnit(outreachUsd, replies),
        totalUsd: perUnit(totalUsd, replies),
      },
    });
  }

  const stats = (a: OriginAcc): OriginStats => {
    const sourcingCostUsd = decimalCentsToUsd(sumDecimalStrings(a.cents));
    const endToEndCostUsd = sourcingCostUsd + a.outreachUsd;
    const replies = a.replied.size;
    const value = input.valuePerPositiveReplyUsd;
    return {
      slug: a.origin?.slug ?? null,
      name: a.origin?.name ?? null,
      family: a.origin?.family ?? null,
      description: a.origin?.description ?? null,
      live: a.origin?.live ?? null,
      used: a.serveCount > 0 || a.leads.size > 0,
      audienceIds: [...a.audienceIds].sort(),
      serveCount: a.serveCount,
      leadsServed: a.leads.size,
      sourcingCostUsd,
      costPerLeadUsd: perUnit(sourcingCostUsd, a.leads.size),
      positiveReplies: replies,
      sourcingCostPerPositiveReplyUsd: perUnit(sourcingCostUsd, replies),
      outreachCostUsd: a.outreachUsd,
      endToEndCostUsd,
      endToEndCostPerPositiveReplyUsd: perUnit(endToEndCostUsd, replies),
      roi: value === null || endToEndCostUsd <= 0 ? null : (replies * value) / endToEndCostUsd,
      roiUnavailableReason: value === null ? "no_positive_reply_value" : endToEndCostUsd <= 0 ? "nothing_spent" : null,
    };
  };

  return {
    origins: SOURCING_ORIGINS.map((o) => stats(accs.get(o.slug)!)),
    unattributed: stats(accs.get(UNKNOWN)!),
    campaigns: campaigns.sort((x, y) => y.totalCostUsd - x.totalCostUsd || x.campaignId.localeCompare(y.campaignId)),
    totals: {
      sourcingCostUsd: decimalCentsToUsd(sumDecimalStrings(sourcingTotal)),
      outreachCostUsd: outreachKnown ? decimalCentsToUsd(sumDecimalStrings(outreachTotal)) : null,
      totalCostUsd: decimalCentsToUsd(sumDecimalStrings(campaignTotal)),
    },
  };
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────

export interface DownstreamIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
}

function runsEnv(): { url: string; apiKey: string } {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  return { url, apiKey };
}

function runsHeaders(apiKey: string, brandId: string, id: DownstreamIdentity): Record<string, string> {
  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": id.orgId, "x-brand-id": brandId };
  if (id.userId) h["x-user-id"] = id.userId;
  if (id.runId) h["x-run-id"] = id.runId;
  return h;
}

const SERVE_PAGE = 500;
const MAX_SERVE_PAGES = 400;

interface ServeRunRow {
  id: string;
  campaignId?: string | null;
  audienceId?: string | null;
  featureSlug?: string | null;
  totalCostInUsdCents?: string;
  netTotalCostInUsdCents?: string;
}

/**
 * Every serve run of the given campaigns with its subtree's COMMITTED cost (runs `GET /v1/runs`,
 * `include=subtreeCost`), one sequential newest-first walk per campaign (a run inserted mid-walk shifts
 * the pages down: a repeat, deduped by id, never a skip), campaigns 4 at a time. Fails loud.
 */
export async function fetchOfferServeCosts(
  brandId: string,
  campaignIds: readonly string[],
  identity: DownstreamIdentity,
  pricing: Pricing,
): Promise<ServeCost[]> {
  const { url, apiKey } = runsEnv();
  const headers = runsHeaders(apiKey, brandId, identity);
  const perCampaign = await mapWithConcurrency(campaignIds, 4, async (campaignId) => {
    const byId = new Map<string, ServeCost>();
    for (let page = 0; ; page += 1) {
      if (page >= MAX_SERVE_PAGES) throw new Error(`runs-service serve walk exceeded ${MAX_SERVE_PAGES} pages for campaign ${campaignId}`);
      const params = new URLSearchParams({
        brandId,
        campaignId,
        serviceName: "lead-service",
        taskName: "lead-serve",
        include: "subtreeCost",
        limit: String(SERVE_PAGE),
        offset: String(page * SERVE_PAGE),
      });
      const response = await fetchWithRetry(`${url}/v1/runs?${params}`, { headers });
      if (!response.ok) throw new Error(`runs-service /v1/runs (serves) failed (${response.status}): ${await response.text()}`);
      const data = (await response.json()) as { runs?: ServeRunRow[] };
      if (!Array.isArray(data.runs)) throw new Error("runs-service /v1/runs returned no runs array");
      for (const r of data.runs) {
        const cents = selectCostCentsString(r, "totalCostInUsdCents", pricing);
        byId.set(r.id, {
          runId: r.id,
          campaignId: r.campaignId ?? campaignId,
          audienceId: r.audienceId ?? null,
          featureSlug: r.featureSlug ?? null,
          cents,
        });
      }
      if (data.runs.length < SERVE_PAGE) return [...byId.values()];
    }
  });
  return perCampaign.flat();
}

/**
 * Each campaign's campaign TOTAL: committed spend of its runs on its channel slugs + every origin slug,
 * one runs `/v1/stats/costs?groupBy=campaignId` read. A campaign with no cost row reads "0".
 */
export async function fetchCampaignTotalCents(
  brandId: string,
  campaignIds: readonly string[],
  channelSlugs: readonly string[],
  identity: DownstreamIdentity,
  pricing: Pricing,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (campaignIds.length === 0) return out;
  const { url, apiKey } = runsEnv();
  const params = new URLSearchParams({
    groupBy: "campaignId",
    brandId,
    featureSlugs: withSourcingSlugs(channelSlugs).join(","),
  });
  const response = await fetchWithRetry(runsCostsUrl(url, "org", pricing, params), { headers: runsHeaders(apiKey, brandId, identity) });
  if (!response.ok) throw new Error(`runs-service /v1/stats/costs (campaign total) failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { groups?: Array<Record<string, unknown> & { dimensions?: { campaignId?: string | null } }> };
  if (!Array.isArray(data.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
  const wanted = new Set(campaignIds);
  for (const g of data.groups) {
    const id = g.dimensions?.campaignId ?? null;
    if (!id || !wanted.has(id)) continue;
    out.set(id, addDecimals(out.get(id) ?? "0", selectCostCentsString(g, "totalCostInUsdCents", pricing)));
  }
  return out;
}

const AUDIENCE_STATUSES = ["suggested", "active", "paused", "archived", "deprecated"] as const;
const AUDIENCE_PAGE = 200;
const MAX_AUDIENCE_PAGES = 100;

interface AudienceListRow {
  id: string;
  channels?: Array<{ list?: string | null }> | null;
}

/**
 * audience id → the list kind human-service states for it (`channels[0].list`; null = it states none),
 * every status, every page (human-service `GET /orgs/audiences`). Fails loud.
 */
export async function fetchAudienceListKinds(brandId: string, identity: DownstreamIdentity): Promise<Map<string, string | null>> {
  const url = process.env.HUMAN_SERVICE_URL;
  const apiKey = process.env.HUMAN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("HUMAN_SERVICE_URL or HUMAN_SERVICE_API_KEY not configured");
  const headers: Record<string, string> = { "x-api-key": apiKey, "x-org-id": identity.orgId, "x-brand-id": brandId };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  const out = new Map<string, string | null>();
  await Promise.all(
    AUDIENCE_STATUSES.map(async (status) => {
      for (let page = 0; ; page += 1) {
        if (page >= MAX_AUDIENCE_PAGES) throw new Error(`human-service audiences walk exceeded ${MAX_AUDIENCE_PAGES} pages for brand ${brandId}`);
        const params = new URLSearchParams({ brandId, status, limit: String(AUDIENCE_PAGE), offset: String(page * AUDIENCE_PAGE) });
        const response = await fetchWithRetry(`${url}/orgs/audiences?${params}`, { headers });
        if (!response.ok) throw new Error(`human-service audiences failed (${response.status}): ${await response.text()}`);
        const data = (await response.json()) as { audiences?: AudienceListRow[] };
        if (!Array.isArray(data.audiences)) throw new Error("human-service audiences returned no audiences array");
        for (const a of data.audiences) out.set(a.id, a.channels?.[0]?.list ?? null);
        if (data.audiences.length < AUDIENCE_PAGE) return;
      }
    }),
  );
  return out;
}
