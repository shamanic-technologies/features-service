/**
 * THE CUSTOMER TEAM'S OWN REACH ON ONE LEG, from the brand's tools (crm-service#102). Conforms to what crm-service
 * DEPLOYS; nothing here is authored by features-service:
 *
 *   GET /internal/people/leg-reach/brands -> { steps, brands: [{ orgId, brandId, scopeStatus, connectedSources, recordedSteps }] }
 *   GET /internal/people/leg-reach?brandId=&orgId=&from=&to= ->
 *     { available: true, reachedFrom: { people, undated, byDay[{day, people}], sources[{source, people}] }, reachedTo: {...} }
 *     { available: false, reason: "no_people_scope" | "not_synced" | "no_connected_source" | "from_step_not_recorded" | "to_step_not_recorded" }
 *
 * Population (crm-service's): the brand's people who reached FROM on any tool it mirrors, minus those our campaigns
 * contacted and those the people layer holds as nobody; TO counted on or after the day they first reached FROM.
 *
 * A step of ours crm-service has no word for (e.g. `booking_call`, `purchase`) is a named reason
 * (`step_not_in_crm_vocabulary`), never a call that 400s. FAIL-LOUD on transport / non-OK / malformed answers.
 */
import { fetchWithRetry } from "./fetch-retry.js";

/** One brand's answer for one leg: the people who reached FROM and whom our campaigns never contacted, and how many
 *  of those reached TO, per UTC day + undated; or a named reason it cannot answer. */
export type TeamLegReach =
  | {
      available: true;
      from: { daily: ReadonlyMap<string, number>; undated: number };
      to: { daily: ReadonlyMap<string, number>; undated: number };
      fromSources: string[];
      toSources: string[];
      /** The same TO people filed on the UTC day they first reached FROM (cohort, crm-service#107); null when the
       *  deployed producer does not serve it yet. */
      toByFromDay: { daily: ReadonlyMap<string, number>; undated: number } | null;
    }
  | { available: false; reason: string };

export interface TeamLegReachBrand {
  orgId: string;
  brandId: string;
}

/** Our step key -> crm-service's word for it, where its vocabulary spells it differently. */
const CRM_STEP_OF: Readonly<Record<string, string>> = { form_submitted: "form_submission", paid_client: "sale" };

/** PURE: crm-service's word for our step, or null when its vocabulary has none. */
export function crmLegStepOf(step: string, crmSteps: readonly string[]): string | null {
  const word = CRM_STEP_OF[step] ?? step;
  return crmSteps.includes(word) ? word : null;
}

function env(): { base: string; apiKey: string } {
  const base = process.env.CRM_SERVICE_URL;
  const apiKey = process.env.CRM_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("CRM_SERVICE_URL or CRM_SERVICE_API_KEY not configured");
  return { base, apiKey };
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const { base, apiKey } = env();
  const res = await fetchWithRetry(`${base}${path}`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`crm-service GET ${path.split("?")[0]}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object") throw new Error(`crm-service GET ${path.split("?")[0]}: malformed body`);
  return body as Record<string, unknown>;
}

/** Every (org, brand) crm-service can be asked about, and its step vocabulary. */
export async function fetchTeamLegReachBrands(): Promise<{ steps: string[]; brands: TeamLegReachBrand[] }> {
  const body = await getJson("/internal/people/leg-reach/brands");
  if (!Array.isArray(body.steps) || !Array.isArray(body.brands)) throw new Error("crm-service leg-reach/brands: no steps/brands arrays");
  const brands = (body.brands as Array<Record<string, unknown>>).map((b) => {
    if (typeof b.orgId !== "string" || typeof b.brandId !== "string") throw new Error("crm-service leg-reach/brands: malformed brand row");
    return { orgId: b.orgId, brandId: b.brandId };
  });
  return { steps: (body.steps as unknown[]).filter((s): s is string => typeof s === "string"), brands };
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function parseEnd(raw: unknown, which: string): { daily: Map<string, number>; undated: number; sources: string[] } {
  const e = raw as Record<string, unknown> | null;
  if (!e || !isCount(e.undated) || !Array.isArray(e.byDay) || !Array.isArray(e.sources)) throw new Error(`crm-service leg-reach: malformed ${which}`);
  const daily = new Map<string, number>();
  for (const d of e.byDay as Array<Record<string, unknown>>) {
    if (typeof d.day !== "string" || !isCount(d.people)) throw new Error(`crm-service leg-reach: malformed ${which}.byDay row`);
    daily.set(d.day, (daily.get(d.day) ?? 0) + d.people);
  }
  const sources = (e.sources as Array<Record<string, unknown>>).filter((s) => isCount(s.people) && s.people > 0).map((s) => String(s.source));
  return { daily, undated: e.undated, sources };
}

/** PURE: parse one deployed leg-reach body. */
export function parseTeamLegReach(body: Record<string, unknown>): TeamLegReach {
  if (typeof body.available !== "boolean") throw new Error("crm-service leg-reach: malformed body (no `available`)");
  if (!body.available) {
    if (typeof body.reason !== "string") throw new Error("crm-service leg-reach: unavailable without a reason");
    return { available: false, reason: body.reason };
  }
  const from = parseEnd(body.reachedFrom, "reachedFrom");
  const to = parseEnd(body.reachedTo, "reachedTo");
  const rawTo = body.reachedTo as Record<string, unknown>;
  let toByFromDay: { daily: Map<string, number>; undated: number } | null = null;
  if (rawTo.byFromDay !== undefined) {
    if (!Array.isArray(rawTo.byFromDay) || !isCount(rawTo.undatedFrom)) throw new Error("crm-service leg-reach: malformed reachedTo.byFromDay");
    const daily = new Map<string, number>();
    for (const d of rawTo.byFromDay as Array<Record<string, unknown>>) {
      if (typeof d.day !== "string" || !isCount(d.people)) throw new Error("crm-service leg-reach: malformed reachedTo.byFromDay row");
      daily.set(d.day, (daily.get(d.day) ?? 0) + d.people);
    }
    toByFromDay = { daily, undated: rawTo.undatedFrom };
  }
  return {
    available: true,
    from: { daily: from.daily, undated: from.undated },
    to: { daily: to.daily, undated: to.undated },
    fromSources: from.sources,
    toSources: to.sources,
    toByFromDay,
  };
}

/** One (org, brand)'s answer for our leg (our step keys). */
export async function fetchTeamLegReach(brand: TeamLegReachBrand, crmSteps: readonly string[], fromStep: string, toStep: string): Promise<TeamLegReach> {
  const from = crmLegStepOf(fromStep, crmSteps);
  const to = crmLegStepOf(toStep, crmSteps);
  if (from === null || to === null) return { available: false, reason: "step_not_in_crm_vocabulary" };
  const qs = new URLSearchParams({ brandId: brand.brandId, orgId: brand.orgId, from, to });
  return parseTeamLegReach(await getJson(`/internal/people/leg-reach?${qs}`));
}
