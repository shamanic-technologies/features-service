import { describe, it, expect } from "vitest";
import { featureSlugsParam, runsFeatureSlugsParam } from "./feature-scope.js";
import { SOURCING_ORIGINS_BY_CHANNEL } from "./sourcing-origins.js";

describe("runsFeatureSlugsParam (spend reads count sourcing in both labelling states)", () => {
  it("adds every sourcing origin slug to a scope holding a channel that sources leads", () => {
    expect(runsFeatureSlugsParam("sales-cold-email-outreach").split(",")).toEqual(
      ["sales-cold-email-outreach", ...SOURCING_ORIGINS_BY_CHANNEL["sales-cold-email-outreach"]!].sort(),
    );
    expect(runsFeatureSlugsParam("sales-crm-email-outreach")).toBe("sales-crm-email-outreach,sourcing-crm-contacts");
    expect(runsFeatureSlugsParam(["ai-meeting-booking", "sales-cold-email-outreach"]).split(",")).toContain("sourcing-apollo-cold-filters");
  });

  it("leaves any other scope byte-identical to featureSlugsParam", () => {
    expect(runsFeatureSlugsParam("ai-meeting-booking")).toBe(featureSlugsParam("ai-meeting-booking"));
    expect(runsFeatureSlugsParam(["pr-cold-email-outreach", "ai-meeting-booking"])).toBe(
      featureSlugsParam(["pr-cold-email-outreach", "ai-meeting-booking"]),
    );
  });
});
