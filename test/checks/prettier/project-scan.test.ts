import { cp, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { GitClient } from "../../../src/git/client.js";
import {
  readStagedChangeSet,
  type ChangeSet,
} from "../../../src/git/change-set.js";
import { buildSnapshotPair } from "../../../src/git/snapshot.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { prettierAdapter } from "../../../src/checks/prettier/adapter.js";
import { persistProjectPrettierTrust } from "../../../src/checks/prettier/project-trust.js";
import { createGitRepository } from "../../helpers/git-repository.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const repositoryPackageRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("project Prettier scan integration", () => {
  it("uses the project formatter and attributes staged lines", async () => {
    const repository = await createGitRepository("zedbee-project-scan-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    await repository.write("passed.ts", "export const value = 'ok';\n");
    await repository.git([
      "add",
      "--",
      "package.json",
      ".prettierrc.json",
      "passed.ts",
    ]);
    const base = await repository.git([
      "commit",
      "--message",
      "base",
      "--no-verify",
    ]);
    if (base.exitCode !== 0) throw new Error(base.stderr);
    await persistProjectPrettierTrust(repository.root, ".");
    await repository.write("passed.ts", "export const value = 'ok';\n");
    await repository.write("failed.ts", 'export const value = "no";\n');
    await repository.git(["add", "--", "passed.ts", "failed.ts"]);

    const git = new GitClient(repository.root);
    const changeSet: ChangeSet = await readStagedChangeSet(git);
    const snapshots = await buildSnapshotPair(repository.root, git);
    onTestFinished(snapshots.cleanup);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: { engine: "project" } },
    });

    const result = await prettierAdapter.runLegacy({
      repositoryRoot: repository.root,
      changeSet,
      config,
      snapshots,
      baselineInspection: await inspectRepository(snapshots.baselineDir),
      targetInspection: await inspectRepository(snapshots.targetDir),
      target: { id: ".", kind: "repository", relativeRoot: "." },
      policy: config.checks.formatting,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.location)).toEqual([
      { file: "failed.ts", startLine: 1, endLine: 1 },
    ]);
    expect(result.findings[0]?.message).toMatch(/this project's Prettier/u);
  });

  it("reports an incomplete formatting check when trust is missing", async () => {
    const repository = await createGitRepository("zedbee-project-scan-trust-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    await repository.git([
      "add",
      "--",
      "package.json",
      ".prettierrc.json",
    ]);
    const base = await repository.git([
      "commit",
      "--message",
      "base",
      "--no-verify",
    ]);
    if (base.exitCode !== 0) throw new Error(base.stderr);
    await repository.write("failed.ts", 'export const value = "no";\n');
    await repository.git(["add", "--", "failed.ts"]);

    const git = new GitClient(repository.root);
    const changeSet = await readStagedChangeSet(git);
    const snapshots = await buildSnapshotPair(repository.root, git);
    onTestFinished(snapshots.cleanup);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: { engine: "project" } },
    });

    const result = await prettierAdapter.runLegacy({
      repositoryRoot: await realpath(repository.root),
      changeSet,
      config,
      snapshots,
      baselineInspection: await inspectRepository(snapshots.baselineDir),
      targetInspection: await inspectRepository(snapshots.targetDir),
      target: { id: ".", kind: "repository", relativeRoot: "." },
      policy: config.checks.formatting,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("incomplete");
    expect(result).toMatchObject({
      error: { code: "PROJECT_PRETTIER_TRUST_REQUIRED" },
    });
  });
});
