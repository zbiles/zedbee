import { expect, it } from "vitest";
import { runCompleteCli } from "../../bench/cli-harness.mjs";

it("measures natural process exit and rejects failed CLI invocations", async () => {
  const result = await runCompleteCli({
    repositoryRoot: process.cwd(),
    args: ["scan", "--help"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--no-service");
  expect(result.durationMs).toBeGreaterThan(0);
  await expect(
    runCompleteCli({
      repositoryRoot: process.cwd(),
      args: ["missing-command"],
    }),
  ).rejects.toThrow("CLI command failed");
});
