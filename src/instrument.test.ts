import { afterEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const setTag = vi.fn();
vi.mock("@sentry/node", () => ({ init, setTag }));

describe("instrument (Sentry v11)", () => {
  afterEach(() => {
    vi.resetModules();
    init.mockClear();
    setTag.mockClear();
    delete process.env.SENTRY_DSN;
  });

  it("inits Sentry without the removed sendDefaultPii option when a DSN is set", async () => {
    process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/0";
    await import("./instrument.js");
    expect(init).toHaveBeenCalledTimes(1);
    const opts = init.mock.calls[0][0];
    expect(opts.dsn).toBe("https://key@o0.ingest.sentry.io/0");
    expect(opts.tracesSampleRate).toBe(0.1);
    expect(opts).not.toHaveProperty("sendDefaultPii");
    expect(setTag).toHaveBeenCalledWith("service", "features-service");
  });

  it("does nothing without a DSN", async () => {
    await import("./instrument.js");
    expect(init).not.toHaveBeenCalled();
  });
});
