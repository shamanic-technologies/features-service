/**
 * STAFF: what we paid to SOURCE a brand's people (`lib/sourcing-investment.ts`), per audience, per
 * person and per company. Three reads over ONE cached computation (the Gold snapshot layer): the
 * summary + audiences, then the people and the companies, each paged or keyed so the dashboard joins
 * them onto human-service's own person / company rows (person: `apolloPersonId`; company: domain).
 *
 * Carries the VENDOR basis (our margin): the api-service gateway mounts these behind requireStaff.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchServedPersonRows } from "../lib/leads-client.js";
import {
  computeSourcingInvestment,
  fetchListBuildCosts,
  fetchServeRunCosts,
  fetchHeldPersonCompanies,
  type SourcingInvestment,
} from "../lib/sourcing-investment.js";

const router = Router();

export const SOURCING_INVESTMENT_DEFINITION = {
  basis: "actual",
  counted: [
    "serve: the whole cost subtree of every lead-service lead-serve run of the brand (Jev pre-pay screens, provider reveal / enrichment, email finding and verification, LinkedIn engagement and buying-signal reads)",
    "listBuild: apollo-service audience-companies runs (company lists pulled when an audience is built or previewed)",
  ],
  notCounted: [
    "email writing, sending and reply reading (outreach)",
    "brand and offer setup, the LLM audience split, the audience-preview email pre-check",
  ],
} as const;

async function loadSourcingInvestment(brandId: string, req: AuthenticatedRequest): Promise<SourcingInvestment> {
  return servedCached({
    view: "brand-sourcing-investment",
    scopeKey: buildScopeKey(brandId, { orgId: req.orgId, m: "sourcing-investment-v2" }),
    orgId: req.orgId,
    compute: async () => {
      const [serves, listBuild, heldCompanies, servedRows] = await Promise.all([
        fetchServeRunCosts(brandId, req.orgId),
        fetchListBuildCosts(brandId, req.orgId),
        fetchHeldPersonCompanies(brandId, req.orgId),
        fetchServedPersonRows(brandId, { orgId: req.orgId, userId: req.userId, runId: req.runId }),
      ]);
      return computeSourcingInvestment({ serves, listBuild, servedRows, heldCompanies });
    },
  });
}

const MAX_PAGE = 500;
const MAX_KEYS = 500;

/** `limit`/`offset` and an optional key list; a malformed value is a 400, never ignored. */
function parsePaging(query: Record<string, unknown>, keyParam: string):
  | { error: string }
  | { limit: number; offset: number; keys: Set<string> | null } {
  const num = (raw: unknown, name: string, dflt: number, min: number, max: number): number | string => {
    if (raw === undefined || raw === "") return dflt;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return `${name} must be an integer`;
    const n = Number(raw);
    if (n < min || n > max) return `${name} must be between ${min} and ${max}`;
    return n;
  };
  const limit = num(query.limit, "limit", 100, 1, MAX_PAGE);
  if (typeof limit === "string") return { error: limit };
  const offset = num(query.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  if (typeof offset === "string") return { error: offset };
  const rawKeys = query[keyParam];
  if (rawKeys === undefined || rawKeys === "") return { limit, offset, keys: null };
  if (typeof rawKeys !== "string") return { error: `${keyParam} must be a comma-separated string` };
  const keys = rawKeys.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length > MAX_KEYS) return { error: `${keyParam} takes at most ${MAX_KEYS} values` };
  return { limit, offset, keys: new Set(keys) };
}

router.get("/brands/:brandId/sourcing-investment", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  try {
    const r = await loadSourcingInvestment(brandId, req);
    const { people: _people, companies: _companies, ...summary } = r;
    return res.json({ brandId, definition: SOURCING_INVESTMENT_DEFINITION, ...summary });
  } catch (error) {
    console.error(`[features-service] sourcing investment error for brand ${brandId}:`, error);
    return res.status(502).json({ error: "Failed to compute sourcing investment" });
  }
});

router.get("/brands/:brandId/sourcing-investment/people", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  const paging = parsePaging(rawReq.query as Record<string, unknown>, "apolloPersonIds");
  if ("error" in paging) return res.status(400).json({ error: paging.error });
  try {
    const r = await loadSourcingInvestment(brandId, req);
    const keys = paging.keys;
    const matching = keys ? r.people.filter((p) => p.apolloPersonId !== null && keys.has(p.apolloPersonId)) : r.people;
    return res.json({
      brandId,
      total: matching.length,
      limit: paging.limit,
      offset: paging.offset,
      people: matching.slice(paging.offset, paging.offset + paging.limit),
    });
  } catch (error) {
    console.error(`[features-service] sourcing investment people error for brand ${brandId}:`, error);
    return res.status(502).json({ error: "Failed to compute sourcing investment" });
  }
});

router.get("/brands/:brandId/sourcing-investment/companies", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  const query = rawReq.query as Record<string, unknown>;
  if (query.companyKeys !== undefined && query.domains !== undefined) {
    return res.status(400).json({ error: "name companyKeys or domains, not both" });
  }
  const byKey = query.companyKeys !== undefined;
  const paging = parsePaging(query, byKey ? "companyKeys" : "domains");
  if ("error" in paging) return res.status(400).json({ error: paging.error });
  try {
    const r = await loadSourcingInvestment(brandId, req);
    const keys = paging.keys;
    const domains = keys && !byKey ? new Set([...keys].map((d) => d.toLowerCase())) : null;
    const matching = !keys
      ? r.companies
      : byKey
        ? r.companies.filter((c) => keys.has(c.companyKey))
        : r.companies.filter((c) => c.companyDomain !== null && domains!.has(c.companyDomain));
    return res.json({
      brandId,
      total: matching.length,
      limit: paging.limit,
      offset: paging.offset,
      companies: matching.slice(paging.offset, paging.offset + paging.limit),
    });
  } catch (error) {
    console.error(`[features-service] sourcing investment companies error for brand ${brandId}:`, error);
    return res.status(502).json({ error: "Failed to compute sourcing investment" });
  }
});

export default router;
