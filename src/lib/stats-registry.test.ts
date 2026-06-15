import { describe, it, expect } from "vitest";
import { requiredStatsSources } from "./stats-registry.js";

describe("requiredStatsSources", () => {
  it("maps raw keys to their sources", () => {
    const { sources } = requiredStatsSources(["recipientsContacted", "leadsServed"]);
    expect([...sources].sort()).toEqual(["email-gateway", "leads"]);
  });

  it("flags needsRunFilter for a runFilter (pipeline) key", () => {
    const { sources, needsRunFilter } = requiredStatsSources(["emailsGenerated"]);
    expect(needsRunFilter).toBe(true);
    expect(sources.has("runs")).toBe(true);
  });

  it("resolves a derived key to the sources of BOTH numerator and denominator", () => {
    // costPerRecipientOpenCents = totalCostInUsdCents (runs) / recipientsOpened (email-gateway)
    const { sources } = requiredStatsSources(["costPerRecipientOpenCents"]);
    expect(sources.has("runs")).toBe(true);
    expect(sources.has("email-gateway")).toBe(true);
  });

  it("ignores unknown keys (chart ids / non-stat props)", () => {
    const { sources, needsRunFilter } = requiredStatsSources(["funnel", "replyBreakdown", "not-a-stat"]);
    expect(sources.size).toBe(0);
    expect(needsRunFilter).toBe(false);
  });

  it("a cold-email feature needs only email-gateway + runs, never outlets/journalists/leads/press-kits", () => {
    const coldEmailKeys = [
      "emailsGenerated",
      "recipientsContacted",
      "recipientsSent",
      "recipientsOpened",
      "recipientOpenRate",
      "costPerRecipientOpenCents",
    ];
    const { sources, needsRunFilter } = requiredStatsSources(coldEmailKeys);
    expect([...sources].sort()).toEqual(["email-gateway", "runs"]);
    expect(needsRunFilter).toBe(true);
    expect(sources.has("outlets")).toBe(false);
    expect(sources.has("journalists")).toBe(false);
    expect(sources.has("leads")).toBe(false);
    expect(sources.has("press-kits")).toBe(false);
    expect(sources.has("ai-visibility")).toBe(false);
  });
});
