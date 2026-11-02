/**
 * FACTORY-USER-DASHBOARD-1102 (owner 2026-11-02, the customer Today page, GTM Factory "Why each one was picked"): the
 * workflow the Engine runs for each result of an offer's live campaigns, newest first, each with its share of the
 * Engine's draws and one plain sentence. PURE; IO in `routes/factory-shadow.ts` (`GET /offers/:offerId/engine-picks`).
 * A pick is the stored DRIVE (what runs, `lib/engine-drive.ts`), its share read on the campaign's stored Engine place.
 */
import type { EngineDriveRow } from "./engine-drive-store.js";

interface PlaceCandidate {
  candidateId: string;
  channelName: string;
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
  pickSharePct: number | null;
}
interface StoredPlan {
  campaignId: string;
  computedAt: string;
  body: { salesFunnelName?: string; engine?: { places?: Array<{ outcome: string; outcomeName: string; candidates?: PlaceCandidate[] }> } };
}

export interface EnginePick {
  campaignId: string;
  campaignName: string | null;
  outcome: string;
  outcomeName: string;
  workflowDynastySlug: string;
  workflowName: string;
  channelName: string | null;
  /** Share of the Engine's draws this workflow took on its campaign's last pass (%); null when the place lists none. */
  sharePct: number | null;
  /** `running` (the Engine's workflow runs) | `rolled_back` (it did worse than the previous choice, which runs again). */
  state: "running" | "rolled_back";
  /** One plain sentence: why it runs. No dash. */
  why: string;
  /** When the Engine last picked (its campaign's last pass). */
  pickedAt: string;
  /** Since when the Engine's workflow runs on this campaign. */
  runningSince: string;
  /** A rolled-back campaign retries the Engine at this instant. */
  retryAt: string | null;
}

const titleOf = (slug: string) => slug.split("-").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** PURE: the picks of the given live plans, from their drives, newest pick first. */
export function enginePicksOf(plans: readonly StoredPlan[], drives: readonly EngineDriveRow[]): EnginePick[] {
  const byCampaign = new Map(plans.map((p) => [p.campaignId, p]));
  const out: EnginePick[] = [];
  for (const d of drives) {
    const plan = byCampaign.get(d.funnelCampaignId);
    if (!plan) continue;
    const place = plan.body.engine?.places?.find((p) => p.outcome === d.outcome);
    const cand = place?.candidates?.find((c) => c.candidateId === `${d.pipeId}::${d.workflowDynastySlug}`) ?? place?.candidates?.find((c) => c.workflowDynastySlug === d.workflowDynastySlug);
    const workflowName = cand?.workflowDynastyName ?? titleOf(d.workflowDynastySlug);
    const outcomeName = place?.outcomeName ?? d.guard?.outcomeName ?? d.outcome;
    const share = cand?.pickSharePct ?? null;
    const channel = cand?.channelName ?? null;
    const retryAt = d.state === "rolled_back" ? (d.guard?.retryAt ?? null) : null;
    const why =
      d.state === "rolled_back"
        ? `${workflowName} did worse than the previous choice for ${outcomeName}, so the previous choice runs again${retryAt ? ` until ${day(retryAt)}` : ""}.`
        : d.guard?.source === "pipe_most_drawn"
          ? `${workflowName} is the workflow the Engine draws most often${channel ? ` on ${channel}` : ""}${share !== null ? ` (${share}% of draws)` : ""}.`
          : share !== null
            ? `${workflowName} took ${share}% of the Engine's draws: the best expected value per dollar for ${outcomeName}.`
            : `${workflowName} is the Engine's pick: the best expected value per dollar for ${outcomeName}.`;
    out.push({
      campaignId: d.funnelCampaignId,
      campaignName: plan.body.salesFunnelName ?? null,
      outcome: d.outcome,
      outcomeName,
      workflowDynastySlug: d.workflowDynastySlug,
      workflowName,
      channelName: channel,
      sharePct: share,
      state: d.state === "rolled_back" ? "rolled_back" : "running",
      why,
      pickedAt: plan.computedAt,
      runningSince: d.switchedAt,
      retryAt,
    });
  }
  return out.sort((a, b) => (a.pickedAt < b.pickedAt ? 1 : a.pickedAt > b.pickedAt ? -1 : a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : a.outcome < b.outcome ? -1 : 1));
}
