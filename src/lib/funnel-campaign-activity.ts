/**
 * WHAT ONE SALES FUNNEL CAMPAIGN DID AND PRODUCED, STEP BY STEP AND PIPE BY PIPE, SINCE INCEPTION (owner 2026-10-11,
 * the campaign page: "what was done, what was produced, the ROI, $ invested, # outcomes, conversion rates"). PURE.
 *
 * THE FUNNEL, in PEOPLE, along the campaign's own path (its catalogue funnel's steps, Start excluded). Who the
 * people are depends only on where the funnel STARTS (one rule for every funnel, `lib/meeting-leg-fleet.ts`
 * `isInternalPipe`):
 *   - it starts at Lead found (proactive): its people are held by the units that FIND or WORK them (its sourcing
 *     unit stores what it finds since 2026-10-12, lead-service LEADS-ONLY-FUNNEL-CAMPAIGN; its outreach unit holds the
 *     people it was handed, and held every found lead before). Every step is lead-service's people count
 *     (`/orgs/leads/bucket-counts`, the Leads page's own set) MERGED over those units by MAX per figure
 *     (`mergeBucketCounts`): the same person sits under each unit that held them, so a sum double counts; the units
 *     hold nested sets (a unit works the people found before it), so the largest is the funnel's. Two outreach rungs
 *     are served after Lead found: Contacted (`counts.contacted`) and Delivered (`people.delivered`: people an email
 *     reached; 0 on a funnel that sends none, e.g. a leads-only funnel: Start -> Lead found -> your team);
 *   - it starts at any other step (reactive: Positive reply -> ...): it holds nobody, its units take people over.
 *     Its people = the people its units were HANDED (lead-service follow-up ledger); the first step counts them, a
 *     step a unit performs as an act (Booking call: the act IS the call placed, lead-service's rule) counts the
 *     people it acted on, every later step counts those people with an attributed outcome at that step.
 * Each step's `rateToNextPct` = next step's people ÷ this step's people, served (the browser divides nothing).
 * A step no producer counts is `people:null` + `unmeasuredReason`, never 0.
 */

/** A step of the funnel campaign's path (Start excluded), in reading order. */
export interface PathStep {
  key: string;
  label: string;
}

export interface FunnelActivityStep {
  key: string;
  label: string;
  /** `step` = a step of the funnel's path; `outreach` = a rung of its outreach between Lead found and the next step. */
  kind: "step" | "outreach";
  people: number | null;
  /** People at the next step ÷ people here × 100 (2 decimals). Null on the last step, or when either side is unmeasured or this side is 0. */
  rateToNextPct: number | null;
  unmeasuredReason: string | null;
}

/** lead-service's bucket for each catalogue step key (`/orgs/leads/bucket-counts` `counts`). */
export const BUCKET_OF_STEP: Readonly<Record<string, string>> = {
  conversation: "positive_reply",
  website_visit: "website_visit",
  booking_call: "booking_call",
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  signup: "signup",
  form_submitted: "form_submission",
  purchase: "sale",
  paid_client: "sale",
};

/** lead-service's attributed-outcome event for each catalogue step key (`/internal/brands/:id/converted-leads`). */
export const OUTCOME_EVENT_OF_STEP: Readonly<Record<string, "meeting_booked" | "meeting_attended" | "signup" | "form_submission" | "sale">> = {
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  signup: "signup",
  form_submitted: "form_submission",
  purchase: "sale",
  paid_client: "sale",
};

/** The step a unit performs AS AN ACT (the act is the outcome): lead-service counts an acted row there as reached. */
export const ACT_IS_OUTCOME_STEPS: ReadonlySet<string> = new Set(["booking_call"]);

const round2 = (n: number) => Math.round(n * 100) / 100;

export function withRates(steps: Array<Omit<FunnelActivityStep, "rateToNextPct">>): FunnelActivityStep[] {
  return steps.map((s, i) => {
    const next = steps[i + 1];
    const rate = next && s.people !== null && next.people !== null && s.people > 0 ? round2((next.people / s.people) * 100) : null;
    return { ...s, rateToNextPct: rate };
  });
}

/** PURE: the people counts of several units of ONE funnel campaign, MAX per figure (never a sum: one person, several units). */
export function mergeBucketCounts(
  buckets: ReadonlyArray<{ total: number; counts: Record<string, number>; people: { sent: number; delivered: number; interested: number } }>,
): { total: number; counts: Record<string, number>; people: { sent: number; delivered: number; interested: number } } {
  const counts: Record<string, number> = {};
  for (const b of buckets) for (const [k, n] of Object.entries(b.counts)) if (typeof n === "number") counts[k] = Math.max(counts[k] ?? 0, n);
  const max = (f: (b: (typeof buckets)[number]) => number) => buckets.reduce((m, b) => Math.max(m, f(b)), 0);
  return {
    total: max((b) => b.total),
    counts,
    people: { sent: max((b) => b.people.sent), delivered: max((b) => b.people.delivered), interested: max((b) => b.people.interested) },
  };
}

/** PURE: a proactive funnel's steps off its units' merged lead-service counts (`mergeBucketCounts`). */
export function proactiveFunnelSteps(
  path: readonly PathStep[],
  bucket: { total: number; counts: Record<string, number>; people: { delivered: number } },
): FunnelActivityStep[] {
  const out: Array<Omit<FunnelActivityStep, "rateToNextPct">> = [];
  for (const s of path) {
    if (s.key === "lead_found") {
      out.push({ key: s.key, label: s.label, kind: "step", people: bucket.total, unmeasuredReason: null });
      out.push({ key: "contacted", label: "Contacted", kind: "outreach", people: bucket.counts.contacted ?? null, unmeasuredReason: bucket.counts.contacted === undefined ? "not_counted_by_lead_service" : null });
      out.push({ key: "delivered", label: "Delivered", kind: "outreach", people: bucket.people.delivered, unmeasuredReason: null });
      continue;
    }
    const b = BUCKET_OF_STEP[s.key];
    const n = b ? bucket.counts[b] : undefined;
    out.push({ key: s.key, label: s.label, kind: "step", people: typeof n === "number" ? n : null, unmeasuredReason: typeof n === "number" ? null : "step_not_counted" });
  }
  return withRates(out);
}

/** PURE: a reactive funnel's steps off the people its units were handed / acted on, and their attributed outcomes. */
export function reactiveFunnelSteps(
  path: readonly PathStep[],
  handed: ReadonlySet<string>,
  actedByStep: ReadonlyMap<string, ReadonlySet<string>>,
  outcomeLeadsByStep: ReadonlyMap<string, ReadonlySet<string> | null>,
): FunnelActivityStep[] {
  const out = path.map((s, i): Omit<FunnelActivityStep, "rateToNextPct"> => {
    if (i === 0) return { key: s.key, label: s.label, kind: "step", people: handed.size, unmeasuredReason: null };
    if (ACT_IS_OUTCOME_STEPS.has(s.key)) {
      const acted = actedByStep.get(s.key);
      return acted
        ? { key: s.key, label: s.label, kind: "step", people: acted.size, unmeasuredReason: null }
        : { key: s.key, label: s.label, kind: "step", people: null, unmeasuredReason: "no_unit_performs_step" };
    }
    if (!(s.key in OUTCOME_EVENT_OF_STEP)) return { key: s.key, label: s.label, kind: "step", people: null, unmeasuredReason: "step_not_counted" };
    const leads = outcomeLeadsByStep.get(s.key);
    if (!leads) return { key: s.key, label: s.label, kind: "step", people: null, unmeasuredReason: "outcomes_unreadable" };
    let n = 0;
    for (const id of leads) if (handed.has(id)) n++;
    return { key: s.key, label: s.label, kind: "step", people: n, unmeasuredReason: null };
  });
  return withRates(out);
}

/** One UTC day of a pipe's work. */
export interface PipeDay {
  date: string;
  /** People handed to the pipe that day (first handed). */
  handed: number;
  /** People the pipe acted on that day (first answer sent / call placed). */
  actedOn: number;
  /** People reaching the pipe's own `to` step that day. */
  reached: number;
}

export interface PipeWork {
  handed: number;
  actedOn: number;
  /** People reaching the pipe's own `to` step (null = no producer counts that step). */
  reached: number | null;
  /** reached ÷ handed × 100. */
  conversionRatePct: number | null;
  daily: PipeDay[];
  /** People counted in the totals with no date for that figure (in no day). */
  undated: { handed: number; actedOn: number; reached: number };
}

const dayOf = (iso: string | null): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/**
 * PURE: what one INTERNAL pipe (one that takes people over: AI Meeting Booking, AI Instant Call) did, per UTC day,
 * since inception. `rows` = its follow-up ledger rows (one per person); `reachedAt` = for each person who reached the
 * pipe's `to` step, when (null = undated); null when no producer counts that step. On a step whose act IS the outcome
 * (`booking_call`) reached = acted on, the same day.
 */
export function internalPipeWork(
  toStep: string,
  rows: ReadonlyArray<{ leadId: string; firstClaimedAt: string | null; firstActedAt: string | null; actedCount: number }>,
  reachedAt: ReadonlyMap<string, string | null> | null,
): PipeWork {
  const days = new Map<string, PipeDay>();
  const day = (d: string) => {
    let v = days.get(d);
    if (!v) days.set(d, (v = { date: d, handed: 0, actedOn: 0, reached: 0 }));
    return v;
  };
  const undated = { handed: 0, actedOn: 0, reached: 0 };
  const handed = new Map<string, string | null>();
  const acted = new Map<string, string | null>();
  for (const r of rows) {
    const h = handed.get(r.leadId);
    if (!handed.has(r.leadId) || (r.firstClaimedAt && (!h || r.firstClaimedAt < h))) handed.set(r.leadId, r.firstClaimedAt ?? h ?? null);
    if (r.actedCount > 0) {
      const a = acted.get(r.leadId);
      if (!acted.has(r.leadId) || (r.firstActedAt && (!a || r.firstActedAt < a))) acted.set(r.leadId, r.firstActedAt ?? a ?? null);
    }
  }
  for (const at of handed.values()) {
    const d = dayOf(at);
    if (d) day(d).handed++;
    else undated.handed++;
  }
  for (const at of acted.values()) {
    const d = dayOf(at);
    if (d) day(d).actedOn++;
    else undated.actedOn++;
  }
  let reached: number | null = null;
  const reachedMap = ACT_IS_OUTCOME_STEPS.has(toStep) ? acted : reachedAt ? new Map([...reachedAt].filter(([id]) => handed.has(id))) : null;
  if (reachedMap) {
    reached = reachedMap.size;
    for (const at of reachedMap.values()) {
      const d = dayOf(at);
      if (d) day(d).reached++;
      else undated.reached++;
    }
  }
  return {
    handed: handed.size,
    actedOn: acted.size,
    reached,
    conversionRatePct: reached !== null && handed.size > 0 ? round2((reached / handed.size) * 100) : null,
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    undated,
  };
}

/** Earliest dated outcome per lead (null when every outcome of that lead is undated). */
export function earliestOutcomeByLead(rows: ReadonlyArray<{ leadId: string; occurredAt: string | null }>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const r of rows) {
    const prev = out.get(r.leadId);
    if (!out.has(r.leadId)) out.set(r.leadId, r.occurredAt);
    else if (r.occurredAt && (!prev || r.occurredAt < prev)) out.set(r.leadId, r.occurredAt);
  }
  return out;
}
