/**
 * TEST FIXTURE — a leg-assignment map that answers `active` for EVERY dynasty, for suites that test
 * the leg-keyed ORDERS and FIGURES rather than the assignment itself. A suite that does test
 * assignments (`routes/leg-assignment-grain.test.ts`) builds its own map.
 */
import type { LegAssignmentRow } from "./workflow-leg-assignments.js";

export function everyWorkflowActive(): Map<string, LegAssignmentRow> {
  return new (class extends Map<string, LegAssignmentRow> {
    override get(slug: string): LegAssignmentRow {
      return {
        featureSlug: "fixture",
        legKey: "fixture",
        workflowDynastySlug: slug,
        state: "active",
        decidedBy: "fixture",
        decidedAt: "2026-09-27T00:00:00.000Z",
        note: null,
      };
    }
    override has(): boolean {
      return true;
    }
  })();
}
