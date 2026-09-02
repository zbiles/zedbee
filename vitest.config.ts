import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Packed-install tests extract hundreds of files. Running several of them
    // at once overwhelms GitHub's Windows disk and causes unrelated tests to
    // miss their time limits. Serial files keep the same coverage without the
    // artificial resource contention.
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
  },
});
