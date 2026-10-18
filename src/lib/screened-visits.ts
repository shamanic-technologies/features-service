/**
 * A WEBSITE VISIT IS A CLICK JUDGED HUMAN (owner doctrine, SCOUT-VISIT-SCREEN-1018; the Research study's notes).
 *
 * Only a click on an email we sent through our OWN transport can be screened: instantly-service records the hit
 * itself and keeps it only once it judged it human (a scanner's is withdrawn). A click the provider reports (an
 * email sent through Instantly) carries no request data and is mostly link scanners: it can never be a website
 * visit. Prod 2026-10-18 on the visit leg: Rampart 160 "visits" of which ~26 human-judged; Lyonesse ranked first
 * on clicks nobody could screen.
 *
 * So every per-workflow figure on a leg whose outcome is the click (`legMaturity(leg).outcomeSignal === "clicked"`)
 * is read on the SCREENABLE population only, both halves on it:
 *   - outcomes = persons with a human-judged click on the send they are credited to;
 *   - contacted = persons whose credited send went through our transport;
 *   - spend = the slug's spend × (contacted through our transport ÷ contacted), the share of its sends that
 *     could be screened. A provider send's spend bought clicks nobody can count, so it prices nothing here.
 * A slug with no screenable send has no website-visit evidence: zero spend, zero contacted, zero visits.
 *
 * Counts come from the fleet person cell (`lib/fleet-positive-repliers.ts`), credited per person by
 * `lib/serving-row-credit.ts` off lead-service's timeline (which states each send's transport and whether a
 * click was recorded by our tracker). PURE.
 */
import { legMaturity } from "./maturity.js";

/** The stats keys a person count carries for the screened halves (beside email-gateway's own keys). */
export const SCREENED_CONTACTED_KEY = "recipientsScreenedContacted";
export const HUMAN_CLICKED_KEY = "recipientsHumanClicked";

export interface ScreenedVisitCounts {
  /** Persons contacted (any transport). */
  contacted: number;
  /** Of them, contacted through our own transport (a click on their email is screened). */
  screenedContacted: number;
  /** Persons with a human-judged click on that send. */
  humanClicks: number;
}

/** TRUE on a leg whose outcome IS the click: its figures are read on screened visits only. */
export function isScreenedVisitLeg(legKey: string | null | undefined): boolean {
  return legMaturity(legKey).outcomeSignal === "clicked";
}

interface CostGroupLike {
  dimensions: Record<string, string | null | undefined>;
}

/** `cents × share` as the producer's decimal-string field (share 0 → "0"). */
function scaleCents(raw: unknown, share: number): unknown {
  if (typeof raw !== "string" && typeof raw !== "number") return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const scaled = n * share;
  return typeof raw === "number" ? scaled : String(scaled);
}

/** PURE. The share of a slug's sends that could be screened (0 when it contacted nobody we can see). */
export function screenableShare(c: ScreenedVisitCounts | undefined): number {
  if (!c || c.contacted <= 0) return 0;
  return Math.min(1, c.screenedContacted / c.contacted);
}

/**
 * PURE. A leg's per-slug evidence read on screened visits (see the module rule): every `*CostInUsdCents` field of
 * each cost group scaled by the slug's screenable share, and each slug's `recipientsContacted` /
 * `recipientsClicked` replaced by the screened counts. Never mutates the inputs.
 */
export function screenVisitEvidence<G extends CostGroupLike>(
  costGroups: readonly G[],
  emailStats: ReadonlyMap<string, Record<string, number>>,
  counts: ReadonlyMap<string, ScreenedVisitCounts>,
): { costGroups: G[]; emailStats: Map<string, Record<string, number>> } {
  const scaledGroups = costGroups.map((g) => {
    const slug = g.dimensions.workflowSlug;
    if (!slug || slug === "__total__") return g;
    const share = screenableShare(counts.get(slug));
    const out = { ...g, dimensions: { ...g.dimensions } } as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(g)) if (k.endsWith("CostInUsdCents")) out[k] = scaleCents(v, share);
    return out as G;
  });
  const stats = new Map<string, Record<string, number>>();
  const slugs = new Set([...emailStats.keys(), ...counts.keys()]);
  for (const slug of slugs) {
    const c = counts.get(slug);
    stats.set(slug, {
      ...(emailStats.get(slug) ?? {}),
      recipientsContacted: c?.screenedContacted ?? 0,
      recipientsClicked: c?.humanClicks ?? 0,
    });
  }
  return { costGroups: scaledGroups, emailStats: stats };
}

/** PURE. Screened counts read off person-count stats (the mature cohort's `matureSlugStats` shape). */
export function screenedCountsOfStats(emailStats: ReadonlyMap<string, Record<string, number>>): Map<string, ScreenedVisitCounts> {
  const out = new Map<string, ScreenedVisitCounts>();
  for (const [slug, s] of emailStats) {
    out.set(slug, {
      contacted: s.recipientsContacted ?? 0,
      screenedContacted: s[SCREENED_CONTACTED_KEY] ?? 0,
      humanClicks: s[HUMAN_CLICKED_KEY] ?? 0,
    });
  }
  return out;
}
