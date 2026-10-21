/**
 * TEAM-OUT-OF-UNIBOX-1017 on the priced population: the org's own team (a member, or a +tag variant of a member's
 * address) is never a lead, with lead-service's member definition; client-service unreadable fails loud.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.unmock("./org-members.js");

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.CLIENT_SERVICE_URL = "http://client:3000";
process.env.CLIENT_SERVICE_API_KEY = "client-key";

const { memberAddressKey, isMemberAddress, loadOrgMemberKeys, OrgMembersUnavailableError, __resetOrgMembersCache } = await import(
  "./org-members.js"
);
const { fetchLeadsForRevenue } = await import("./leads-client.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

function lead(leadId: string, email: string): Record<string, unknown> {
  return { leadId, email, sent: true, lead: { firstName: "A", lastName: "B", organization: null } };
}

function mockServices(opts: { members: Array<string | null>; leads: Record<string, unknown>[]; clientStatus?: number }): string[] {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push(url);
    if (url.startsWith("http://client:3000/internal/users")) {
      if (opts.clientStatus && opts.clientStatus !== 200) return new Response("boom", { status: opts.clientStatus });
      return Response.json({ users: opts.members.map((email) => ({ email })), total: opts.members.length });
    }
    return Response.json({ leads: opts.leads });
  });
  return seen;
}

describe("memberAddressKey / isMemberAddress (lead-service's fold)", () => {
  it("folds case and a +tag, nothing else", () => {
    expect(memberAddressKey(" Kevin.Lourd+redeliver1014c@Gmail.com ")).toBe("kevin.lourd@gmail.com");
    expect(memberAddressKey("kevin.lourd@gmail.com")).toBe("kevin.lourd@gmail.com");
    expect(memberAddressKey("+tag@gmail.com")).toBeNull();
    expect(memberAddressKey("not-an-address")).toBeNull();
    expect(memberAddressKey(null)).toBeNull();
    const members = new Set(["kevin.lourd@gmail.com"]);
    expect(isMemberAddress("kevin.lourd+pfu1014@gmail.com", members)).toBe(true);
    expect(isMemberAddress("kevin.lourdes@gmail.com", members)).toBe(false);
    expect(isMemberAddress("kevin.lourd@gmail.co", members)).toBe(false);
  });
});

describe("fetchLeadsForRevenue drops the org's own team", () => {
  beforeEach(() => __resetOrgMembersCache());
  afterEach(() => vi.restoreAllMocks());

  it("a member and every +tag variant of a member's address are not leads; everyone else stays", async () => {
    const seen = mockServices({
      members: ["Kevin.Lourd@gmail.com", null],
      leads: [
        lead("team-1", "kevin.lourd+redeliver1014c@gmail.com"),
        lead("team-2", "kevin.lourd@gmail.com"),
        lead("prospect", "kevin.lourdes@gmail.com"),
        lead("other", "ada@acme.com"),
      ],
    });
    const persons = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(persons.map((p) => p.leadId).sort()).toEqual(["other", "prospect"]);
    const membersCall = seen.find((u) => u.startsWith("http://client:3000"));
    expect(membersCall).toContain("orgId=org-1");
    expect(membersCall).toContain("allMembers=true");
  });

  it("client-service unreadable fails the read loud, never 'nobody is a member'", async () => {
    mockServices({ members: [], leads: [lead("x", "ada@acme.com")], clientStatus: 503 });
    await expect(fetchLeadsForRevenue("brand-1", undefined, HEADERS)).rejects.toBeInstanceOf(OrgMembersUnavailableError);
  });

  it("an org with no member keeps every lead", async () => {
    mockServices({ members: [], leads: [lead("x", "ada@acme.com")] });
    expect((await fetchLeadsForRevenue("brand-1", undefined, HEADERS)).map((p) => p.leadId)).toEqual(["x"]);
  });

  it("reads the members once per org within the cache window", async () => {
    const seen = mockServices({ members: ["a@b.com"], leads: [] });
    await Promise.all([loadOrgMemberKeys("org-9"), loadOrgMemberKeys("org-9")]);
    await loadOrgMemberKeys("org-9");
    expect(seen.filter((u) => u.startsWith("http://client:3000")).length).toBe(1);
  });
});
