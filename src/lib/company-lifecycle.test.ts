import { describe, expect, it } from "vitest";
import { companyLifecycles } from "./company-lifecycle.js";

describe("companyLifecycles — each organisation's highest rung (DEALS-LIFECYCLE-1021)", () => {
  const persons = [
    { leadId: "l1", orgId: "acme" },
    { leadId: "l2", orgId: "acme" },
    { leadId: "l3", orgId: "globex" },
    { leadId: "l4", orgId: "initech" },
    { leadId: "l5", orgId: null },
  ];

  it("takes the highest rung over the organisation's people and counts each one once", () => {
    const r = companyLifecycles({
      persons,
      rows: [
        { leadIds: ["l1"], rung: "contacted" },
        { leadIds: ["l2"], rung: "meeting_booked" },
        { leadIds: ["l3"], rung: "engaged" },
        { leadIds: ["l5"], rung: "paid_client" }, // no company: its own row, as on the revenue read
        { leadIds: ["zz"], rung: "paid_client" }, // not this scope's lead
      ],
    });
    expect(r.organizations).toEqual([
      { organizationKey: "lead:l5", orgId: null, lifecycle: { key: "paid_client", rank: 7, label: "Paid client" } },
      { organizationKey: "org:acme", orgId: "acme", lifecycle: { key: "meeting_booked", rank: 5, label: "Meeting booked" } },
      { organizationKey: "org:globex", orgId: "globex", lifecycle: { key: "engaged", rank: 3, label: "Engaged" } },
      { organizationKey: "org:initech", orgId: "initech", lifecycle: null },
    ]);
    expect(r.organizationCount).toBe(4);
    expect(r.withoutCompanyCount).toBe(1);
    expect(r.noRungOrganizationCount).toBe(1);
    expect(r.outOfScopeRowCount).toBe(1);
    const counts = Object.fromEntries(r.rungs.map((x) => [x.key, x.organizationCount]));
    expect(counts).toEqual({
      lead_found: 0,
      contacted: 0,
      engaged: 1,
      signup_or_form: 0,
      meeting_booked: 1,
      meeting_attended: 0,
      paid_client: 1,
    });
    expect(r.rungs.find((x) => x.key === "paid_client")?.withoutCompanyCount).toBe(1);
    // The partition is exact.
    expect(r.rungs.reduce((s, x) => s + x.organizationCount, 0) + r.noRungOrganizationCount).toBe(r.organizationCount);
    expect(r.rungs.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a row holding several leads lifts every organisation it touches", () => {
    const r = companyLifecycles({ persons, rows: [{ leadIds: ["l3", "l4"], rung: "signup_or_form" }] });
    expect(r.organizations.filter((o) => o.lifecycle?.key === "signup_or_form").map((o) => o.orgId)).toEqual(["globex", "initech"]);
    expect(r.organizations.find((o) => o.orgId === "acme")?.lifecycle).toBeNull();
    // A company-less lead on no rung is not listed (nothing to show, no company).
    expect(r.organizations.some((o) => o.organizationKey === "lead:l5")).toBe(false);
  });

  it("fails loud on a rung that is not on the ladder", () => {
    expect(() => companyLifecycles({ persons, rows: [{ leadIds: ["l1"], rung: "qualified" }] })).toThrow(/unknown lifecycle rung/);
  });
});
