/**
 * The org's own TEAM is never a lead of its brands (owner 2026-10-17, TEAM-OUT-OF-UNIBOX-1017: « Tu peux aussi
 * arrêter de m'afficher dans mon unibox, je suis un team member »). lead-service applies it to its Unibox (so the
 * Deals board never shows a member); every population THIS service prices or counts is read through
 * `fetchLeadsForRevenue` (`leads-client.ts`), which drops the same people here, so the revenue read and the board
 * price ONE pipeline (2026-10-21: $237.63 vs $236.86 on the distribute.you offer, the gap = 4 test leads at the
 * owner's own `+tag` addresses).
 *
 * SAME definition as lead-service (`src/lib/org-members.ts` there, byte-equal fold): membership is client-service's
 * fact (`GET /internal/users?orgId=&allMembers=true`: users whose last active org it is PLUS every member the
 * identity provider holds), read HERE only to EXCLUDE; a `+tag` variant of a member's address (`local+tag@domain`,
 * same local part and domain, case-folded) is the member; nothing else is folded.
 *
 * FAIL LOUD: client-service unreadable throws `OrgMembersUnavailableError`, never "nobody is a member" (that would
 * price the team as leads again). No per-org or per-address list anywhere.
 */
import { fetchWithRetry } from "./fetch-retry.js";

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 500;
/** Members change rarely; one read per org per window per process. */
export const ORG_MEMBERS_TTL_MS = 5 * 60_000;

export class OrgMembersUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgMembersUnavailableError";
  }
}

/** The key one person's address folds to: lower-cased, `+tag` dropped from the local part. null = not an address. */
export function memberAddressKey(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  const base = plus === -1 ? local : local.slice(0, plus);
  if (base.length === 0) return null;
  return `${base}@${domain}`;
}

/** Is this address one of the members' (or a +tag variant of one)? */
export function isMemberAddress(email: string | null | undefined, members: ReadonlySet<string>): boolean {
  if (members.size === 0) return false;
  const key = memberAddressKey(email);
  return key !== null && members.has(key);
}

interface UsersPage {
  users: Array<{ email: string | null }>;
  total: number;
}

async function fetchMemberEmails(orgId: string): Promise<string[]> {
  const url = process.env.CLIENT_SERVICE_URL;
  const apiKey = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !apiKey) throw new OrgMembersUnavailableError("CLIENT_SERVICE_URL or CLIENT_SERVICE_API_KEY not configured");
  const emails: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const pageUrl = `${url}/internal/users?orgId=${encodeURIComponent(orgId)}&allMembers=true&limit=${PAGE_SIZE}&offset=${offset}`;
    let response: Response;
    try {
      response = await fetchWithRetry(pageUrl, { headers: { "x-api-key": apiKey } }, { timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (error) {
      throw new OrgMembersUnavailableError(`client-service unreachable reading the members of org ${orgId}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OrgMembersUnavailableError(`client-service answered ${response.status} reading the members of org ${orgId}: ${body.slice(0, 300)}`);
    }
    const page = (await response.json()) as UsersPage;
    if (!Array.isArray(page?.users) || typeof page.total !== "number") {
      throw new OrgMembersUnavailableError(`client-service answered an unreadable member list for org ${orgId}`);
    }
    for (const u of page.users) if (u?.email) emails.push(u.email);
    if (page.users.length < PAGE_SIZE || offset + page.users.length >= page.total) return emails;
  }
}

const cache = new Map<string, { keys: Set<string>; at: number }>();
const inFlight = new Map<string, Promise<Set<string>>>();

/** Every member address key of the org (cached `ORG_MEMBERS_TTL_MS`, one read in flight per org). Throws when unreadable. */
export async function loadOrgMemberKeys(orgId: string): Promise<Set<string>> {
  if (!orgId) throw new OrgMembersUnavailableError("no org id to read the members of");
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < ORG_MEMBERS_TTL_MS) return hit.keys;
  const pending = inFlight.get(orgId);
  if (pending) return pending;
  const p = (async () => {
    const keys = new Set<string>();
    for (const e of await fetchMemberEmails(orgId)) {
      const k = memberAddressKey(e);
      if (k) keys.add(k);
    }
    cache.set(orgId, { keys, at: Date.now() });
    return keys;
  })().finally(() => inFlight.delete(orgId));
  inFlight.set(orgId, p);
  return p;
}

/** Test seam: forget every cached member list. */
export function __resetOrgMembersCache(): void {
  cache.clear();
  inFlight.clear();
}
