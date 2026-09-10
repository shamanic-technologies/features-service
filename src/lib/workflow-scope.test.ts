/**
 * WHICH LEADS ARE THIS WORKFLOW'S — the membership rule the `?workflow=` drill-down narrows on,
 * driven from one catalogue fixture with no network in sight.
 */
import { describe, it, expect } from "vitest";
import { buildWorkflowScope, dynastyOfSlug } from "./workflow-scope.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";

const wf = (slug: string, dynasty: string, name: string): WorkflowMetadata => ({
  id: slug, workflowSlug: slug, workflowName: slug, workflowDynastyName: name,
  workflowDynastySlug: dynasty, version: 1, status: "active",
  featureSlug: "sales-cold-email-outreach", createdForBrandId: null, upgradedTo: null,
});

const CATALOGUE = [wf("dawn-v1", "dawn", "Dawn"), wf("dawn-v2", "dawn", "Dawn"), wf("osprey-v1", "osprey", "Osprey")];

describe("buildWorkflowScope", () => {
  // WHAT THE SPEND PRODUCERS ARE ASKED FOR. Prod, 2026-09-10: routing this through the producers'
  // OWN `workflowDynastySlug` lever made runs answer 500 and email-gateway 502 for any dynasty
  // workflow-service does not describe — a RETIRED lineage, i.e. the workflow a "which of these
  // burned money" question is most often about — so the read 502'd instead of answering.
  it("asks the producers for the VERSIONED slugs it resolved itself, never for the dynasty", () => {
    expect(buildWorkflowScope("dawn", CATALOGUE).producerSlugs).toBe("dawn-v1,dawn-v2");
  });

  it("a dynasty the catalogue does not describe asks for ITS OWN slug — a retired lineage still has rows under it", () => {
    expect(buildWorkflowScope("retired-wf", CATALOGUE).producerSlugs).toBe("retired-wf");
  });

  it("folds every VERSION of the dynasty in, and nothing else", () => {
    const scope = buildWorkflowScope("dawn", CATALOGUE);
    expect(scope.workflowSlugs).toEqual(["dawn-v1", "dawn-v2"]);
    expect(scope.workflowDynastyName).toBe("Dawn");
    expect(scope.includes("dawn-v1")).toBe(true);
    expect(scope.includes("dawn-v2")).toBe(true);
    expect(scope.includes("osprey-v1")).toBe(false);
  });

  it("a lead served under NO workflow belongs to no scope", () => {
    const scope = buildWorkflowScope("dawn", CATALOGUE);
    expect(scope.includes(null)).toBe(false);
    expect(scope.includes(undefined)).toBe(false);
    expect(scope.includes("")).toBe(false);
  });

  it("a slug the catalogue does not describe is ITS OWN dynasty of one — so every key the grouped read emits resolves", () => {
    const scope = buildWorkflowScope("retired-wf", CATALOGUE);
    expect(scope.includes("retired-wf")).toBe(true);
    expect(scope.includes("dawn-v1")).toBe(false);
    // Nothing is invented for it: no name, no versions — and it is still a real, answerable scope.
    expect(scope.workflowDynastyName).toBeNull();
    expect(scope.workflowSlugs).toEqual([]);
  });

  it("a dynasty nobody ever ran is an empty membership, never a throw", () => {
    const scope = buildWorkflowScope("never-ran", CATALOGUE);
    expect(scope.workflowSlugs).toEqual([]);
    expect(scope.includes("dawn-v1")).toBe(false);
  });

  it("dynastyOfSlug maps a version to its dynasty and leaves an unknown slug alone", () => {
    const of = dynastyOfSlug(CATALOGUE);
    expect(of("dawn-v2")).toBe("dawn");
    expect(of("mystery-v9")).toBe("mystery-v9");
  });
});
