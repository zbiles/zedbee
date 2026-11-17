import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { sourceMoves } from "../../src/checks/source-moves.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import { resolveConfig } from "../../src/config/profiles.js";
import {
  createAnalysisReuseSession,
  withAnalysisReuseSession,
} from "../../src/checks/analysis-reuse.js";
import type { CheckRunContext } from "../../src/checks/adapter.js";

const debt = "export function debt(a) { if (a) return a; return 0; }";
async function context(): Promise<CheckRunContext> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-move-capture-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const baselineDir = join(root, "before"),
    targetDir = join(root, "after");
  for (const dir of [baselineDir, targetDir]) {
    await mkdir(dir);
    await writeFile(
      join(dir, "package.json"),
      '{"name":"fixture","private":true}',
    );
  }
  await writeFile(join(baselineDir, "old.js"), debt);
  await writeFile(join(targetDir, "new.js"), debt);
  // Unsupported unrelated source must never participate in move capture.
  await writeFile(join(baselineDir, "unrelated.js"), "function {");
  await writeFile(join(targetDir, "unrelated.js"), "function {");
  const changeSet = {
    files: new Map([
      [
        "old.js",
        { path: "old.js", status: "deleted" as const, addedRanges: [] },
      ],
      [
        "new.js",
        {
          path: "new.js",
          status: "added" as const,
          addedRanges: [{ start: 1, end: 1 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine: () => true,
  };
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  return {
    repositoryRoot: targetDir,
    config,
    changeSet,
    snapshots: {
      baselineDir,
      targetDir,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baselineDir),
    targetInspection: await inspectRepository(targetDir),
    target: { id: ".", kind: "workspace", relativeRoot: "." },
    policy: config.checks.cyclomaticComplexity,
    policyForFile: createFilePolicyResolver(config, changeSet),
    signal: new AbortController().signal,
  };
}
it("captures only selected sources and reuses the same syntax map for equivalent check policy", async () => {
  const run = await context();
  const session = createAnalysisReuseSession();
  onTestFinished(() => session.close());
  await withAnalysisReuseSession(session, async () => {
    const first = await sourceMoves(run, "cyclomaticComplexity");
    const second = await sourceMoves(run, "cyclomaticComplexity");
    expect(first.pairs).toHaveLength(1);
    expect(second).toBe(first);
    expect(first.diagnostics).toEqual([]);
  });
});
it("missing donor capture cannot supply a baseline exemption", async () => {
  const run = await context();
  await rm(join(run.snapshots.baselineDir, "old.js"));
  const result = await sourceMoves(run, "cyclomaticComplexity");
  expect(result.pairs).toEqual([]);
  expect(result.diagnostics).toEqual(["SOURCE_MOVE_CAPTURE_UNAVAILABLE"]);
});
it("a symlinked donor cannot supply a baseline exemption", async () => {
  const run = await context();
  await rm(join(run.snapshots.baselineDir, "old.js"));
  await writeFile(join(run.snapshots.baselineDir, "real.js"), debt);
  await symlink("real.js", join(run.snapshots.baselineDir, "old.js"));
  const result = await sourceMoves(run, "cyclomaticComplexity");
  expect(result.pairs).toEqual([]);
});
it("cancellation is never converted into a matching fallback", async () => {
  const run = await context();
  const controller = new AbortController();
  controller.abort();
  await expect(
    sourceMoves({ ...run, signal: controller.signal }, "cyclomaticComplexity"),
  ).rejects.toThrow();
});

it("reports an explicit conservative fallback for an oversized changed source", async () => {
  const run = await context();
  await writeFile(
    join(run.snapshots.baselineDir, "old.js"),
    "//" + "a".repeat(512 * 1024),
  );
  const result = await sourceMoves(run, "cyclomaticComplexity");
  expect(result.pairs).toEqual([]);
  expect(result.diagnostics).toEqual(["SOURCE_MOVE_BUDGET_EXCEEDED"]);
});
