/**
 * ONE CELL PER WORKFLOW VERSION ON ONE LEG (LIVE-RESEARCH-1018). Pure: the totals are the leg's per-slug evidence
 * (`fetchFleetLegSlugEvidence`, the ranking's own), the dated parts come from the runs ledger (spend by run-start month,
 * per campaign) and the fleet person cell (persons by serve month, per org).
 *
 *  - FLASH: every month. MATURE: spend of runs started before the leg's cutoff, persons served before it (a person
 *    never served stays in the mature total, as the producer counts it, but in no month).
 *  - The outcome is the leg's own: a positive reply, or (a visit leg) a human-judged click on a send our tracker screens;
 *    the people counted on a visit leg are the ones emailed through our own sender (`lib/screened-visits.ts`).
 */
import { legFiguresOf, rollUpLegEvidenceByDynasty, type SlugCostGroup } from "../fleet-leg-maturity.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";
import type { BucketFigures } from "./studies.js";
import type { SlugCell, SlugHalf } from "./buckets.js";

/** Spend of one (slug, campaign) over one run-start window. */
export interface DatedSpendRow {
  workflowSlug: string;
  campaignId: string;
  /** `YYYY-MM` the window sits in. */
  month: string;
  /** The window ends before the leg's cutoff (its runs are in the mature cohort). */
  beforeCutoff: boolean;
  spentUsd: number;
}

export interface SlugCellsInput {
  legKey: string;
  /** The leg's outcome is the click (a visit leg): people and outcomes are the screened halves. */
  screened: boolean;
  /** The outcome signal of the leg. */
  signal: "positiveReply" | "clicked" | "other";
  /** `YYYY-MM-DD` of the cutoff; null when the leg waits for nothing (mature ≡ flash). */
  cutoffDay: string | null;
  flash: { costGroups: readonly SlugCostGroup[]; emailStats: ReadonlyMap<string, Record<string, number>> };
  mature: { costGroups: readonly SlugCostGroup[]; emailStats: ReadonlyMap<string, Record<string, number>> } | null;
  persons: readonly FleetPersonBucket[];
  spend: readonly DatedSpendRow[];
  orgOfCampaign: ReadonlyMap<string, string>;
}

const ZERO = (): BucketFigures => ({ spentUsd: 0, contacted: 0, outcomes: 0 });

function perSlug(costGroups: readonly SlugCostGroup[], emailStats: ReadonlyMap<string, Record<string, number>>) {
  const slugs = new Set<string>();
  for (const g of costGroups) if (g.dimensions.workflowSlug && g.dimensions.workflowSlug !== "__total__") slugs.add(g.dimensions.workflowSlug);
  // Each version its own "dynasty": the ranking's roll-up, one slug at a time.
  return rollUpLegEvidenceByDynasty([...slugs].map((s) => ({ workflowSlug: s, workflowDynastySlug: s })), costGroups, emailStats).byDynasty;
}

/** PURE. Every slug with spend on the leg, both halves. */
export function buildSlugCells(input: SlugCellsInput): SlugCell[] {
  const flashBy = perSlug(input.flash.costGroups, input.flash.emailStats);
  const matureBy = input.mature ? perSlug(input.mature.costGroups, input.mature.emailStats) : null;
  const personOf = (b: FleetPersonBucket): BucketFigures => ({
    spentUsd: 0,
    contacted: input.screened ? b.screenedContacted : b.contacted,
    outcomes: input.signal === "positiveReply" ? b.positiveReplies : input.signal === "clicked" ? (input.screened ? b.humanClicked : b.clicked) : 0,
  });
  const dated = new Map<string, { flash: { months: Record<string, BucketFigures>; strata: Record<string, BucketFigures> }; mature: { months: Record<string, BucketFigures>; strata: Record<string, BucketFigures> } }>();
  const datedOf = (slug: string) => {
    let d = dated.get(slug);
    if (!d) {
      d = { flash: { months: {}, strata: {} }, mature: { months: {}, strata: {} } };
      dated.set(slug, d);
    }
    return d;
  };
  const add = (into: Record<string, BucketFigures>, key: string, f: BucketFigures) => {
    const t = (into[key] ??= ZERO());
    t.spentUsd += f.spentUsd;
    t.contacted += f.contacted;
    t.outcomes += f.outcomes;
  };
  for (const b of input.persons) {
    if (!b.servedDay) continue;
    const month = b.servedDay.slice(0, 7);
    const f = personOf(b);
    const stratum = `${b.orgId}|${month}`;
    const d = datedOf(b.workflowSlug);
    add(d.flash.months, month, f);
    add(d.flash.strata, stratum, f);
    if (input.cutoffDay === null || b.servedDay < input.cutoffDay) {
      add(d.mature.months, month, f);
      add(d.mature.strata, stratum, f);
    }
  }
  // A visit leg's spend is the SCREENABLE share of each version's spend (`lib/screened-visits.ts`); dated, that share is
  // the month's own (people emailed through our sender ÷ people emailed that month): a month nothing could be screened
  // in carries no visit spend, never a slice of the total spread over it.
  const shareOf = new Map<string, [number, number]>();
  if (input.screened) {
    for (const b of input.persons) {
      if (!b.servedDay) continue;
      const k = `${b.workflowSlug}\t${b.servedDay.slice(0, 7)}`;
      const t = shareOf.get(k) ?? [0, 0];
      t[0] += b.contacted;
      t[1] += b.screenedContacted;
      shareOf.set(k, t);
    }
  }
  const screenShare = (slug: string, month: string): number => {
    if (!input.screened) return 1;
    const t = shareOf.get(`${slug}\t${month}`);
    return t && t[0] > 0 ? Math.min(1, t[1] / t[0]) : 0;
  };
  for (const r of input.spend) {
    const org = input.orgOfCampaign.get(r.campaignId);
    const f = { spentUsd: r.spentUsd * screenShare(r.workflowSlug, r.month), contacted: 0, outcomes: 0 };
    const d = datedOf(r.workflowSlug);
    add(d.flash.months, r.month, f);
    if (org) add(d.flash.strata, `${org}|${r.month}`, f);
    if (input.cutoffDay === null || r.beforeCutoff) {
      add(d.mature.months, r.month, f);
      if (org) add(d.mature.strata, `${org}|${r.month}`, f);
    }
  }
  const cells: SlugCell[] = [];
  for (const [slug, ev] of flashBy) {
    const d = dated.get(slug) ?? { flash: { months: {}, strata: {} }, mature: { months: {}, strata: {} } };
    const flash: SlugHalf = { figures: figuresOf(input.legKey, ev), months: d.flash.months, strata: d.flash.strata };
    const mature: SlugHalf | null = matureBy ? { figures: figuresOf(input.legKey, matureBy.get(slug)), months: d.mature.months, strata: d.mature.strata } : null;
    cells.push({ slug, flash, mature });
  }
  return cells.sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

function figuresOf(legKey: string, ev: Parameters<typeof legFiguresOf>[1]): BucketFigures {
  const f = legFiguresOf(legKey, ev);
  return { spentUsd: f.spentUsd, contacted: f.contacted, outcomes: f.outcomes };
}
