/**
 * GET /brands/:brandId/lead-families — EVERY person of the brand's offers in their FAMILY (won, hot,
 * lost, cold), for the Unibox filters (owner 2026-10-08). The family is the offer outcomes pipeline's
 * own verdict (`buildOfferPipelineAndFamilies`, `lib/offer-pipeline-explained.ts`) computed off the SAME
 * inputs `/offers/:offerId/outcomes` reads, so the counts equal Today's Customers won (leads), Hot leads
 * and Lost leads (+ ruled out, stated apart). Nothing is re-derived here: this route only unions the
 * brand's offers, a person on several taking the strongest family.
 *
 * Unpaged on purpose: a brand's family members are thousands of thin rows, and the consumer
 * (crm-service's people list) filters and counts server-side off one read.
 */
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, pricedFingerprint, type DownstreamHeaders } from "./revenue.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { buildOfferChannelMap } from "../lib/offer-channels.js";
import { buildOfferLegPartition, stepValues } from "../lib/offer-outcomes.js";
import { OUTCOME_CAUSES, causeScopeKeyPart, parseOutcomeCauses } from "../lib/outcome-cause.js";
import { BrandOwnershipError, assertBrandHeld } from "../lib/brand-ownership.js";
import { servedCachedJson, sendSnapshotJson, buildScopeKey } from "../lib/view-cache.js";
import { maturityDaysForLeg } from "../lib/roi-maturity.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import { createHash } from "node:crypto";
import {
  LEAD_FAMILY_RANK,
  buildOfferPipelineAndFamilies,
  offerStepSets,
  type LeadFamily,
  type LeadFamilyRow,
} from "../lib/offer-pipeline-explained.js";
import { catalogueEntry, readOfferPersons } from "./offer-outcomes.js";
import { fetchBrandIntent, foldIntentIntoFamilies, type IntentFoldSummary } from "../lib/relationship-intent.js";

const router = Router();

export interface BrandLeadFamilyRow extends Omit<LeadFamilyRow, "leadId"> {
  /** lead-service's lead; null on a person who is none of our outreach leads (Hot from lead-service's tags). */
  leadId: string | null;
  /** The offer whose verdict gave the family (the strongest, offer id ascending on a tie); null when the tags did. */
  offerId: string | null;
  /** How a Hot row is Hot: the outreach pipeline's verdict, or lead-service's tags (lead + wants business). */
  hotBasis: "pipeline" | "wants_business" | null;
  /** lead-service's person on a row its tags made Hot; null otherwise. */
  humanId: string | null;
}

const FAMILIES: readonly LeadFamily[] = ["won", "hot", "lost", "cold"];

function hashKeyPart(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * PURE: the Gold cell key. Everything the body is computed ON (offers, their campaigns, the funnels and
 * economics they are priced on) rides the `decl`/`econ` FINGERPRINT parts: when one moves, the previous
 * cell of the same org + brand + cause is served at once and the new one is computed behind it
 * (`familyKeyOf`), never a 9-30 s blocking compute on the read that noticed (crm-service reads with a
 * 30 s timeout; prod 2026-10-08, brand `75d7e3e8…`, ~18k people, 4 MB).
 */
export function leadFamiliesScopeKey(
  brandId: string,
  orgId: string,
  offers: ReadonlyArray<{
    offerId: string;
    partition: { groups: ReadonlyArray<{ legKey: string; featureSlug: string; campaignIds: readonly string[] }> };
    declared: Parameters<typeof priceOnDeclaredFunnel>[0];
  }>,
  cause: string,
): string {
  return buildScopeKey(brandId, {
    orgId,
    decl: hashKeyPart(
      offers
        .map(
          (o) =>
            `${o.offerId}>${o.partition.groups.map((g) => `${g.legKey}@${g.featureSlug}>${g.campaignIds.join("+")}`).join(",")}` +
            `|${o.declared.map((f) => f.funnelKey).sort().join("+") || "none"}`,
        )
        .join(";"),
    ),
    econ: hashKeyPart(offers.map((o) => `${o.offerId}>${pricedFingerprint(priceOnDeclaredFunnel(o.declared))}`).join(";")),
    cause,
    // A lead lead-service marks Disqualified is priced at 0 and lands in `lost` (owner 2026-10-13);
    // a person lead-service tags lead + wants business is Hot, any channel (HOT-INBOUND-UNANSWERED-1016).
    m: "disq-mark-1+intent-hot-1",
  });
}

/** PURE: union per-offer families, strongest wins (ties: first offer, ids ascending), row ids merged. */
export function unionBrandFamilies(perOffer: ReadonlyArray<{ offerId: string; families: readonly LeadFamilyRow[] }>) {
  const byLead = new Map<string, BrandLeadFamilyRow>();
  for (const { offerId, families } of perOffer) {
    for (const row of families) {
      const current = byLead.get(row.leadId);
      if (!current) {
        byLead.set(row.leadId, { ...row, campaignLeadIds: [...row.campaignLeadIds], offerId, hotBasis: null, humanId: null });
        continue;
      }
      const ids = [...new Set([...current.campaignLeadIds, ...row.campaignLeadIds])];
      if (LEAD_FAMILY_RANK[row.family] < LEAD_FAMILY_RANK[current.family]) {
        byLead.set(row.leadId, { ...row, email: row.email ?? current.email, campaignLeadIds: ids, offerId, hotBasis: null, humanId: null });
      } else {
        current.campaignLeadIds = ids;
        current.email = current.email ?? row.email;
      }
    }
  }
  return summarizeFamilies([...byLead.values()]);
}

/** PURE: sort rows strongest first and count PEOPLE (one lead, or one tagged person over all their addresses). */
export function summarizeFamilies(rows: BrandLeadFamilyRow[]) {
  const keyOf = (p: BrandLeadFamilyRow) => p.leadId ?? `human:${p.humanId}`;
  const people = rows.sort(
    (a, b) => LEAD_FAMILY_RANK[a.family] - LEAD_FAMILY_RANK[b.family] || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0),
  );
  const countOf = (pred: (p: BrandLeadFamilyRow) => boolean) => new Set(people.filter(pred).map(keyOf)).size;
  const counts = Object.fromEntries(FAMILIES.map((f) => [f, countOf((p) => p.family === f)])) as Record<LeadFamily, number>;
  return {
    counts,
    hotBreakdown: {
      pipeline: countOf((p) => p.family === "hot" && p.hotBasis !== "wants_business"),
      wantsBusiness: countOf((p) => p.family === "hot" && p.hotBasis === "wants_business"),
    },
    lostBreakdown: {
      wentCold: countOf((p) => p.lostReason === "went_cold"),
      ruledOut: countOf((p) => p.lostReason === "ruled_out"),
    },
    people,
  };
}

/**
 * PURE: the outreach pipeline's families + lead-service's tags (HOT-INBOUND-UNANSWERED-1016): whoever is
 * tagged lead yes AND wants business yes, any channel, last word within the fresh window, is Hot.
 */
export function withIntentHot(pipelineRows: readonly BrandLeadFamilyRow[], intent: Parameters<typeof foldIntentIntoFamilies>[1], now: Date) {
  const folded = foldIntentIntoFamilies<BrandLeadFamilyRow>(pipelineRows, intent, now, (p, email) => ({
    leadId: null,
    email,
    campaignLeadIds: [],
    family: "hot",
    lostReason: null,
    offerId: null,
    hotBasis: "wants_business",
    humanId: p.humanId,
  }));
  return { ...summarizeFamilies(folded.rows), intent: folded.summary as IntentFoldSummary };
}

router.get("/brands/:brandId/lead-families", apiKeyAuth, async (rawReq, res) => {
  try {
    const req = rawReq as AuthenticatedRequest;
    const brandId = req.params.brandId as string;
    const causes = parseOutcomeCauses(req.query.cause);
    if (causes === null) {
      return res.status(400).json({
        error: `cause must be a comma-separated subset of: ${OUTCOME_CAUSES.join(", ")}`,
        reason: "cause_unrecognised",
      });
    }
    const headers: DownstreamHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId, featureSlug: undefined };
    const rows = await fetchBrandCampaignRows(brandId, undefined, { orgId: req.orgId, userId: req.userId, runId: req.runId });
    const offerIds = buildOfferChannelMap(rows).offerIds;
    // The ownership check and the offers' pricing reads are independent: one round trip, not two.
    const [, offers] = await Promise.all([
      assertBrandHeld(brandId, headers),
      Promise.all(
        offerIds.map(async (offerId) => ({
          offerId,
          partition: buildOfferLegPartition(rows, offerId, (slug) => catalogueEntry(slug)?.channel ?? null),
          declared: await fetchDeclaredFunnelsSoft(brandId, req.orgId, offerId),
        })),
      ),
    ]);

    const payload = await servedCachedJson({
      view: "brand-lead-families",
      // Keyed on THIS route's response shape only: a deploy changing another route keeps the cell warm.
      scopeKey: leadFamiliesScopeKey(brandId, req.orgId, offers, causeScopeKeyPart(causes)),
      responseShape: routeResponseShapeFingerprint("/brands/{brandId}/lead-families"),
      orgId: req.orgId,
      compute: async () => {
        const perOffer: Array<{ offerId: string; families: LeadFamilyRow[]; counts: Record<LeadFamily, number> }> = [];
        // One offer at a time: each reads the brand's leads, and this process runs a small heap.
        for (const o of offers) {
          const campaignIds = [...new Set(o.partition.groups.flatMap((g) => g.campaignIds))].sort();
          if (campaignIds.length === 0) {
            perOffer.push({ offerId: o.offerId, families: [], counts: { won: 0, hot: 0, lost: 0, cold: 0 } });
            continue;
          }
          const people = await readOfferPersons({
            brandId,
            offerId: o.offerId,
            campaignIds,
            headers,
            pricedFunnelKeys: o.declared.map((f) => f.funnelKey),
            causes,
            needDates: o.partition.groups.some((g) => maturityDaysForLeg(g.legKey) > 0),
          });
          const { families } = buildOfferPipelineAndFamilies({
            persons: people.persons,
            evidence: people.evidence,
            declared: o.declared,
            values: stepValues(o.declared),
            cold: people.cold,
            sets: offerStepSets(people.persons, people.evidence),
            pricedCauses: causes,
          });
          perOffer.push({ offerId: o.offerId, families, counts: unionBrandFamilies([{ offerId: o.offerId, families }]).counts });
        }
        const pipeline = unionBrandFamilies(perOffer);
        const intent = await fetchBrandIntent(brandId, headers);
        const union = withIntentHot(pipeline.people, intent, new Date());
        return {
          brandId,
          outcomeCauses: { priced: [...causes] },
          counts: union.counts,
          hotBreakdown: union.hotBreakdown,
          lostBreakdown: union.lostBreakdown,
          pipelineCounts: pipeline.counts,
          intent: union.intent,
          offers: perOffer.map((o) => ({ offerId: o.offerId, counts: o.counts })),
          people: union.people,
        };
      },
    });
    sendSnapshotJson(res, payload);
  } catch (error) {
    if (error instanceof BrandOwnershipError) return res.status(404).json({ error: "Brand not found", reason: "brand_not_found" });
    console.error("[features-service] Brand lead families error:", error);
    res.status(502).json({ error: "Failed to compute brand lead families" });
  }
});

export default router;
