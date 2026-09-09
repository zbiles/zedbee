import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getCurrentTest } from "@vitest/runner";
import { Ajv } from "ajv";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { copyGitRepository } from "../helpers/git-repository.js";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
let packDirectory: string;
let temporaryReportRoot: string;
let tarballPath: string;
let tarballFiles: readonly string[];
let installedNodeModules: string;
let installedRepositoryTemplate: string;

function cancellationOptions(
  signal = getCurrentTest()?.context.signal,
): Readonly<{
  cancelSignal?: AbortSignal;
  killDescendants: false;
}> {
  return signal === undefined
    ? { killDescendants: false }
    : { cancelSignal: signal, killDescendants: false };
}

async function runNpm(
  args: readonly string[],
  cwd: string,
  cancelSignal?: AbortSignal,
) {
  return execa("npm", args, {
    cwd,
    env: { npm_config_cache: join(packDirectory, "npm-cache") },
    reject: false,
    stdin: "ignore",
    ...cancellationOptions(cancelSignal),
  });
}

beforeAll(async () => {
  const hookSignal = new AbortController().signal;
  [packDirectory, temporaryReportRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), "zedbee-pack-")),
    mkdtemp(join(tmpdir(), "zr-")),
  ]);
  temporaryReportRoot = await realpath(temporaryReportRoot);
  const shared = sharedPackedTarball();
  if (shared === null) {
    const packed = await runNpm(
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        packDirectory,
      ],
      packageRoot,
      hookSignal,
    );
    expect(packed.exitCode).toBe(0);
    const metadata = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    tarballPath = join(packDirectory, metadata[0]!.filename);
    tarballFiles = metadata[0]!.files.map(({ path }) => path).sort();
  } else {
    tarballPath = shared.path;
    tarballFiles = shared.files;
  }
  const installRoot = join(packDirectory, "installed-fixture");
  await mkdir(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    '{"name":"zedbee-shared-e2e-install","private":true}\n',
  );
  await installPackedFixture(
    tarballPath,
    packageRoot,
    installRoot,
    join(packDirectory, "install-cache"),
    { cancelSignal: hookSignal },
  );
  installedNodeModules = await realpath(join(installRoot, "node_modules"));

  installedRepositoryTemplate = join(packDirectory, "repository-template");
  await cp(inject("sharedGitTemplate"), installedRepositoryTemplate, {
    recursive: true,
  });
  await Promise.all([
    writeFile(
      join(installedRepositoryTemplate, "package.json"),
      JSON.stringify({
        name: "zedbee-e2e-fixture",
        version: "1.0.0",
        private: true,
      }),
    ),
    writeFile(
      join(installedRepositoryTemplate, ".gitignore"),
      "node_modules\n",
    ),
    writeFile(
      join(installedRepositoryTemplate, "tsconfig.json"),
      '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}\n',
    ),
    writeFile(
      join(installedRepositoryTemplate, ".zedbeerc.jsonc"),
      '{"schemaVersion":1,"profile":"fast"}\n',
    ),
  ]);
  await execa("git", ["add", "--all"], {
    cwd: installedRepositoryTemplate,
    stdin: "ignore",
  });
  await execa("git", ["commit", "--message", "fixture setup"], {
    cwd: installedRepositoryTemplate,
    stdin: "ignore",
  });
});

afterAll(async () => {
  if (installedNodeModules !== undefined) {
    const stopped = await execa(
      process.execPath,
      [
        join(installedNodeModules, "zedbee", "dist", "cli.js"),
        "service",
        "stop",
        "--format",
        "json",
      ],
      {
        env: {
          TMPDIR: temporaryReportRoot,
          TMP: temporaryReportRoot,
          TEMP: temporaryReportRoot,
          NODE_OPTIONS: "",
          NODE_PATH: "",
        },
        reject: false,
        stdin: "ignore",
      },
    );
    expect(stopped.exitCode, stopped.stderr).toBe(0);
  }
  await Promise.all([
    rm(packDirectory, { recursive: true, force: true }),
    rm(temporaryReportRoot, { recursive: true, force: true }),
  ]);
  await expect(lstat(temporaryReportRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

async function createInstalledRepository() {
  const repository = await copyGitRepository(installedRepositoryTemplate);
  await symlink(
    installedNodeModules,
    join(repository.root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
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
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
        TMPDIR: temporaryReportRoot,
        TMP: temporaryReportRoot,
        TEMP: temporaryReportRoot,
      },
      reject: false,
      stdin: "ignore",
      ...cancellationOptions(),
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
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
        TMPDIR: temporaryReportRoot,
        TMP: temporaryReportRoot,
        TEMP: temporaryReportRoot,
      },
      reject: false,
      stdin: "ignore",
      ...cancellationOptions(),
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

async function temporaryJsonReports(
  directory = temporaryReportRoot,
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const reports = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return temporaryJsonReports(path);
      return entry.isFile() &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u.test(
          entry.name,
        )
        ? [path]
        : [];
    }),
  );
  return reports.flat().sort();
}

describe("packaged Zedbee CLI", () => {
  it("runs captured Knip from the installed package through the default service on repeat scans", async () => {
    const repository = await createInstalledRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        checks: Object.fromEntries(
          [
            "formatting",
            "lint",
            "types",
            "cyclomaticComplexity",
            "readabilityComplexity",
            "structuralSecurity",
            "secrets",
            "duplication",
            "dependencyArchitecture",
            "deadCode",
            "reactCorrectness",
            "reactAccessibility",
            "vulnerabilities",
          ].map((id) => [id, id === "deadCode" ? "error" : "off"]),
        ),
      }),
    );
    await repository.write(
      "package.json",
      JSON.stringify({
        name: "knip-packaged-fixture",
        private: true,
        main: "src/index.ts",
      }),
    );
    await repository.write(
      "src/index.ts",
      'import { used } from "./lib.js";\nconsole.log(used);\n',
    );
    await repository.write("src/lib.ts", "export const used = 1;\n");
    await repository.commitAll("captured Knip baseline");
    await repository.write(
      "src/lib.ts",
      "export const used = 1;\nexport const unused = 2;\n",
    );
    await repository.git(["add", "--", "src/lib.ts"]);
    const findings = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runZedbee(repository.root);
      expect(result.exitCode, result.stderr || result.stdout).toBe(1);
      const report = JSON.parse(result.stdout) as {
        checks: Array<{
          checkId: string;
          findings: Array<{ location?: { file: string } }>;
        }>;
      };
      const knip = report.checks.find(({ checkId }) => checkId === "deadCode");
      expect(knip?.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            location: expect.objectContaining({ file: "src/lib.ts" }),
          }),
        ]),
      );
      findings.push(knip!.findings);
    }
    expect(findings[1]).toEqual(findings[0]);
    for (const entry of [
      "knip-worker.js",
      "executor.js",
      "resolver.wasm",
      "resolver.LICENSE",
      "resolver.provenance.json",
    ]) {
      expect(tarballFiles).toContain(`dist/checks/dead-code/${entry}`);
    }
  });

  it("ships runnable analyzer entries and every engine adapter outside the source repository", async () => {
    for (const entry of ["worker", "supervisor", "bootstrap", "windows-job"]) {
      expect(tarballFiles).toContain(`dist/checks/runner/${entry}.js`);
    }
    const installedRoot = await realpath(join(installedNodeModules, "zedbee"));
    expect(relative(packageRoot, installedRoot)).toMatch(/^\.\./u);
    await expect(lstat(join(installedRoot, "src"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(join(installedNodeModules, "tsx")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    // The path comes from the installed package, never a source-tree import.
    const registry = pathToFileURL(
      join(installedRoot, "dist/checks/runner/registry.js"),
    );
    const result = await execa(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      const { loadAnalyzerAdapter } = await import(${JSON.stringify(registry.href)});
      const ids = ["formatting", "lint", "types", "cyclomaticComplexity", "readabilityComplexity", "structuralSecurity", "secrets", "duplication", "dependencyArchitecture", "deadCode", "reactCorrectness", "reactAccessibility", "vulnerabilities"];
      console.log(JSON.stringify(await Promise.all(ids.map(async id => (await loadAnalyzerAdapter(id)).id))));
    `,
      ],
      {
        cwd: packDirectory,
        env: { NODE_OPTIONS: undefined, NODE_PATH: undefined },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual([
      "formatting",
      "lint",
      "types",
      "cyclomaticComplexity",
      "readabilityComplexity",
      "structuralSecurity",
      "secrets",
      "duplication",
      "dependencyArchitecture",
      "deadCode",
      "reactCorrectness",
      "reactAccessibility",
      "vulnerabilities",
    ]);
    expect(result.stderr).toBe("");
  });

  it("provides installed help and safe scan diagnostics without a runtime TypeScript loader", async () => {
    const repository = await createInstalledRepository();
    const help = await runPackagedCli(repository.root, ["scan", "--help"]);
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain("--diagnostics");
    expect(help.stdout).toContain("--no-service");
    const sourceMarker = "privateInstalledWorkerSourceMarker";
    await repository.write(
      "value.ts",
      `export const ${sourceMarker}={answer:42}\n`,
    );
    await repository.git(["add", "--", "value.ts"]);
    const result = await runZedbee(repository.root, "json", ["--diagnostics"]);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
    });
    expect(result.stderr).toContain("ZEDBEE DIAGNOSTICS");
    expect(result.stderr).not.toContain(sourceMarker);
    expect(result.stderr).not.toContain(repository.root);
    expect(result.stderr).not.toContain(packageRoot);
  });

  it("ships the public managed-fix guide without private planning artifacts", () => {
    expect(tarballFiles).toContain("docs/managed-fixes.md");
    expect(tarballFiles).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:^|\/)\.superpowers(?:\/|$)/u),
        expect.stringMatching(/(?:^|\/)(?:plan|spec)s?(?:\/|\.|$)/iu),
      ]),
    );
  });

  it("scans committed branch findings in base mode from the packed CLI", async () => {
    const repository = await createInstalledRepository();
    const baseline = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.write("src/branch.ts", "export const branch={value:1}\n");
    await repository.commitAll("committed branch finding");
    const target = (await repository.git(["rev-parse", "HEAD"])).stdout;
    const beforeTree = (await repository.git(["write-tree"])).stdout;
    const beforeStatus = (
      await repository.git(["status", "--porcelain=v1", "-z"])
    ).stdout;

    const result = await runPackagedCli(repository.root, [
      "scan",
      "--base",
      baseline,
      "--format",
      "json",
    ]);
    const report = JSON.parse(result.stdout) as {
      mode: string;
      baseline: string | null;
      target: string | null;
      requestedBase?: string;
      changedFileCount: number | null;
      outcome: string;
      exitCode: number;
      checks: Array<{
        checkId: string;
        findings: Array<{ location?: { file: string } }>;
      }>;
    };

    expect(result.exitCode, result.stderr).toBe(1);
    expect(report).toMatchObject({
      mode: "base",
      baseline,
      target,
      requestedBase: baseline,
      changedFileCount: 1,
      outcome: "blocked",
      exitCode: 1,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "formatting",
          findings: expect.arrayContaining([
            expect.objectContaining({
              location: expect.objectContaining({ file: "src/branch.ts" }),
            }),
          ]),
        }),
      ]),
    );
    expect((await repository.git(["write-tree"])).stdout).toBe(beforeTree);
    expect(
      (await repository.git(["status", "--porcelain=v1", "-z"])).stdout,
    ).toBe(beforeStatus);
  });

  it("previews and applies exact plus whole-file fixes without changing the index or writing a report", async () => {
    const repository = await createInstalledRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      `${JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        checks: {
          formatting: "error",
          lint: {
            severity: "error",
            rules: { "no-extra-semi": "error" },
          },
          reactCorrectness: "off",
        },
      })}\n`,
    );
    await repository.commitAll("managed fix policy");
    const staged = "export const value = 1;;\n";
    const working = `${staged}const unstaged={value:2}\n`;
    await repository.write("src/value.js", staged);
    await repository.git(["add", "--", "src/value.js"]);
    await repository.write("src/value.js", working);
    await repository.write("notes.txt", "unrelated unstaged work\n");
    const beforeTree = (await repository.git(["write-tree"])).stdout;
    const beforeIndex = (await repository.git(["show", ":src/value.js"]))
      .stdout;
    const reportsBefore = await temporaryJsonReports();

    const preview = await runPackagedCli(repository.root, [
      "fix",
      "--format",
      "json",
    ]);
    const previewJson = JSON.parse(preview.stdout) as {
      applied: boolean;
      schemaVersion: number;
      target: string;
      selectedChecks: string[];
      items: Array<{ checkId: string; scope: string }>;
    };

    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(previewJson).toMatchObject({
      applied: false,
      schemaVersion: 1,
      target: "index",
      selectedChecks: ["formatting", "lint", "reactCorrectness"],
    });
    expect(previewJson.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "lint", scope: "finding" }),
        expect.objectContaining({
          checkId: "formatting",
          scope: "working-file",
        }),
      ]),
    );
    expect(await repository.read("src/value.js")).toBe(working);
    expect(await temporaryJsonReports()).toEqual(reportsBefore);

    const applied = await runPackagedCli(repository.root, [
      "fix",
      "--yes",
      "--format",
      "json",
    ]);
    const appliedJson = JSON.parse(applied.stdout) as {
      applied: boolean;
      schemaVersion: number;
      result: {
        exitCode: number;
        appliedFixes: number;
        changedFiles: string[];
        issues: unknown[];
      };
    };

    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(appliedJson).toMatchObject({
      applied: true,
      schemaVersion: 1,
      result: {
        exitCode: 0,
        appliedFixes: 2,
        changedFiles: ["src/value.js"],
        issues: [],
      },
    });
    expect(await repository.read("src/value.js")).toBe(
      "export const value = 1;\nconst unstaged = { value: 2 };\n",
    );
    expect(await repository.read("notes.txt")).toBe(
      "unrelated unstaged work\n",
    );
    expect((await repository.git(["write-tree"])).stdout).toBe(beforeTree);
    expect((await repository.git(["show", ":src/value.js"])).stdout).toBe(
      beforeIndex,
    );
    expect(await temporaryJsonReports()).toEqual(reportsBefore);
    for (const privateField of [
      "baseSource",
      "replacement",
      "sha256",
      staged.trim(),
      working.trim(),
    ]) {
      expect(applied.stdout).not.toContain(privateField);
    }
  });

  it("preserves partial progress when an unstaged exact edit overlaps", async () => {
    const repository = await createInstalledRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      `${JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        checks: {
          formatting: "off",
          lint: {
            severity: "error",
            rules: { "no-extra-semi": "error" },
          },
          reactCorrectness: "off",
        },
      })}\n`,
    );
    await repository.commitAll("managed lint policy");
    const conflictStaged = "export const conflict = 1;;\n";
    const conflictWorking = "export const conflict = 1;\n";
    const safeStaged = "export const safe = 1;;\n";
    await repository.write("src/conflict.js", conflictStaged);
    await repository.write("src/safe.js", safeStaged);
    await repository.git(["add", "--", "src/conflict.js", "src/safe.js"]);
    await repository.write("src/conflict.js", conflictWorking);
    const beforeTree = (await repository.git(["write-tree"])).stdout;
    const reportsBefore = await temporaryJsonReports();

    const result = await runPackagedCli(repository.root, [
      "fix",
      "lint",
      "--yes",
      "--format",
      "json",
    ]);
    const output = JSON.parse(result.stdout) as {
      applied: boolean;
      result: {
        exitCode: number;
        changedFiles: string[];
        unchangedFiles: string[];
        issues: Array<{
          kind: string;
          file: string;
          message: string;
          remediation: string;
        }>;
      };
    };

    expect(result.exitCode, result.stderr).toBe(1);
    expect(output).toMatchObject({
      applied: true,
      result: {
        exitCode: 1,
        changedFiles: ["src/safe.js"],
        unchangedFiles: ["src/conflict.js"],
        issues: [
          {
            kind: "conflict",
            file: "src/conflict.js",
            message: expect.stringMatching(/overlap/i),
            remediation: expect.stringMatching(/resolve/i),
          },
        ],
      },
    });
    expect(await repository.read("src/conflict.js")).toBe(conflictWorking);
    expect(await repository.read("src/safe.js")).toBe(
      "export const safe = 1;\n",
    );
    expect((await repository.git(["write-tree"])).stdout).toBe(beforeTree);
    expect(await temporaryJsonReports()).toEqual(reportsBefore);
  });

  it("rejects an unsupported managed-fix selector from the installed package", async () => {
    const repository = await createInstalledRepository();

    const result = await runPackagedCli(repository.root, [
      "fix",
      "reactAccessibility",
      "--yes",
      "--format",
      "json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/allowed choices|invalid argument/i);
  });

  it("runs through the executable npm bin launcher", async () => {
    const repository = await createInstalledRepository();
    const launcher = join(
      repository.root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "zedbee.cmd" : "zedbee",
    );

    const result = await execa(launcher, ["--help"], {
      cwd: repository.root,
      reject: false,
      stdin: "ignore",
      ...cancellationOptions(),
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: zedbee");
  });

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
      /COMPLETE REPORT\n([\s\S]*?)\n\n/u,
    );
    expect(reportSection, result.stdout).not.toBeNull();
    expect(result.stdout.match(/COMPLETE REPORT/gu)).toHaveLength(2);
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
  });

  it("persists a successful zero-finding automatic report with blank guidance", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);

    const result = await runAutomaticScan(repository.root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMIT ALLOWED");
    expect(result.stdout).not.toContain("AGENT GUIDANCE");
    expect(result.stdout).not.toContain("AGENT NEXT STEP");
    expect(result.stdout.match(/COMPLETE REPORT/gu)).toHaveLength(2);
    const reportSection = result.stdout.match(
      /COMPLETE REPORT\n([\s\S]*?)\n\n/u,
    );
    expect(reportSection, result.stdout).not.toBeNull();
    const reportPath = JSON.parse(
      reportSection?.[1]?.replaceAll(/\s/gu, "") ?? "",
    ) as string;
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      readonly checks: readonly { readonly findings: readonly unknown[] }[];
    };
    expect(report.checks.flatMap((check) => check.findings)).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("exposes the installed CLI help and command set", async () => {
    const repository = await createInstalledRepository();

    const result = await runPackagedCli(repository.root, ["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: zedbee");
    for (const command of [
      "init",
      "scan",
      "fix",
      "checks",
      "doctor",
      "service",
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("runs the experimental reusable API outside the source tree and exits after close", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    const result = await execa(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createLocalAnalyzerExecutor, runScan } from "zedbee";
      const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
      try {
        const report = await runScan({ repositoryRoot: process.cwd(), executor, cache: false });
        console.log(JSON.stringify({ outcome: report.outcome, incomplete: report.summary.incomplete }));
      } finally { await executor.close(); }
    `,
      ],
      {
        cwd: repository.root,
        env: {
          NODE_OPTIONS: "",
          NODE_PATH: "",
          TMPDIR: temporaryReportRoot,
          TMP: temporaryReportRoot,
          TEMP: temporaryReportRoot,
        },
        reject: false,
        stdin: "ignore",
        ...cancellationOptions(),
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      outcome: "pass",
      incomplete: 0,
    });
  });

  it("ships customization schema and effective check metadata", async () => {
    const repository = await createInstalledRepository();
    const config = {
      $schema: "./node_modules/zedbee/schema/zedbee.schema.json",
      schemaVersion: 1,
      profile: "fast",
      checks: {
        formatting: {
          severity: "error",
          settings: {
            printWidth: 100,
            singleAttributePerLine: true,
            singleQuote: true,
          },
        },
        lint: { rules: { "no-console": "warn" } },
        cyclomaticComplexity: { max: 12, blockWorsening: false },
        duplication: {
          threshold: 3,
          settings: { minLines: 8, minTokens: 70, mode: "strict" },
        },
      },
      overrides: [
        {
          files: ["src/**/*.ts"],
          checks: {
            formatting: { settings: { printWidth: 88 } },
            lint: { rules: { "no-console": "off" } },
          },
        },
      ],
    } as const;
    await repository.write(".zedbeerc.jsonc", `${JSON.stringify(config)}\n`);
    await repository.git(["add", "--", ".zedbeerc.jsonc"]);

    const shippedSchema = JSON.parse(
      await repository.read("node_modules/zedbee/schema/zedbee.schema.json"),
    );
    const validate = new Ajv({
      allErrors: true,
      strictTuples: false,
    }).compile(shippedSchema);
    expect(validate(config), validate.errors?.map(String).join("\n")).toBe(
      true,
    );

    const result = await runPackagedCli(repository.root, [
      "checks",
      "--format",
      "json",
    ]);
    expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
    const output = JSON.parse(result.stdout) as {
      checks: Array<{
        id: string;
        configuration: {
          customized: boolean;
          values: Record<
            string,
            { value: unknown; source: string; customized: boolean }
          >;
          overrides: Array<{
            files: string[];
            values: Record<string, unknown>;
          }>;
        };
      }>;
    };
    const check = (id: string) =>
      output.checks.find((candidate) => candidate.id === id)?.configuration;

    expect(check("formatting")).toMatchObject({
      customized: true,
      values: {
        "settings.printWidth": {
          value: 100,
          source: "repository",
          customized: true,
        },
        "settings.singleQuote": {
          value: true,
          source: "repository",
          customized: true,
        },
        "settings.singleAttributePerLine": {
          value: true,
          source: "repository",
          customized: true,
        },
      },
      overrides: [
        {
          files: ["src/**/*.ts"],
          values: { "settings.printWidth": 88 },
        },
      ],
    });
    expect(check("lint")).toMatchObject({
      customized: true,
      values: {
        "rules.no-console": {
          value: "warn",
          source: "repository",
          customized: true,
        },
      },
      overrides: [
        {
          files: ["src/**/*.ts"],
          values: { "rules.no-console": "off" },
        },
      ],
    });
    expect(check("cyclomaticComplexity")).toMatchObject({
      customized: true,
      values: {
        max: { value: 12, source: "repository", customized: true },
        blockWorsening: {
          value: false,
          source: "repository",
          customized: true,
        },
      },
    });
    expect(check("duplication")).toMatchObject({
      customized: true,
      values: {
        threshold: { value: 3, source: "repository", customized: true },
        "settings.minLines": {
          value: 8,
          source: "repository",
          customized: true,
        },
        "settings.minTokens": {
          value: 70,
          source: "repository",
          customized: true,
        },
        "settings.mode": {
          value: "strict",
          source: "repository",
          customized: true,
        },
      },
    });
  });

  // Keep independent CLI invocations separate so failures identify the command.
  it("lists SARIF in the packaged scan help", async () => {
    const repository = await createInstalledRepository();
    const help = await runPackagedCli(repository.root, ["scan", "--help"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("sarif");
  });

  it.each(["sarif", "text"] as const)(
    "accepts explicit %s output from the packaged scan without writing a report",
    async (format) => {
      const repository = await createInstalledRepository();
      await repository.write("value.ts", "export const value = 1;\n");
      await repository.git(["add", "--", "value.ts"]);

      const reportsBefore = await temporaryJsonReports();
      const result = await runZedbee(repository.root, format);
      const reportsAfter = await temporaryJsonReports();

      expect(result.exitCode).toBe(0);
      if (format === "sarif") {
        expect(JSON.parse(result.stdout).version).toBe("2.1.0");
      } else {
        expect(result.stdout).toContain("BEE-UTIFUL");
      }
      expect(result.stderr).toBe("");
      expect(reportsAfter).toEqual(reportsBefore);
    },
  );

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
  });

  // Separate cases identify failures in JSON, redirected text, and help.
  it("runs doctor as JSON from the installed package", async () => {
    const repository = await createInstalledRepository();

    const result = await runPackagedCli(repository.root, [
      "doctor",
      "--format",
      "json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 0 });
  });

  it("renders redirected doctor output as plain text from the installed package", async () => {
    const repository = await createInstalledRepository();
    const redirected = await runPackagedCli(repository.root, ["doctor"]);

    expect(redirected.exitCode, redirected.stderr).toBe(0);
    expect(redirected.stdout).toContain("PASS git:");
    expect(redirected.stdout).not.toContain("DOCTOR");
    expect(redirected.stdout).not.toMatch(/\u001b\[/u);
  });

  it("shows doctor help from the installed package", async () => {
    const repository = await createInstalledRepository();
    const help = await runPackagedCli(repository.root, ["doctor", "--help"]);

    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain("auto");
    expect(help.stdout).toContain("--no-color");
  });

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
    expect(result.stdout).not.toContain("\u001b[?1000h");
    expect(result.stdout).not.toContain("\u001b[?1006h");
    expect(result.stdout).not.toContain("\u001b[?1006l");
    expect(result.stdout).not.toContain("\u001b[?1000l");
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ applied: true });
    expect(await repository.read(".zedbeerc.jsonc")).toContain(
      '"profile": "fast"',
    );
    expect(await repository.read(".git/hooks/pre-commit")).toContain(
      "npx --no-install zedbee scan",
    );
  });

  it("rejects conflicting source excerpt overrides before scanning", async () => {
    const repository = await createInstalledRepository();

    const result = await runZedbee(repository.root, "json", [
      "--include-source",
      "--no-source",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/cannot be used with option/i);
    expect(result.stdout).toBe("");
  });

  it("passes formatted staged code and leaves Git state unchanged", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    const before = await repository.git(["status", "--porcelain=v1", "-z"]);

    const reportsBefore = await temporaryJsonReports();
    const result = await runZedbee(repository.root);
    const reportsAfter = await temporaryJsonReports();
    const after = await repository.git(["status", "--porcelain=v1", "-z"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      outcome: "pass",
      exitCode: 0,
      target: "index",
    });
    expect(after.stdout).toBe(before.stdout);
    expect(reportsAfter).toEqual(reportsBefore);
  });

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
  });

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
  });

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
  });

  it("reports incomplete packaged scans in SARIF notifications", async () => {
    const repository = await createInstalledRepository();
    await repository.write("value.ts", "export const value = 1;\n");
    await repository.git(["add", "--", "value.ts"]);
    await repository.write(".zedbeerc.jsonc", '{"schemaVersion":');
    await repository.git(["add", "--", ".zedbeerc.jsonc"]);

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
  });
});
