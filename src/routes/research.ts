/**
 * THE RESEARCH STUDIES, SERVED LIVE (LIVE-RESEARCH-1018, owner 2026-10-18: « on ne pourrait pas avoir les articles de
 * recherche lire les data live? »). Staff only (api-key; the gateway mounts it behind staff), fleet-wide, no identity.
 *
 *   GET /internal/research?basis=user|actual   the whole file the staff Research page renders (billed by default)
 *   GET /internal/research/conclusions          the CONCLUSION studies with their quotable facts (billed): social-service
 *   GET /internal/research/studies              every MEASURED study, `quotable` only on a conclusion (billed)
 *
 * Built OFF the request path like every fleet read here: the refresher (whose fleet cells are warm) computes, the
 * server serves the last build (persisted in the fleet cell store, so a fresh process never answers empty), and a
 * read past the fresh window kicks one background rebuild. Before the first build ever: 503 `research_not_computed_yet`.
 *
 * ONE evidence, ONE rule: a workflow's bar IS its row of the leg workflow ranking (`/public/stats/leg-workflow-ranking`),
 * and every other bar regroups the same per-version evidence (`fetchFleetLegSlugEvidence`), dated by the runs ledger and
 * the fleet person cell. Pure assembly: `lib/research/*`.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { refresherBaseUrl } from "../lib/view-refresher.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { legCutoffIso, legMaturity, startedBeforeParam } from "../lib/maturity.js";
import { runsCostsUrl, selectCostCentsString, type Pricing } from "../lib/pricing.js";
import { runsSpendSlugsParam } from "../lib/feature-scope.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST } from "../lib/brand-spend-by-day-client.js";
import { fetchFleetPersonBuckets } from "../lib/fleet-positive-repliers.js";
import { isScreenedVisitLeg } from "../lib/screened-visits.js";
import { fetchMeetingBookingBeforeAfter } from "../lib/meeting-booking-before-after.js";
import { getInternalPipeFleet, MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY } from "../lib/meeting-leg-fleet.js";
import type { CostGroup, WorkflowMetadata } from "../lib/public-stats-clients.js";
import { buildSlugCells, type DatedSpendRow } from "../lib/research/slug-cells.js";
import { assembleResearch, type ColdEmailPipeInput } from "../lib/research/assemble.js";
import { researchConclusions, researchMeasuredStudies } from "../lib/research/conclusions.js";
import type { ResearchFile } from "../lib/research/types.js";
import { fetchFleetLegSlugEvidence, readLegWorkflowRanking } from "./public.js";

const router = Router();

const COLD_EMAIL = "sales-cold-email-outreach";
const REPLY_LEG = "start_to_conversation";
const VISIT_LEG = "start_to_website_visit";
const FRESH_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const RANKING_WAIT_MS = 10 * 60_000;
/** The first month runs carry cold email spend (the ledger starts in February 2026). */
const FIRST_MONTH = "2026-01";

type Basis = "user" | "actual";

const monthStart = (ym: string) => `${ym}-01T00:00:00.000Z`;
const nextMonth = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** PURE. The run-start windows the dated spend is read over: each month, the cutoff's month split at the cutoff. */
export function spendWindows(now: Date, cutoffIso: string | null): Array<{ month: string; from: string; to: string; beforeCutoff: boolean }> {
  const out: Array<{ month: string; from: string; to: string; beforeCutoff: boolean }> = [];
  const last = now.toISOString().slice(0, 7);
  for (let ym = FIRST_MONTH; ym <= last; ym = nextMonth(ym)) {
    const from = monthStart(ym);
    const to = monthStart(nextMonth(ym));
    if (cutoffIso && cutoffIso > from && cutoffIso < to) {
      out.push({ month: ym, from, to: cutoffIso, beforeCutoff: true });
      out.push({ month: ym, from: cutoffIso, to, beforeCutoff: false });
    } else {
      out.push({ month: ym, from, to, beforeCutoff: cutoffIso === null || to <= cutoffIso });
    }
  }
  return out;
}

/** Spend per (version, campaign) over one run-start window, every org's campaigns of the leg (incurred, like the ranking). */
async function fetchWindowSpend(featureSlug: string, ids: readonly string[], from: string, to: string): Promise<CostGroup[]> {
  const base = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !key) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({
    groupBy: "workflowSlug,campaignId",
    featureSlugs: runsSpendSlugsParam(featureSlug, "own"),
    campaignIds: ids.join(","),
    startedAfter: from,
    startedBefore: startedBeforeParam(to),
  });
  // The fleet aggregation that co-groups two keys is runs-service's service-auth one (the public one takes a single key);
  // it states the billed fields beside the vendor ones, so both bases read it (`selectCostCentsString` picks).
  const res = await fetchWithRetry(runsCostsUrl(base, "public", "vendor", params), { headers: { "x-api-key": key } });
  if (!res.ok) throw new Error(`runs-service dated research spend failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(body.groups)) throw new Error("runs-service dated research spend: no groups array");
  return body.groups;
}

async function fetchDatedSpend(featureSlug: string, campaignIds: readonly string[], pricing: Pricing, cutoffIso: string | null, now: Date): Promise<DatedSpendRow[]> {
  const ids = [...new Set(campaignIds)].sort();
  if (!ids.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) chunks.push(ids.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST));
  const reads = spendWindows(now, cutoffIso).flatMap((w) => chunks.map((c) => ({ w, c })));
  const rows = await mapWithConcurrency(reads, 3, async ({ w, c }) => {
    const groups = await fetchWindowSpend(featureSlug, c, w.from, w.to);
    return groups.flatMap((g): DatedSpendRow[] => {
      const slug = g.dimensions.workflowSlug;
      const campaignId = g.dimensions.campaignId;
      if (!slug || !campaignId) return [];
      const cents = Number(selectCostCentsString(g, "totalCostInUsdCents", pricing, "incurred"));
      return cents ? [{ workflowSlug: slug, campaignId, month: w.month, beforeCutoff: w.beforeCutoff, spentUsd: cents / 100 }] : [];
    });
  });
  return rows.flat();
}

/** A dynasty's name as the page shows it: workflow-service's name less the channel's words ("Rampart"). */
function labelFor(workflows: readonly WorkflowMetadata[]): (dynasty: string) => string {
  const names = new Map<string, string>();
  for (const w of workflows) if (w.workflowDynastyName && !names.has(w.workflowDynastySlug)) names.set(w.workflowDynastySlug, w.workflowDynastyName);
  return (dynasty) => {
    const name = names.get(dynasty);
    if (!name) return dynasty;
    const short = name.replace(/^(Sales Cold Email Outreach|Ai Meeting Booking)\s+/i, "");
    return short || name;
  };
}

async function coldEmailPipe(legKey: string, basis: Basis, now: Date): Promise<{ input: ColdEmailPipeInput; unpricedUsd: number }> {
  const pricing: Pricing = basis === "actual" ? "vendor" : "gross";
  const [ev, ranking, unpriced] = await Promise.all([
    fetchFleetLegSlugEvidence(COLD_EMAIL, legKey, "own", pricing),
    basis === "user" ? readLegWorkflowRanking(COLD_EMAIL, legKey, RANKING_WAIT_MS) : Promise.resolve(null),
    basis === "actual" ? fetchFleetLegSlugEvidence(COLD_EMAIL, legKey, "own", "vendorUnpriced") : Promise.resolve(null),
  ]);
  if (basis === "user" && !ranking) throw new Error(`leg workflow ranking ${COLD_EMAIL}|${legKey} not built yet`);
  const campaignIds = ev.campaigns.map((c) => c.campaignId);
  const [persons, spend] = await Promise.all([
    fetchFleetPersonBuckets(COLD_EMAIL, new Set(campaignIds)),
    fetchDatedSpend(COLD_EMAIL, campaignIds, pricing, ev.cutoffIso, now),
  ]);
  const rule = legMaturity(legKey);
  const screened = isScreenedVisitLeg(legKey);
  // The vendor basis leaves out WHOLE every version carrying billed spend no vendor cost prices (its priced part alone
  // would read as the whole), and states how much that was.
  const unpricedBySlug = new Map<string, number>();
  for (const g of unpriced?.flash.costGroups ?? []) {
    const slug = g.dimensions.workflowSlug;
    const cents = Number(g.totalCostInUsdCents);
    if (slug && cents > 0) unpricedBySlug.set(slug, (unpricedBySlug.get(slug) ?? 0) + cents / 100);
  }
  const keep = (g: { dimensions: Record<string, string | null> }) => !unpricedBySlug.has(g.dimensions.workflowSlug ?? "");
  const cells = buildSlugCells({
    legKey,
    screened,
    signal: rule.outcomeSignal === "positiveReply" ? "positiveReply" : rule.outcomeSignal === "clicked" ? "clicked" : "other",
    cutoffDay: ev.cutoffIso ? ev.cutoffIso.slice(0, 10) : null,
    flash: { costGroups: ev.flash.costGroups.filter(keep), emailStats: ev.flash.emailStats },
    mature: ev.mature ? { costGroups: ev.mature.costGroups.filter(keep), emailStats: ev.mature.emailStats } : null,
    persons,
    spend: spend.filter((r) => !unpricedBySlug.has(r.workflowSlug)),
    orgOfCampaign: new Map(ev.campaigns.map((c) => [c.campaignId, c.orgId])),
  });
  return {
    input: {
      legKey,
      durationDays: rule.durationDays,
      outcomesRequired: rule.outcomesRequired,
      cutoffDay: ev.cutoffIso ? ev.cutoffIso.slice(0, 10) : null,
      cells,
      dynastyOf: new Map(ev.workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug])),
      labelOf: labelFor(ev.workflows),
      rankingRows: ranking ? ranking.rows : null,
    },
    unpricedUsd: [...unpricedBySlug.values()].reduce((a, b) => a + b, 0),
  };
}

/** The whole file, computed IN THIS PROCESS (the refresher, or the server when it is off). */
export async function computeResearch(basis: Basis, now = new Date()): Promise<ResearchFile> {
  const meetingRule = legMaturity(MEETING_BOOKING_LEG_KEY);
  const [reply, visit, meetingRanking, meetingFleet, beforeAfter] = await Promise.all([
    coldEmailPipe(REPLY_LEG, basis, now),
    coldEmailPipe(VISIT_LEG, basis, now),
    basis === "user" ? readLegWorkflowRanking(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, RANKING_WAIT_MS) : Promise.resolve(null),
    basis === "user" ? getInternalPipeFleet(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, "meeting_booked") : Promise.resolve(null),
    fetchMeetingBookingBeforeAfter(),
  ]);
  return assembleResearch({
    costBasis: basis,
    now,
    unpricedBilledUsd: reply.unpricedUsd + visit.unpricedUsd,
    reply: reply.input,
    visit: visit.input,
    meeting: {
      outcomesRequired: meetingRule.outcomesRequired,
      rankingRows: meetingRanking ? meetingRanking.rows : null,
      unattributableCampaigns: meetingFleet ? meetingFleet.unattributableCampaignIds.length : 0,
    },
    beforeAfter,
    meetingOutcomesRequired: meetingRule.outcomesRequired,
  });
}

// ── serving: last build, persisted; one background rebuild at a time per basis ─────────────────────────────

const store = new Map<Basis, { value: ResearchFile; computedAt: number }>();
const warming = new Map<Basis, Promise<void>>();
const cellKey = (basis: Basis) => `research:${basis}`;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Ask the refresher (whose fleet cells are warm) to compute; compute here when it cannot. */
async function buildResearch(basis: Basis): Promise<ResearchFile> {
  const base = refresherBaseUrl();
  if (base) {
    try {
      const res = await fetch(`${base}/internal/research/compute?basis=${basis}`, { headers: { "x-api-key": process.env.FEATURES_SERVICE_API_KEY ?? "" } });
      if (res.ok) return (await res.json()) as ResearchFile;
      console.error(`[features-service] refresher answered ${res.status} for research ${basis}; computing locally`);
    } catch (error) {
      console.error(`[features-service] refresher unreachable for research ${basis}; computing locally:`, error);
    }
  }
  return computeResearch(basis);
}

export function warmResearch(basis: Basis): Promise<void> {
  const entry = store.get(basis);
  if (entry && Date.now() - entry.computedAt < FRESH_MS) return Promise.resolve();
  const inFlight = warming.get(basis);
  if (inFlight) return inFlight;
  const p = withTimeout(buildResearch(basis), BUILD_TIMEOUT_MS, `research ${basis}`)
    .then(async (value) => {
      const computedAt = Date.now();
      store.set(basis, { value, computedAt });
      await storeFleetCell(cellKey(basis), JSON.stringify(value), computedAt);
    })
    .catch((error) => console.error(`[features-service] research ${basis} build failed, keeping the previous one:`, error))
    .finally(() => warming.delete(basis));
  warming.set(basis, p);
  return p;
}

/** The last build (the persisted copy on a fresh process); kicks a rebuild when stale. Null = never built. */
export async function readResearch(basis: Basis): Promise<ResearchFile | null> {
  if (!store.has(basis)) {
    const stored = await loadFleetCell(cellKey(basis));
    if (stored && !store.has(basis)) {
      try {
        store.set(basis, { value: JSON.parse(stored.text) as ResearchFile, computedAt: stored.computedAt });
      } catch (error) {
        console.error(`[features-service] research ${basis}: persisted copy unreadable, rebuilding:`, error);
      }
    }
  }
  void warmResearch(basis);
  return store.get(basis)?.value ?? null;
}

/** Test seam. */
export function __resetResearch(): void {
  store.clear();
  warming.clear();
}

const basisOf = (raw: unknown): Basis | null => (raw === undefined || raw === "" || raw === "user" || raw === "billed" ? "user" : raw === "actual" ? "actual" : null);

const notYet = (res: import("express").Response) =>
  res.status(503).json({ error: "The research studies have not been computed yet: the first build after this deploy is running.", reason: "research_not_computed_yet" });

router.get("/internal/research", apiKeyOnly, async (req, res) => {
  const basis = basisOf(req.query.basis);
  if (!basis) {
    res.status(400).json({ error: "basis must be user (billed, default) or actual", reason: "basis_unrecognised" });
    return;
  }
  try {
    const file = await readResearch(basis);
    if (!file) return notYet(res);
    res.json(file);
  } catch (error) {
    console.error("[features-service] research read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/conclusions", apiKeyOnly, async (_req, res) => {
  try {
    const file = await readResearch("user");
    if (!file) return notYet(res);
    res.json(researchConclusions(file));
  } catch (error) {
    console.error("[features-service] research conclusions failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/research/studies", apiKeyOnly, async (_req, res) => {
  try {
    const file = await readResearch("user");
    if (!file) return notYet(res);
    res.json(researchMeasuredStudies(file));
  } catch (error) {
    console.error("[features-service] research studies failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** The refresher's compute door (the server asks it; never cached here: the caller stores the answer). */
router.get("/internal/research/compute", apiKeyOnly, async (req, res) => {
  const basis = basisOf(req.query.basis);
  if (!basis) {
    res.status(400).json({ error: "basis must be user or actual" });
    return;
  }
  try {
    res.json(await computeResearch(basis));
  } catch (error) {
    console.error(`[features-service] research compute (${basis}) failed:`, error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
