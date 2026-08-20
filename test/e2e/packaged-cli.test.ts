import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { installPackedFixture } from "../helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
let packDirectory: string;
let temporaryReportRoot: string;
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
  [packDirectory, temporaryReportRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), "zedbee-pack-")),
    mkdtemp(join(tmpdir(), "zedbee-pack-reports-")),
  ]);
  temporaryReportRoot = await realpath(temporaryReportRoot);
  const packed = await runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    packageRoot,
  );
  expect(packed.exitCode).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarballPath = join(packDirectory, metadata[0]!.filename);
}, 30_000);

afterAll(async () => {
  await Promise.all([
    rm(packDirectory, { recursive: true, force: true }),
    rm(temporaryReportRoot, { recursive: true, force: true }),
  ]);
  await expect(lstat(temporaryReportRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
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
  format: "json" | "sarif" | "text" = "json",
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
    {
      cwd: repositoryRoot,
      env: {
        TMPDIR: temporaryReportRoot,
        TMP: temporaryReportRoot,
        TEMP: temporaryReportRoot,
      },
      reject: false,
      stdin: "ignore",
    },
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
    {
      cwd: repositoryRoot,
      env: {
        TMPDIR: temporaryReportRoot,
        TMP: temporaryReportRoot,
        TEMP: temporaryReportRoot,
      },
      reject: false,
      stdin: "ignore",
    },
  );
}

async function runAutomaticScan(repositoryRoot: string) {
  return runPackagedCli(repositoryRoot, [
    "scan",
    "--no-color",
    "--no-animations",
  ]);
}

describe("packaged Zedbee CLI", () => {
  it("bounds automatic piped findings and persists the complete JSON report", async () => {
    const repository = await createInstalledRepository();
    for (let index = 1; index <= 26; index += 1) {
      await repository.write(
        `src/value-${index}.ts`,
        `export const value${index}={answer:${index}}\n`,
      );
    }
    await repository.git(["add", "--", "src"]);

    const result = await runAutomaticScan(repository.root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Showing 25 of 26 findings.");
    const reportSection = result.stdout.match(
      /Full report:\s*([\s\S]*?)\nZedbee will remove this report/u,
    );
    expect(reportSection, result.stdout).not.toBeNull();
    const reportLiteral = reportSection?.[1]?.replaceAll(/\s/gu, "");
    const reportPath = JSON.parse(reportLiteral ?? "") as string;
    expect(reportPath).toBeTruthy();
    expect(relative(temporaryReportRoot, reportPath)).not.toMatch(
      /^\.\.(?:[/\\]|$)/u,
    );
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      readonly checks: readonly { readonly findings: readonly unknown[] }[];
    };
    expect(report.checks.flatMap((check) => check.findings)).toHaveLength(26);
    expect(result.stderr).toBe("");
  }, 30_000);

  it("exposes the installed CLI help and command set", async () => {
    const repository = await createInstalledRepository();

    const result = await runPackagedCli(repository.root, ["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: zedbee");
    for (const command of ["init", "scan", "checks", "doctor"]) {
      expect(result.stdout).toContain(command);
    }
  }, 30_000);

  it("lists and accepts SARIF as a packaged scan output format", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);

    const help = await runPackagedCli(repository.root, ["scan", "--help"]);
    const result = await runZedbee(repository.root, "sarif");

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("sarif");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).version).toBe("2.1.0");
    expect(result.stderr).toBe("");
  }, 30_000);

  it("exports every blocked fixture finding as a complete SARIF report", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value={answer:42}\n");
    await repository.git(["add", "--", "value.ts"]);

    const result = await runZedbee(repository.root, "sarif");
    const report = JSON.parse(result.stdout) as {
      readonly version: string;
      readonly runs: readonly [
        {
          readonly results: readonly {
            readonly ruleId: string;
            readonly properties: { readonly checkId: string };
          }[];
          readonly invocations: readonly [
            {
              readonly executionSuccessful: boolean;
              readonly toolExecutionNotifications: readonly unknown[];
              readonly properties: {
                readonly outcome: string;
                readonly exitCode: number;
              };
            },
          ];
        },
      ];
    };

    expect(result.exitCode).toBe(1);
    expect(report.version).toBe("2.1.0");
    expect(report.runs[0].results).toHaveLength(1);
    expect(report.runs[0].results[0]).toMatchObject({
      ruleId: "formatting/prettier",
      properties: { checkId: "formatting" },
    });
    expect(report.runs[0].invocations[0]).toMatchObject({
      executionSuccessful: true,
      toolExecutionNotifications: [],
      properties: { outcome: "blocked", exitCode: 1 },
    });
  }, 30_000);

  it("runs doctor from the installed package", async () => {
    const repository = await createInstalledRepository();

    const result = await runPackagedCli(repository.root, [
      "doctor",
      "--format",
      "json",
    ]);
    const redirected = await runPackagedCli(repository.root, ["doctor"]);
    const help = await runPackagedCli(repository.root, ["doctor", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 0 });
    expect(redirected.exitCode).toBe(0);
    expect(redirected.stdout).toContain("PASS git:");
    expect(redirected.stdout).not.toContain("DOCTOR");
    expect(redirected.stdout).not.toMatch(/\u001b\[/u);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("auto");
    expect(help.stdout).toContain("--no-color");
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

  it("reports incomplete packaged scans in SARIF notifications", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    await repository.write(".zedbeerc.jsonc", '{"schemaVersion":');

    const result = await runZedbee(repository.root, "sarif");
    const report = JSON.parse(result.stdout) as {
      readonly version: string;
      readonly runs: readonly [
        {
          readonly results: readonly unknown[];
          readonly invocations: readonly [
            {
              readonly executionSuccessful: boolean;
              readonly toolExecutionNotifications: readonly {
                readonly descriptor: { readonly id: string };
              }[];
              readonly properties: {
                readonly outcome: string;
                readonly exitCode: number;
              };
            },
          ];
        },
      ];
    };

    expect(result.exitCode).toBe(2);
    expect(report.version).toBe("2.1.0");
    expect(report.runs[0].results).toEqual([]);
    expect(report.runs[0].invocations[0]).toMatchObject({
      executionSuccessful: false,
      properties: { outcome: "incomplete", exitCode: 2 },
    });
    expect(
      report.runs[0].invocations[0].toolExecutionNotifications,
    ).toHaveLength(1);
    expect(
      report.runs[0].invocations[0].toolExecutionNotifications[0]?.descriptor
        .id,
    ).toBe("CONFIG_INVALID");
  }, 30_000);
});
