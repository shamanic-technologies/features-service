import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithRetry } from "./fetch-retry.js";

/** A `fetch failed` TypeError whose cause carries a transient connect-phase code. */
function transientError(code: string): TypeError {
  return new TypeError("fetch failed", { cause: { code } });
}

/** An AggregateError (Node happy-eyeballs shape) with per-address sub-errors. */
function aggregateTransient(code: string): Error {
  return Object.assign(new Error("fetch failed"), { errors: [{ code }] });
}

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries a transient cause.code rejection then succeeds", async () => {
    vi.useFakeTimers();
    const ok = new Response("ok", { status: 200 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(transientError("ECONNREFUSED"))
      .mockResolvedValueOnce(ok);

    const p = fetchWithRetry("http://sibling/x");
    const a = expect(p).resolves.toBe(ok);
    await vi.runAllTimersAsync();
    await a;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries a transient AggregateError.errors rejection then succeeds", async () => {
    vi.useFakeTimers();
    const ok = new Response("ok", { status: 200 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(aggregateTransient("ETIMEDOUT"))
      .mockResolvedValueOnce(ok);

    const p = fetchWithRetry("http://sibling/x");
    const a = expect(p).resolves.toBe(ok);
    await vi.runAllTimersAsync();
    await a;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-transient rejection immediately without retrying", async () => {
    const boom = new TypeError("fetch failed", { cause: { code: "ERR_INVALID_URL" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(boom);

    await expect(fetchWithRetry("http://sibling/x")).rejects.toBe(boom);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a completed HTTP 5xx response as-is — never retried (server already answered)", async () => {
    const serverError = new Response("server error", { status: 500 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(serverError);

    const res = await fetchWithRetry("http://sibling/x");

    expect(res).toBe(serverError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured retries (1 initial + 3) on persistent transient errors", async () => {
    vi.useFakeTimers();
    const err = transientError("ECONNRESET");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(err);

    const p = fetchWithRetry("http://sibling/x");
    const a = expect(p).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await a;

    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
