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
  },
});
