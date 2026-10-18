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
  /** The org whose campaigns the spend is on (a stratum is a client x month). */
  orgId: string;
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
    const org = r.orgId;
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

/**
 * PURE. Each slug cell SPLIT by what wrote its people's sequences (LIVE-RESEARCH-1018: the LLM, template, naming and
 * first-email studies). `groupOf` names a person bucket's group (a model, a template, a layout...), null = not on record.
 * A slug's people, outcomes and spend are shared out on its people: each group takes the slug's figures in the
 * proportion its own people (and their outcomes) hold, month by month for the dated parts. So a group's figures add up,
 * over its slugs, to exactly what the ranking's per-version evidence states, and a slug the groups do not cover keeps
 * the rest in `leftOut`.
 */
export function splitCellsByGroup(
  cells: readonly SlugCell[],
  persons: readonly FleetPersonBucket[],
  input: Pick<SlugCellsInput, "screened" | "signal" | "cutoffDay">,
  groupOf: (b: FleetPersonBucket) => string | null,
): { cells: SlugCell[]; leftOut: { contacted: number; outcomes: number } } {
  const contactedOf = (b: FleetPersonBucket) => (input.screened ? b.screenedContacted : b.contacted);
  const outcomesOf = (b: FleetPersonBucket) =>
    input.signal === "positiveReply" ? b.positiveReplies : input.signal === "clicked" ? (input.screened ? b.humanClicked : b.clicked) : 0;
  type Acc = { contacted: number; outcomes: number; months: Record<string, BucketFigures>; strata: Record<string, BucketFigures> };
  const by = new Map<string, Map<string, { flash: Acc; mature: Acc }>>(); // slug -> group ("" = not on record)
  const accOf = () => ({ contacted: 0, outcomes: 0, months: {}, strata: {} }) as Acc;
  const add = (a: Acc, b: FleetPersonBucket) => {
    const c = contactedOf(b);
    const o = outcomesOf(b);
    a.contacted += c;
    a.outcomes += o;
    if (!b.servedDay) return;
    const m = b.servedDay.slice(0, 7);
    for (const [rec, k] of [
      [a.months, m],
      [a.strata, `${b.orgId}|${m}`],
    ] as const) {
      const t = (rec[k] ??= ZERO());
      t.contacted += c;
      t.outcomes += o;
    }
  };
  for (const b of persons) {
    const g = groupOf(b) ?? "";
    const slugMap = by.get(b.workflowSlug) ?? new Map();
    by.set(b.workflowSlug, slugMap);
    const e = slugMap.get(g) ?? { flash: accOf(), mature: accOf() };
    slugMap.set(g, e);
    add(e.flash, b);
    if (input.cutoffDay === null || (b.servedDay !== "" && b.servedDay < input.cutoffDay) || b.servedDay === "") add(e.mature, b);
  }
  const out: SlugCell[] = [];
  const leftOut = { contacted: 0, outcomes: 0 };
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  for (const cell of cells) {
    const groups = by.get(cell.slug);
    if (!groups) {
      leftOut.contacted += cell.flash.figures.contacted;
      leftOut.outcomes += cell.flash.figures.outcomes;
      continue;
    }
    const totals = (half: "flash" | "mature") => {
      const t = { contacted: 0, outcomes: 0, months: {} as Record<string, number> };
      for (const e of groups.values()) {
        t.contacted += e[half].contacted;
        t.outcomes += e[half].outcomes;
        for (const [m, f] of Object.entries(e[half].months)) t.months[m] = (t.months[m] ?? 0) + f.contacted;
      }
      return t;
    };
    const tf = totals("flash");
    const tm = totals("mature");
    const halfOf = (h: SlugHalf, e: Acc, t: ReturnType<typeof totals>): SlugHalf => {
      const ks = share(e.contacted, t.contacted);
      const figures = { spentUsd: h.figures.spentUsd * ks, contacted: h.figures.contacted * ks, outcomes: t.outcomes > 0 ? h.figures.outcomes * share(e.outcomes, t.outcomes) : 0 };
      const months: Record<string, BucketFigures> = {};
      for (const [m, f] of Object.entries(e.months)) months[m] = { spentUsd: (h.months[m]?.spentUsd ?? 0) * share(f.contacted, t.months[m] ?? 0), contacted: f.contacted, outcomes: f.outcomes };
      const strata: Record<string, BucketFigures> = {};
      for (const [k, f] of Object.entries(e.strata)) {
        const m = k.slice(k.indexOf("|") + 1);
        strata[k] = { spentUsd: (h.months[m]?.spentUsd ?? 0) * share(f.contacted, t.months[m] ?? 0), contacted: f.contacted, outcomes: f.outcomes };
      }
      return { figures, months, strata };
    };
    for (const [g, e] of groups) {
      const flash = halfOf(cell.flash, e.flash, tf);
      if (!g) {
        leftOut.contacted += flash.figures.contacted;
        leftOut.outcomes += flash.figures.outcomes;
        continue;
      }
      out.push({ slug: `${cell.slug}\t${g}`, flash, mature: cell.mature ? halfOf(cell.mature, e.mature, tm) : null });
    }
  }
  return { cells: out, leftOut };
}

/** The group a split cell belongs to (`splitCellsByGroup`'s slug is `<version>\t<group>`). */
export const groupOfSplitSlug = (slug: string): string => slug.slice(slug.indexOf("\t") + 1);
