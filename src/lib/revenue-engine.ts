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
 * PATHS ARE FUNNEL LEGS; MILESTONES ARE NOT PATHS. The caller passes the legs of the funnels the brand
 * DECLARED it sells through as `paths`, and the pre-funnel delivery milestones (contacted / sent /
 * delivered / opened) separately as `milestones`. A milestone carries no revenue field, so it can
 * never contribute a cent — it only tags a lead's position and keeps it present in `leads[]` for the
 * count series. An outreach that produced no conversion is therefore not pipeline anywhere.
 *
 * Dedup keys (see global identity-keying note):
 *   - persons dedup on the ATOMIC member (leadId) — one lead surfacing under several
 *     campaign rows is ONE person; their signals are OR'd across rows, signal dates
 *     keep the earliest (MIN) across rows.
 *   - orgs dedup on organization id; a person with no org is their own singleton org.
 *
 * Only persons with EV > 0 enter the ORGANIZATIONS table, the time series and the total — an
 * outreach that produced no conversion is not pipeline. A person who reached only a delivery
 * milestone stays in `leads[]` at `expectedRevenueUsd: 0` (the count series are built from that same
 * array), but claims no expected revenue anywhere.
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
  /** LTR × the funnel's rate ladder — the expected revenue this path contributes when its signal fired. */
  expectedRevenueUsd: number;
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
   * Marks the TERMINAL leg — the paying client every funnel ends at, worth the whole close value rather
   * than a fraction of it. When a human stated what this particular deal was worth, that amount IS the
   * contribution, read straight instead of scaled through the brand's average: realized revenue is a
   * fact, so it must not depend on the brand having declared a lifetime revenue at all.
   */
  terminal?: boolean;
}

/**
 * A DELIVERY MILESTONE — a thing that happened on the way to the funnel, and NOT a leg of one.
 *
 * Contacted / sent / delivered / opened are steps of NO funnel in brand-service's catalogue: every
 * funnel a brand can declare starts at a positive reply or a website visit. So a milestone has NO
 * revenue field at all — it cannot be priced, weighted down or zeroed, because there is nothing on it
 * to price. It exists for exactly two jobs:
 *
 *   - it gives a lead its POSITION tag when the lead reached no funnel leg ("delivered"), and
 *   - it keeps that lead PRESENT in `leads[]`, which is the snapshot every Overview count series is
 *     built from (contacted / opened / clicked / replied). Dropping the lead would silently gut those
 *     counts — a brand with 7,181 contacted leads would report a handful.
 *
 * A milestone contributes ZERO to a lead's expected value, to an organisation's, and to the pipeline
 * total. Milestones are listed in ascending funnel order so the LAST fired one is the furthest reached.
 */
export interface FunnelMilestone {
  /** Tag surfaced to the UI as the lead's position when it reached no priced leg. */
  tag: string;
  /** Key into a person's `signals` map. */
  signal: string;
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
  /**
   * The campaign the row was served under. Carried so a person-grain count can be grouped by the
   * campaign IDENTITY before it is deduped — the ONLY way an identity's distinct-lead figure can be
   * counted on the same basis as the brand's. Null when the producer states none. The engine ignores
   * it (it never affects EV); pure passthrough, and `dedupPersonsByLead` keeps the first row's value
   * because a deduped person no longer belongs to a single campaign.
   */
  campaignId?: string | null;
  /**
   * The WORKFLOW the row was served under, frozen on the producer's `leads_campaigns` row at serve
   * time. Carried for the SAME reason as `campaignId` above and with the same rules: it lets a grain
   * partition persons BEFORE they are deduped, the engine never reads it (it can never affect EV),
   * and `dedupPersonsByLead` keeps the first row's value because a deduped person no longer belongs
   * to a single workflow. Null when the producer states none.
   */
  workflowSlug?: string | null;
  /** Which funnel signals fired for this person (e.g. { clicked: true, positiveReply: false }). */
  signals: Record<string, boolean>;
  /** ISO timestamp of each signal's first occurrence, when known (null otherwise). */
  signalDates?: Record<string, string | null>;
  /**
   * WHAT THIS PERSON IS WORTH, when somebody said so — overriding the brand's / offer's average
   * lifetime revenue for this lead alone.
   *
   * Every path's expected revenue is `value × a rate ladder`, so this scales the whole ladder rather
   * than only the terminal rung: a lead stated at $49k is worth more at every rung than a lead priced
   * on a $4k average, and that is the point of stating it. A won deal MUST carry one (the producer
   * refuses a sale with no amount) — realized revenue is the one figure with no excuse to be an
   * average — and any earlier rung MAY carry one, for the unusually large lead worth pricing before
   * it closes.
   *
   * Null / absent = nobody said, so the brand's declared revenue stands. Never 0-by-default: a 0 here
   * would say the deal was worth nothing, which is a statement, not a silence.
   */
  valueUsd?: number | null;
  /**
   * The signals this person can NEVER fire, because a human stated the step will not happen.
   *
   * A "never" is not an outcome and nothing counts it; what it does is tell a lead that is DEAD at a
   * step from one still PENDING, which no count could ever express. A pending lead legitimately keeps
   * the forecast its evidence earns; a dead one has no path left through the funnels that contain that
   * step, so those funnels' legs are worth nothing for it — including the legs it already fired, whose
   * whole value was a forecast of the thing that has now been ruled out.
   *
   * It is the FUNNEL that dies, not just the one step: the caller expands a dead step into every leg
   * of every declared funnel containing it (see `deadLegSignalsFor`), so a brand that also sells a
   * funnel the dead step is not on keeps that funnel's value for this lead. Empty / absent = nothing was
   * ruled out, which is every lead today.
   */
  deadSignals?: readonly string[];
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
   * WHY THIS LEAD CAN NEVER CONVERT, when it cannot — the two ends of the delivery ladder that take a
   * person OUT of the funnel while leaving the outreach we paid for standing. `bounced` says the
   * mailbox refused the email; `unsubscribed` says the person asked us to stop. Both are FACTS about a
   * lead we did contact, so they ride the row beside `contacted` rather than erasing it: a row a
   * customer opens has to say the same thing as the counts above it, and a lead showing "contacted"
   * with nothing else and no reason would read as a lead we simply never worked.
   *
   * Neither is a funnel step and neither carries expected value; what they DO is remove this lead from
   * `outcomes.recipientsConvertible`, the base every pipeline figure on the grain rests on.
   */
  bounced: boolean;
  unsubscribed: boolean;
  /**
   * Per-lead OUTCOME signals + their first-occurrence ISO dates, OR'd / MIN'd across the lead's
   * campaign rows (same provenance as `contacted`/`contactedAt`). These drive the Overview graph's
   * Opens / Clicks / goal-outcome ACTUAL series, server-computed from THIS `leads[]` snapshot so
   * they are coherent-by-construction with Outreach + the table (features-service#377). Each flag's
   * date is real (no synthesis): null when the signal fired but the date is unknown, or not fired.
   *   - opened         ← email-gateway `firstOpenedAt`   (a known open timestamp IS the signal)
   *   - clicked        ← email-gateway `firstClickedAt`  (website-visit; the signup-goal's observed outcome)
   *   - repliedPositive← `positiveReply` signal (replied && replyClassification "positive"). The date is
   *     email-gateway `firstRepliedAt` BUT gated on the positive classification — a negative/neutral-only
   *     replier (firstRepliedAt present, positiveReply signal false) carries a NULL date, matching the
   *     boolean, so consumers dating positive replies off the timestamp never surface a non-positive reply.
   *     The SAME positive-reply classification the booked-meetings lens
   *     (P=replyToMeeting) + audience-stats positiveReplies use — distinct from `meetingBooked` (the
   *     reply is the meeting-goal engagement signal, the booked meeting is its downstream outcome).
   *   - meetingBooked   ← a human stated the meeting was booked (lead-service step statements)
   *   - meetingAttended ← a human stated the meeting was ATTENDED — the rung above booked, and the one
   *     the lead is priced on once it is reached. It is stated by hand ONLY: attendance happens off the
   *     client's website, so no page-load tag can observe it, which is why the show-up rate it measures
   *     could never be checked against reality before.
   *   - purchased      ← a human (or the tracker) stated the deal closed — realized revenue
   *   - signup / formSubmission ← lead-service conversion tracker: the DISTINCT matched-lead email set
   *     (`converted-lead-emails?event=signup|form_submission`) intersected with this lead's email —
   *     REAL producer-side attribution (lead-service runs the match waterfall), the SAME identity join
   *     audience-stats uses. Distinct from `clicked` (the website-visit signup PROXY the funnel EV math
   *     anchors to). NO date: lead-service exposes WHICH lead converted but NOT when — the conversion
   *     timestamp exists internally (dedupe buckets by calendar-day) but no endpoint surfaces it, so
   *     `signupAt`/`formSubmissionAt` stay null (never the outreach date — that would be the wrong
   *     signal). Auto-populates when lead-service exposes the conversion date. features-service#476.
   */
  opened: boolean;
  openedAt: string | null;
  clicked: boolean;
  clickedAt: string | null;
  repliedPositive: boolean;
  repliedPositiveAt: string | null;
  meetingBooked: boolean;
  meetingBookedAt: string | null;
  meetingAttended: boolean;
  meetingAttendedAt: string | null;
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
  /** The lead's expected value. An outcome that happened stays counted — it never expires. */
  ev: number;
  tags: string[];
  /** Most-advanced (max) date among fired events; null if none dated. */
  date: string | null;
  firedEvents: FiredEvent[];
  /** True when the lead reached a delivery milestone (which is worth nothing, but is not nothing). */
  reachedMilestone: boolean;
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
 * Per-person EV — mutually-exclusive positions (meeting, closeWin) contribute via MAX; paths flagged
 * `engagementRoute` (click + reply) are combined as independent probabilities bounded by
 * `closeValueUsd`. ev = MAX(best single fired path, combined routes). date = max fired-event date;
 * firedEvents = every fired PATH (for the ledger). Tags show the lead's terminal conversions, falling
 * back to the FURTHEST delivery milestone reached when the lead reached no funnel leg at all.
 *
 * Milestones contribute no EV and no ledger row — they are not paths. They only supply the fallback
 * tag, a date, and the fact that this lead exists at all.
 */
function evForPerson(
  person: EnginePerson,
  paths: ResolvedPath[],
  milestones: readonly FunnelMilestone[],
  closeValueUsd: number,
): PersonEv {
  let maxPositionEv = 0;
  const routeEvs: number[] = [];
  const firedEvents: FiredEvent[] = [];
  let date: string | null = null;
  const legTags: string[] = [];
  let furthestMilestoneTag: string | null = null;
  let reachedPosition = false;

  // WHAT THIS PERSON IS WORTH. Every path EV is `value × a rate ladder`, so a stated per-lead value
  // scales the whole ladder rather than only its terminal rung — a lead somebody priced at $49k is
  // worth more at every rung than one priced on a $4k average. Nobody said ⇒ the brand's own number,
  // unscaled, which is every lead today.
  const statedValueUsd =
    typeof person.valueUsd === "number" && Number.isFinite(person.valueUsd) && person.valueUsd >= 0
      ? person.valueUsd
      : null;
  const scale = statedValueUsd !== null && closeValueUsd > 0 ? statedValueUsd / closeValueUsd : 1;
  const scaledCloseValueUsd = closeValueUsd * scale;

  // Steps a human ruled out for this person. Expanded by the caller into every leg of every funnel
  // containing the dead step, so a funnel that never touches it keeps its value.
  const dead = person.deadSignals && person.deadSignals.length > 0 ? new Set(person.deadSignals) : null;

  // Milestones first — listed in ascending funnel order, so the last fired is the furthest reached.
  for (const milestone of milestones) {
    if (!person.signals[milestone.signal]) continue;
    furthestMilestoneTag = milestone.tag;
    date = maxDate(date, person.signalDates?.[milestone.signal] ?? null);
  }

  for (const path of paths) {
    if (!person.signals[path.signal]) continue;
    // A leg of a funnel a human ruled this person out of carries nothing — not even the legs already
    // fired, whose whole value was a forecast of the thing that has now been ruled out. It is not in
    // the ledger either: there is no expected revenue to itemise.
    if (dead?.has(path.signal)) continue;
    // A TERMINAL leg carrying a stated amount IS that amount — realized revenue is a fact, so it must
    // not be routed through the brand's average (nor vanish for a brand that declared no revenue).
    const contributionUsd =
      path.terminal && statedValueUsd !== null ? statedValueUsd : path.expectedRevenueUsd * scale;
    if (path.engagementRoute) {
      routeEvs.push(contributionUsd);
    } else {
      reachedPosition = true;
      if (contributionUsd > maxPositionEv) maxPositionEv = contributionUsd;
    }
    const eventDate = person.signalDates?.[path.signal] ?? null;
    firedEvents.push({ tag: path.tag, eventDate, contributionUsd, ledger: path.ledger !== false });
    date = maxDate(date, eventDate);
    if (!legTags.includes(path.tag)) legTags.push(path.tag);
  }

  // WHAT A HUMAN OBSERVED BEATS WHAT WE FORECAST.
  //
  // The engagement routes (click, reply) are two independent shots at the SAME single close, so on
  // their own they combine as independent probabilities bounded by one close value — firing both earns
  // strictly more than either alone and never more than one close.
  //
  // But an OBSERVED POSITION (a meeting booked, a meeting attended, a deal won) is not another shot at
  // that close: it IS that close, further along. The routes were forecasting exactly the thing that has
  // now happened, so once a position fired they are EXTINGUISHED rather than combined — keeping them
  // would add the forecast of an event to the event itself. A `max` alone would not do it: a brand
  // whose self-serve rate beats its booked→paid rate can have the click route out-value the meeting the
  // lead is actually sitting in.
  const ev = reachedPosition ? maxPositionEv : combineIndependent(routeEvs, scaledCloseValueUsd);

  const tags = legTags.length > 0 ? legTags : furthestMilestoneTag ? [furthestMilestoneTag] : [];
  return { person, ev, tags, date, firedEvents, reachedMilestone: furthestMilestoneTag !== null };
}

export function computeRevenue(
  paths: ResolvedPath[],
  rawPersons: EnginePerson[],
  closeValueUsd = 0,
  milestones: readonly FunnelMilestone[] = [],
): RevenueResult {
  const persons = dedupPersonsByLead(rawPersons);

  // Funnel stage ordinal: milestones first (they precede every leg), then the legs in ascending funnel
  // order → higher = more advanced. An entity's status = the FURTHEST stage it reached = max rank.
  const stageRank = new Map(
    [...milestones.map((m) => m.tag), ...paths.map((p) => p.tag)].map((tag, i) => [tag, i] as const),
  );
  const rankOfTags = (tags: string[]): number =>
    tags.reduce((max, t) => Math.max(max, stageRank.get(t) ?? -1), -1);

  // Score every person. A lead enters the tables when it reached a funnel leg worth something OR a
  // delivery milestone — the milestone-only lead carries 0 and is filtered out of the organizations,
  // the time series and the total below, but stays in `leads[]` so the count series stay whole.
  const scored = persons
    .map((person) => evForPerson(person, paths, milestones, closeValueUsd))
    .filter((p) => p.ev > 0 || p.reachedMilestone);

  // Leads table — one row per engaged person.
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
    bounced: Boolean(person.signals.bounced),
    unsubscribed: Boolean(person.signals.unsubscribed),
    opened: Boolean(person.signals.open),
    openedAt: person.signalDates?.open ?? null,
    clicked: Boolean(person.signals.clicked),
    clickedAt: person.signalDates?.clicked ?? null,
    repliedPositive: Boolean(person.signals.positiveReply),
    // Gate the timestamp on the positive classification, NOT email-gateway's sentiment-agnostic
    // `firstRepliedAt` — a negative/neutral-only replier must carry a null date (matches the boolean).
    repliedPositiveAt: person.signals.positiveReply ? (person.signalDates?.positiveReply ?? null) : null,
    meetingBooked: Boolean(person.signals.meeting),
    meetingBookedAt: person.signalDates?.meeting ?? null,
    meetingAttended: Boolean(person.signals.meetingAttended),
    meetingAttendedAt: person.signalDates?.meetingAttended ?? null,
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

  // Events table — one row per fired, dated event. Every fired event is itemised; an event that
  // happened is never suppressed by how long ago it happened.
  const events: EventRow[] = [];
  for (const entry of scored) {
    for (const ev of entry.firedEvents) {
      if (!ev.ledger) continue; // a path can opt out of itemisation; milestones never reach here at all
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

  // Organizations — dedup on org id (no org → singleton keyed by leadId). An org's EV is the MAX
  // over its members (1 org = 1 client = 1 LTR).
  const byOrg = new Map<string, PersonEv[]>();
  for (const entry of scored) {
    const key = entry.person.orgId ?? `lead:${entry.person.leadId}`;
    const bucket = byOrg.get(key);
    if (bucket) bucket.push(entry);
    else byOrg.set(key, [entry]);
  }

  interface OrgAgg { row: OrganizationRow; ev: number; birthDate: string | null; }
  const orgAggs: OrgAgg[] = [];
  for (const bucket of byOrg.values()) {
    let top = bucket[0];
    const tags: string[] = [];
    let orgDate: string | null = null;
    let orgDomain: string | null = null; // first non-null domain across the org's leads
    let orgEv = 0;
    for (const entry of bucket) {
      // Pick the most valuable member for identity.
      if (entry.ev > top.ev) top = entry;
      for (const tag of entry.tags) if (!tags.includes(tag)) tags.push(tag);
      orgDate = maxDate(orgDate, entry.date);
      if (!orgDomain && entry.person.orgDomain) orgDomain = entry.person.orgDomain;
      if (entry.ev > orgEv) orgEv = entry.ev; // MAX over the org's members
    }
    orgAggs.push({
      row: {
        orgId: top.person.orgId,
        orgName: top.person.orgName,
        orgLogoUrl: top.person.orgLogoUrl,
        orgDomain,
        topPerson: { firstName: top.person.firstName, lastName: top.person.lastName, photoUrl: top.person.photoUrl },
        tags,
        expectedRevenueUsd: orgEv,
        mostAdvancedDate: orgDate,
      },
      ev: orgEv,
      birthDate: orgDate,
    });
  }
  let totalPipelineUsd = 0;
  const organizations: OrganizationRow[] = [];
  for (const agg of orgAggs) {
    if (agg.ev <= 0) continue;
    totalPipelineUsd += agg.ev; // SUM between distinct orgs
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

  // Time series — each org steps the cumulative pipeline UP at its event date. Every delta is
  // positive, so the curve is MONOTONE NON-DECREASING: an outcome that happened stays counted, and
  // nothing ever steps it back down. Its final value equals the headline total. Undated orgs are
  // absent from the timeline (still counted in the headline — no silent inflation).
  const deltas: { date: string; delta: number }[] = [];
  for (const agg of orgAggs) {
    if (agg.ev > 0 && agg.birthDate) deltas.push({ date: agg.birthDate, delta: agg.ev });
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
