import { mkdir, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SecretLintCoreResult } from "@secretlint/types";
import { compareObservationSets } from "../../../src/attribution/compare.js";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { createSecretsAdapter } from "../../../src/checks/secrets/adapter.js";
import { SECRET_LINT_CONFIG } from "../../../src/checks/secrets/config.js";
import { MAX_SECRET_FILE_BYTES } from "../../../src/checks/secrets/content.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

async function context(
  files: readonly ChangedFile[],
): Promise<CheckRunContext> {
  const [baseline, target, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, target, live]) {
    await fixture.writeJson("package.json", { name: "fixture" });
    await mkdir(`${fixture.root}/src`, { recursive: true });
  }
  const changeSet: ChangeSet = {
    files: new Map(files.map((file) => [file.path, file])),
    isEmpty: files.length === 0,
    containsAddedLine: (path, line) =>
      files
        .find((file) => file.path === path)
        ?.addedRanges.some(
          (range) => line >= range.start && line <= range.end,
        ) ?? false,
  };
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  return {
    repositoryRoot: live.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: target.root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(target.root),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.secrets,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

function result(filePath: string, sourceContent: string): SecretLintCoreResult {
  return {
    filePath,
    sourceContent,
    sourceContentType: "text",
    messages: [
      {
        type: "message",
        ruleId: "@secretlint/secretlint-rule-github",
        ruleParentId: "@secretlint/secretlint-rule-preset-recommend",
        message: "masked",
        messageId: "GITHUB_TOKEN",
        range: [0, sourceContent.length],
        loc: {
          start: { line: 1, column: 0 },
          end: { line: 1, column: sourceContent.length },
        },
        severity: "error",
      },
    ],
  };
}

describe("secretsAdapter", () => {
  it("uses selected-target wording when there are no changed files", async () => {
    const run = await context([]);

    await expect(createSecretsAdapter().inspect(run)).resolves.toMatchObject({
      applies: false,
      reason: "No changed target files to scan",
    });
  });

  it("passes Zedbee's preset directly to lintSource and scans only changed pairs", async () => {
    const run = await context([
      {
        path: "src/changed.txt",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
      { path: "src/deleted.txt", status: "deleted", addedRanges: [] },
    ]);
    await writeFile(
      `${run.snapshots.baselineDir}/src/changed.txt`,
      "old-token",
    );
    await writeFile(`${run.snapshots.targetDir}/src/changed.txt`, "new-token");
    await writeFile(
      `${run.snapshots.baselineDir}/src/deleted.txt`,
      "deleted-token",
    );
    const calls: Array<{
      filePath: string;
      config: unknown;
      maskSecrets: boolean | undefined;
    }> = [];
    const adapter = createSecretsAdapter({
      lintSource: async ({ source, options }) => {
        calls.push({
          filePath: source.filePath,
          config: options.config,
          maskSecrets: options.maskSecrets,
        });
        return result(source.filePath, source.content);
      },
      comparisonKey: () => new Uint8Array(32).fill(1),
    });

    const collected = await adapter.collect(run);
    expect(calls).toHaveLength(2);
    expect(calls.every(({ config }) => config === SECRET_LINT_CONFIG)).toBe(
      true,
    );
    expect(calls.every(({ maskSecrets }) => maskSecrets === true)).toBe(true);
    expect(calls.map(({ filePath }) => filePath)).toEqual([
      "src/changed.txt",
      "src/changed.txt",
    ]);
    expect(JSON.stringify(collected)).not.toMatch(
      /old-token|new-token|deleted-token/,
    );
  });

  it("uses the previous path for a rename baseline and the staged path for identity", async () => {
    const run = await context([
      {
        path: "src/new-name.txt",
        previousPath: "src/old-name.txt",
        status: "renamed",
        addedRanges: [],
      },
    ]);
    await writeFile(
      `${run.snapshots.baselineDir}/src/old-name.txt`,
      "same-token",
    );
    await writeFile(
      `${run.snapshots.targetDir}/src/new-name.txt`,
      "same-token",
    );
    const adapter = createSecretsAdapter({
      lintSource: async ({ source }) => result(source.filePath, source.content),
      comparisonKey: () => new Uint8Array(32).fill(2),
    });
    const collected = await adapter.collect(run);
    expect(collected.baselineObservations[0]?.location?.file).toBe(
      "src/old-name.txt",
    );
    expect(collected.targetObservations[0]?.location?.file).toBe(
      "src/new-name.txt",
    );
    expect(collected.baselineObservations[0]?.comparisonIdentity).toBe(
      collected.targetObservations[0]?.comparisonIdentity,
    );
    const findings = compareObservationSets(
      collected.baselineObservations,
      collected.targetObservations,
      {
        changedPaths: ["src/new-name.txt"],
        changedEntityIdentities: [],
        repositoryDelta: true,
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.attribution.staged).toBe(false);
  });

  it("attributes a replacement secret at the same location to the staged change", async () => {
    const run = await context([
      {
        path: "src/secret.txt",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    await writeFile(
      `${run.snapshots.baselineDir}/src/secret.txt`,
      "old-secret",
    );
    await writeFile(`${run.snapshots.targetDir}/src/secret.txt`, "new-secret");
    const adapter = createSecretsAdapter({
      lintSource: async ({ source }) => result(source.filePath, source.content),
      comparisonKey: () => new Uint8Array(32).fill(3),
    });

    const collected = await adapter.collect(run);
    const findings = compareObservationSets(
      collected.baselineObservations,
      collected.targetObservations,
      {
        changedPaths: ["src/secret.txt"],
        changedEntityIdentities: [],
        repositoryDelta: true,
        addedRanges: [{ file: "src/secret.txt", start: 1, end: 1 }],
      },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.attribution).toMatchObject({
      kind: "range-overlap",
      staged: true,
    });
  });

  it("does not report a secret removed by a staged deletion", async () => {
    const run = await context([
      { path: "src/deleted.txt", status: "deleted", addedRanges: [] },
    ]);
    await writeFile(
      `${run.snapshots.baselineDir}/src/deleted.txt`,
      "deleted-secret",
    );
    const adapter = createSecretsAdapter({
      lintSource: async () => {
        throw new Error("deleted files must not be linted");
      },
      comparisonKey: () => new Uint8Array(32),
    });

    await expect(adapter.collect(run)).resolves.toMatchObject({
      baselineObservations: [],
      targetObservations: [],
    });
  });

  it("skips binary files and fails safely for invalid UTF-8 and over-limit text", async () => {
    const binaryRun = await context([
      {
        path: "asset.bin",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    await writeFile(
      `${binaryRun.snapshots.targetDir}/asset.bin`,
      Buffer.from([0, 1, 2, 3]),
    );
    const lintSource = async (): Promise<SecretLintCoreResult> => {
      throw new Error("binary should not be linted");
    };
    await expect(
      createSecretsAdapter({
        lintSource,
        comparisonKey: () => new Uint8Array(32),
      }).collect(binaryRun),
    ).resolves.toMatchObject({ targetObservations: [] });

    const invalidRun = await context([
      {
        path: "invalid.txt",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    await writeFile(
      `${invalidRun.snapshots.targetDir}/invalid.txt`,
      Buffer.from([0xc3, 0x28]),
    );
    const invalidFailure = await createSecretsAdapter({
      lintSource,
      comparisonKey: () => new Uint8Array(32),
    })
      .collect(invalidRun)
      .catch((error: unknown) => error);
    expect(invalidFailure).toMatchObject({
      code: "SECRET_FILE_INVALID_UTF8",
      path: "invalid.txt",
      remediation: expect.stringContaining("valid UTF-8"),
    });
    expect(JSON.stringify(invalidFailure)).not.toMatch(/staged|Git index/iu);

    const largeRun = await context([
      {
        path: "large.txt",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    await writeFile(
      `${largeRun.snapshots.targetDir}/large.txt`,
      "x".repeat(MAX_SECRET_FILE_BYTES + 1),
    );
    await expect(
      createSecretsAdapter({
        lintSource,
        comparisonKey: () => new Uint8Array(32),
      }).collect(largeRun),
    ).rejects.toMatchObject({
      code: "SECRET_FILE_TOO_LARGE",
      path: "large.txt",
      remediation: expect.stringContaining("1 MiB"),
    });
  });

  it("fails safely when a required baseline file is missing or a target is a symlink", async () => {
    const missingBaselineRun = await context([
      {
        path: "src/value.txt",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    await writeFile(
      `${missingBaselineRun.snapshots.targetDir}/src/value.txt`,
      "value",
    );
    const lintSource = async (): Promise<SecretLintCoreResult> => {
      throw new Error("unsafe input should not be linted");
    };
    await expect(
      createSecretsAdapter({
        lintSource,
        comparisonKey: () => new Uint8Array(32),
      }).collect(missingBaselineRun),
    ).rejects.toMatchObject({
      code: "SECRET_FILE_UNSAFE",
      path: "src/value.txt",
    });

    const symlinkRun = await context([
      {
        path: "src/link.txt",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    await symlink(
      "../package.json",
      `${symlinkRun.snapshots.targetDir}/src/link.txt`,
    );
    const symlinkFailure = await createSecretsAdapter({
      lintSource,
      comparisonKey: () => new Uint8Array(32),
    })
      .collect(symlinkRun)
      .catch((error: unknown) => error);
    expect(symlinkFailure).toMatchObject({
      code: "SECRET_FILE_UNSAFE",
      path: "src/link.txt",
    });
    expect(JSON.stringify(symlinkFailure)).not.toMatch(/staged|Git index/iu);
  });

  it("turns unknown analyzer failures into one safe incomplete error", async () => {
    const run = await context([
      {
        path: "src/secret.txt",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    await writeFile(`${run.snapshots.targetDir}/src/secret.txt`, "secret");
    const adapter = createSecretsAdapter({
      lintSource: async () => {
        throw new Error("private analyzer output");
      },
      comparisonKey: () => new Uint8Array(32),
    });
    const error = await adapter.collect(run).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "SECRETLINT_ANALYSIS_FAILED",
      message: "Secret analysis could not be completed safely.",
    });
    expect(JSON.stringify(error)).not.toContain("private analyzer output");
  });
});
