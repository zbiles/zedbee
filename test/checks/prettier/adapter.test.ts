import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as formatDiff from "../../../src/checks/prettier/format-diff.js";
import { CheckIncompleteError } from "../../../src/checks/incomplete-error.js";
import type { ConfigFile, ResolvedConfig } from "../../../src/config/schema.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { prettierAdapter } from "../../../src/checks/prettier/adapter.js";
import { GitClient } from "../../../src/git/client.js";
import {
  readStagedChangeSet,
  type ChangeSet,
} from "../../../src/git/change-set.js";
import { buildSnapshotPair } from "../../../src/git/snapshot.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import type { RepositoryInspection } from "../../../src/inspection/types.js";
import { createGitRepository } from "../../helpers/git-repository.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

function config(when: "relevant" | "always" = "relevant"): ResolvedConfig {
  return resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    checks: { formatting: { when } },
  });
}

function changeSet(files: ChangeSet["files"]): ChangeSet {
  return {
    files,
    isEmpty: files.size === 0,
    containsAddedLine(file, line) {
      return (
        files
          .get(file.replaceAll("\\", "/"))
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  };
}

async function runAdapter(
  repository: Awaited<ReturnType<typeof createGitRepository>>,
  when: "relevant" | "always" = "relevant",
  resolvedConfig = config(when),
) {
  const git = new GitClient(repository.root);
  const stagedChanges = await readStagedChangeSet(git);
  const snapshots = await buildSnapshotPair(repository.root, git);
  onTestFinished(snapshots.cleanup);
  return prettierAdapter.runLegacy({
    repositoryRoot: repository.root,
    changeSet: stagedChanges,
    config: resolvedConfig,
    snapshots,
    baselineInspection: await inspectRepository(snapshots.baselineDir),
    targetInspection: await inspectRepository(snapshots.targetDir),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: resolvedConfig.checks.formatting,
    policyForFile: testFilePolicyResolver(resolvedConfig),
    signal: new AbortController().signal,
  });
}

function inspection(snapshotRoot = "/tmp/snapshot"): RepositoryInspection {
  return {
    snapshotRoot,
    packageManager: "unknown",
    lockfiles: [],
    workspaces: [
      {
        relativeRoot: ".",
        manifestPath: "package.json",
        sourceFiles: [],
        tsconfigPaths: [],
        environments: ["javascript"],
        dependencyDeclarations: [],
      },
    ],
  };
}

function inspectionContext(changes: ChangeSet, resolvedConfig = config()) {
  return {
    repositoryRoot: "/repo",
    changeSet: changes,
    config: resolvedConfig,
    baselineInspection: inspection("/tmp/baseline"),
    targetInspection: inspection("/tmp/target"),
  };
}

describe("prettierAdapter.inspect", () => {
  it("applies to supported staged target files and ignores deletions", async () => {
    const supported = changeSet(
      new Map([
        [
          "src/value.ts",
          {
            path: "src/value.ts",
            status: "modified" as const,
            addedRanges: [{ start: 1, end: 1 }],
          },
        ],
        [
          "src/removed.tsx",
          {
            path: "src/removed.tsx",
            status: "deleted" as const,
            addedRanges: [],
          },
        ],
      ]),
    );

    await expect(
      prettierAdapter.inspect(inspectionContext(supported)),
    ).resolves.toEqual({
      applies: true,
      executionClass: "lightweight",
      requiresBaseline: false,
      targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
    });

    const onlyDeletion = changeSet(
      new Map([
        [
          "src/removed.tsx",
          {
            path: "src/removed.tsx",
            status: "deleted" as const,
            addedRanges: [],
          },
        ],
      ]),
    );
    await expect(
      prettierAdapter.inspect(inspectionContext(onlyDeletion)),
    ).resolves.toEqual({
      applies: false,
      reason: "No supported changed files",
    });
  });

  it.each([
    "js",
    "jsx",
    "ts",
    "tsx",
    "json",
    "jsonc",
    "css",
    "md",
    "markdown",
    "yml",
    "yaml",
  ])("recognizes .%s files", async (extension) => {
    const file = `file.${extension}`;
    const changes = changeSet(
      new Map([
        [
          file,
          {
            path: file,
            status: "added" as const,
            addedRanges: [{ start: 1, end: 1 }],
          },
        ],
      ]),
    );

    await expect(
      prettierAdapter.inspect(inspectionContext(changes)),
    ).resolves.toMatchObject({
      applies: true,
    });
  });

  it("applies optimistically under always policy", async () => {
    await expect(
      prettierAdapter.inspect(
        inspectionContext(changeSet(new Map()), config("always")),
      ),
    ).resolves.toMatchObject({ applies: true });
  });
});

describe("prettierAdapter.run", () => {
  it("applies singleAttributePerLine to staged JSX", async () => {
    const repository = await createGitRepository();
    await repository.write("component.tsx", "export const existing = true;\n");
    await repository.commitAll("formatted base");
    await repository.write(
      "component.tsx",
      'export const view = <Widget first="1" second="2" />;\n',
    );
    await repository.git(["add", "--", "component.tsx"]);
    const formattingConfig = resolveConfig({
      schemaVersion: 1,
      checks: {
        formatting: { settings: { singleAttributePerLine: true } },
      },
    } as unknown as ConfigFile);

    const result = await runAdapter(repository, "relevant", formattingConfig);

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.location).toEqual({
      file: "component.tsx",
      startLine: 1,
      endLine: 1,
    });
  });

  it("applies target-side formatting settings per staged file override", async () => {
    const repository = await createGitRepository();
    await repository.write("src/value.ts", "export const existing = true\n");
    await repository.write("test/value.ts", "export const existing = true;\n");
    await repository.commitAll("formatted base");
    await repository.write("src/value.ts", 'export const source = "ready";\n');
    await repository.write("test/value.ts", "export const spec = 'ready'\n");
    await repository.git(["add", "--", "src/value.ts", "test/value.ts"]);
    await repository.write("src/value.ts", "export const source = 'ready'\n");
    await repository.write("test/value.ts", "export const spec = 'ready';\n");
    const formattingConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        formatting: { settings: { semi: false, singleQuote: true } },
      },
      overrides: [
        {
          files: ["test/**"],
          checks: { formatting: { settings: { semi: true } } },
        },
      ],
    });

    const result = await runAdapter(repository, "relevant", formattingConfig);

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.location)).toEqual([
      { file: "src/value.ts", startLine: 1, endLine: 1 },
      { file: "test/value.ts", startLine: 1, endLine: 1 },
    ]);
  });

  it("skips staged files whose target-side formatting policy is off", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "generated/value.ts",
      "export const existing = true;\n",
    );
    await repository.commitAll("generated base");
    await repository.write(
      "generated/value.ts",
      "export const generated={value:1}\n",
    );
    await repository.git(["add", "--", "generated/value.ts"]);
    const formattingConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      overrides: [
        {
          files: ["generated/**"],
          checks: { formatting: "off" },
        },
      ],
    });

    const result = await runAdapter(repository, "relevant", formattingConfig);

    expect(result).toMatchObject({ status: "completed", findings: [] });
  });

  it("does not report pre-existing formatting outside staged lines", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "const existing={value:1}\n");
    await repository.commitAll("existing debt");
    await repository.write(
      "value.ts",
      "const existing={value:1}\nexport const added = true;\n",
    );
    await repository.git(["add", "--", "value.ts"]);

    const result = await runAdapter(repository);

    expect(result).toMatchObject({ status: "completed", findings: [] });
  });

  it("reports a formatting transformation that overlaps a staged line", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const existing = true;\n");
    await repository.commitAll("formatted base");
    await repository.write(
      "value.ts",
      "export const existing = true;\nexport const staged={value:1}\n",
    );
    await repository.git(["add", "--", "value.ts"]);

    const result = await runAdapter(repository);

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      check: "formatting",
      rule: "prettier",
      severity: "error",
      remediation:
        "Run zedbee fix formatting, review the working-file changes, and stage the desired result.",
      location: { file: "value.ts", startLine: 2, endLine: 2 },
      attribution: {
        kind: "transformation-diff",
        staged: true,
        evidence: ["Prettier transformation overlaps staged target lines 2-2"],
      },
    });
    expect(result.findings[0]?.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads the staged snapshot when the working tree was formatted later", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const existing = true;\n");
    await repository.commitAll("formatted base");
    await repository.write("value.ts", "export const staged={value:1}\n");
    await repository.git(["add", "--", "value.ts"]);
    await repository.write("value.ts", "export const staged = { value: 1 };\n");

    const result = await runAdapter(repository);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.location?.startLine).toBe(1);
  });

  it("returns a skipped result when always mode finds no supported target files", async () => {
    const repository = await createGitRepository();
    await repository.write("notes.txt", "plain text\n");
    await repository.git(["add", "--", "notes.txt"]);

    const result = await runAdapter(repository, "always");

    expect(result).toMatchObject({
      checkId: "formatting",
      status: "skipped",
      findings: [],
      skipReason: "No supported target files",
    });
  });

  it("sanitizes parser failures as incomplete analysis", async () => {
    const repository = await createGitRepository();
    const invalidSource = '{"secret":"do-not-render",';
    await repository.write("broken.json", invalidSource);
    await repository.git(["add", "--", "broken.json"]);

    const result = await runAdapter(repository);

    expect(result).toMatchObject({
      checkId: "formatting",
      status: "incomplete",
      findings: [],
      error: {
        code: "PRETTIER_FAILED",
        message: "Prettier could not analyze broken.json.",
        path: "broken.json",
        remediation:
          "Fix the parser or file-reading error, then stage the result.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(invalidSource);
    expect(JSON.stringify(result)).not.toContain("do-not-render");
  });

  it("reports comparison timeouts as incomplete rather than passing the file", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const staged={value:1}\n");
    await repository.git(["add", "--", "value.ts"]);
    const compare = vi
      .spyOn(formatDiff, "formattingTransformationRanges")
      .mockRejectedValueOnce(
        new CheckIncompleteError({
          code: "FORMATTING_DIFF_TIMEOUT",
          message: "The formatting comparison exceeded its time limit.",
          remediation: "Format and stage the file, then scan again.",
        }),
      );
    onTestFinished(() => compare.mockRestore());

    const result = await runAdapter(repository);

    expect(result).toMatchObject({
      status: "incomplete",
      findings: [],
      error: {
        code: "FORMATTING_DIFF_TIMEOUT",
        message:
          "The formatting comparison for value.ts exceeded its time limit.",
        path: "value.ts",
      },
    });
  });
});
