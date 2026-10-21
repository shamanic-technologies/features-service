/**
 * HOW SPECIFIC IS EACH CLIENT'S B2B NICHE (RESEARCH-NICHE-1021, owner 2026-10-21: "being very specific in a B2B niche is
 * what I see working best in practice", said to a client; measure it across our clients).
 *
 * The unit is the (org, brand, offer) a cold email campaign sells (offer '' = a campaign stating none). Its grade is an
 * ASSESSED fact, judged once by Jev (chat-service platform judgments, `choice`) on what the client sells and who its
 * audiences target, and persisted (`niche_grades`); a pair is re-judged only when that text changes. Never a regex,
 * never a hand list. The text Jev reads:
 *   - the brand (brand-service: name, domain) and the offer (name, one-sentence description);
 *   - the audiences built for that offer (human-service's audience snapshot: name + the target text the audience was
 *     built from), else every audience of the brand when the campaign states no offer or the offer has none.
 *
 * Population: every (org, brand, offer) behind the leg's campaigns EXCEPT our own: an org whose every member is staff
 * (`isStaffOnlyOrg`, the showcase's and billing's rule: our test orgs) and a brand on our own domain (distribute.you).
 * A campaign naming no brand is graded nowhere. A pair Jev could not judge this build (or whose text could not be read)
 * is left out and counted (`unjudged`), never given a default grade.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { nicheGrades } from "../../db/schema.js";
import { fetchWithRetry } from "../fetch-retry.js";
import { mapWithConcurrency } from "../concurrency.js";
import { fetchBrandsBasic, fetchOrgUserEmails } from "../accounts-client.js";
import { isStaffEmail, isStaffOnlyOrg } from "../showcase-clients.js";

export const NICHE_GRADES = ["narrow", "focused", "broad"] as const;
export type NicheGrade = (typeof NICHE_GRADES)[number];

export const NICHE_LABEL: Record<NicheGrade, string> = {
  narrow: "Narrow niche",
  focused: "Focused",
  broad: "Broad",
};

/** What each grade means: the criteria Jev judges against, and the line the page prints under the study. */
export const NICHE_CRITERIA: Record<NicheGrade, string> = {
  narrow: "One vertical (a single industry or sub-industry) AND a precise buyer (a named role or job in it), e.g. employed chiropractors, or billing managers at medical practices.",
  focused: "Either one vertical or one precise buyer but not both, or a few closely related verticals, e.g. marketing directors at any B2B company, or every role at dental clinics.",
  broad: "Horizontal: many industries and many buyer roles, any business, consumers, or no clear target at all.",
};

const JEV_TIMEOUT_MS = 60_000;
const JUDGE_CONCURRENCY = 4;
/** The text a pair is judged on is re-read at most every 6 hours (an offer or audience rarely changes). */
const STATE_HOLD_MS = 6 * 60 * 60_000;

export interface NicheCampaign {
  campaignId: string;
  orgId: string;
  brandId: string | null;
  offerId: string | null;
}

/** One graded client (brand x offer), as the study lists it. */
export interface GradedClient {
  key: string;
  orgId: string;
  brandId: string;
  offerId: string;
  /** "Doc Dinners" or "Doc Dinners · Press Coverage" when the brand sells several offers here. */
  label: string;
  grade: NicheGrade;
  confidence: number;
}

export interface NicheGradesRead {
  /** Campaign id -> its client's grade (only graded clients' campaigns). */
  byCampaign: Map<string, GradedClient>;
  clients: GradedClient[];
  /** Pairs left out as ours (staff orgs, our own domain). */
  excludedOurs: number;
  /** Pairs not graded this build (text unreadable or Jev failed), with the last reason. */
  unjudged: { count: number; lastReason: string | null };
}

export interface JudgedState {
  brand: { name: string | null; domain: string | null };
  offer: { name: string; description: string | null } | null;
  audiences: Array<{ name: string; target: string | null }>;
}

const pairKey = (orgId: string, brandId: string, offerId: string) => `${orgId}|${brandId}|${offerId}`;

/** PURE. A stable digest of the text judged: same text, same digest, never re-asked. */
export function stateHashOf(state: JudgedState): string {
  const canonical = {
    brand: state.brand,
    offer: state.offer,
    audiences: [...state.audiences].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.target ?? "") < (b.target ?? "") ? -1 : 1)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** PURE. Our own brand: its domain is the staff domain (distribute.you). */
export function isOurDomain(domain: string | null): boolean {
  return Boolean(domain) && isStaffEmail(`x@${domain!.toLowerCase().replace(/^www\./, "")}`);
}

/** PURE. The Jev question: how specific is this client's B2B niche. */
export function nicheQuestion() {
  return {
    type: "choice" as const,
    instructions:
      "A client of a cold email agency sells the offer in the state to the audiences in the state (each audience's target text says who it is built to reach). " +
      "How specific is the B2B niche this client targets? Judge on WHO is targeted: the industry (vertical) and the buyer (the role that buys). " +
      "Use the audiences' target texts first, then the offer, then the brand. A narrow niche is one vertical AND a precise buyer in it. " +
      "Ignore how good the offer sounds, the company's size and any claim about results.",
    criteria: Object.fromEntries(NICHE_GRADES.map((g) => [g, NICHE_CRITERIA[g]])),
  };
}

async function askJev(state: JudgedState): Promise<{ grade: NicheGrade; confidence: number; probabilities: Record<string, number>; model: string }> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(
    `${base}/internal/platform-judgments`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey }, body: JSON.stringify({ state, questions: { niche: nicheQuestion() } }) },
    { timeoutMs: JEV_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown }> };
  const a = body.answers?.niche;
  if (a?.type !== "choice" || typeof a.choice !== "string" || typeof a.confidence !== "number") throw new Error("chat-service answered without a readable choice");
  if (!(NICHE_GRADES as readonly string[]).includes(a.choice)) throw new Error(`chat-service picked ${a.choice}, not a niche grade`);
  if (typeof body.model !== "string" || body.model === "") throw new Error("chat-service answered without naming the model release");
  const probabilities = (a.probabilities && typeof a.probabilities === "object" ? a.probabilities : { [a.choice]: 1 }) as Record<string, number>;
  return { grade: a.choice as NicheGrade, confidence: a.confidence, probabilities, model: body.model };
}

interface OfferRow {
  offerId: string;
  name: string;
  description: string | null;
}
interface AudienceRow {
  name: string;
  targetText: string | null;
  offerId: string | null;
}

async function readOffers(orgId: string, brandId: string): Promise<OfferRow[]> {
  const res = await fetchWithRetry(`${process.env.BRAND_SERVICE_URL}/internal/brands/${encodeURIComponent(brandId)}/offers`, {
    headers: { "x-api-key": process.env.BRAND_SERVICE_API_KEY ?? "", "x-org-id": orgId },
  });
  if (!res.ok) throw new Error(`brand-service offers ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { offers?: OfferRow[] };
  if (!Array.isArray(body.offers)) throw new Error("brand-service offers: no offers array");
  return body.offers;
}

async function readAudiences(orgId: string, brandId: string): Promise<AudienceRow[]> {
  const q = new URLSearchParams({ orgId });
  const res = await fetchWithRetry(`${process.env.HUMAN_SERVICE_URL}/internal/brands/${encodeURIComponent(brandId)}/audience-snapshot?${q}`, {
    headers: { "x-api-key": process.env.HUMAN_SERVICE_API_KEY ?? "" },
  });
  if (!res.ok) throw new Error(`human-service audience-snapshot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { audiences?: Array<{ name?: unknown; targetText?: unknown; offerId?: unknown }> };
  if (!Array.isArray(body.audiences)) throw new Error("human-service audience-snapshot: no audiences array");
  return body.audiences.map((a) => ({
    name: typeof a.name === "string" ? a.name : "",
    targetText: typeof a.targetText === "string" ? a.targetText : null,
    offerId: typeof a.offerId === "string" ? a.offerId : null,
  }));
}

/** PURE. The text one pair is judged on: the offer's own audiences, else every audience of the brand. */
export function judgedStateOf(
  brand: { name: string | null; domain: string | null },
  offerId: string,
  offers: readonly OfferRow[],
  audiences: readonly AudienceRow[],
): JudgedState {
  const offer = offerId ? offers.find((o) => o.offerId === offerId) ?? null : null;
  const own = offerId ? audiences.filter((a) => a.offerId === offerId) : [];
  const picked = own.length ? own : audiences;
  return {
    brand,
    offer: offer ? { name: offer.name, description: offer.description } : null,
    audiences: picked.map((a) => ({ name: a.name, target: a.targetText })),
  };
}

const stateHeld = new Map<string, { at: number; state: JudgedState }>();

/** Test seam. */
export function __resetNicheGrades(): void {
  stateHeld.clear();
}

/**
 * Every graded client behind `campaigns`, judging (and storing) the pairs not judged on their current text. Fails soft
 * per pair; throws only when the population itself (orgs, brands, the store) cannot be read.
 */
export async function readNicheGrades(campaigns: readonly NicheCampaign[], deps: { ask?: typeof askJev } = {}): Promise<NicheGradesRead> {
  const ask = deps.ask ?? askJev;
  const pairs = new Map<string, { orgId: string; brandId: string; offerId: string; campaignIds: string[] }>();
  for (const c of campaigns) {
    if (!c.brandId) continue;
    const k = pairKey(c.orgId, c.brandId, c.offerId ?? "");
    const p = pairs.get(k) ?? { orgId: c.orgId, brandId: c.brandId, offerId: c.offerId ?? "", campaignIds: [] };
    p.campaignIds.push(c.campaignId);
    pairs.set(k, p);
  }
  const orgIds = [...new Set([...pairs.values()].map((p) => p.orgId))];
  const staffOrgs = new Set<string>();
  await mapWithConcurrency(orgIds, 4, async (orgId) => {
    if (isStaffOnlyOrg(await fetchOrgUserEmails(orgId))) staffOrgs.add(orgId);
  });
  const brands = await fetchBrandsBasic([...new Set([...pairs.values()].map((p) => p.brandId))]);
  const stored = new Map(
    (await db.select().from(nicheGrades)).map((r) => [pairKey(r.orgId, r.brandId, r.offerId), r] as const),
  );
  let excludedOurs = 0;
  const unjudged = { count: 0, lastReason: null as string | null };
  const todo = [...pairs.values()].filter((p) => {
    const ours = staffOrgs.has(p.orgId) || isOurDomain(brands.get(p.brandId)?.domain ?? null);
    if (ours) excludedOurs += 1;
    return !ours;
  });
  // The text of each (org, brand) is read once per build at most, held 6 hours.
  const brandText = new Map<string, Promise<{ offers: OfferRow[]; audiences: AudienceRow[] }>>();
  const textOf = (orgId: string, brandId: string) => {
    const k = `${orgId}|${brandId}`;
    if (!brandText.has(k)) brandText.set(k, Promise.all([readOffers(orgId, brandId), readAudiences(orgId, brandId)]).then(([offers, audiences]) => ({ offers, audiences })));
    return brandText.get(k)!;
  };
  const graded = await mapWithConcurrency(todo, JUDGE_CONCURRENCY, async (p): Promise<{ p: typeof p; grade: NicheGrade; confidence: number; offerName: string | null } | null> => {
    const k = pairKey(p.orgId, p.brandId, p.offerId);
    try {
      const held = stateHeld.get(k);
      let state: JudgedState;
      if (held && Date.now() - held.at < STATE_HOLD_MS) state = held.state;
      else {
        const b = brands.get(p.brandId);
        const { offers, audiences } = await textOf(p.orgId, p.brandId);
        state = judgedStateOf({ name: b?.name ?? null, domain: b?.domain ?? null }, p.offerId, offers, audiences);
        stateHeld.set(k, { at: Date.now(), state });
      }
      const hash = stateHashOf(state);
      const row = stored.get(k);
      if (row && row.stateHash === hash) return { p, grade: row.grade as NicheGrade, confidence: row.confidence, offerName: state.offer?.name ?? null };
      const j = await ask(state);
      const values = { orgId: p.orgId, brandId: p.brandId, offerId: p.offerId, grade: j.grade, confidence: j.confidence, probabilities: j.probabilities, model: j.model, judgedState: state, stateHash: hash, judgedAt: new Date() };
      await db
        .insert(nicheGrades)
        .values(values)
        .onConflictDoUpdate({ target: [nicheGrades.orgId, nicheGrades.brandId, nicheGrades.offerId], set: values });
      return { p, grade: j.grade, confidence: j.confidence, offerName: state.offer?.name ?? null };
    } catch (err) {
      unjudged.count += 1;
      unjudged.lastReason = err instanceof Error ? err.message : String(err);
      console.error(`[features-service] research niche: ${k} not graded this build:`, err);
      return null;
    }
  });
  const ok = graded.filter((g): g is NonNullable<typeof g> => g !== null);
  const offersPerBrand = new Map<string, number>();
  for (const g of ok) offersPerBrand.set(`${g.p.orgId}|${g.p.brandId}`, (offersPerBrand.get(`${g.p.orgId}|${g.p.brandId}`) ?? 0) + 1);
  const clients: GradedClient[] = ok.map((g) => {
    const name = brands.get(g.p.brandId)?.name ?? g.p.brandId;
    const several = (offersPerBrand.get(`${g.p.orgId}|${g.p.brandId}`) ?? 0) > 1;
    return {
      key: pairKey(g.p.orgId, g.p.brandId, g.p.offerId),
      orgId: g.p.orgId,
      brandId: g.p.brandId,
      offerId: g.p.offerId,
      label: several && g.offerName ? `${name} · ${g.offerName}` : name,
      grade: g.grade,
      confidence: g.confidence,
    };
  });
  const byCampaign = new Map<string, GradedClient>();
  const clientOf = new Map(clients.map((c) => [c.key, c]));
  for (const p of pairs.values()) {
    const c = clientOf.get(pairKey(p.orgId, p.brandId, p.offerId));
    if (c) for (const id of p.campaignIds) byCampaign.set(id, c);
  }
  return { byCampaign, clients, excludedOurs, unjudged };
}

/** Staff read: one stored grade (tests / probes). */
export async function storedNicheGrade(orgId: string, brandId: string, offerId: string) {
  const [row] = await db
    .select()
    .from(nicheGrades)
    .where(and(eq(nicheGrades.orgId, orgId), eq(nicheGrades.brandId, brandId), eq(nicheGrades.offerId, offerId)));
  return row ?? null;
}
