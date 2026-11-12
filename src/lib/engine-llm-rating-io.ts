/**
 * THE IO OF THE LLM RATING (LLM-RATING-PER-ENGINE-1112; pure rule `lib/engine-llm-rating.ts`, stores
 * `lib/engine-llm-store.ts`). The EVIDENCE (every LLM call the fleet made, filed per Engine and LLM dynasty, with the
 * Units its decision made) is built OFF the request path and STORED (fleet cell `engine-llm-evidence-v1`): a process
 * starts from the stored build, ONE process rebuilds it every `EVIDENCE_FRESH_MS`, a failed rebuild keeps the last one.
 *
 * The build aggregates our copy of the fleet's LLM calls (`lib/llm-call-feed.ts`: each call filed at copy time under its
 * Engine and LLM dynasty, each decision's ledger Units) in SQL, so it holds per (Engine, LLM, day) rows, never the calls.
 */
import { claimFleetCellBuild, loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { UNPLACED, type LlmDay, type LlmEvidence, type LlmLine, type PickRecord, type UniverseRule } from "./engine-llm-rating.js";
import { listLlmPicks, listUniverseRules } from "./engine-llm-store.js";
import { ingestTemplateDecisions } from "./engine-template-rating-io.js";
import { readLlmDynasties } from "./llm-dynasties.js";
import { readOutOfCreditProvidersSoft } from "./vendor-credit-client.js";

export const EVIDENCE_CELL_KEY = "engine-llm-evidence-v2";
export const EVIDENCE_FRESH_MS = 15 * 60_000;
const CLAIM_MS = 10 * 60_000;
/** Picks are read from this day on (the store starts on the ship day). */
const PICKS_SINCE = "2026-11-01";

export interface EvidenceCounts {
  calls: number;
  /** Calls whose work names no Engine we can place (no script, no workflow assigned on a pipe). */
  callsWithNoEngine: number;
  /** Decisions whose ledger Units are not read yet (counted as no Unit meanwhile). */
  decisionsAwaitingUnits: number;
  supportCalls: number;
  lastCallAt: string | null;
}

export interface EvidenceBuild {
  computedAt: string;
  evidence: LlmEvidence[];
  /** The same evidence per TEMPLATE dynasty (phase 2): each row's `llmDynastySlug` holds the template dynasty slug. */
  templates: LlmEvidence[];
  counts: EvidenceCounts;
}

/** One aggregated row of the copy: per (Engine, LLM, place, decision day). */
export interface DecisionDayRow {
  outcome: string;
  llmDynastySlug: string;
  place: string | null;
  day: string;
  decisions: number;
  successes: number;
  outcomes: number;
}
/** Calls and money per (Engine, LLM, call day). */
export interface CallDayRow {
  outcome: string;
  llmDynastySlug: string;
  place: string | null;
  day: string;
  calls: number;
  spentUsd: number;
}

/**
 * PURE: the copy's aggregates as the Rating's evidence (the same shape `llmEvidence` builds from single calls): calls and
 * money on the day they happened, decisions on their first call's day; a decision a pick placed counts at its place too
 * (its calls and money with it).
 */
export function evidenceFromAggregates(decisionDays: readonly DecisionDayRow[], callDays: readonly CallDayRow[]): LlmEvidence[] {
  const out = new Map<string, { all: Map<string, LlmDay>; places: Map<string, Map<string, LlmDay>>; first: string; last: string; outcome: string; llm: string }>();
  const entry = (outcome: string, llm: string, day: string) => {
    const k = `${outcome}|${llm}`;
    let e = out.get(k);
    if (!e) {
      e = { all: new Map(), places: new Map(), first: day, last: day, outcome, llm };
      out.set(k, e);
    }
    return e;
  };
  const dayOf = (m: Map<string, LlmDay>, day: string) => {
    let d = m.get(day);
    if (!d) {
      d = { day, calls: 0, decisions: 0, successes: 0, outcomes: 0, spentUsd: 0 };
      m.set(day, d);
    }
    return d;
  };
  for (const r of decisionDays) {
    const e = entry(r.outcome, r.llmDynastySlug, r.day);
    const place = r.place ?? UNPLACED;
    const placeDays = e.places.get(place) ?? new Map<string, LlmDay>();
    e.places.set(place, placeDays);
    for (const m of [e.all, placeDays]) {
      const d = dayOf(m, r.day);
      d.decisions += r.decisions;
      d.successes += r.successes;
      d.outcomes += r.outcomes;
    }
  }
  for (const r of callDays) {
    const e = entry(r.outcome, r.llmDynastySlug, r.day);
    const place = r.place ?? UNPLACED;
    const placeDays = e.places.get(place) ?? new Map<string, LlmDay>();
    e.places.set(place, placeDays);
    for (const m of [e.all, placeDays]) {
      const d = dayOf(m, r.day);
      d.calls += r.calls;
      d.spentUsd += r.spentUsd;
    }
    if (r.day < e.first) e.first = r.day;
    if (r.day > e.last) e.last = r.day;
  }
  const sorted = (m: Map<string, LlmDay>) => [...m.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return [...out.values()].map((e) => ({
    outcome: e.outcome,
    llmDynastySlug: e.llm,
    days: sorted(e.all),
    byPlace: new Map([...e.places].map(([p, m]) => [p, sorted(m)])),
    firstCallDay: e.first,
    lastCallDay: e.last,
  }));
}

// ── The stored build ─────────────────────────────────────────────────────────────────────────────────

interface StoredEvidence {
  outcome: string;
  llmDynastySlug: string;
  days: LlmDay[];
  byPlace: Array<[string, LlmDay[]]>;
  firstCallDay: string;
  lastCallDay: string;
}

export const serializeEvidenceBuild = (b: EvidenceBuild): string =>
  JSON.stringify({
    computedAt: b.computedAt,
    counts: b.counts,
    evidence: b.evidence.map((e): StoredEvidence => ({ ...e, byPlace: [...e.byPlace] })),
    templates: b.templates.map((e): StoredEvidence => ({ ...e, byPlace: [...e.byPlace] })),
  });

export function parseEvidenceBuild(text: string): EvidenceBuild {
  const raw = JSON.parse(text) as { computedAt: string; counts: EvidenceCounts; evidence: StoredEvidence[]; templates?: StoredEvidence[] };
  const parse = (e: StoredEvidence) => ({ ...e, byPlace: new Map(e.byPlace) });
  return { computedAt: raw.computedAt, counts: raw.counts, evidence: raw.evidence.map(parse), templates: (raw.templates ?? []).map(parse) };
}

/**
 * The copy's evidence rows. A call's Engine = its own (script / workflow), else its decision's (a platform call made for a
 * caller's run states no script), else the Engine of the pick its run or its parent run asked for with the same LLM (a
 * service with no script, e.g. brand-service's offer-field drafts). A call a pick placed counts for that pick's Engine and
 * its decision is the asking run, even on a support-marked run (the pick states it is an Engine decision); any other
 * support work is never evidence.
 */
const FILED_CALLS = sql`
  SELECT COALESCE(p.run_id, c.decision_run_id) AS decision_run_id, COALESCE(c.outcome, k.outcome, p.outcome) AS outcome,
         c.llm_dynasty_slug, c.started_at, c.spent_usd
  FROM llm_call_copy c
  LEFT JOIN (SELECT decision_run_id, max(outcome) AS outcome FROM llm_call_copy WHERE outcome IS NOT NULL GROUP BY 1) k ON k.decision_run_id = c.decision_run_id
  LEFT JOIN LATERAL (
    SELECT x.run_id, x.outcome FROM engine_llm_picks x
    WHERE x.llm_dynasty_slug = c.llm_dynasty_slug AND x.run_id IN (c.parent_run_id, c.decision_run_id)
      AND (COALESCE(c.outcome, k.outcome) IS NULL OR x.outcome = COALESCE(c.outcome, k.outcome))
    ORDER BY x.picked_at DESC LIMIT 1
  ) p ON true
  WHERE c.llm_dynasty_slug IS NOT NULL
    AND (c.support_function IS NULL OR p.run_id IS NOT NULL)
    AND COALESCE(c.outcome, k.outcome, p.outcome) IS NOT NULL
`;

export async function computeEvidence(): Promise<EvidenceBuild> {
  // Decisions: one per (decision run, Engine, LLM), on its first call's day, a success when the ledger credits it a Unit
  // of its Engine's outcome; its place = a recorded pick of that run naming that LLM on that Engine.
  const decisionDays = (await db.execute(sql`
    WITH filed AS (${FILED_CALLS}),
    d AS (
      SELECT c.decision_run_id, c.outcome, c.llm_dynasty_slug, min(c.started_at) AS first_at
      FROM filed c
      GROUP BY 1, 2, 3
    ), u AS (
      SELECT d.*, COALESCE((x.units ->> d.outcome)::numeric, 0) AS units,
             (SELECT p.place FROM engine_llm_picks p WHERE p.run_id = d.decision_run_id AND p.outcome = d.outcome AND p.llm_dynasty_slug = d.llm_dynasty_slug ORDER BY p.picked_at DESC LIMIT 1) AS place
      FROM d LEFT JOIN llm_decision_units x ON x.decision_run_id = d.decision_run_id
    )
    SELECT outcome, llm_dynasty_slug, place, to_char(first_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           count(*)::int AS decisions, count(*) FILTER (WHERE units > 0)::int AS successes, COALESCE(sum(units), 0)::float AS outcomes
    FROM u GROUP BY 1, 2, 3, 4
  `)) as unknown as Array<{ outcome: string; llm_dynasty_slug: string; place: string | null; day: string; decisions: number; successes: number; outcomes: number }>;
  const callDays = (await db.execute(sql`
    WITH filed AS (${FILED_CALLS})
    SELECT f.outcome, f.llm_dynasty_slug,
           (SELECT p.place FROM engine_llm_picks p WHERE p.run_id = f.decision_run_id AND p.outcome = f.outcome AND p.llm_dynasty_slug = f.llm_dynasty_slug ORDER BY p.picked_at DESC LIMIT 1) AS place,
           to_char(f.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS calls, sum(f.spent_usd)::float AS spent_usd
    FROM filed f
    GROUP BY 1, 2, 3, 4
  `)) as unknown as Array<{ outcome: string; llm_dynasty_slug: string; place: string | null; day: string; calls: number; spent_usd: number }>;
  const [counts] = (await db.execute(sql`
    SELECT count(*)::int AS calls,
           count(*) FILTER (WHERE outcome IS NULL)::int AS no_engine,
           count(*) FILTER (WHERE support_function IS NOT NULL)::int AS support,
           max(started_at) AS last_at,
           (SELECT count(*)::int FROM llm_decision_units WHERE read_at IS NULL) AS units_pending
    FROM llm_call_copy
  `)) as unknown as Array<{ calls: number; no_engine: number; support: number; last_at: string | Date | null; units_pending: number }>;
  const evidence = evidenceFromAggregates(
    decisionDays.map((r) => ({ outcome: r.outcome, llmDynastySlug: r.llm_dynasty_slug, place: r.place, day: r.day, decisions: Number(r.decisions), successes: Number(r.successes), outcomes: Number(r.outcomes) })),
    callDays.map((r) => ({ outcome: r.outcome, llmDynastySlug: r.llm_dynasty_slug, place: r.place, day: r.day, calls: Number(r.calls), spentUsd: Number(r.spent_usd) })),
  );
  // Templates: which dynasty each decision wrote with (history feeds first, then the picks), its decision's LLM spend
  // and ledger Units, on the decision's first call day; placed by a recorded template pick of the decision's run.
  try {
    const ingested = await ingestTemplateDecisions();
    console.log(`[features-service] template decisions ingested: ${ingested.threads} thread generations, ${ingested.sequences} new sequence decisions`);
  } catch (error) {
    console.error("[features-service] template decisions not ingested this build (the stored ones are read):", (error as Error).message);
  }
  const templateDays = (await db.execute(sql`
    WITH filed AS (${FILED_CALLS}),
    dec AS (
      SELECT decision_run_id, outcome, min(started_at) AS first_at, sum(spent_usd) AS spent, count(*) AS calls FROM filed GROUP BY 1, 2
    ), u AS (
      SELECT d.*, t.template_dynasty_slug, COALESCE((x.units ->> d.outcome)::numeric, 0) AS units,
             (SELECT p.place FROM engine_template_picks p WHERE p.run_id = d.decision_run_id AND p.outcome = d.outcome AND p.template_dynasty_slug = t.template_dynasty_slug ORDER BY p.picked_at DESC LIMIT 1) AS place
      FROM dec d
      JOIN template_decisions t ON t.decision_run_id = d.decision_run_id
      LEFT JOIN llm_decision_units x ON x.decision_run_id = d.decision_run_id
    )
    SELECT outcome, template_dynasty_slug, place, to_char(first_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           count(*)::int AS decisions, count(*) FILTER (WHERE units > 0)::int AS successes, COALESCE(sum(units), 0)::float AS outcomes,
           sum(calls)::int AS calls, sum(spent)::float AS spent_usd
    FROM u GROUP BY 1, 2, 3, 4
  `)) as unknown as Array<{ outcome: string; template_dynasty_slug: string; place: string | null; day: string; decisions: number; successes: number; outcomes: number; calls: number; spent_usd: number }>;
  const templates = evidenceFromAggregates(
    templateDays.map((r) => ({ outcome: r.outcome, llmDynastySlug: r.template_dynasty_slug, place: r.place, day: r.day, decisions: Number(r.decisions), successes: Number(r.successes), outcomes: Number(r.outcomes) })),
    templateDays.map((r) => ({ outcome: r.outcome, llmDynastySlug: r.template_dynasty_slug, place: r.place, day: r.day, calls: Number(r.calls), spentUsd: Number(r.spent_usd) })),
  );
  return {
    computedAt: new Date().toISOString(),
    evidence,
    templates,
    counts: {
      calls: Number(counts?.calls ?? 0),
      callsWithNoEngine: Number(counts?.no_engine ?? 0),
      supportCalls: Number(counts?.support ?? 0),
      decisionsAwaitingUnits: Number(counts?.units_pending ?? 0),
      lastCallAt: counts?.last_at ? new Date(counts.last_at).toISOString() : null,
    },
  };
}

let held: EvidenceBuild | null = null;
let flight: Promise<EvidenceBuild | null> | null = null;

async function rebuild(): Promise<EvidenceBuild | null> {
  if (!(await claimFleetCellBuild(EVIDENCE_CELL_KEY, CLAIM_MS))) return held;
  try {
    const built = await computeEvidence();
    held = built;
    await storeFleetCell(EVIDENCE_CELL_KEY, serializeEvidenceBuild(built), Date.parse(built.computedAt));
    console.log(`[features-service] LLM rating evidence built: ${built.counts.calls} calls, ${built.evidence.length} (Engine, LLM) rows, ${built.counts.callsWithNoEngine} with no Engine, ${built.counts.decisionsAwaitingUnits} decisions awaiting their Units`);
    return built;
  } catch (error) {
    console.error("[features-service] LLM rating evidence rebuild failed, the last build stays served:", (error as Error).message);
    return held;
  }
}

/**
 * The evidence: held in memory, else the stored build (whatever its age), refreshed behind when older than
 * `EVIDENCE_FRESH_MS`. Null = nothing built yet anywhere (the pick then rates on the universe alone, said so).
 */
export async function readEngineLlmEvidence(): Promise<EvidenceBuild | null> {
  if (!held) {
    const stored = await loadFleetCell(EVIDENCE_CELL_KEY);
    if (stored) {
      try {
        held = parseEvidenceBuild(stored.text);
      } catch (error) {
        console.error("[features-service] stored LLM rating evidence unreadable, rebuilding:", (error as Error).message);
      }
    }
  }
  const stale = !held || Date.now() - Date.parse(held.computedAt) > EVIDENCE_FRESH_MS;
  if (stale && !flight) {
    flight = rebuild().finally(() => {
      flight = null;
    });
  }
  return held;
}

/** Boot / interval warm: rebuild when stale (one process, claimed). */
export async function warmEngineLlmEvidence(): Promise<"built" | "skipped"> {
  const before = held?.computedAt;
  await readEngineLlmEvidence();
  if (flight) await flight;
  return held?.computedAt !== before ? "built" : "skipped";
}

/** Everything a pick or the staff read needs, read now (universe, dynasties and credit are live; evidence stored). */
export async function readRatingInputs(label: string): Promise<{
  rules: UniverseRule[];
  lines: LlmLine[];
  picks: PickRecord[];
  outOfCreditProviders: Set<string>;
  build: EvidenceBuild | null;
}> {
  const [rules, dynasties, picks, outOfCredit, build] = await Promise.all([
    listUniverseRules(),
    readLlmDynasties(),
    listLlmPicks(PICKS_SINCE),
    readOutOfCreditProvidersSoft(label),
    readEngineLlmEvidence(),
  ]);
  return {
    rules,
    lines: dynasties.map((d) => ({ slug: d.slug, name: d.name, provider: d.provider, servedToday: d.servedToday })),
    picks,
    outOfCreditProviders: outOfCredit ?? new Set(),
    build,
  };
}

/** Test seam. */
export function __resetEngineLlmEvidenceForTest(build: EvidenceBuild | null = null): void {
  held = build;
  flight = null;
}

/** Rebuild every `EVIDENCE_FRESH_MS` on a clock (one process wins the claim), never only on a read. */
export function startEngineLlmEvidenceLoop(): void {
  setInterval(() => void warmEngineLlmEvidence().catch((err) => console.error("[features-service] LLM rating evidence tick failed:", err)), EVIDENCE_FRESH_MS).unref();
}
