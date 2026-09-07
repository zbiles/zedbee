import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["test/global-setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Deadlines belong to the whole run (scripts/run-with-deadline.mjs locally, the
    // Actions job in CI), not individual tests or setup/cleanup hooks.
    testTimeout: 0,
    hookTimeout: 0,
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
  },
});
