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
 * A lead CARRIES every origin that found it (owner 2026-10-08, no first-found credit): its serve's origin
 * (audience kind, else the proven unrecorded origin) PLUS the list kind of every audience of the offer
 * human-service records it a member of (`MembershipOrigins`: served there, or found there while already
 * taken for the brand). A lead with a proven origin is never also unattributed.
 *   sourcingCostUsd     Σ subtree cost of the serves from that origin (run slug, else audience kind).
 *   leadsServed         distinct leads CARRYING that origin (a lead two sources found counts in both).
 *   leadsAlsoFoundByAnotherSource  of those, the leads another origin found too.
 *   positiveReplies     those leads with a positive reply (same per-lead signal as the outcome reads).
 *   outreachCostUsd     each campaign's outreach split evenly over the leads it served, each lead's share
 *                       credited to EVERY origin it carries (`outreachAllocation`): an outreach run
 *                       writes to one lead, the cost of a lead's emails is not split per origin upstream.
 * The OFFER counts each lead once: `sourceOverlap` buckets the leads by how many origins found them
 * (Σ buckets = leadTotal) and states the excess Σ per-origin leads carries (`extraSourceCredits`).
 *   endToEndCostUsd        sourcing + allocated outreach: what the origin's leads cost end to end.
 *   roi                 positive replies × value of a positive reply (offer terms) ÷ end-to-end cost.
 * A serve or lead that recorded NO audience takes the origin its campaign's unrecorded runs are PROVEN
 * to come from (`originOfUnrecorded`: a single-origin channel, or the lead-provider costs those runs
 * bought). Only WHICH origin a serve counts under moves: every campaign total and sourcing figure is
 * the same sum. Serves and leads nothing proves sit in `unattributed`, never spread.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { addDecimals, decimalCentsToUsd, sumDecimalStrings } from "./decimal.js";
import { mapWithConcurrency } from "./concurrency.js";
import { runsCostsUrl, selectCostCentsString, type Pricing } from "./pricing.js";
import { isMatureCount, legCutoffIso, legMaturity, maturityPair, servedInMatureCohort, type MaturityPair } from "./maturity.js";
import {
  SOURCING_ORIGINS,
  originOfServe,
  originOfUnrecorded,
  sourcingOriginBySlug,
  sourcingOriginOfList,
  withSourcingSlugs,
  type SourcingOrigin,
  type SourcingProvider,
  type UnrecordedCostEvidence,
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
  /** The lead's email: the key its audience memberships (human-service) join on. */
  email?: string | null;
  /** When the run that contacts it took it (the maturity clock). Null/absent = not stated (in the mature cohort). */
  servedAt?: string | null;
}

/**
 * EVERY SOURCE THAT FOUND A PERSON (owner 2026-10-08: "It must be tagged both ... So we know a human
 * belongs to several signals, which is a higher interest"): normalised email → the origin slugs of every
 * audience of this offer (or of no offer) human-service records the person a member of, served there or
 * found there while already taken. Null = the read failed: every lead carries only its serve's origin and
 * the overlap figures are null, never "nobody was found twice".
 */
export type MembershipOrigins = ReadonlyMap<string, ReadonlySet<string>>;

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
  provider: SourcingProvider | null;
  description: string | null;
  live: boolean | null;
  used: boolean;
  audienceIds: string[];
  serveCount: number;
  leadsServed: number;
  /** Of `leadsServed`, the leads another source found too. Null when memberships were unreadable. */
  leadsAlsoFoundByAnotherSource: number | null;
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
  sources: Array<{ slug: string | null; name: string | null; provider: SourcingProvider | null; sourcingCostUsd: number; serveCount: number; leadsServed: number }>;
  serveCount: number;
  leadsServed: number;
  positiveReplies: number;
  sourcingCostUsd: number;
  outreachCostUsd: number | null;
  totalCostUsd: number;
  outreachUnavailableReason: "sourcing_exceeds_campaign_total" | null;
  costPerPositiveReply: { sourcingUsd: number | null; outreachUsd: number | null; totalUsd: number | null };
}

/** The leads, positive replies and positive reply rate of one population. */
export interface ReplyFigures {
  leads: number;
  positiveReplies: number;
  /** 100 × positiveReplies / leads; null at 0 leads (a measured 0 stays 0). */
  positiveReplyRatePct: number | null;
}

/** The offer's leads bucketed by how many sources found each one. */
export interface SourceCountBucket extends ReplyFigures {
  /** 0 = no source proven (unattributed), 1, 2, 3 = three or more. */
  sourceCount: 0 | 1 | 2 | 3;
  label: "unattributed" | "1" | "2" | "3+";
  /** FLASH (every lead to date) + MATURE (leads served before the conversation leg's cutoff) + the verdict. */
  maturity: MaturityPair<ReplyFigures>;
}

export interface SourceOverlap {
  window: "since_inception";
  /** Distinct leads of the offer's campaigns, each counted ONCE (= Σ buckets.leads). */
  leadTotal: number;
  positiveReplyTotal: number;
  /** Σ over origins of `leadsServed`: ≥ the leads with a source; the excess is `extraSourceCredits`. */
  sourceCreditTotal: number;
  /** Leads 2+ sources found. */
  multiSourceLeads: number;
  /** Σ over multi-source leads of (sources − 1) = sourceCreditTotal − (leadTotal − unattributed leads). */
  extraSourceCredits: number;
  /** The maturity rule the buckets' MATURE cohort and verdict follow (the conversation leg's). */
  maturityRule: { legKey: string; durationDays: number; outcomesRequired: number; cutoff: string | null };
  buckets: SourceCountBucket[];
}

export interface OfferSourcing {
  origins: OriginStats[];
  unattributed: OriginStats;
  campaigns: CampaignSourcingSplit[];
  totals: { sourcingCostUsd: number; outreachCostUsd: number | null; totalCostUsd: number };
  /** Null when human-service's memberships were unreadable (`sourceOverlapUnavailableReason`). */
  sourceOverlap: SourceOverlap | null;
  sourceOverlapUnavailableReason: "memberships_unavailable" | null;
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
  alsoFoundElsewhere: Set<string>;
  outreachUsd: number;
}

/** PURE: the per-origin and per-campaign figures. */
export function computeOfferSourcing(input: {
  campaigns: readonly SourcingCampaignInput[];
  serves: readonly ServeCost[];
  totalCentsByCampaign: ReadonlyMap<string, string>;
  listOfAudience: ReadonlyMap<string, string | null>;
  /** campaign id → the origin its unrecorded (audience-less) serves and leads are proven to come from. */
  unrecordedOriginByCampaign: ReadonlyMap<string, SourcingOrigin | null>;
  leads: readonly SourcedLead[];
  valuePerPositiveReplyUsd: number | null;
  /** Every source that found each person; null = unreadable. Absent = not read (same as null). */
  memberships?: MembershipOrigins | null;
  now?: Date;
}): OfferSourcing {
  const memberships = input.memberships ?? null;
  const campaignIds = new Set(input.campaigns.map((c) => c.id));
  const accs = new Map<string, OriginAcc>();
  const UNKNOWN = "__unattributed__";
  const acc = (origin: SourcingOrigin | null): OriginAcc => {
    const key = origin?.slug ?? UNKNOWN;
    let a = accs.get(key);
    if (!a) {
      a = { origin, audienceIds: new Set(), serveCount: 0, cents: [], leads: new Set(), replied: new Set(), alsoFoundElsewhere: new Set(), outreachUsd: 0 };
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
    const origin = originOfServe({
      runFeatureSlug: s.featureSlug,
      audienceId: s.audienceId,
      listOfAudience: input.listOfAudience,
      unrecordedOrigin: input.unrecordedOriginByCampaign.get(s.campaignId) ?? null,
    });
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

  // Per lead (the offer counts each ONCE): every origin it carries — its serves' and every audience that found it.
  interface LeadAcc {
    origins: Set<string>;
    replied: boolean;
    emails: Set<string>;
    servedAt: string | null;
  }
  const leadAccs = new Map<string, LeadAcc>();
  for (const l of input.leads) {
    if (!l.campaignId || !campaignIds.has(l.campaignId)) continue;
    const origin = l.audienceId
      ? sourcingOriginOfList(input.listOfAudience.get(l.audienceId) ?? null)
      : (input.unrecordedOriginByCampaign.get(l.campaignId) ?? null);
    if (l.audienceId) acc(origin).audienceIds.add(l.audienceId);
    const c = camp(l.campaignId);
    c.leads.add(l.leadId);
    if (l.positiveReply) c.replied.add(l.leadId);
    campOrigin(c, origin).leads.add(l.leadId);
    let la = leadAccs.get(l.leadId);
    if (!la) {
      la = { origins: new Set(), replied: false, emails: new Set(), servedAt: null };
      leadAccs.set(l.leadId, la);
    }
    la.origins.add(origin?.slug ?? UNKNOWN);
    if (l.positiveReply) la.replied = true;
    const email = l.email?.trim().toLowerCase();
    if (email) la.emails.add(email);
    if (l.servedAt && (la.servedAt === null || l.servedAt < la.servedAt)) la.servedAt = l.servedAt;
  }
  for (const la of leadAccs.values()) {
    if (memberships) for (const e of la.emails) for (const slug of memberships.get(e) ?? []) if (accs.has(slug)) la.origins.add(slug);
    // A lead some source is proven for is not unattributed.
    if (la.origins.size > 1) la.origins.delete(UNKNOWN);
  }
  for (const [leadId, la] of leadAccs) {
    for (const slug of la.origins) {
      const a = accs.get(slug)!;
      a.leads.add(leadId);
      if (la.replied) a.replied.add(leadId);
      if (la.origins.size > 1) a.alsoFoundElsewhere.add(leadId);
    }
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
      // A lead's share is credited to EVERY source it carries (each source's end-to-end cost is what its
      // leads cost; rows are not additive across sources when a lead came from two).
      const outreachUsd = decimalCentsToUsd(outreachCents);
      const totalLeads = c.leads.size;
      if (totalLeads === 0) acc(null).outreachUsd += outreachUsd;
      else
        for (const leadId of c.leads)
          for (const slug of leadAccs.get(leadId)!.origins) accs.get(slug)!.outreachUsd += outreachUsd / totalLeads;
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
          provider: e.origin?.provider ?? null,
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
      provider: a.origin?.provider ?? null,
      description: a.origin?.description ?? null,
      live: a.origin?.live ?? null,
      used: a.serveCount > 0 || a.leads.size > 0,
      audienceIds: [...a.audienceIds].sort(),
      serveCount: a.serveCount,
      leadsServed: a.leads.size,
      leadsAlsoFoundByAnotherSource: memberships ? a.alsoFoundElsewhere.size : null,
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
    sourceOverlap: memberships ? buildSourceOverlap([...leadAccs.values()], input.now ?? new Date()) : null,
    sourceOverlapUnavailableReason: memberships ? null : "memberships_unavailable",
  };
}

/** The leg whose maturity rule a positive-reply rate follows. */
const REPLY_LEG = "start_to_conversation";

const replyFigures = (leads: number, positiveReplies: number): ReplyFigures => ({
  leads,
  positiveReplies,
  positiveReplyRatePct: leads > 0 ? (100 * positiveReplies) / leads : null,
});

/** PURE: the offer's leads bucketed by how many sources found each (0 = unattributed, 1, 2, 3+). */
export function buildSourceOverlap(
  leads: ReadonlyArray<{ origins: ReadonlySet<string>; replied: boolean; servedAt: string | null }>,
  now: Date,
): SourceOverlap {
  const rule = legMaturity(REPLY_LEG);
  const cutoff = legCutoffIso(REPLY_LEG, now);
  const LABELS = ["unattributed", "1", "2", "3+"] as const;
  const counts = LABELS.map(() => ({ flash: [0, 0], mature: [0, 0] }));
  let credits = 0;
  let multi = 0;
  let replies = 0;
  for (const l of leads) {
    const known = [...l.origins].filter((o) => sourcingOriginBySlug(o)).length;
    credits += known;
    if (known > 1) multi += 1;
    if (l.replied) replies += 1;
    const b = counts[Math.min(known, 3)]!;
    b.flash[0]! += 1;
    if (l.replied) b.flash[1]! += 1;
    if (servedInMatureCohort(l.servedAt, cutoff)) {
      b.mature[0]! += 1;
      if (l.replied) b.mature[1]! += 1;
    }
  }
  const unattributed = counts[0]!.flash[0]!;
  return {
    window: "since_inception",
    leadTotal: leads.length,
    positiveReplyTotal: replies,
    sourceCreditTotal: credits,
    multiSourceLeads: multi,
    extraSourceCredits: credits - (leads.length - unattributed),
    maturityRule: { legKey: REPLY_LEG, durationDays: rule.durationDays, outcomesRequired: rule.outcomesRequired, cutoff },
    buckets: counts.map((c, i) => {
      const flash = replyFigures(c.flash[0]!, c.flash[1]!);
      const mature = replyFigures(c.mature[0]!, c.mature[1]!);
      return {
        sourceCount: i as 0 | 1 | 2 | 3,
        label: LABELS[i]!,
        ...flash,
        maturity: maturityPair(flash, mature.leads > 0 ? mature : null, isMatureCount(mature.positiveReplies, REPLY_LEG)),
      };
    }),
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

/**
 * Per campaign, the cost names its UNRECORDED runs bought (cost rows with no audience, on the channel
 * slugs + origin slugs) and each name's latest run start: the evidence `originOfUnrecorded` reads.
 * One runs `/v1/stats/costs?groupBy=campaignId,audienceId,costName` read. Fails loud.
 */
export async function fetchUnrecordedCostEvidence(
  brandId: string,
  campaignIds: readonly string[],
  channelSlugs: readonly string[],
  identity: DownstreamIdentity,
): Promise<Map<string, UnrecordedCostEvidence[]>> {
  const out = new Map<string, UnrecordedCostEvidence[]>();
  if (campaignIds.length === 0) return out;
  const { url, apiKey } = runsEnv();
  const params = new URLSearchParams({
    groupBy: "campaignId,audienceId,costName",
    brandId,
    featureSlugs: withSourcingSlugs(channelSlugs).join(","),
  });
  const response = await fetchWithRetry(runsCostsUrl(url, "org", "gross", params), { headers: runsHeaders(apiKey, brandId, identity) });
  if (!response.ok) throw new Error(`runs-service /v1/stats/costs (unrecorded evidence) failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as {
    groups?: Array<{ dimensions?: { campaignId?: string | null; audienceId?: string | null; costName?: string | null }; maxStartedAt?: string | null }>;
  };
  if (!Array.isArray(data.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
  const wanted = new Set(campaignIds);
  for (const g of data.groups) {
    const id = g.dimensions?.campaignId ?? null;
    const costName = g.dimensions?.costName ?? null;
    if (!id || !wanted.has(id) || g.dimensions?.audienceId || !costName) continue;
    const list = out.get(id) ?? [];
    list.push({ costName, maxStartedAt: g.maxStartedAt ?? null });
    out.set(id, list);
  }
  return out;
}

/** campaign id → the origin of its unrecorded serves and leads (null = nothing proves one). PURE. */
export function unrecordedOriginsByCampaign(
  campaigns: readonly Pick<SourcingCampaignInput, "id" | "featureSlug">[],
  evidence: ReadonlyMap<string, readonly UnrecordedCostEvidence[]>,
): Map<string, SourcingOrigin | null> {
  return new Map(campaigns.map((c) => [c.id, originOfUnrecorded(c.featureSlug, evidence.get(c.id) ?? [])] as const));
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

const MEMBERSHIP_PAGE = 5000;
const MAX_MEMBERSHIP_PAGES = 200;

interface MembershipPersonRow {
  emailNorm?: string | null;
  memberships?: Array<{ audienceId?: string; offerId?: string | null; list?: string | null }> | null;
}

/**
 * normalised email → the origins of every audience of `offerId` (or of no offer) the person is a member of,
 * RAW (no deprecated→canonical collapse), from human-service `GET /internal/brands/:brandId/memberships`,
 * every page. Throws on any failure (the caller degrades to `memberships_unavailable`, loudly).
 */
export async function fetchMembershipOrigins(brandId: string, offerId: string, identity: DownstreamIdentity): Promise<Map<string, Set<string>>> {
  const url = process.env.HUMAN_SERVICE_URL;
  const apiKey = process.env.HUMAN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("HUMAN_SERVICE_URL or HUMAN_SERVICE_API_KEY not configured");
  const out = new Map<string, Set<string>>();
  for (let page = 0; ; page += 1) {
    if (page >= MAX_MEMBERSHIP_PAGES) throw new Error(`human-service memberships walk exceeded ${MAX_MEMBERSHIP_PAGES} pages for brand ${brandId}`);
    const params = new URLSearchParams({ orgId: identity.orgId, limit: String(MEMBERSHIP_PAGE), offset: String(page * MEMBERSHIP_PAGE) });
    const response = await fetchWithRetry(`${url}/internal/brands/${encodeURIComponent(brandId)}/memberships?${params}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!response.ok) throw new Error(`human-service memberships failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { people?: MembershipPersonRow[] };
    if (!Array.isArray(data.people)) throw new Error("human-service memberships returned no people array");
    for (const p of data.people) {
      const email = p.emailNorm?.trim().toLowerCase();
      if (!email) continue;
      for (const m of p.memberships ?? []) {
        if (m.offerId && m.offerId !== offerId) continue;
        const origin = sourcingOriginOfList(m.list ?? null);
        if (!origin) continue;
        const set = out.get(email) ?? new Set<string>();
        set.add(origin.slug);
        out.set(email, set);
      }
    }
    if (data.people.length < MEMBERSHIP_PAGE) return out;
  }
}
