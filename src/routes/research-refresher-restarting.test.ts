import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// BOX-OVERLOAD-1026: when the refresher is restarting (an OOM respawn), a Research build waits for it. It used to
// run on the serving process ("computing locally"), holding the dashboard's event loop for minutes.
const { warmResearch, __resetResearch } = await import("./research.js");
const { __setRefresherSupervisedForTest } = await import("../lib/view-refresher.js");

afterEach(() => {
  __setRefresherSupervisedForTest(false);
  delete process.env.VIEW_REFRESHER_PORT;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetResearch();
});

describe("a Research build while the refresher restarts", () => {
  it("is not built on the serving process and is retried on the next ask, not 10 min later", async () => {
    __setRefresherSupervisedForTest(true);
    delete process.env.VIEW_REFRESHER_PORT;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await warmResearch("user", "mature");
    expect(warn.mock.calls.flat().join(" ")).toContain("refresher restarting");
    expect(error).not.toHaveBeenCalled();

    // The refresher announced its port but does not answer yet: still waits, still no failed build.
    process.env.VIEW_REFRESHER_PORT = "65530";
    const fetchMock = vi.fn(async (_url: string) => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    await warmResearch("user", "mature");
    await warmResearch("user", "mature");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/internal/research/compute?basis=user&view=mature");
    expect(error).not.toHaveBeenCalled();
  });
});
