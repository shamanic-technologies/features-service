import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateRequiredEnv, REQUIRED_ENV } from "../src/lib/env.js";

describe("validateRequiredEnv", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of REQUIRED_ENV) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("throws when required env vars are missing", () => {
    for (const key of REQUIRED_ENV) {
      delete process.env[key];
    }
    expect(() => validateRequiredEnv()).toThrow("Missing required environment variables");
  });

  it("lists all missing vars in the error message", () => {
    for (const key of REQUIRED_ENV) {
      delete process.env[key];
    }
    expect(() => validateRequiredEnv()).toThrow(REQUIRED_ENV.join(", "));
  });

  it("does not throw when all env vars are set", () => {
    for (const key of REQUIRED_ENV) {
      process.env[key] = "test-value";
    }
    expect(() => validateRequiredEnv()).not.toThrow();
  });

  it("treats empty string as missing", () => {
    for (const key of REQUIRED_ENV) {
      process.env[key] = "test-value";
    }
    process.env.RUNS_SERVICE_URL = "";
    expect(() => validateRequiredEnv()).toThrow("RUNS_SERVICE_URL");
  });
});
