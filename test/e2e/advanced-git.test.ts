import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("advanced staged Git states", () => {
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
