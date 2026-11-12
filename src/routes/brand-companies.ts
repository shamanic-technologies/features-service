/**
 * GET /brands/:brandId/companies            — the brand's companies, one PAGE at a time (sort, search, rung filter)
 * GET /brands/:brandId/companies/:companyKey — ONE company, its place in the value order and its neighbours
 *
 * MON-PAGE-SPEED-2-1112 (owner goal: every dashboard page instant, no read over 1 s). The Companies page, a Company
 * page and the search palette used to read the brand revenue body for its `organizations[]` (7.1 MB on our own
 * brand, 11,345 companies, prod 2026-11-12) plus the brand company lifecycle body (2.0 MB) for the rungs: ~9 MB on
 * every visit, over the browser's 2 MB persisted-cache cap. These reads serve the SAME rows (`lib/brand-companies.ts`),
 * slim and paged: a page of 60 is ~35 KB.
 *
 * WHERE THE ROWS COME FROM: the brand revenue body of this request's cell family, served first (the same stored
 * answer `GET /brands/:id/revenue` sends, `brandRevenueBodyFirst`), joined to the brand company lifecycle cell
 * (`GET /brands/:id/deals-value?columns=company_lifecycle`). Both stay the source of truth; the index derived from
 * them is memoized per stored pair, so a page turn costs a filter and a slice. No figure is computed here.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { brandRevenueBodyFirst, handleError } from "./brand-economics.js";
import { brandLifecycleRead, BrandHasNoOfferCampaignsError } from "./deals-value.js";
import {
  buildCompanyIndex,
  oneCompany,
  pageCompanies,
  parseCompanyPageQuery,
  type CompanyIndex,
  type StoredCompany,
  type StoredLifecycle,
} from "../lib/brand-companies.js";
import { parsePricing } from "../lib/pricing.js";

const router = Router();

interface MemoEntry {
  revenueText: string;
  lifecycleText: string | null;
  index: CompanyIndex;
}

/** One index per (org, brand, pricing), rebuilt only when either stored body moved. Bounded: oldest out first. */
const memo = new Map<string, MemoEntry>();
const MEMO_MAX = 64;

/** Test seam. */
export function __resetBrandCompaniesMemo(): void {
  memo.clear();
}

class CompaniesRefused {
  constructor(readonly status: number, readonly json: unknown) {}
}

/** The brand's company index for this request, or a refusal the revenue read itself would answer. */
async function companyIndexFor(rawReq: import("express").Request): Promise<CompanyIndex> {
  const req = rawReq as unknown as AuthenticatedRequest & { params: { brandId: string } };
  const brandId = req.params.brandId;
  const pricing = parsePricing(rawReq.query.pricing);
  if (pricing === null) throw new CompaniesRefused(400, { error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
  // The revenue cell this list derives from is the DEFAULT one of its pricing (no leads/cause/window variant).
  const revenueReq = Object.create(rawReq, { query: { value: { pricing }, enumerable: true } }) as import("express").Request;
  const headers = { orgId: req.orgId, userId: req.userId, runId: req.runId };
  const [revenue, lifecycle] = await Promise.all([
    brandRevenueBodyFirst(revenueReq),
    brandLifecycleRead(brandId, headers, "company_lifecycle").catch((error: unknown) => {
      // A brand none of whose campaigns sells an offer has no lifecycle: every company stands on no rung.
      if (error instanceof BrandHasNoOfferCampaignsError) return null;
      throw error;
    }),
  ]);
  if ("refused" in revenue) throw new CompaniesRefused(revenue.refused.status, revenue.refused.json);
  const revenueText = revenue.body.json;
  const lifecycleText = lifecycle?.json ?? null;
  const key = `${req.orgId}\0${brandId}\0${pricing}`;
  const hit = memo.get(key);
  if (hit && hit.revenueText === revenueText && hit.lifecycleText === lifecycleText) {
    memo.delete(key);
    memo.set(key, hit);
    return hit.index;
  }
  const body = JSON.parse(revenueText) as { organizations?: StoredCompany[] };
  if (!Array.isArray(body.organizations)) {
    console.error(`[features-service] brand ${brandId} revenue body carries no organizations[]: no company list`, Object.keys(body));
    throw new Error(`brand ${brandId} revenue body carries no organizations[]`);
  }
  const index = buildCompanyIndex(body.organizations, lifecycleText ? (JSON.parse(lifecycleText) as StoredLifecycle) : null);
  memo.set(key, { revenueText, lifecycleText, index });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  return index;
}

function refuse(res: import("express").Response, error: unknown) {
  if (error instanceof CompaniesRefused) return res.status(error.status).json(error.json);
  return handleError(res, error, "companies");
}

router.get("/brands/:brandId/companies", apiKeyAuth, async (req, res) => {
  const query = parseCompanyPageQuery(req.query as Record<string, unknown>);
  if ("error" in query) return res.status(400).json(query);
  try {
    const index = await companyIndexFor(req);
    const { total, companies } = pageCompanies(index, query);
    return res.json({
      brandId: req.params.brandId,
      sort: query.sort,
      q: query.q,
      rung: query.rung,
      offset: query.offset,
      limit: query.limit,
      total,
      organizationCount: index.byValue.length,
      rungs: index.rungs,
      companies,
    });
  } catch (error) {
    return refuse(res, error);
  }
});

router.get("/brands/:brandId/companies/:companyKey", apiKeyAuth, async (req, res) => {
  try {
    const index = await companyIndexFor(req);
    const found = oneCompany(index, req.params.companyKey as string);
    if (!found) {
      return res.status(404).json({
        error: `no company of brand ${req.params.brandId} is addressed by ${req.params.companyKey}`,
        reason: "company_not_found",
      });
    }
    return res.json({
      brandId: req.params.brandId,
      ...found,
      organizationCount: index.byValue.length,
      rungs: index.rungs,
    });
  } catch (error) {
    return refuse(res, error);
  }
});

export default router;
