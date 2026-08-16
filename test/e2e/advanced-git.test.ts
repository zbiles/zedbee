import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("advanced staged Git states", () => {
  it.each(["git-lfs-pointer", "intent-to-add"] as const)(
    "returns incomplete for %s content that cannot be analyzed exactly",
    async (kind) => {
      const repository = await createGitRepository();
      await repository.write("package.json", '{"name":"fixture"}\n');
      await repository.commitAll("base");
      if (kind === "git-lfs-pointer") {
        await repository.write(
          "large.dat",
          "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 42\n",
        );
        await repository.git(["add", "--", "large.dat"]);
      } else {
        await repository.write("future.ts", "export const future = true;\n");
        await repository.git(["add", "--intent-to-add", "--", "future.ts"]);
      }

      const report = await runScan({ repositoryRoot: repository.root });

      expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    },
  );

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
