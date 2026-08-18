import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { installPackedFixture } from "../helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
let packDirectory: string;
let tarballPath: string;

beforeAll(async () => {
  packDirectory = await mkdtemp(join(tmpdir(), "zedbee-hook-pack-"));
  const packed = await execa(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    {
      cwd: packageRoot,
      env: { npm_config_cache: join(packDirectory, "npm-cache") },
      reject: false,
      stdin: "ignore",
    },
  );
  expect(packed.exitCode).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarballPath = join(packDirectory, metadata[0]!.filename);
}, 30_000);

afterAll(async () => {
  await rm(packDirectory, { recursive: true, force: true });
});

describe("raw pre-commit hook", () => {
  it("allows formatted commits, blocks formatting regressions, and preserves existing hook work", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "package.json",
      JSON.stringify({
        name: "zedbee-hook-fixture",
        version: "1.0.0",
        private: true,
      }),
    );
    await repository.write(".gitignore", "node_modules/\n");
    await installPackedFixture(
      tarballPath,
      packageRoot,
      repository.root,
      join(packDirectory, "install-cache"),
    );
    await repository.write(
      "tsconfig.json",
      '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}\n',
    );
    await repository.write(
      ".zedbeerc.jsonc",
      '{"schemaVersion":1,"profile":"fast"}\n',
    );
    await repository.commitAll("fixture setup");

    const hookPath = join(repository.root, ".git", "hooks", "pre-commit");
    const hook = [
      "#!/bin/sh",
      "printf 'existing hook\\n' >/dev/null",
      "./node_modules/.bin/zedbee scan --format text",
      "",
    ].join("\n");
    await writeFile(hookPath, hook);
    await chmod(hookPath, 0o755);

    await repository.write("formatted.ts", "export const formatted = true;\n");
    await repository.git(["add", "--", "formatted.ts"]);
    const allowed = await repository.git([
      "commit",
      "--message",
      "formatted change",
    ]);
    expect(allowed.exitCode).toBe(0);

    await repository.write("broken.ts", "export const broken={value:true}\n");
    await repository.git(["add", "--", "broken.ts"]);
    const blocked = await repository.git([
      "commit",
      "--message",
      "broken change",
    ]);

    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("THAT STINGS");
    expect(await readFile(hookPath, "utf8")).toContain(
      "printf 'existing hook\\n' >/dev/null",
    );
  }, 60_000);
});
