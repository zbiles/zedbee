import { describe, expect, it } from "vitest";
import type { CheckResult } from "../../src/core/types.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { readStagedChangeSet } from "../../src/git/change-set.js";
import { GitClient } from "../../src/git/client.js";
import { buildSnapshotPair } from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderText } from "../../src/renderers/text.js";
import { runScan, type RunScanDependencies } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

function lintResult(): CheckResult {
  return {
    checkId: "lint",
    status: "completed",
    durationMs: 1,
    findings: [
      {
        id: "lint:src/value.ts:4",
        check: "lint",
        rule: "no-debugger",
        severity: "error",
        message: "Remove debugger.",
        location: { file: "src/value.ts", startLine: 4 },
        attribution: {
          kind: "range-overlap",
          staged: true,
          evidence: ["src/value.ts:4"],
        },
      },
    ],
  };
}

describe("partially staged reporting", () => {
  it("attaches source only from the staged target snapshot", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "src/value.ts",
      "one\ntwo\nthree\nexport const version = 'BASELINE';\n",
    );
    await repository.commitAll("baseline");
    await repository.write(
      "src/value.ts",
      "one\ntwo\nthree\nexport const version = 'STAGED-ONLY';\n",
    );
    await repository.git(["add", "--", "src/value.ts"]);
    await repository.write(
      "src/value.ts",
      "one\ntwo\nthree\nexport const version = 'WORKTREE-ONLY';\n",
    );

    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: "error" },
      reporting: { sourceExcerpts: "always" },
    });
    const git = new GitClient(repository.root);
    let tick = 0;
    const dependencies: RunScanDependencies = {
      loadConfig: async () => config,
      createGitClient: () => git,
      readChangeSet: readStagedChangeSet,
      buildSnapshots: buildSnapshotPair,
      inspectRepository,
      baselineForEmptyChange: async () => "HEAD",
      dispatch: async () => [
        {
          result: lintResult(),
          policy: Object.freeze({ ...config.checks.lint }),
        },
      ],
      evaluate: evaluatePolicy,
      adapters: [],
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      clock: () => tick++,
    };

    const report = await runScan({
      repositoryRoot: repository.root,
      reportingSurface: "json",
      dependencies,
    });

    expect(report.checks[0]?.findings[0]?.sourceExcerpt).toEqual({
      line: 4,
      text: "export const version = 'STAGED-ONLY';",
      redacted: false,
      truncated: false,
    });
    expect(JSON.stringify(report)).not.toMatch(/BASELINE|WORKTREE-ONLY/);
  });

  it("redacts every report surface when lint overlaps a staged secret finding", async () => {
    const stagedSecret = "RECOGNIZABLE-STAGED-SECRET-9f4c";
    const repository = await createGitRepository();
    await repository.write(
      "src/value.ts",
      "one\ntwo\nthree\nexport const token = 'BASELINE';\n",
    );
    await repository.commitAll("baseline");
    await repository.write(
      "src/value.ts",
      `one\ntwo\nthree\nexport const token = '${stagedSecret}';\n`,
    );
    await repository.git(["add", "--", "src/value.ts"]);
    await repository.write(
      "src/value.ts",
      "one\ntwo\nthree\nexport const token = 'WORKTREE-ONLY';\n",
    );

    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: "error", secrets: "error" },
      reporting: { sourceExcerpts: "always" },
    });
    const git = new GitClient(repository.root);
    const secretResult: CheckResult = {
      checkId: "secrets",
      status: "completed",
      durationMs: 1,
      findings: [
        {
          ...lintResult().findings[0]!,
          id: "secrets:src/value.ts:4",
          check: "secrets",
          rule: "generic-api-key",
          message: "A secret was detected.",
        },
      ],
    };
    let tick = 0;
    const dependencies: RunScanDependencies = {
      loadConfig: async () => config,
      createGitClient: () => git,
      readChangeSet: readStagedChangeSet,
      buildSnapshots: buildSnapshotPair,
      inspectRepository,
      baselineForEmptyChange: async () => "HEAD",
      dispatch: async () => [
        {
          result: lintResult(),
          policy: Object.freeze({ ...config.checks.lint }),
        },
        {
          result: secretResult,
          policy: Object.freeze({ ...config.checks.secrets }),
        },
      ],
      evaluate: evaluatePolicy,
      adapters: [],
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      clock: () => tick++,
    };

    const report = await runScan({
      repositoryRoot: repository.root,
      reportingSurface: "json",
      dependencies,
    });
    const lintExcerpt = report.checks.find(({ checkId }) => checkId === "lint")
      ?.findings[0]?.sourceExcerpt;

    expect(lintExcerpt).toEqual({
      line: 4,
      redacted: true,
      truncated: false,
    });
    expect(report.summary.findings).toHaveLength(2);
    for (const surface of [
      JSON.stringify(report),
      renderJson(report),
      renderText(report, { width: 120, color: false }),
    ]) {
      expect(surface).not.toContain(stagedSecret);
      expect(surface).not.toContain("BASELINE");
      expect(surface).not.toContain("WORKTREE-ONLY");
    }
  });
});
