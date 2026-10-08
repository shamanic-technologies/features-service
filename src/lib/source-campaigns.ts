/**
 * SOURCE CAMPAIGNS — the offer's sourcing origins served as CAMPAIGNS (owner 2026-10-07, "the sources ARE
 * campaigns"), and the outreach campaigns' money split around them. PURE: every input is read by a route.
 *
 *   <Name>      [Apollo Cold Filters] -> Lead found                 [On]  [Up to $X/day]   (source campaign)
 *   Jubilation  Lead found -> Sales Cold Email -> Positive reply    [On]  [Up to $Y/day]   (outreach campaign)
 *
 * IDENTITY (what campaign-service and billing key On/Off and budget on, like every campaign of the fleet):
 *   (offerId, featureSlug = the origin's slug, legKey = `SOURCE_LEG_KEY` "start_to_lead_found").
 *   campaignKey = `campaign:<origin slug>|start_to_lead_found` (`sourceCampaignKeyOf`).
 * The outreach campaigns keep their identity, name and history (Jubilation is still
 * `campaign:sales-cold-email-outreach|start_to_conversation`); an entry campaign of a channel that sources
 * leads states `fedBy` = the `lead_found` step and the source campaigns that feed it.
 *
 * MONEY (nothing moves; every figure is a re-cut of `/offers/:id/sourcing`, same Gold cell):
 *   source campaign costUsd   = the origin's sourcing cost (Σ committed subtree cost of its serves) over every
 *                               campaign of the offer + the non-serve spend of campaigns whose featureSlug IS
 *                               the origin (none today; the future state where serves run under the source
 *                               campaign's own id). Split per outreach campaign in `costByOutreachCampaign`.
 *   outreach ownCostUsd       = its total − the sourcing a source campaign now carries = its outreach + the
 *                               sourcing NO origin is proven for (unattributed, never spread).
 * So, per outreach campaign: Σ sourcedBy + ownCostUsd = totalCostUsd (its old figure), and over the offer:
 *   Σ sourceCampaigns.costUsd + Σ outreachCampaigns.ownCostUsd = totals.totalCostUsd.
 *
 * ROI of a source campaign (measured, since inception) = what its leads returned once contacted: the
 * origin's positive replies × the offer's value of a positive reply ÷ what those leads cost end to end
 * (sourcing + the outreach spent on them). An origin nothing was spent on is unmeasured (reason stated).
 */
import { campaignNameKeyOf } from "./offer-sales-paths.js";
import {
  LEAD_FOUND_STEP,
  SOURCE_LEG_KEY,
  SOURCING_ORIGINS,
  SOURCING_PARENT_CHANNEL_SLUGS,
  sourceCampaignKeyOf,
  sourcingOriginBySlug,
  type SourcingOrigin,
  type SourcingProvider,
} from "./sourcing-origins.js";
import type { OfferSourcing, OriginStats, SourceOverlap } from "./offer-sourcing.js";

export type SourceCampaignRoiUnavailableReason =
  | "no_positive_reply_value"
  | "nothing_spent"
  /** The offer's sourcing read failed: the row is listed (identity, name), its figures are null. */
  | "sourcing_unavailable";

export interface LeadFoundStep {
  key: "lead_found";
  label: string;
  description: string;
  shortDescription: string;
}

export interface SourceCampaign {
  kind: "source";
  /** `campaign:<origin slug>|start_to_lead_found`, unique within the response. */
  campaignKey: string;
  /** The ORIGIN's feature slug: what campaign-service and billing key the campaign on, with `legKey`. */
  channelSlug: string;
  /** The origin's name (Apollo Cold Filters, ...). */
  channelName: string;
  legKey: typeof SOURCE_LEG_KEY;
  campaignName: string | null;
  reactive: false;
  managed: true;
  operatedBy: "platform";
  fromStep: null;
  toStep: LeadFoundStep;
  provider: SourcingProvider | null;
  family: SourcingOrigin["family"];
  description: string;
  /** False on a retired origin (listed only when the offer used it: its history still costs what it cost). */
  live: boolean;
  roi: number | null;
  roiBasis: "measured";
  roiUnavailableReason: SourceCampaignRoiUnavailableReason | null;
  /** Leads CARRYING this source (a lead two sources found counts in both). */
  leadsFound: number | null;
  /** Of `leadsFound`, the leads another source found too. Null when unreadable. */
  leadsAlsoFoundByAnotherSource: number | null;
  positiveReplies: number | null;
  costUsd: number | null;
  endToEndCostUsd: number | null;
  costPerLeadUsd: number | null;
  costByOutreachCampaign: Array<{ campaignKey: string | null; featureSlug: string; legKey: string | null; costUsd: number }>;
}

/** The offer's leads by number of sources that found them, as `/offers/:id/sourcing` serves it. */
export interface SourceOverlapView {
  sourceOverlap: SourceOverlap | null;
  sourceOverlapUnavailableReason: "memberships_unavailable" | "sourcing_unavailable" | null;
}

/** PURE: the overlap block of a sourcing read (null read = `sourcing_unavailable`). */
export function sourceOverlapOf(sourcing: OfferSourcing | null): SourceOverlapView {
  if (!sourcing) return { sourceOverlap: null, sourceOverlapUnavailableReason: "sourcing_unavailable" };
  return { sourceOverlap: sourcing.sourceOverlap, sourceOverlapUnavailableReason: sourcing.sourceOverlapUnavailableReason };
}

export interface FedBy {
  step: LeadFoundStep;
  sourceCampaignKeys: string[];
}

export interface OutreachCampaignSplit {
  /** `campaign:<channel slug>|<leg key>`: the sales-paths campaign this money is; null when campaign-service states no leg. */
  campaignKey: string | null;
  featureSlug: string;
  legKey: string | null;
  campaignIds: string[];
  /** The campaign's committed spend since inception, UNCHANGED (Σ of its campaign-service campaigns' totals). */
  totalCostUsd: number;
  sourcingCostUsd: number;
  outreachCostUsd: number | null;
  /** The part of its sourcing each source campaign now carries. */
  sourcedBy: Array<{ sourceCampaignKey: string; originSlug: string; costUsd: number }>;
  /** Sourcing no origin is proven for: it stays on this campaign, never spread. */
  unattributedSourcingCostUsd: number;
  /** totalCostUsd − Σ sourcedBy = outreach + unattributed sourcing. Σ sourcedBy + ownCostUsd = totalCostUsd. */
  ownCostUsd: number;
}

const leadFound = (): LeadFoundStep => ({ ...LEAD_FOUND_STEP });

const keyOf = (featureSlug: string, legKey: string | null): string | null => (legKey ? campaignNameKeyOf(featureSlug, legKey) : null);

/** The origins served as source campaigns: every LIVE origin, plus a retired one the offer used. Catalogue order. */
export function sourceCampaignOrigins(sourcing: OfferSourcing | null): SourcingOrigin[] {
  const used = new Set((sourcing?.origins ?? []).filter((o) => o.used).map((o) => o.slug));
  return [...SOURCING_ORIGINS].filter((o) => o.live || used.has(o.slug)).sort((a, b) => a.displayOrder - b.displayOrder);
}

/** The keys a campaign name is assigned under for the source campaigns, in display order. */
export function sourceCampaignNameKeys(origins: readonly SourcingOrigin[]): string[] {
  return origins.map((o) => sourceCampaignKeyOf(o.slug));
}

/** PURE: each outreach campaign (channel × leg) of the offer, its total unchanged, split around the source campaigns. */
export function buildOutreachCampaignSplits(sourcing: OfferSourcing): OutreachCampaignSplit[] {
  const out = new Map<string, OutreachCampaignSplit>();
  for (const c of sourcing.campaigns) {
    if (sourcingOriginBySlug(c.featureSlug)) continue; // a source campaign's own row: it is a source campaign
    const id = `${c.featureSlug}|${c.legKey ?? ""}`;
    let s = out.get(id);
    if (!s) {
      s = {
        campaignKey: keyOf(c.featureSlug, c.legKey),
        featureSlug: c.featureSlug,
        legKey: c.legKey,
        campaignIds: [],
        totalCostUsd: 0,
        sourcingCostUsd: 0,
        outreachCostUsd: 0,
        sourcedBy: [],
        unattributedSourcingCostUsd: 0,
        ownCostUsd: 0,
      };
      out.set(id, s);
    }
    s.campaignIds.push(c.campaignId);
    s.totalCostUsd += c.totalCostUsd;
    s.sourcingCostUsd += c.sourcingCostUsd;
    s.outreachCostUsd = s.outreachCostUsd === null || c.outreachCostUsd === null ? null : s.outreachCostUsd + c.outreachCostUsd;
    for (const src of c.sources) {
      if (src.slug === null) {
        s.unattributedSourcingCostUsd += src.sourcingCostUsd;
        continue;
      }
      const key = sourceCampaignKeyOf(src.slug);
      const e = s.sourcedBy.find((x) => x.sourceCampaignKey === key);
      if (e) e.costUsd += src.sourcingCostUsd;
      else s.sourcedBy.push({ sourceCampaignKey: key, originSlug: src.slug, costUsd: src.sourcingCostUsd });
    }
  }
  return [...out.values()]
    .map((s) => ({
      ...s,
      campaignIds: [...s.campaignIds].sort(),
      sourcedBy: s.sourcedBy.sort((a, b) => b.costUsd - a.costUsd || a.sourceCampaignKey.localeCompare(b.sourceCampaignKey)),
      ownCostUsd: s.totalCostUsd - s.sourcedBy.reduce((t, x) => t + x.costUsd, 0),
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd || (a.campaignKey ?? "~").localeCompare(b.campaignKey ?? "~"));
}

/**
 * PURE: one source campaign per origin of `sourceCampaignOrigins`, its figures read off the offer's sourcing
 * (null + `sourcing_unavailable` when that read failed: the row is still listed so it can be turned on).
 */
export function buildSourceCampaigns(input: { sourcing: OfferSourcing | null; names: ReadonlyMap<string, string> }): SourceCampaign[] {
  const { sourcing } = input;
  const stats = new Map<string, OriginStats>((sourcing?.origins ?? []).filter((o) => o.slug).map((o) => [o.slug!, o] as const));
  // Non-serve spend of campaigns whose featureSlug IS an origin (a source campaign's own runs): it is the source's.
  const ownRemainder = new Map<string, number>();
  const byOutreach = new Map<string, Map<string, { campaignKey: string | null; featureSlug: string; legKey: string | null; costUsd: number }>>();
  for (const c of sourcing?.campaigns ?? []) {
    const self = sourcingOriginBySlug(c.featureSlug);
    if (self) ownRemainder.set(self.slug, (ownRemainder.get(self.slug) ?? 0) + (c.outreachCostUsd ?? 0));
    for (const src of c.sources) {
      if (!src.slug) continue;
      const m = byOutreach.get(src.slug) ?? new Map();
      const id = `${c.featureSlug}|${c.legKey ?? ""}`;
      const e = m.get(id) ?? { campaignKey: keyOf(c.featureSlug, c.legKey), featureSlug: c.featureSlug, legKey: c.legKey, costUsd: 0 };
      e.costUsd += src.sourcingCostUsd;
      m.set(id, e);
      byOutreach.set(src.slug, m);
    }
  }
  return sourceCampaignOrigins(sourcing).map((o): SourceCampaign => {
    const key = sourceCampaignKeyOf(o.slug);
    const s = stats.get(o.slug) ?? null;
    const base = {
      kind: "source" as const,
      campaignKey: key,
      channelSlug: o.slug,
      channelName: o.name,
      legKey: SOURCE_LEG_KEY,
      campaignName: input.names.get(key) ?? null,
      reactive: false as const,
      managed: true as const,
      operatedBy: "platform" as const,
      fromStep: null,
      toStep: leadFound(),
      provider: o.provider,
      family: o.family,
      description: o.description,
      live: o.live,
      roiBasis: "measured" as const,
    };
    if (!sourcing || !s) {
      return {
        ...base,
        roi: null,
        roiUnavailableReason: "sourcing_unavailable",
        leadsFound: null,
        leadsAlsoFoundByAnotherSource: null,
        positiveReplies: null,
        costUsd: null,
        endToEndCostUsd: null,
        costPerLeadUsd: null,
        costByOutreachCampaign: [],
      };
    }
    const own = ownRemainder.get(o.slug) ?? 0;
    const costUsd = s.sourcingCostUsd + own;
    return {
      ...base,
      roi: s.roi,
      roiUnavailableReason: s.roiUnavailableReason,
      leadsFound: s.leadsServed,
      leadsAlsoFoundByAnotherSource: s.leadsAlsoFoundByAnotherSource,
      positiveReplies: s.positiveReplies,
      costUsd,
      endToEndCostUsd: s.endToEndCostUsd + own,
      costPerLeadUsd: s.leadsServed > 0 ? costUsd / s.leadsServed : null,
      costByOutreachCampaign: [...(byOutreach.get(o.slug)?.values() ?? [])]
        .filter((e) => !sourcingOriginBySlug(e.featureSlug))
        .sort((a, b) => b.costUsd - a.costUsd || (a.campaignKey ?? "~").localeCompare(b.campaignKey ?? "~")),
    };
  });
}

/** PURE: whether a sales-paths campaign row is fed by `lead_found` — an ENTRY campaign of a channel that sources leads. */
export function isFedByLeadFound(c: { channelSlug: string; reactive: boolean }): boolean {
  return !c.reactive && SOURCING_PARENT_CHANNEL_SLUGS.includes(c.channelSlug);
}

/** PURE: the sales-paths body with `sourceCampaigns` beside `campaigns`, and `fedBy` on every campaign row. Additive. */
export function withSourceCampaigns<C extends { channelSlug: string; reactive: boolean }, B extends { campaigns?: C[] }>(
  body: B,
  sourceCampaigns: SourceCampaign[],
  overlap: SourceOverlapView,
): Omit<B, "campaigns"> & { campaigns?: Array<C & { fedBy: FedBy | null }>; sourceCampaigns: SourceCampaign[] } & SourceOverlapView {
  const keys = sourceCampaigns.map((s) => s.campaignKey);
  const campaigns = body.campaigns?.map((c) => ({
    ...c,
    fedBy: isFedByLeadFound(c) ? ({ step: leadFound(), sourceCampaignKeys: [...keys] } satisfies FedBy) : null,
  }));
  return { ...body, ...(campaigns ? { campaigns } : {}), sourceCampaigns, ...overlap };
}
