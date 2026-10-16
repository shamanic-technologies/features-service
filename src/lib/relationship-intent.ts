/**
 * HOT-INBOUND-UNANSWERED-1016 (owner 2026-10-16): "EVERY person who writes to us is TAGGED to know whether
 * they are a LEAD or not; and IF a lead, they are TAGGED on whether they WANT to do business with us or not."
 * Hot = a lead who wants to do business with us, WHATEVER the channel (inbound email, WhatsApp, signup,
 * Copilot, API), not only the people our outreach reached.
 *
 * Both tags are lead-service's (`GET /internal/brands/{brandId}/relationships/intent`): every person who
 * wrote to the brand, `lead.state` and `wantsBusiness.state` (yes|no|unsure|null). They are READ, never
 * re-judged here. This module folds them into the brand's lead families (`routes/brand-lead-families.ts`).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { LEAD_FAMILY_RANK, type LeadFamily } from "./offer-pipeline-explained.js";

export type IntentState = "yes" | "no" | "unsure" | null;

export interface BrandIntentPerson {
  humanId: string;
  /** Lower-cased by lead-service; trimmed + lower-cased again here (the families' match key). */
  emails: string[];
  lastInboundAt: string | null;
  leadState: IntentState;
  wantsBusinessState: IntentState;
}

/**
 * A "wants business" yes holds while the person is still talking to us: their LAST word to the brand is at
 * most this many days old. Past it the tag no longer makes them Hot (it does not make them anything else:
 * the outreach pipeline's own verdict on them, if any, stands). 30 days = the usual B2B lead-score decay
 * window (activity older than a month stops counting toward "sales ready"), and the lead-service judge
 * re-asks the question the moment they write again, so a person who comes back is Hot again at once.
 */
export const WANTS_BUSINESS_FRESH_DAYS = 30;

const STATES = new Set(["yes", "no", "unsure"]);

function stateOf(answer: unknown, field: string, humanId: string): IntentState {
  const s = (answer as { state?: unknown } | null)?.state ?? null;
  if (s === null) return null;
  if (typeof s !== "string" || !STATES.has(s)) {
    throw new Error(`lead-service relationships/intent served ${field}.state "${String(s)}" for human ${humanId}`);
  }
  return s as IntentState;
}

/** Every person who wrote to the brand with both tags. Fail loud: a swallowed read would empty Hot. */
export async function fetchBrandIntent(
  brandId: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<BrandIntentPerson[]> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  const response = await fetchWithRetry(
    `${url}/internal/brands/${encodeURIComponent(brandId)}/relationships/intent`,
    { headers: reqHeaders },
    { timeoutMs: 30_000 },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`lead-service relationships/intent failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { people?: unknown };
  if (!Array.isArray(data.people)) throw new Error("lead-service relationships/intent returned no people array");
  return (data.people as Array<Record<string, unknown>>).map((p) => {
    const humanId = p?.humanId;
    if (typeof humanId !== "string" || humanId === "") throw new Error("lead-service relationships/intent returned a person without a humanId");
    if (!Array.isArray(p.emails)) throw new Error(`lead-service relationships/intent returned human ${humanId} without emails`);
    const lastInboundAt = p.lastInboundAt;
    if (lastInboundAt !== null && typeof lastInboundAt !== "string") {
      throw new Error(`lead-service relationships/intent returned human ${humanId} with a malformed lastInboundAt`);
    }
    return {
      humanId,
      emails: [...new Set((p.emails as unknown[]).filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase()).filter(Boolean))],
      lastInboundAt: lastInboundAt as string | null,
      leadState: stateOf(p.lead, "lead", humanId),
      wantsBusinessState: stateOf(p.wantsBusiness, "wantsBusiness", humanId),
    };
  });
}

/** The family row shape both the outreach pipeline and this fold write (`BrandLeadFamilyRow`). */
export interface FoldableFamilyRow {
  leadId: string | null;
  email: string | null;
  family: LeadFamily;
  lostReason: "went_cold" | "ruled_out" | null;
  /** How the row is Hot: the outreach pipeline's verdict, or lead-service's two tags. Null when not hot. */
  hotBasis?: "pipeline" | "wants_business" | null;
  /** lead-service's person, on a row the tags made Hot. */
  humanId?: string | null;
}

export interface IntentFoldSummary {
  /** People who wrote to the brand (lead-service's list). */
  writers: number;
  /** Among them, tagged lead yes AND wants business yes. */
  leadsWantingBusiness: number;
  /** Of those, last word older than `freshDays`: not made Hot. */
  silentTooLong: number;
  /** Of the fresh ones: already won / already Hot on the outreach pipeline (unchanged). */
  alreadyWon: number;
  alreadyHot: number;
  /** Rows the outreach pipeline had as Lost / Cold, now Hot (the tags say they want business now). */
  promotedFromLost: number;
  promotedFromCold: number;
  /** People who were none of our outreach leads (inbound only), now Hot. */
  addedInbound: number;
  /** Of the added ones, people with no email address: in the list, unmatchable by email. */
  addedWithoutEmail: number;
  freshDays: number;
}

/**
 * PURE. Folds lead-service's tags into the outreach pipeline's families. A person tagged lead yes AND
 * wants business yes whose last word is fresh is HOT on every email they hold: a Won row stays Won
 * (won > hot), a Hot row stays Hot, a Lost or Cold row becomes Hot (they write to us wanting business
 * NOW, which outranks "went cold" / "never engaged"), and an address the pipeline never had gets a new
 * Hot row (`leadId: null`, `humanId` set). Nobody is ever demoted: a "no" tag on a pipeline Hot lead
 * leaves the pipeline's verdict (ruling a lead out is lead-service's Disqualified mark, already priced).
 */
export function foldIntentIntoFamilies<R extends FoldableFamilyRow>(
  rows: readonly R[],
  intent: readonly BrandIntentPerson[],
  now: Date,
  makeRow: (p: BrandIntentPerson, email: string | null) => R,
  freshDays = WANTS_BUSINESS_FRESH_DAYS,
): { rows: R[]; summary: IntentFoldSummary } {
  const out: R[] = rows.map((r) => ({ ...r, hotBasis: r.family === "hot" ? "pipeline" : (r.hotBasis ?? null) }));
  const byEmail = new Map<string, R[]>();
  for (const r of out) {
    if (!r.email) continue;
    const list = byEmail.get(r.email) ?? [];
    list.push(r);
    byEmail.set(r.email, list);
  }
  const summary: IntentFoldSummary = {
    writers: intent.length,
    leadsWantingBusiness: 0,
    silentTooLong: 0,
    alreadyWon: 0,
    alreadyHot: 0,
    promotedFromLost: 0,
    promotedFromCold: 0,
    addedInbound: 0,
    addedWithoutEmail: 0,
    freshDays,
  };
  const cutoff = now.getTime() - freshDays * 86_400_000;
  for (const raw of intent) {
    if (raw.leadState !== "yes" || raw.wantsBusinessState !== "yes") continue;
    const p = { ...raw, emails: [...new Set(raw.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))] };
    summary.leadsWantingBusiness += 1;
    const last = p.lastInboundAt ? Date.parse(p.lastInboundAt) : NaN;
    if (!Number.isFinite(last) || last < cutoff) {
      summary.silentTooLong += 1;
      continue;
    }
    const existing = p.emails.flatMap((e) => byEmail.get(e) ?? []);
    const best = existing.reduce<R | null>((b, r) => (!b || LEAD_FAMILY_RANK[r.family] < LEAD_FAMILY_RANK[b.family] ? r : b), null);
    if (best?.family === "won") summary.alreadyWon += 1;
    else if (best?.family === "hot") summary.alreadyHot += 1;
    else if (best?.family === "lost") summary.promotedFromLost += 1;
    else if (best?.family === "cold") summary.promotedFromCold += 1;
    else {
      summary.addedInbound += 1;
      if (p.emails.length === 0) summary.addedWithoutEmail += 1;
    }
    for (const r of existing) {
      if (r.family === "lost" || r.family === "cold") {
        r.family = "hot";
        r.lostReason = null;
        r.hotBasis = "wants_business";
        r.humanId = p.humanId;
      }
    }
    // Every address of theirs the pipeline never had: a Hot row, so the Unibox matches whichever one it holds.
    const missing = p.emails.filter((e) => !byEmail.has(e));
    if (best === null && missing.length === 0) out.push(makeRow(p, null));
    for (const email of missing) {
      const row = makeRow(p, email);
      out.push(row);
      byEmail.set(email, [row]);
    }
  }
  return { rows: out, summary };
}
