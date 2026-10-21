/**
 * THE STUDIES OF WHAT WROTE THE EMAILS (LIVE-RESEARCH-1018): which LLM, which template, naming the client, and how the
 * first email is laid out, opens and uses dashes. Pure.
 *
 * Every person is filed under what wrote their sequence (content-generation-service's record, carried by the fleet
 * person cell); each workflow version's spend, people and outcomes (the ranking's per-version evidence) are shared out
 * on its people (`splitCellsByGroup`), so a model's or a template's figures add up to the ranking's. A bar reads MATURE
 * once its pooled mature outcomes reach the leg's bar, else everything to date and Learning (the ranking's rule).
 * Model names and tiers are chat-service's (`/internal/model-ids`: cheap = Flash, strong and frontier = Pro).
 */
import { bucketOf, groupCells, type SlugCell } from "./buckets.js";
import { splitCellsByGroup, groupOfSplitSlug, type SlugCellsInput } from "./slug-cells.js";
import { dimensionStudies, costBars, costTitle, counts, pricedSorted, rateBars, rateTitle, strataOf, pairOf, type PipeTerms, type ResearchBucket } from "./studies.js";
import { compareVerdict, headlineFor } from "./verdict.js";
import { modelKey, n, pctText, templateLabel, usd } from "./format.js";
import { namingOf, namingStudies, NAMING_LABEL } from "./naming.js";
import type { ResearchChart, ResearchStudy } from "./types.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";
import { NO_TEMPLATE_DYNASTIES, type TemplateDynastyIndex } from "./template-dynasties.js";

export interface ModelName {
  label: string;
  tier: "Flash" | "Pro";
}

export interface GenerationsInput {
  terms: PipeTerms;
  legKey: string;
  cells: readonly SlugCell[];
  persons: readonly FleetPersonBucket[];
  split: Pick<SlugCellsInput, "screened" | "signal" | "cutoffDay">;
  /** Concrete model id → its name and tier (chat-service). A model it does not name reads its id. */
  models: ReadonlyMap<string, ModelName>;
  /** Template id → its prompt text (content-generation-service), for the naming study. */
  templateTexts: ReadonlyMap<string, string>;
  /** Ask the naming question (the positive reply pipe only: a website visit needs the name and the link). */
  naming: boolean;
  /** The pipe's template dynasties (content-generation-service): a template bar is a dynasty, its versions pooled. */
  templateDynasties?: TemplateDynastyIndex;
}

const LAYOUT: Record<string, string> = { one_block: "One block", single_line_breaks: "Single line breaks", double_line_breaks: "Double line breaks" };
const OPENING: Record<string, string> = { greeting: "Greeting + first name", first_name_alone: "First name alone", no_greeting: "No greeting" };
const DASH: Record<string, string> = { em: "Em dash", en: "En dash", both: "Both dashes", none: "No dash" };

function bucketsBy(
  input: GenerationsInput,
  groupOf: (b: FleetPersonBucket) => string | null,
  label: (g: string) => string,
  basisOf?: (g: string) => "mature" | "flash" | undefined,
) {
  const { cells, leftOut } = splitCellsByGroup(input.cells, input.persons, input.split, groupOf);
  const { groups } = groupCells(cells, groupOfSplitSlug);
  const rows: ResearchBucket[] = [...groups].map(([g, cs]) => bucketOf({ key: g, label: label(g), legKey: input.legKey, cells: cs, forceBasis: basisOf?.(g) }));
  return { rows, leftOut, spendByVersion: spendByVersionOf(cells) };
}

/**
 * Per group, the spend (all to date, the ranking's lifetime basis) its people cost under each workflow VERSION: the
 * weights a template's return is read on (`lib/research/catalog.ts`, TPL-DYNASTY-ROWS-1021-FS).
 */
function spendByVersionOf(cells: readonly SlugCell[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const c of cells) {
    const tab = c.slug.indexOf("\t");
    if (tab < 0) continue;
    const version = c.slug.slice(0, tab);
    const g = c.slug.slice(tab + 1);
    const m = out.get(g) ?? new Map<string, number>();
    out.set(g, m);
    m.set(version, (m.get(version) ?? 0) + c.flash.figures.spentUsd);
  }
  return out;
}

const leftOutLine = (t: PipeTerms, l: { contacted: number }, what: string) =>
  l.contacted >= 1 ? [`${n(Math.round(l.contacted))} ${t.exposureNoun} whose ${what} is not on record are left out.`] : [];

/** The bars of a shape cut: every bucket drawn; one with no outcome yet runs the full length and reads "None yet". */
function shapeBars(t: PipeTerms, rows: readonly ResearchBucket[]) {
  const priced = costBars(t, rows);
  const max = priced.reduce((m, p) => Math.max(m, p.value), 0);
  const none = rows
    .filter((r) => !(r.figures.outcomes > 0 && r.figures.spentUsd > 0) && r.figures.contacted > 0)
    .sort((a, b) => b.figures.contacted - a.figures.contacted)
    .map((r) => ({ label: r.label, value: max, display: "None yet", note: `${counts(t, r.figures)}, ${usd(r.figures.spentUsd)} spent`, thin: true }));
  return [...priced, ...none];
}

function shapeStudy(input: GenerationsInput, dim: "layout" | "opening" | "dash"): ResearchStudy {
  const t = input.terms;
  const names = dim === "layout" ? LAYOUT : dim === "opening" ? OPENING : DASH;
  // An email carrying both dashes is its own bucket only when it is not rare: under 5% of first emails it is counted with
  // the em dash (the snapshot's rule; a bucket of a handful of people states nothing).
  const bothShare = (() => {
    if (dim !== "dash") return 1;
    let all = 0;
    let both = 0;
    for (const b of input.persons) {
      if (!b.generation?.dash) continue;
      const c = input.split.screened ? b.screenedContacted : b.contacted;
      all += c;
      if (b.generation.dash === "both") both += c;
    }
    return all ? both / all : 0;
  })();
  const foldBoth = dim === "dash" && bothShare < 0.05;
  const field = (b: FleetPersonBucket) => {
    if (!b.generation) return null;
    const v = b.generation[dim];
    return foldBoth && v === "both" ? "em" : v;
  };
  const all = bucketsBy(input, field, (g) => names[g] ?? g);
  const tierOf = (b: FleetPersonBucket) => (b.generation ? (input.models.get(b.generation.model)?.tier ?? null) : null);
  const tiers = (["Flash", "Pro"] as const)
    .map((tier) => ({ tier, rows: bucketsBy(input, (b) => (tierOf(b) === tier ? field(b) : null), (g) => names[g] ?? g).rows }))
    .filter((x) => x.rows.some((r) => r.figures.contacted > 0));
  const rows = all.rows;
  const w = pricedSorted(rows)[0];
  const low = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  const charts: ResearchChart[] = [
    { kind: "bars", title: `All tiers: ${low(costTitle(t))}`, lowerIsBetter: true, points: shapeBars(t, rows), note: t.note },
    ...(dim === "dash" ? [{ kind: "bars" as const, title: `All tiers: ${low(rateTitle(t))}`, lowerIsBetter: false, points: rateBars(t, rows), note: t.note }] : []),
    ...tiers.flatMap(({ tier, rows: tr }) => [
      { kind: "bars" as const, title: `${tier} tier: ${low(costTitle(t))}`, lowerIsBetter: true, points: shapeBars(t, tr), note: t.note },
      ...(dim === "dash" ? [{ kind: "bars" as const, title: `${tier} tier: ${low(rateTitle(t))}`, lowerIsBetter: false, points: rateBars(t, tr), note: t.note }] : []),
    ]),
  ];
  const lines: string[] = [];
  if (w) lines.push(`${w.label}: ${counts(t, w.figures)}, ${usd(w.figures.spentUsd)} spent.`);
  for (const { tier, rows: tr } of tiers) {
    const tw = pricedSorted(tr)[0];
    if (tw) lines.push(`${tier} tier: ${tw.label} is cheapest at ${usd(tw.figures.spentUsd / tw.figures.outcomes)} per ${t.noun} (${counts(t, tw.figures)}).`);
  }
  if (dim === "dash") {
    // dashes are a model habit: the share of each model's first emails carrying one
    const byModel = new Map<string, { all: number; dash: number }>();
    for (const b of input.persons) {
      if (!b.generation?.dash) continue;
      const label = input.models.get(b.generation.model)?.label ?? b.generation.model;
      const c = input.split.screened ? b.screenedContacted : b.contacted;
      const x = byModel.get(label) ?? { all: 0, dash: 0 };
      x.all += c;
      if (b.generation.dash !== "none") x.dash += c;
      byModel.set(label, x);
    }
    const pts = [...byModel.entries()]
      .filter(([, x]) => x.all > 0)
      .map(([label, x]) => ({ label, value: Number(((100 * x.dash) / x.all).toFixed(1)), display: `${Math.round((100 * x.dash) / x.all)}%`, note: `${n(x.dash)} with a dash · ${n(x.all)} ${t.exposureNoun}`, thin: false }))
      .sort((a, b) => b.value - a.value);
    if (pts.length) charts.push({ kind: "bars", title: "Share of first emails with a dash, by model (%)", lowerIsBetter: false, points: pts, note: t.note });
    if (pts.length > 1) lines.push(`Dashes are a model habit: ${pts[0]!.label} puts one in ${pts[0]!.display} of its first emails, ${pts[pts.length - 1]!.label} in ${pts[pts.length - 1]!.display}. Read each tier against the models writing its buckets.`);
    lines.push(
      `Buckets on the first email's text: an em dash, an en dash, ${foldBoth ? `neither (the ${(bothShare * 100).toFixed(1)}% carrying both, under 5%, are counted with the em dash)` : "both, neither"}. A plain hyphen is not a dash. Classified on the text by content-generation-service, no LLM involved.`,
    );
    lines.push(`Our templates never banned dashes until Sep 29, 2026, when every template started forbidding both.`);
  } else {
    lines.push(
      dim === "layout"
        ? "Three layouts: one block (no line break at all), single line breaks (a new line with no empty line), double line breaks (an empty line between paragraphs). Classified on the first email's text by content-generation-service, no LLM involved."
        : `A greeting word in any language we write in (Hi, Hallo, Bonjour...) counts as a greeting whatever follows; the lead's first name glued to the first sentence by a comma, a colon or a dash counts as the first name alone. Classified on the first email's text by content-generation-service, no LLM involved.`,
    );
    lines.push("The model chose this on its own until Sep 28, 2026, when the templates started requiring a greeting and blank-line paragraphs.");
  }
  lines.push(`Each person is filed under how their first email looked, with every ${t.noun} they sent since.`);
  lines.push(...leftOutLine(t, all.leftOut, "first email"));
  lines.push("The buckets ran for different clients, audiences and months: this is not a split test.");
  const base = {
    id: `${t.pipe}-${dim}-roi`,
    pipe: t.pipe,
    topic: dim,
    goal: "roi" as const,
    question:
      dim === "layout"
        ? `Does the layout of the first email change what a ${t.noun} costs?`
        : dim === "opening"
          ? `Does the way the first email opens change what a ${t.noun} costs?`
          : `Do dashes in the first email change what a ${t.noun} costs, and how often one comes?`,
    status: w ? ("measured" as const) : ("not_enough_data" as const),
    winner: w ? w.label : null,
    result: w ? { display: usd(w.figures.spentUsd / w.figures.outcomes), unit: `per ${t.noun}`, sample: counts(t, w.figures) } : null,
    charts,
    conclusion: lines,
  };
  const { a, b, m } = pairOf(rows, "roi");
  const arm = (r?: ResearchBucket) => (r ? { label: r.label, outcomes: r.figures.outcomes, exposure: r.figures.contacted, spend: r.figures.spentUsd } : null);
  const v = w ? compareVerdict({ a: arm(a), b: arm(b), goal: "roi", comparisons: m, strata: strataOf(rows), noun: t.noun, nouns: t.nounPlural }) : { kind: "noise" as const, reason: `No ${t.noun} yet in any bucket.` };
  const headline = w ? `${w.label} wins at ${usd(w.figures.spentUsd / w.figures.outcomes)} per ${t.noun}.` : `No ${t.noun} yet in any bucket.`;
  return { ...base, headline: w ? headlineFor(headline, v.kind) : headline, crowned: v.kind === "conclusion", verdict: { kind: v.kind, reason: v.reason } };
}

/**
 * PURE. The model bars (one per model NAME: two ids naming one model are one bar), the template bars of one pipe (one
 * per template DYNASTY, its versions pooled; a version no dynasty lists is its own bar) and, per version, its share of
 * its bar read on the bar's own basis (so a dynasty's versions add up to it exactly).
 */
export function generationBuckets(input: GenerationsInput) {
  const modelLabel = (id: string) => input.models.get(id)?.label ?? id;
  const dyn = input.templateDynasties ?? NO_TEMPLATE_DYNASTIES;
  const llm = bucketsBy(input, (b) => (b.generation ? modelLabel(b.generation.model) : null), (g) => g);
  const tpl = bucketsBy(input, (b) => (b.generation?.promptType ? dyn.keyOf(b.generation.promptType) : null), dyn.labelOf);
  const basisOfBar = new Map(tpl.rows.map((r) => [r.key, r.basis]));
  const versions = bucketsBy(input, (b) => b.generation?.promptType ?? null, templateLabel, (v) => basisOfBar.get(dyn.keyOf(v)));
  return {
    llm: { rows: llm.rows.map((r) => ({ ...r, key: modelKey(r.label) })), leftOut: llm.leftOut },
    tpl,
    tplVersions: versions.rows,
    /** Template bar key (dynasty, else version) / template version → workflow version → spend of its people. */
    tplSpendByVersion: tpl.spendByVersion,
    tplVersionSpendByVersion: versions.spendByVersion,
    modelLabel,
  };
}

/** PURE. Every study of what wrote the emails, for one pipe. */
export function generationStudies(input: GenerationsInput): ResearchStudy[] {
  const t = input.terms;
  const out: ResearchStudy[] = [];
  const { llm, tpl } = generationBuckets(input);
  out.push(
    ...dimensionStudies(t, llm.rows, {
      topic: "llm",
      dimNoun: "LLM",
      keyed: true,
      likeForLikeLines: true,
      extraLines: leftOutLine(t, llm.leftOut, "model"),
    }),
  );
  out.push(...dimensionStudies(t, tpl.rows, { topic: "template", dimNoun: "template", keyed: true, extraLines: leftOutLine(t, tpl.leftOut, "template") }));
  if (input.naming) {
    const both: string[] = [];
    const sideOf = (tplId: string | null | undefined) => {
      if (!tplId) return null;
      const side = namingOf(input.templateTexts.get(tplId));
      if (side === "both") {
        if (!both.includes(tplId)) both.push(tplId);
        return null;
      }
      return side;
    };
    const naming = bucketsBy(input, (b) => sideOf(b.generation?.promptType), (g) => NAMING_LABEL[g as "held" | "named"]);
    const held = naming.rows.find((r) => r.key === "held");
    const named = naming.rows.find((r) => r.key === "named");
    const versions = (side: "held" | "named") => new Set(input.persons.filter((b) => sideOf(b.generation?.promptType) === side).map((b) => b.generation!.promptType)).size;
    const empty = (key: "held" | "named"): ResearchBucket => ({ key, label: NAMING_LABEL[key], basis: "flash", figures: { spentUsd: 0, contacted: 0, outcomes: 0 }, learning: true, months: null, strata: null });
    out.push(
      ...namingStudies(t, {
        held: { ...(held ?? empty("held")), versions: versions("held") },
        named: { ...(named ?? empty("named")), versions: versions("named") },
        silentPeople: Math.round(naming.leftOut.contacted),
        bothTemplates: both.map(templateLabel),
      }),
    );
  }
  out.push(shapeStudy(input, "layout"), shapeStudy(input, "opening"), shapeStudy(input, "dash"));
  return out;
}

export { pctText };
