import { mkdtemp, rm } from "node:fs/promises";
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

async function runNpm(args: readonly string[], cwd: string) {
  return execa("npm", args, {
    cwd,
    env: { npm_config_cache: join(packDirectory, "npm-cache") },
    reject: false,
    stdin: "ignore",
  });
}

beforeAll(async () => {
  packDirectory = await mkdtemp(join(tmpdir(), "zedbee-pack-"));
  const build = await runNpm(["run", "build"], packageRoot);
  expect(build.exitCode).toBe(0);
  const packed = await runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    packageRoot,
  );
  expect(packed.exitCode).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarballPath = join(packDirectory, metadata[0]!.filename);
}, 30_000);

afterAll(async () => {
  await rm(packDirectory, { recursive: true, force: true });
});

async function createInstalledRepository() {
  const repository = await createGitRepository();
  await repository.write(
    "package.json",
    JSON.stringify({
      name: "zedbee-e2e-fixture",
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
  return repository;
}

async function runZedbee(
  repositoryRoot: string,
  format: "json" | "text" = "json",
  extraArguments: readonly string[] = [],
) {
  return execa(
    process.execPath,
    [
      join(repositoryRoot, "node_modules", "zedbee", "dist", "cli.js"),
      "scan",
      "--format",
      format,
      ...extraArguments,
    ],
    { cwd: repositoryRoot, reject: false, stdin: "ignore" },
  );
}

async function runPackagedCli(
  repositoryRoot: string,
  arguments_: readonly string[],
) {
  return execa(
    process.execPath,
    [
      join(repositoryRoot, "node_modules", "zedbee", "dist", "cli.js"),
      ...arguments_,
    ],
    { cwd: repositoryRoot, reject: false, stdin: "ignore" },
  );
}

describe("packaged Zedbee CLI", () => {
  it("exposes the installed CLI help and command set", async () => {
    const repository = await createInstalledRepository();

    const result = await runPackagedCli(repository.root, ["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: zedbee");
    for (const command of ["init", "scan", "checks", "doctor"]) {
      expect(result.stdout).toContain(command);
    }
  }, 30_000);

  it("runs doctor from the installed package", async () => {
    const repository = await createInstalledRepository();

    const result = await runPackagedCli(repository.root, [
      "doctor",
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 0 });
  }, 30_000);

  it("initializes a raw hook non-interactively from the installed package", async () => {
    const repository = await createInstalledRepository();
    await rm(join(repository.root, ".zedbeerc.jsonc"));

    const result = await runPackagedCli(repository.root, [
      "init",
      "--profile",
      "fast",
      "--hook",
      "raw",
      "--yes",
      "--format",
      "json",
      "--no-color",
      "--no-animations",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ applied: true });
    expect(await repository.read(".zedbeerc.jsonc")).toContain(
      '"profile": "fast"',
    );
    expect(await repository.read(".git/hooks/pre-commit")).toContain(
      "npx --no-install zedbee scan",
    );
  }, 30_000);

  it("rejects conflicting source excerpt overrides before scanning", async () => {
    const repository = await createInstalledRepository();

    const result = await runZedbee(repository.root, "json", [
      "--include-source",
      "--no-source",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/cannot be used with option/i);
    expect(result.stdout).toBe("");
  }, 30_000);

  it("passes formatted staged code and leaves Git state unchanged", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    const before = await repository.git(["status", "--porcelain=v1", "-z"]);

    const result = await runZedbee(repository.root);
    const after = await repository.git(["status", "--porcelain=v1", "-z"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      outcome: "pass",
      exitCode: 0,
      target: "index",
    });
    expect(after.stdout).toBe(before.stdout);
  }, 30_000);

  it("blocks an attributed staged formatting regression", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value={answer:42}\n");
    await repository.git(["add", "--", "value.ts"]);

    const result = await runZedbee(repository.root);
    const report = JSON.parse(result.stdout) as {
      outcome: string;
      checks: Array<{
        checkId: string;
        findings: Array<{ location: { file: string; startLine: number } }>;
      }>;
    };

    expect(result.exitCode).toBe(1);
    expect(report.outcome).toBe("blocked");
    const formatting = report.checks.find(
      ({ checkId }) => checkId === "formatting",
    );
    expect(formatting?.findings[0]?.location).toMatchObject({
      file: "value.ts",
      startLine: 1,
    });
  }, 30_000);

  it("scans the staged regression even after the working tree is formatted", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value={answer:42}\n");
    await repository.git(["add", "--", "value.ts"]);
    await repository.write(
      "value.ts",
      "export const value = { answer: 42 };\n",
    );

    const result = await runZedbee(repository.root);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
    });
  }, 30_000);

  it("does not block pre-existing formatting outside staged lines", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "const existing={answer:42}\n");
    await repository.commitAll("existing formatting debt");
    await repository.write(
      "value.ts",
      "const existing={answer:42}\nexport const added = true;\n",
    );
    await repository.git(["add", "--", "value.ts"]);

    const result = await runZedbee(repository.root);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
    });
  }, 30_000);

  it("returns exit code 2 and valid JSON for malformed configuration", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    await repository.write(".zedbeerc.jsonc", '{"schemaVersion":');

    const result = await runZedbee(repository.root);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      outcome: "incomplete",
      exitCode: 2,
    });
  }, 30_000);
});
