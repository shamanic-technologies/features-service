/**
 * Generic expected-pipeline-revenue engine.
 *
 * Funnel-agnostic: it knows nothing about sales, press, hiring, etc. The caller
 * resolves a feature's funnel into numeric `ResolvedPath[]` (each path = a signal
 * that, when fired, contributes a precomputed expected-revenue amount) and a flat
 * list of per-row persons. The engine then applies the universal rule:
 *
 *   - Inside an entity      — mutually-exclusive funnel positions (delivery milestones, meeting,
 *     closeWin) contribute via MAX (a lead is at exactly one; 1 org = 1 client = 1 LTR). Paths
 *     flagged `engagementRoute` (e.g. click + reply) are INDEPENDENT, non-mutually-exclusive shots
 *     at the SAME single close, so they are combined as independent probabilities bounded by one
 *     close value (`closeValueUsd`). A person's EV = MAX(best single fired path, combined routes);
 *     an org's EV = max person EV across the org.
 *   - SUM between entities   — total pipeline = sum of org EV over DISTINCT orgs.
 *
 * Dedup keys (see global identity-keying note):
 *   - persons dedup on the ATOMIC member (leadId) — one lead surfacing under several
 *     campaign rows is ONE person; their signals are OR'd across rows, signal dates
 *     keep the earliest (MIN) across rows.
 *   - orgs dedup on organization id; a person with no org is their own singleton org.
 *
 * Only persons with EV > 0 (at least one signal fired) enter the tables and the total
 * — an un-engaged served lead is not pipeline.
 *
 * Dates (optional — populated once per-event timestamps are available from email-gateway):
 *   - each fired signal carries an event date (`signalDates[signal]`);
 *   - an entity's date is the MOST-ADVANCED (max) of its fired-event dates;
 *   - the time-series cumulates org EV ordered by org event date (undated orgs are
 *     still in the headline total but cannot be placed on the timeline — no silent drop,
 *     they are simply absent from the series).
 */

export interface ResolvedPath {
  /** Conversion-type tag surfaced to the UI (e.g. "visit", "reply"). */
  tag: string;
  /** Key into a person's `signals` map that triggers this path. */
  signal: string;
  /** LTR × rate-chain — the expected revenue this path contributes when its signal fired. */
  expectedRevenueUsd: number;
  /**
   * "delivery" = a cumulative funnel milestone (contacted/sent/delivered); only the FURTHEST
   * reached one is shown as the entity's tag, and it is suppressed once an engagement fired.
   * "engagement" (default) = a terminal conversion (visit/reply); shown multi-tag.
   * Delivery paths must be listed in ascending funnel order so the last fired = furthest.
   */
  kind?: "delivery" | "engagement";
  /**
   * Marks an INDEPENDENT engagement route (e.g. click, reply) — a non-mutually-exclusive shot at
   * the same single close. Paths sharing this flag are COMBINED as independent probabilities
   * (bounded by `closeValueUsd`), not MAX'd: a lead that fired several routes earns strictly more
   * than any one alone, capped at one close. Leave unset for mutually-exclusive positions (delivery
   * milestones, meeting, closeWin) which stay MAX.
   */
  engagementRoute?: boolean;
  /** Whether a fired event of this path is itemised in the events ledger. Defaults to true. */
  ledger?: boolean;
  /**
   * Decay window in ms. When this is the FURTHEST reached stage and `now − eventDate >
   * staleAfterMs`, the lead is considered DEAD — it stalled before advancing to the next stage.
   * Applies to ANY kind: pre-engagement delivery milestones (contacted/sent/delivered/open) and
   * post-engagement stages (reply → meeting, meeting → close). Omitted → the stage never decays
   * (terminals: click stays alive, closeWin is realized revenue immune to decay). Decay also
   * no-ops when the furthest stage has no known date (fail-open: never kill a lead whose
   * progress we can't see).
   */
  staleAfterMs?: number;
}

export interface EnginePerson {
  leadId: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  /** Company domain (no protocol, no www), for the dashboard to build a logo.dev URL. Null when unknown. */
  orgDomain: string | null;
  // Firmographic context (lead-service #327/#336) — carried through so the digest/dashboard can show
  // WHO the prospect + their company are. All null when the upstream enrichment never resolved a value;
  // never synthesized. The engine ignores these (they don't affect EV); pure passthrough to leads[].
  /** Person's current-employer job title. Null when unknown. */
  title: string | null;
  /** Person's Apollo seniority band (e.g. "vp", "director", "manager"). Null when unknown. */
  seniority: string | null;
  /** Company industry. Null when unknown. */
  orgIndustry: string | null;
  /** Company estimated headcount (raw number — the consumer bands it). Null when unknown. */
  orgEmployeeCount: number | null;
  /** Company city. Null when unknown. */
  orgCity: string | null;
  /** Company country. Null when unknown. */
  orgCountry: string | null;
  /** Recipient email — used by the route to join per-event timestamps; ignored by the engine. */
  email?: string | null;
  /** Which funnel signals fired for this person (e.g. { clicked: true, positiveReply: false }). */
  signals: Record<string, boolean>;
  /** ISO timestamp of each signal's first occurrence, when known (null otherwise). */
  signalDates?: Record<string, string | null>;
}

export interface TopPerson {
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}

export interface OrganizationRow {
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  /** Company domain (no protocol, no www) for logo.dev. First non-null across the org's leads; null when none known. */
  orgDomain: string | null;
  topPerson: TopPerson;
  tags: string[];
  expectedRevenueUsd: number;
  /** Most-advanced (max) event date for the org. Null when no event date is known. */
  mostAdvancedDate: string | null;
}

export interface LeadRow {
  leadId: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  /** Company domain (no protocol, no www) for logo.dev. Null when unknown for this lead's org. */
  orgDomain: string | null;
  // Firmographic context (lead-service #327/#336) — WHO the prospect + their company are, so the
  // outcome-digest email + dashboard conversions/leads surfaces can reassure the customer without a
  // dashboard open. All null when the upstream enrichment never resolved a value; never synthesized.
  /** Person's current-employer job title. Null when unknown. */
  title: string | null;
  /** Person's Apollo seniority band (e.g. "vp", "director", "manager"). Null when unknown. */
  seniority: string | null;
  /** Company industry. Null when unknown. */
  orgIndustry: string | null;
  /** Company estimated headcount (raw number — the consumer bands it for display). Null when unknown. */
  orgEmployeeCount: number | null;
  /** Company city. Null when unknown. */
  orgCity: string | null;
  /** Company country. Null when unknown. */
  orgCountry: string | null;
  tags: string[];
  expectedRevenueUsd: number;
  /** Most-advanced (max) event date for the lead. Null when no event date is known. */
  date: string | null;
  /**
   * True when the lead has been contacted — email-gateway delivery evidence (`signals.contacted`,
   * OR'd across the lead's campaign rows). This is the SAME signal the Outreach stat card and the
   * pipeline-activity daily graph should count, so all three Overview surfaces agree on "contacted"
   * from one snapshot (features-service#371). Engine never re-derives it; it mirrors the overlay.
   */
  contacted: boolean;
  /**
   * ISO timestamp of FIRST contact (email-gateway `firstContactedAt`, MIN'd across campaign rows);
   * null when contacted but the date is unknown, or not yet contacted. The real per-lead timestamp
   * the daily graph buckets by — no synthesis (features-service#371).
   */
  contactedAt: string | null;
  /**
   * Per-lead OUTCOME signals + their first-occurrence ISO dates, OR'd / MIN'd across the lead's
   * campaign rows (same provenance as `contacted`/`contactedAt`). These drive the Overview graph's
   * Opens / Clicks / goal-outcome ACTUAL series, server-computed from THIS `leads[]` snapshot so
   * they are coherent-by-construction with Outreach + the table (features-service#377). Each flag's
   * date is real (no synthesis): null when the signal fired but the date is unknown, or not fired.
   *   - opened         ← email-gateway `firstOpenedAt`   (a known open timestamp IS the signal)
   *   - clicked        ← email-gateway `firstClickedAt`  (website-visit; the signup-goal's observed outcome)
   *   - repliedPositive← `positiveReply` signal (replied && replyClassification "positive"), dated by
   *     email-gateway `firstRepliedAt`. The SAME positive-reply classification the booked-meetings lens
   *     (P=replyToMeeting) + audience-stats positiveReplies use — distinct from `meetingBooked` (the
   *     reply is the meeting-goal engagement signal, the booked meeting is its downstream outcome).
   *   - meetingBooked  ← instantly manual-qualification `meetingBookedAt` (the meeting-goal outcome)
   *   - purchased      ← instantly manual-qualification `closedAt`        (the purchase-goal outcome)
   *   - signup / formSubmission ← lead-service conversion tracker: the DISTINCT matched-lead email set
   *     (`converted-lead-emails?event=signup|form_submission`) intersected with this lead's email —
   *     REAL producer-side attribution (lead-service runs the match waterfall), the SAME identity join
   *     audience-stats uses. Distinct from `clicked` (the website-visit signup PROXY the funnel EV math
   *     anchors to). NO date: lead-service exposes WHICH lead converted but NOT when — the conversion
   *     timestamp exists internally (dedupe buckets by calendar-day) but no endpoint surfaces it, so
   *     `signupAt`/`formSubmissionAt` stay null (never the outreach date — that would be the wrong
   *     signal). Auto-populates when lead-service exposes the conversion date. features-service#473.
   */
  opened: boolean;
  openedAt: string | null;
  clicked: boolean;
  clickedAt: string | null;
  repliedPositive: boolean;
  repliedPositiveAt: string | null;
  meetingBooked: boolean;
  meetingBookedAt: string | null;
  purchased: boolean;
  purchasedAt: string | null;
  signup: boolean;
  signupAt: string | null;
  formSubmission: boolean;
  formSubmissionAt: string | null;
  /**
   * Lens-only: the lead's conversion probability (0–100) for the requested outcome lens. Present
   * ONLY on a lensed `?lens=` response; ABSENT on the default/grouped responses (keeps them
   * byte-identical). Set by the lens path in `revenue.ts`, never by the engine.
   */
  conversionProbabilityPct?: number;
}

export interface TimeSeriesPoint {
  date: string;
  cumulativePipelineUsd: number;
}

export interface EventRow {
  leadId: string;
  person: string | null;
  org: string | null;
  eventType: string;
  eventDate: string;
  contributionUsd: number;
}

export interface RevenueResult {
  headline: { totalPipelineUsd: number };
  timeSeries: TimeSeriesPoint[];
  organizations: OrganizationRow[];
  leads: LeadRow[];
  events: EventRow[];
}

/** One day's signal-lead count for an actual series. `date` is a UTC calendar day (YYYY-MM-DD). */
export interface SignalDailyPoint {
  date: string;
  count: number;
}
/** @deprecated name kept for back-compat — identical shape. Use {@link SignalDailyPoint}. */
export type ContactedDailyPoint = SignalDailyPoint;

/**
 * Server-computed per-signal actual aggregates for the brand Overview's daily graph + stat cards —
 * derived from the SAME `leads[]` snapshot the table renders, so the stat card, the daily graph and
 * the table all move together from one payload (features-service#371/#372/#377). One of these is
 * emitted per ACTUAL series the graph renders (Outreach=contacted, Opens=opened, Clicks=clicked,
 * goal outcome=meetingBooked/purchased). Convention: metric surfaces compute server-side, the
 * dashboard renders only.
 *
 * Invariant (coherent by construction): `total === sum(daily[].count) + undatedCount ===` the number
 * of leads in this payload that carry the signal. When every such lead has a known date,
 * `undatedCount === 0` and `total === sum(daily[].count)` — the card count equals the graph sum.
 * Because every series is built from the SAME `leads[]`, a downstream signal can never exceed its
 * upstream one beyond what the data allows (opened ⊆ contacted, clicked ⊆ contacted, …) — no
 * "open with nothing contacted".
 */
export interface SignalSeries {
  /** Total leads in scope carrying the signal — the matching stat-card count. */
  total: number;
  /**
   * Per-day buckets, keyed by the UTC calendar day (YYYY-MM-DD) of each lead's signal date,
   * ascending by date, one entry per day that has ≥1 dated lead. The ACTUAL series the 7-day graph
   * renders (the dashboard slices its window from this complete series). Sums to `total -
   * undatedCount`. No `now` dependence — buckets come only from the per-lead timestamps, so the
   * series is wall-clock-independent.
   */
  daily: SignalDailyPoint[];
  /**
   * Leads carrying the signal with a null signal date (cannot be bucketed — no synthesis, the date
   * stays unknown). Counted toward `total` but in no `daily` bucket, so the card and graph stay
   * reconcilable: `total = sum(daily[].count) + undatedCount`.
   */
  undatedCount: number;
}
/** @deprecated name kept for back-compat — identical shape. Use {@link SignalSeries}. */
export type OutreachContactedSeries = SignalSeries;

/**
 * Build a per-signal daily actual series from the payload's final lead rows. PURE function of
 * `leads[]` — the same array the response returns — so the card count, the daily buckets and the
 * table are guaranteed mutually coherent (they cannot disagree about the signal). A matching lead
 * with a known date lands in its UTC-day bucket; a matching lead with a null date is counted in
 * `total` + `undatedCount` only (never synthesized into a date). `has`/`dateOf` select the signal
 * (e.g. `l => l.opened` / `l => l.openedAt`).
 */
export function buildSignalSeries(
  leads: LeadRow[],
  has: (lead: LeadRow) => boolean,
  dateOf: (lead: LeadRow) => string | null,
): SignalSeries {
  let total = 0;
  let undatedCount = 0;
  const byDay = new Map<string, number>();
  for (const lead of leads) {
    if (!has(lead)) continue;
    total += 1;
    const date = dateOf(lead);
    if (date) {
      const day = date.slice(0, 10); // YYYY-MM-DD (UTC) from the ISO timestamp
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    } else {
      undatedCount += 1;
    }
  }
  const daily = [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { total, daily, undatedCount };
}

/**
 * The Outreach contacted aggregates — `buildSignalSeries` specialised to the `contacted` signal.
 * Kept as a named helper for the existing call sites (features-service#371/#372).
 */
export function buildContactedSeries(leads: LeadRow[]): SignalSeries {
  return buildSignalSeries(leads, (l) => l.contacted, (l) => l.contactedAt);
}

interface FiredEvent {
  tag: string;
  eventDate: string | null;
  contributionUsd: number;
  ledger: boolean;
}

interface PersonEv {
  person: EnginePerson;
  /** Live EV — 0 when the lead has decayed (stalled past its stage window). Drives the total. */
  ev: number;
  /** Pre-decay EV — the EV the lead would have if alive. > 0 means it entered the pipeline. */
  evRaw: number;
  /** True when the lead stalled at a delivery stage past its decay window with no engagement. */
  dead: boolean;
  /** ISO timestamp the lead decayed (furthest-stage date + staleAfterMs); null when alive. */
  deathDate: string | null;
  tags: string[];
  /** Most-advanced (max) date among fired events; null if none dated. */
  date: string | null;
  firedEvents: FiredEvent[];
}

/** Latest (max) of two ISO timestamps; nulls ignored. ISO-8601 sorts lexicographically. */
function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Earliest (min) of two ISO timestamps; nulls ignored. */
function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/**
 * Compare two ISO timestamps most-recent-first (descending). ISO-8601 sorts
 * lexicographically. A null date (no known conversion date) sorts LAST.
 */
function cmpDateDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

function personName(p: EnginePerson): string | null {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

/** Merge per-campaign rows of the same lead into one person; OR signals, MIN signal dates. */
export function dedupPersonsByLead(rows: EnginePerson[]): EnginePerson[] {
  const byLead = new Map<string, EnginePerson>();
  for (const row of rows) {
    const existing = byLead.get(row.leadId);
    if (!existing) {
      byLead.set(row.leadId, { ...row, signals: { ...row.signals }, signalDates: { ...(row.signalDates ?? {}) } });
      continue;
    }
    for (const [key, value] of Object.entries(row.signals)) {
      existing.signals[key] = Boolean(existing.signals[key]) || value;
    }
    if (row.signalDates) {
      existing.signalDates = existing.signalDates ?? {};
      for (const [key, value] of Object.entries(row.signalDates)) {
        existing.signalDates[key] = minDate(existing.signalDates[key] ?? null, value ?? null);
      }
    }
    if (!existing.orgId && row.orgId) {
      existing.orgId = row.orgId;
      existing.orgName = row.orgName;
      existing.orgLogoUrl = row.orgLogoUrl;
      // Org firmographics travel with the org identity — backfill from the same row that supplies it.
      existing.orgIndustry = row.orgIndustry;
      existing.orgEmployeeCount = row.orgEmployeeCount;
      existing.orgCity = row.orgCity;
      existing.orgCountry = row.orgCountry;
    }
    if (!existing.orgDomain && row.orgDomain) existing.orgDomain = row.orgDomain;
    // Person firmographics: first non-null across the lead's campaign rows (never overwrite a known value).
    if (existing.title == null && row.title != null) existing.title = row.title;
    if (existing.seniority == null && row.seniority != null) existing.seniority = row.seniority;
  }
  return [...byLead.values()];
}

/**
 * Combine INDEPENDENT engagement-route EVs into one expected value, bounded by a single close.
 *
 * Each route's EV = closeValueUsd × P(close | that route fired). Treating the routes as independent
 * shots at the SAME single close, P(close | any fired) = 1 − Π(1 − Pᵢ), so the combined EV is
 * closeValueUsd × (1 − Π(1 − evᵢ/closeValueUsd)). For two routes this equals a + b − a·b/closeValueUsd:
 * strictly greater than either alone, strictly less than their plain sum, and never above one close
 * (1 lead = 1 LTR). Degrades to a plain sum when each evᵢ ≪ closeValueUsd. Empty list → 0. A
 * non-positive close value (LTR 0 ⇒ every route EV is 0 too) → the bare max, which is 0.
 */
function combineIndependent(evs: number[], closeValueUsd: number): number {
  if (evs.length === 0) return 0;
  if (evs.length === 1) return evs[0]; // single route → exact value, no float drift from the OR formula
  if (closeValueUsd <= 0) return Math.max(...evs);
  let surviveProduct = 1;
  for (const ev of evs) surviveProduct *= 1 - ev / closeValueUsd;
  return closeValueUsd * (1 - surviveProduct);
}

/**
 * Per-person EV — mutually-exclusive positions (delivery milestones, meeting, closeWin) contribute
 * via MAX; paths flagged `engagementRoute` (click + reply) are combined as independent probabilities
 * bounded by `closeValueUsd`. evRaw = MAX(best single fired path, combined routes). date = max
 * fired-event date; firedEvents = every fired path (for the ledger). Tags collapse delivery stages
 * to the FURTHEST reached one and suppress it once an engagement fired — so a row shows its single
 * funnel position, or its terminal conversions (visit/reply), not every milestone it passed.
 */
function evForPerson(person: EnginePerson, paths: ResolvedPath[], now: number, closeValueUsd: number): PersonEv {
  let maxSingleEv = 0;
  const routeEvs: number[] = [];
  const firedEvents: FiredEvent[] = [];
  let date: string | null = null;
  const engagementTags: string[] = [];
  let furthestDeliveryTag: string | null = null;
  // Furthest reached stage = the LAST fired path (paths are in ascending funnel order), across
  // ALL kinds. Its window + date drive decay: a lead's status is its most-advanced stage, and a
  // stage that should have advanced (reply→meeting, meeting→close, delivered→open) but didn't
  // within its window is dead. Stages with no window (click, closeWin) are terminal-alive.
  let furthestStaleAfterMs: number | null = null;
  let furthestDate: string | null = null;
  for (const path of paths) {
    if (!person.signals[path.signal]) continue;
    if (path.expectedRevenueUsd > maxSingleEv) maxSingleEv = path.expectedRevenueUsd;
    if (path.engagementRoute) routeEvs.push(path.expectedRevenueUsd);
    const eventDate = person.signalDates?.[path.signal] ?? null;
    firedEvents.push({ tag: path.tag, eventDate, contributionUsd: path.expectedRevenueUsd, ledger: path.ledger !== false });
    date = maxDate(date, eventDate);
    // Last fired in iteration order = furthest reached stage (drives decay, any kind).
    furthestStaleAfterMs = path.staleAfterMs ?? null;
    furthestDate = eventDate;
    if (path.kind === "delivery") {
      furthestDeliveryTag = path.tag; // last delivery = furthest delivery (tag display when no engagement)
    } else if (!engagementTags.includes(path.tag)) {
      engagementTags.push(path.tag);
    }
  }

  // EV = MAX(best single fired path, combined engagement routes). Mutually-exclusive positions
  // (delivery milestones, meeting, closeWin) only ever raise maxSingleEv; the independent routes
  // (click + reply) combine as independent probabilities of the SAME single close, bounded by one
  // close value — firing BOTH earns strictly more than either alone yet never exceeds one close.
  // closeWin's full-LTR single path still dominates via the MAX (realized revenue).
  const evRaw = Math.max(maxSingleEv, combineIndependent(routeEvs, closeValueUsd));

  // Decay: the lead's FURTHEST reached stage carries a window it failed to advance past → DEAD.
  // Pre-engagement (contacted/sent/delivered/open) AND post-engagement (reply/meeting) decay the
  // same way; terminal stages (click/closeWin) have no window → never decay (closeWin = realized,
  // immune even when old). Fail-open: no known date for the furthest stage → can't time it → alive.
  let dead = false;
  let deathDate: string | null = null;
  if (furthestStaleAfterMs !== null && furthestDate !== null) {
    const deathMs = Date.parse(furthestDate) + furthestStaleAfterMs;
    if (now > deathMs) {
      dead = true;
      deathDate = new Date(deathMs).toISOString();
    }
  }

  const baseTags = engagementTags.length > 0 ? engagementTags : furthestDeliveryTag ? [furthestDeliveryTag] : [];
  const tags = dead ? [...baseTags, "stale"] : baseTags;
  return { person, ev: dead ? 0 : evRaw, evRaw, dead, deathDate, tags, date, firedEvents };
}

export function computeRevenue(paths: ResolvedPath[], rawPersons: EnginePerson[], now: number = Date.now(), closeValueUsd = 0): RevenueResult {
  const persons = dedupPersonsByLead(rawPersons);

  // Funnel stage ordinal: index in `paths` (ascending funnel order) → higher = more advanced.
  // An entity's status = the FURTHEST stage it reached = max rank over its tags.
  const stageRank = new Map(paths.map((p, i) => [p.tag, i] as const));
  const rankOfTags = (tags: string[]): number =>
    tags.reduce((max, t) => Math.max(max, stageRank.get(t) ?? -1), -1);

  // Score every person; keep those that entered the pipeline (raw EV > 0) — including the
  // ones that have since decayed (they still show in the leads table, tagged `stale`).
  const scored = persons
    .map((person) => evForPerson(person, paths, now, closeValueUsd))
    .filter((p) => p.evRaw > 0);

  // Leads table — one row per engaged person. Live EV (0 for decayed leads), `stale` tag carried.
  const leads: LeadRow[] = scored.map(({ person, ev, tags, date }) => ({
    leadId: person.leadId,
    firstName: person.firstName,
    lastName: person.lastName,
    photoUrl: person.photoUrl,
    orgName: person.orgName,
    orgLogoUrl: person.orgLogoUrl,
    orgDomain: person.orgDomain,
    title: person.title,
    seniority: person.seniority,
    orgIndustry: person.orgIndustry,
    orgEmployeeCount: person.orgEmployeeCount,
    orgCity: person.orgCity,
    orgCountry: person.orgCountry,
    tags,
    expectedRevenueUsd: ev,
    date,
    contacted: Boolean(person.signals.contacted),
    contactedAt: person.signalDates?.contacted ?? null,
    opened: Boolean(person.signals.open),
    openedAt: person.signalDates?.open ?? null,
    clicked: Boolean(person.signals.clicked),
    clickedAt: person.signalDates?.clicked ?? null,
    repliedPositive: Boolean(person.signals.positiveReply),
    repliedPositiveAt: person.signalDates?.positiveReply ?? null,
    meetingBooked: Boolean(person.signals.meeting),
    meetingBookedAt: person.signalDates?.meeting ?? null,
    purchased: Boolean(person.signals.closeWin),
    purchasedAt: person.signalDates?.closeWin ?? null,
    signup: Boolean(person.signals.signup),
    signupAt: person.signalDates?.signup ?? null,
    formSubmission: Boolean(person.signals.formSubmission),
    formSubmissionAt: person.signalDates?.formSubmission ?? null,
  }));
  // Default sort: most-advanced status first, then most-recent conversion date, then EV (deterministic).
  leads.sort((a, b) => {
    const r = rankOfTags(b.tags) - rankOfTags(a.tags);
    if (r !== 0) return r;
    const d = cmpDateDesc(a.date, b.date);
    if (d !== 0) return d;
    return b.expectedRevenueUsd - a.expectedRevenueUsd;
  });

  // Events table — one row per fired, dated event. Decayed leads contribute no events.
  const events: EventRow[] = [];
  for (const entry of scored) {
    if (entry.dead) continue;
    for (const ev of entry.firedEvents) {
      if (!ev.ledger) continue; // delivery-stage events drive EV/dates but aren't itemised
      if (!ev.eventDate) continue; // can't place an undated event on the ledger
      events.push({
        leadId: entry.person.leadId,
        person: personName(entry.person),
        org: entry.person.orgName,
        eventType: ev.tag,
        eventDate: ev.eventDate,
        contributionUsd: ev.contributionUsd,
      });
    }
  }
  // Default sort: most-advanced status first, then most-recent date, then contribution (deterministic).
  events.sort((a, b) => {
    const r = (stageRank.get(b.eventType) ?? -1) - (stageRank.get(a.eventType) ?? -1);
    if (r !== 0) return r;
    const d = cmpDateDesc(a.eventDate, b.eventDate);
    if (d !== 0) return d;
    return b.contributionUsd - a.contributionUsd;
  });

  // Organizations — dedup on org id (no org → singleton keyed by leadId). An org's live EV is
  // the MAX over its ALIVE members; an org all of whose members decayed is dead (excluded from
  // the table + total). topPerson/tags taken from the alive members when any, else the decayed.
  const byOrg = new Map<string, PersonEv[]>();
  for (const entry of scored) {
    const key = entry.person.orgId ?? `lead:${entry.person.leadId}`;
    const bucket = byOrg.get(key);
    if (bucket) bucket.push(entry);
    else byOrg.set(key, [entry]);
  }

  interface OrgAgg { row: OrganizationRow; aliveEv: number; rawEv: number; birthDate: string | null; deathDate: string | null; }
  const orgAggs: OrgAgg[] = [];
  for (const bucket of byOrg.values()) {
    let top = bucket[0];
    const tags: string[] = [];
    let orgDate: string | null = null;
    let orgDomain: string | null = null; // first non-null domain across the org's leads
    let aliveEv = 0;
    let rawEv = 0;
    let orgDeathDate: string | null = null; // latest member death — when the org fully phased out
    for (const entry of bucket) {
      // Pick the most valuable member for identity: prefer alive over dead, then higher EV.
      const better = (entry.ev > top.ev) || (entry.ev === top.ev && !entry.dead && top.dead);
      if (better) top = entry;
      for (const tag of entry.tags) if (!tags.includes(tag)) tags.push(tag);
      orgDate = maxDate(orgDate, entry.date);
      if (!orgDomain && entry.person.orgDomain) orgDomain = entry.person.orgDomain;
      if (entry.ev > aliveEv) aliveEv = entry.ev;      // MAX over alive members
      if (entry.evRaw > rawEv) rawEv = entry.evRaw;     // MAX raw (pre-decay)
      orgDeathDate = maxDate(orgDeathDate, entry.deathDate);
    }
    const orgDead = aliveEv === 0;
    orgAggs.push({
      row: {
        orgId: top.person.orgId,
        orgName: top.person.orgName,
        orgLogoUrl: top.person.orgLogoUrl,
        orgDomain,
        topPerson: { firstName: top.person.firstName, lastName: top.person.lastName, photoUrl: top.person.photoUrl },
        tags,
        expectedRevenueUsd: aliveEv,
        mostAdvancedDate: orgDate,
      },
      aliveEv,
      rawEv,
      birthDate: orgDate,
      deathDate: orgDead ? orgDeathDate : null,
    });
  }
  // Total + table: alive orgs only (decayed orgs phase out of the pipeline).
  let totalPipelineUsd = 0;
  const organizations: OrganizationRow[] = [];
  for (const agg of orgAggs) {
    if (agg.aliveEv <= 0) continue;
    totalPipelineUsd += agg.aliveEv; // SUM between distinct alive orgs
    organizations.push(agg.row);
  }
  // Default sort: most-advanced status first, then most-recent conversion date, then EV (deterministic).
  organizations.sort((a, b) => {
    const r = rankOfTags(b.tags) - rankOfTags(a.tags);
    if (r !== 0) return r;
    const d = cmpDateDesc(a.mostAdvancedDate, b.mostAdvancedDate);
    if (d !== 0) return d;
    return b.expectedRevenueUsd - a.expectedRevenueUsd;
  });

  // Time series — each org steps the cumulative pipeline UP at its event date, and a decayed
  // org steps it back DOWN at its death date. So the curve rises as leads engage and falls as
  // stalled ones phase out; its final value equals the alive headline total. Undated orgs are
  // absent from the timeline (still counted in the headline — no silent inflation).
  const deltas: { date: string; delta: number }[] = [];
  for (const agg of orgAggs) {
    if (agg.aliveEv > 0) {
      if (agg.birthDate) deltas.push({ date: agg.birthDate, delta: agg.aliveEv });
    } else if (agg.birthDate && agg.deathDate) {
      deltas.push({ date: agg.birthDate, delta: agg.rawEv });
      deltas.push({ date: agg.deathDate, delta: -agg.rawEv });
    }
  }
  deltas.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const timeSeries: TimeSeriesPoint[] = [];
  let cumulative = 0;
  for (const d of deltas) {
    cumulative += d.delta;
    const last = timeSeries[timeSeries.length - 1];
    if (last && last.date === d.date) last.cumulativePipelineUsd = cumulative; // collapse same-instant steps
    else timeSeries.push({ date: d.date, cumulativePipelineUsd: cumulative });
  }

  return { headline: { totalPipelineUsd }, timeSeries, organizations, leads, events };
}
