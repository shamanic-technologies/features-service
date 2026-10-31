import { describe, expect, it } from "vitest";
import { withLiveTemplateStatus } from "./live-template-status.js";
import type { CatalogTemplate, CatalogTemplateVersion } from "./catalog.js";
import type { TemplateDynasty } from "./template-dynasties.js";

const roi = { value: 2, display: "2.00x", basis: "measured" as const, source: "own_outcomes" as const, spendCovered: null, unavailableReason: null };
const figs = { rank: 1, rankBasis: "cost_per_outcome" as const, emails: "100", emailsNoun: "emails", outcomes: "3", spend: "$30", cost: "$10.00", rate: "3.0%", thin: false, sample: "3 positive replies · 100 emails", charts: [] };
const version = (key: string, head: boolean): CatalogTemplateVersion => ({ key, label: key, head, hasText: true, status: head ? "active" : "deprecated", roi: roi.display, roiDetail: roi, ...figs });

// The stored build (up to 15 min old): Client Rep Pitch active, head v7.
const built: CatalogTemplate = {
  key: "cold-reply-client-rep-pitch-blind",
  label: "Client Rep Pitch",
  hasText: true,
  dynasty: { slug: "cold-reply-client-rep-pitch-blind", name: "Client Rep Pitch", description: "", signature: null, identity: "blind", head: { key: "blind-discovery-email-v7", label: "v7" } },
  standaloneReason: null,
  status: "active",
  statusSource: "content_generation",
  statusUnavailableReason: null,
  roi: roi.display,
  roiDetail: roi,
  versions: [version("blind-discovery-email-v6", false), version("blind-discovery-email-v7", true)],
  workflows: [],
  runs: [],
  postFigures: null,
  ...figs,
};
const live = (over: Partial<TemplateDynasty>): TemplateDynasty => ({
  slug: "cold-reply-client-rep-pitch-blind",
  name: "Client Rep Pitch",
  description: "",
  signature: null,
  identity: "blind",
  head: "blind-discovery-email-v7",
  versions: ["blind-discovery-email-v6", "blind-discovery-email-v7"],
  status: "active",
  statusSource: "content_generation",
  versionStatuses: { "blind-discovery-email-v6": "deprecated", "blind-discovery-email-v7": "active" },
  ...over,
});

describe("withLiveTemplateStatus (TPL-STATUS-LIVE-1023)", () => {
  it("a template deprecated on content-generation reads deprecated over a stale active build", () => {
    const [row] = withLiveTemplateStatus([built], [live({ status: "deprecated", versionStatuses: { "blind-discovery-email-v6": "deprecated", "blind-discovery-email-v7": "deprecated" } })]);
    expect(row!.status).toBe("deprecated");
    expect(row!.statusSource).toBe("content_generation");
    expect(row!.versions.map((v) => v.status)).toEqual(["deprecated", "deprecated"]);
    // Figures stay the build's.
    expect(row!.spend).toBe("$30");
    expect(row!.versions[1]!.spend).toBe("$30");
  });

  it("reactivated reads active again", () => {
    const deprecatedBuild = { ...built, status: "deprecated" as const };
    expect(withLiveTemplateStatus([deprecatedBuild], [live({})])[0]!.status).toBe("active");
  });

  it("an upgrade moves the head and lists the new version with no figure", () => {
    const [row] = withLiveTemplateStatus([built], [
      live({
        head: "blind-discovery-email-v8",
        versions: ["blind-discovery-email-v6", "blind-discovery-email-v7", "blind-discovery-email-v8"],
        versionStatuses: { "blind-discovery-email-v6": "deprecated", "blind-discovery-email-v7": "deprecated", "blind-discovery-email-v8": "active" },
      }),
    ]);
    expect(row!.dynasty!.head!.key).toBe("blind-discovery-email-v8");
    expect(row!.versions.map((v) => [v.key, v.head, v.status])).toEqual([
      ["blind-discovery-email-v6", false, "deprecated"],
      ["blind-discovery-email-v7", false, "deprecated"],
      ["blind-discovery-email-v8", true, "active"],
    ]);
    const v8 = row!.versions[2]!;
    expect([v8.emails, v8.outcomes, v8.spend, v8.cost, v8.rank, v8.sample]).toEqual(["0", "0", "$0.00", null, null, "0 positive replies · 0 emails"]);
    expect(v8.roiDetail.basis).toBe("expected");
  });

  it("an unreadable read, or a dynasty no longer listed, keeps the build's rows", () => {
    expect(withLiveTemplateStatus([built], "template_dynasties_unreadable")).toEqual([built]);
    expect(withLiveTemplateStatus([built], null)).toEqual([built]);
    expect(withLiveTemplateStatus([built], [live({ slug: "other" })])).toEqual([built]);
  });
});
