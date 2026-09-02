import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Git and package-manager integration work is slower on hosted Windows.
    // Bound concurrency and allow a small timing margin without weakening the
    // tighter defaults used by every other platform.
    ...(process.platform === "win32"
      ? { maxWorkers: 2, testTimeout: 15_000 }
      : {}),
  },
});
