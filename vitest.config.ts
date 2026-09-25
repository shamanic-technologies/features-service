import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Collect tests from src ONLY. CI runs `pnpm build` (emits dist/*.test.js) before
    // `pnpm test`, and vitest's default glob would otherwise pick up BOTH src and dist —
    // running every suite twice, doubling console output and tripping the vitest
    // worker-teardown race (EnvironmentTeardownError). src is the source of truth.
    include: ["src/**/*.test.ts"],
    // The live lead copy (src/lib/lead-copy.ts) is module state that would carry one test's leads
    // into the next. Route suites mock the whole-population WALK; the copy has its own suites
    // (lead-copy.test.ts, routes/live-lead-copy.test.ts), which switch it on explicitly.
    env: { LEAD_COPY_ENABLED: "false", DOWNSTREAM_READ_SHARE_MS: "0" },
  },
});
