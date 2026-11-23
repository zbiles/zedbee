import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createSeparateCompilerWorkspaces } from "../helpers/separate-compiler-workspaces.js";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

async function installFixture(root: string, consumer: string, scratch: string) {
  let tarball = sharedPackedTarball()?.path;
  if (tarball === undefined) {
    const result = await execa(
      "npm",
      [
        "pack",
        root,
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        scratch,
      ],
      { env: { npm_config_cache: join(scratch, "pack-cache") } },
    );
    tarball = join(scratch, JSON.parse(result.stdout)[0].filename);
  }
  await installPackedFixture(tarball, root, consumer, join(scratch, "cache"));
}

it("renders contextual and source-free diagnostics from the installed package", async () => {
  const repo = await createGitRepository("zedbee-diagnostic-package-");
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-diagnostic-pack-"));
  const root = resolve(import.meta.dirname, "../..");
  try {
    await repo.write(
      "package.json",
      JSON.stringify({ name: "consumer", type: "module", private: true }),
    );
    await repo.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          types: [],
          module: "ESNext",
          moduleResolution: "bundler",
        },
        include: ["src/**/*.ts"],
      }),
    );
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
        ),
      }),
    );
    await repo.write("src/account.ts", "export const existing = 1;\n");
    await repo.write("src/index.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    await installFixture(root, repo.root, scratch);
    await repo.write(
      "src/index.ts",
      'import { MissingAccount } from "./account";\nexport const current = MissingAccount;\n',
    );
    await repo.git(["add", "src/index.ts"]);
    const cli = join(repo.root, "node_modules/zedbee/dist/cli.js");
    const invoke = (format: string, policy: string) =>
      execa(
        process.execPath,
        [
          cli,
          "scan",
          "--format",
          format,
          "--no-service",
          "--no-source",
          "--diagnostic-messages",
          policy,
        ],
        {
          cwd: repo.root,
          reject: false,
          env: { ZEDBEE_TELEMETRY_DISABLED: "1" },
        },
      );
    const detailed = await invoke("json", "contextual");
    expect(detailed.exitCode, detailed.stderr).toBe(1);
    expect(
      JSON.parse(detailed.stdout).checks.flatMap(
        (check: { findings: unknown[] }) => check.findings,
      ),
    ).toContainEqual(
      expect.objectContaining({
        rule: "typescript/TS2305",
        message: expect.stringContaining("MissingAccount"),
      }),
    );
    const strict = await invoke("json", "source-free");
    expect(strict.exitCode, strict.stderr).toBe(1);
    expect(strict.stdout).not.toContain("MissingAccount");
    const text = await invoke("text", "contextual");
    expect(text.exitCode, text.stderr).toBe(1);
    expect(text.stdout).toContain("MissingAccount");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it("prints both local installation problems from a piped automatic merge hook", async () => {
  const repo = await createSeparateCompilerWorkspaces();
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-incomplete-merge-"));
  const root = resolve(import.meta.dirname, "../..");
  try {
    const requireGit = async (args: readonly string[]) => {
      const result = await repo.git(args);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    await requireGit(["branch", "incoming"]);
    await repo.write(
      "extension/src/index.ts",
      'export { value } from "fixture-package";\nexport const extensionChange = 1;\n',
    );
    await repo.commitAll("change extension");
    const firstParent = await requireGit(["rev-parse", "HEAD"]);
    await requireGit(["checkout", "incoming"]);
    await repo.write(
      "e2e/src/index.ts",
      'export { value } from "fixture-package";\nexport const testsChange = 1;\n',
    );
    await repo.commitAll("change e2e");
    await requireGit(["checkout", "--detach", firstParent]);

    await installFixture(root, join(repo.root, "web"), scratch);
    const cli = join(repo.root, "web/node_modules/zedbee/dist/cli.js");
    const hookPath = await requireGit(["rev-parse", "--git-path", "hooks"]);
    await repo.write(
      join(hookPath, "pre-merge-commit"),
      '#!/bin/sh\nexec "$TEST_NODE" "$TEST_CLI" scan --merge --hook-invocation --no-service --no-color --no-animations\n',
    );
    const { chmod } = await import("node:fs/promises");
    await chmod(resolve(repo.root, hookPath, "pre-merge-commit"), 0o755);
    const result = await execa("git", ["merge", "--no-edit", "incoming"], {
      cwd: repo.root,
      reject: false,
      stdin: "ignore",
      env: {
        TEST_NODE: process.execPath,
        TEST_CLI: cli,
        ZEDBEE_TELEMETRY_DISABLED: "1",
      },
    });
    expect(result.exitCode).toBe(1);
    const output = [result.stdout, result.stderr].join("\n");
    expect(output).toContain("SCAN INCOMPLETE");
    expect(output.match(/COMPARISON INSTALLATION UNAVAILABLE/gu)).toHaveLength(
      2,
    );
    expect(output.match(/Checks: Lint, TypeScript/gu)).toHaveLength(2);
    for (const folder of ["e2e", "extension"]) {
      expect(output).toContain(`npm --prefix ${folder} ci`);
    }
    const reportPath = output
      .match(/"([^"]+zedbee-scan-report-[^"]+\.json)"/u)?.[1]
      ?.replaceAll(/\r?\n/gu, "");
    expect(reportPath).toBeDefined();
    const report = JSON.parse(await readFile(reportPath!, "utf8"));
    expect(report.exitCode).toBe(2);
    const incomplete = report.checks.filter(
      (check: { status: string }) => check.status === "incomplete",
    );
    expect(incomplete).toHaveLength(4);
    for (const check of incomplete) {
      expect(check.error).toMatchObject({
        diagnostic: { snapshot: "baseline" },
        snapshot: "last-commit",
        comparisonParent: firstParent,
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
