import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  packDirectory = await mkdtemp(join(tmpdir(), "zedbee-init-pack-"));
  const build = await execa("npm", ["run", "build"], {
    cwd: packageRoot,
    env: { npm_config_cache: join(packDirectory, "npm-cache") },
    reject: false,
    stdin: "ignore",
  });
  expect(build.exitCode, build.stderr).toBe(0);
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
  expect(packed.exitCode, packed.stderr).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarballPath = join(packDirectory, metadata[0]!.filename);
}, 30_000);

afterAll(async () => {
  await rm(packDirectory, { recursive: true, force: true });
});

describe("packaged init command", () => {
  it("preserves a raw hook, creates usable policy, and stays idempotent", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "init-fixture", version: "1.0.0", private: true })}\n`,
    );
    await repository.write(".gitignore", "node_modules/\n");
    await installPackedFixture(
      tarballPath,
      packageRoot,
      repository.root,
      join(packDirectory, "install-cache"),
    );
    const hookPath = join(repository.root, ".git/hooks/pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\nprintf 'existing hook\\n'\nnpm test\n",
    );
    await chmod(hookPath, 0o751);

    const run = () =>
      execa(
        process.execPath,
        [
          join(repository.root, "node_modules/zedbee/dist/cli.js"),
          "init",
          "--profile",
          "thorough",
          "--checks",
          "lint,types",
          "--hook",
          "raw",
          "--yes",
          "--format",
          "json",
          "--no-color",
          "--no-animations",
        ],
        { cwd: repository.root, reject: false, stdin: "ignore" },
      );

    const first = await run();
    const second = await run();
    const hook = await readFile(hookPath, "utf8");
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );

    expect(first.exitCode, first.stderr).toBe(0);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      applied: true,
      files: [".zedbeerc.jsonc", ".git/hooks/pre-commit"],
      proposal: { profile: "thorough", hook: "raw" },
    });
    expect(first.stdout).not.toContain(repository.root);
    expect(config).toContain('"schemaVersion": 1');
    expect(config).toContain('"profile": "thorough"');
    expect(config).toContain('"lint": "error"');
    expect(config).toContain('"types": "error"');
    expect(config).toContain('"formatting": "off"');
    expect(hook).toContain("printf 'existing hook\\n'");
    expect(hook).toContain("npm test");
    expect(hook.match(/zedbee scan/gu) ?? []).toHaveLength(1);
    expect((await stat(hookPath)).mode & 0o777).toBe(0o751);
  }, 60_000);
});
