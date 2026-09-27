/**
 * Guards for the brand-transfer half this service owns: the overlap refusal that keeps the stated-amount
 * invariant across a move, and the in-process lead copies of both orgs being dropped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { assertMoveFits } from "./transfer-brand.js";
import { StatedAmountConflictError } from "./stated-monthly-amounts-store.js";
import { dropLeadCopiesForOrgs, readLeadCopy, __leadCopySizes, __resetLeadCopies } from "./lead-copy.js";

describe("assertMoveFits", () => {
  it("lets a move land on an empty target pair", () => {
    expect(() => assertMoveFits([{ id: "a", startDate: "2026-07-01", endDate: null }], [])).not.toThrow();
  });

  it("lets disjoint ranges coexist on the target pair", () => {
    expect(() =>
      assertMoveFits(
        [{ id: "a", startDate: "2026-07-01", endDate: "2026-07-31" }],
        [{ id: "b", startDate: "2026-08-01", endDate: null }],
      ),
    ).not.toThrow();
  });

  it("refuses a move that would put two amounts in force on one day", () => {
    expect(() =>
      assertMoveFits(
        [{ id: "a", startDate: "2026-07-01", endDate: null }],
        [{ id: "b", startDate: "2026-09-01", endDate: null }],
      ),
    ).toThrow(StatedAmountConflictError);
  });

  it("ignores a moving row already resident (a re-run is idempotent)", () => {
    const row = { id: "a", startDate: null, endDate: null };
    expect(() => assertMoveFits([row], [row])).not.toThrow();
  });
});

describe("dropLeadCopiesForOrgs", () => {
  beforeEach(() => __resetLeadCopies());

  it("drops every copy of the named orgs and keeps the others", async () => {
    const answer = async () => ({ cursor: "c1", full: true, leads: [{ id: "l1" }], removed: [] }) as never;
    await readLeadCopy("org-src|/orgs/leads|brand=b", answer);
    await readLeadCopy("org-dst|/orgs/leads|brand=b", answer);
    await readLeadCopy("org-other|/orgs/leads|brand=x", answer);

    expect(dropLeadCopiesForOrgs(["org-src", "org-dst"])).toBe(2);
    expect(Object.keys(__leadCopySizes())).toEqual(["org-other|/orgs/leads|brand=x"]);
  });
});
