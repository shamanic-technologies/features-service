import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const cells = vi.hoisted(() => new Map<string, { text: string; computedAt: number }>());
vi.mock("../lib/fleet-cell-store.js", () => ({
  loadFleetCell: async (key: string) => cells.get(key) ?? null,
  claimFleetCellBuild: async () => true,
  storeFleetCell: async (key: string, text: string, computedAt: number) => void cells.set(key, { text, computedAt }),
}));

import { __resetLegWriterRanking, readLegWriterRanking, warmLegWriterRankingOnBoot } from "./leg-writer-ranking.js";

describe("leg writer ranking boot step (MON-BOOT-SPIKE-1112: start from the stored copy, skip while fresh)", () => {
  it("a stored copy younger than 15 min is installed and skipped: nothing rebuilt, reads serve it at once", async () => {
    __resetLegWriterRanking();
    const payload = { featureSlug: "threads-post", legKey: "start_to_threads_post_published", computedAt: "stored", writerEvidence: "measured" };
    cells.set("leg-writer-ranking:threads-post|start_to_threads_post_published", { text: JSON.stringify(payload), computedAt: Date.now() - 60_000 });
    expect(await warmLegWriterRankingOnBoot("threads-post", "start_to_threads_post_published")).toBe("skipped");
    const served = await readLegWriterRanking("threads-post", "start_to_threads_post_published", 1);
    expect(served?.computedAt).toBe("stored");
  });

  it("the boot sequence holds every delayed boot warm: no fleet rebuild fires on its own timer after listen", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const steps = index.slice(index.indexOf("async function bootWarmSteps("), index.indexOf("function warmFleetPositiveRepliersOnBoot("));
    expect(steps).toContain("warmLegWriterRankingOnBoot(");
    expect(steps).toContain("warmCustomerHealthOnBoot()");
    const listen = index.slice(index.indexOf('app.listen(Number(PORT), "::"'), index.indexOf("export default app"));
    expect(listen).not.toContain("setTimeout(");
    expect(listen).not.toContain("warmEveryLegWriterRanking");
    expect(listen).not.toContain("readCustomerHealthText");
  });
});
