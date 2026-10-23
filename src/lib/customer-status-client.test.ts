import { describe, it, expect } from "vitest";
import { parseCustomerStatuses } from "./customer-status-client.js";

describe("parseCustomerStatuses", () => {
  it("keeps billing's verdict and own-org flag per org", () => {
    const m = parseCustomerStatuses({
      customers: [
        { orgId: "a", orgName: "A", customerStatus: "churned", ownOrg: false, ownOrgReason: null, months: [] },
        { orgId: "b", orgName: null, customerStatus: null, ownOrg: true, ownOrgReason: "platform_org" },
      ],
    });
    expect(m.get("a")).toEqual({ orgId: "a", orgName: "A", customerStatus: "churned", ownOrg: false, ownOrgReason: null, orgDeleted: false });
    expect(m.get("b")?.customerStatus).toBeNull();
    expect(m.get("b")?.ownOrg).toBe(true);
  });

  it("fails loud on a verdict it does not know or a missing list", () => {
    expect(() => parseCustomerStatuses({ customers: [{ orgId: "a", customerStatus: "lapsed", ownOrg: false }] })).toThrow(/unknown customerStatus/);
    expect(() => parseCustomerStatuses({})).toThrow(/no customers/);
  });
});
