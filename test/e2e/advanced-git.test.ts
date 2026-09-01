import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runScan } from "../../src/scan/run-scan.js";
import { GitClient } from "../../src/git/client.js";
import { buildCommitSnapshotPair } from "../../src/git/snapshot.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("advanced staged Git states", () => {
  it("materializes immutable commit sources despite later index and working-tree changes", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    const baselineCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.write("value.ts", "export const value = 2;\n");
    await repository.commitAll("target");
    const targetCommit = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.write("value.ts", "export const value = 3;\n");
    await repository.git(["add", "--", "value.ts"]);
    await repository.write("value.ts", "export const value = 4;\n");
    const beforeIndex = await repository.git(["write-tree"]);

    const pair = await buildCommitSnapshotPair(
      repository.root,
      new GitClient(repository.root),
      baselineCommit,
      targetCommit,
    );
    onTestFinished(pair.cleanup);

    expect(await readFile(join(pair.baselineDir, "value.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
    expect(await readFile(join(pair.targetDir, "value.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    await pair.cleanup();
    expect((await repository.git(["write-tree"])).stdout).toBe(beforeIndex.stdout);
  });

  it("returns incomplete for a staged Git LFS pointer", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.commitAll("base");
    await repository.write(
      "large.dat",
      "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 42\n",
    );
    await repository.git(["add", "--", "large.dat"]);

    const report = await runScan({ repositoryRoot: repository.root });

    expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
  });

  it("returns incomplete for staged binary JavaScript", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.commitAll("base");
    await writeFile(
      join(repository.root, "binary.js"),
      Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x00, 0x78]),
    );
    await repository.git(["add", "--", "binary.js"]);

    const report = await runScan({ repositoryRoot: repository.root });

    expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(report.checks).toMatchObject([
      {
        error: {
          code: "UNSUPPORTED_BINARY_INPUT",
          path: "binary.js",
        },
      },
    ]);
  });

  it("allows an ordinary staged binary asset", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.commitAll("base");
    await writeFile(
      join(repository.root, "asset.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    await repository.git(["add", "--", "asset.png"]);

    const report = await runScan({ repositoryRoot: repository.root });

    expect(report).toMatchObject({ outcome: "pass", exitCode: 0 });
  });

  it("returns incomplete for a staged submodule pointer", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.commitAll("base");
    const head = await repository.git(["rev-parse", "HEAD"]);
    await repository.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head.stdout},vendor/demo`,
    ]);

    const report = await runScan({ repositoryRoot: repository.root });

    expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(report.checks).toMatchObject([
      {
        error: {
          code: "GIT_SUBMODULE_UNAVAILABLE",
          path: "vendor/demo",
        },
      },
    ]);
  });

  it("scans and commits exactly the staged file when another path is intent-to-add", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.write(
      ".zedbeerc.jsonc",
      '{"schemaVersion":1,"profile":"fast"}\n',
    );
    await repository.commitAll("base");
    await repository.write("staged.txt", "staged\n");
    await repository.write("future.ts", "export const future = true;\n");
    await repository.git(["add", "--", "staged.txt"]);
    await repository.git(["add", "--intent-to-add", "--", "future.ts"]);

    const report = await runScan({ repositoryRoot: repository.root });
    const commit = await repository.git(["commit", "--message", "staged only"]);
    const committedPaths = await repository.git([
      "ls-tree",
      "--name-only",
      "HEAD",
      "--",
      "staged.txt",
      "future.ts",
    ]);

    expect(report).toMatchObject({ outcome: "pass", exitCode: 0 });
    expect(commit.exitCode).toBe(0);
    expect(committedPaths.stdout).toBe("staged.txt");
  });

  it.runIf(process.platform !== "win32")(
    "never follows a staged symbolic link outside the snapshot",
    async () => {
      const repository = await createGitRepository();
      await repository.write("package.json", '{"name":"fixture"}\n');
      await repository.commitAll("base");
      const external = await mkdtemp(join(tmpdir(), "zedbee-external-link-"));
      const externalFile = join(external, "outside.ts");
      await writeFile(externalFile, "export const outside = 'sensitive';\n");
      await symlink(externalFile, join(repository.root, "outside.ts"));
      await repository.git(["add", "--", "outside.ts"]);

      const report = await runScan({ repositoryRoot: repository.root });

      expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
      expect(JSON.stringify(report)).not.toContain("sensitive");
    },
  );
});
