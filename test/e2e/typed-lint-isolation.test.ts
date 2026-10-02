import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const root = resolve(import.meta.dirname, "../..");

it("runs staged and committed typed lint with a different consumer TypeScript version", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-typed-lint-isolation-"));
  const web = join(scratch, "web");
  try {
    await mkdir(web);
    const npmOptions = {
      cwd: web,
      stdin: "ignore" as const,
      env: { npm_config_cache: join(scratch, "npm-cache") },
    };
    const pack = async (directory: string) => {
      const packed = await execa(
        "npm",
        [
          "pack",
          directory,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          scratch,
        ],
        npmOptions,
      );
      return join(scratch, JSON.parse(packed.stdout)[0].filename as string);
    };
    const tarball = sharedPackedTarball()?.path ?? (await pack(root));
    const olderTypescript = await pack(
      join(root, "node_modules/typescript-5-9-3"),
    );
    await writeFile(
      join(web, "package.json"),
      JSON.stringify({
        name: "typed-lint-consumer",
        private: true,
        devDependencies: {
          typescript: `file:${olderTypescript}`,
          "typescript-eslint": "8.67.0",
        },
      }),
    );
    await installPackedFixture(
      tarball,
      root,
      web,
      join(scratch, "install-cache"),
      { reuseSharedInstall: false },
    );
    const tsc = await execa(
      "npm",
      ["exec", "--offline", "--", "tsc", "--version"],
      npmOptions,
    );
    expect(tsc.stdout).toBe("Version 5.9.3");
    await writeFile(join(scratch, ".gitignore"), "node_modules/\n");
    await writeFile(
      join(web, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    );
    await writeFile(join(web, "value.ts"), "export const value: number = 1;\n");
    const git = (args: string[]) => execa("git", args, { cwd: scratch });
    await git(["init", "--quiet"]);
    await git(["add", "."]);
    const commit = () =>
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ]);
    await commit();
    await writeFile(
      join(web, "value.ts"),
      'export const value: number = JSON.parse("2");\n',
    );
    await git(["add", "web/value.ts"]);
    const cli = join(web, "node_modules/zedbee/dist/cli.js");
    const scan = async (args: string[]) => {
      const result = await execa(
        process.execPath,
        [
          cli,
          "scan",
          ...args,
          "--no-service",
          "--format",
          "json",
          "--no-source",
        ],
        { cwd: scratch, reject: false },
      );
      const report = JSON.parse(result.stdout);
      expect(report.exitCode, result.stdout).toBe(1);
      const lint = report.checks.find(
        (check: { checkId: string }) => check.checkId === "lint",
      );
      expect(lint, JSON.stringify(lint)).toBeDefined();
      expect(lint.status, JSON.stringify(lint.error)).not.toBe("incomplete");
      expect(lint.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "@typescript-eslint/no-unsafe-assignment",
          }),
        ]),
      );
    };
    await scan([]);
    await commit();
    await scan(["--base", "HEAD~1"]);
    const manifest = JSON.parse(
      await readFile(join(web, "node_modules/typescript/package.json"), "utf8"),
    );
    expect(manifest.version).toBe("5.9.3");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
