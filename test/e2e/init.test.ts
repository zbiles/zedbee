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
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
let packDirectory: string;
let tarballPath: string;

beforeAll(async () => {
  packDirectory = await mkdtemp(join(tmpdir(), "zedbee-init-pack-"));
  const shared = sharedPackedTarball();
  if (shared !== null) {
    tarballPath = shared.path;
    return;
  }
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
});

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
    await repository.write(".gitignore", "node_modules\n");
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
    expect(config).toContain(
      '"$schema": "./node_modules/zedbee/schema/zedbee.schema.json"',
    );
    expect(config).toContain('"agentGuidance"');
    for (const expandedSetting of [
      '"settings"',
      '"rules"',
      '"max"',
      '"blockWorsening"',
      '"threshold"',
      '"minLines"',
      '"minTokens"',
    ]) {
      expect(config).not.toContain(expandedSetting);
    }
    expect(hook).toContain("printf 'existing hook\\n'");
    expect(hook).toContain("npm test");
    expect(hook.match(/zedbee scan/gu) ?? []).toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(hookPath)).mode & 0o777).toBe(0o751);
    }
  });

  it("initializes, diagnoses, and scans with the packaged Node-native security stack", async () => {
    const repository = await createGitRepository("zedbee-native-security-");
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "native-security-fixture", version: "1.0.0", private: true })}\n`,
    );
    await repository.write(".gitignore", "node_modules\n");
    await repository.write("src/index.ts", "export const ready = true;\n");
    await repository.commitAll("fixture");
    await installPackedFixture(
      tarballPath,
      packageRoot,
      repository.root,
      join(packDirectory, "native-security-install-cache"),
    );
    const installedStatus = await repository.git(["status", "--porcelain"]);
    if (installedStatus.stdout.length > 0) {
      await repository.commitAll("installed package");
    }

    const cli = join(repository.root, "node_modules/zedbee/dist/cli.js");
    const invoke = (args: readonly string[]) =>
      execa(process.execPath, [cli, ...args], {
        cwd: repository.root,
        reject: false,
        stdin: "ignore",
      });
    const initialized = await invoke([
      "init",
      "--profile",
      "recommended",
      "--hook",
      "raw",
      "--checks",
      "secrets",
      "--yes",
      "--format",
      "json",
      "--no-color",
      "--no-animations",
    ]);

    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(
      await readFile(join(repository.root, ".git/hooks/pre-commit"), "utf8"),
    ).toContain("zedbee scan");

    const diagnosed = await invoke(["doctor", "--format", "json"]);
    expect(diagnosed.exitCode, `${diagnosed.stderr}\n${diagnosed.stdout}`).toBe(
      0,
    );
    const doctor = JSON.parse(diagnosed.stdout) as {
      diagnostics: Array<{ id: string; status: string; message: string }>;
    };
    expect(doctor.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "secretlint-readiness", status: "pass" }),
        expect.objectContaining({ id: "lockfile-support", status: "pass" }),
        expect.objectContaining({ id: "osv-connectivity", status: "pass" }),
        expect.objectContaining({ id: "hook-state", status: "pass" }),
      ]),
    );
    expect(JSON.stringify(doctor)).not.toMatch(
      /managed-engine|gitleaks|osv-scanner|offline-database/iu,
    );

    expect(
      (await repository.git(["add", "--", ".zedbeerc.jsonc"])).exitCode,
    ).toBe(0);
    const canary = `ghp_${"a".repeat(36)}`;
    await repository.write(
      "src/credential.ts",
      `export const credential = ${JSON.stringify(canary)};\n`,
    );
    expect((await repository.git(["add", "src/credential.ts"])).exitCode).toBe(
      0,
    );
    const scanned = await invoke([
      "scan",
      "--format",
      "json",
      "--no-source",
      "--no-color",
      "--no-animations",
    ]);
    expect(scanned.exitCode, `${scanned.stderr}\n${scanned.stdout}`).toBe(1);
    const report = JSON.parse(scanned.stdout) as {
      outcome: string;
      checks: Array<{
        checkId: string;
        status: string;
        findings: Array<{ rule: string }>;
      }>;
    };
    const secrets = report.checks.find(({ checkId }) => checkId === "secrets");
    expect(report.outcome).toBe("blocked");
    expect(secrets).toMatchObject({ status: "completed" });
    expect(
      secrets?.findings.some(({ rule }) =>
        rule.includes("secretlint-rule-github"),
      ),
    ).toBe(true);
    expect(scanned.stdout).not.toContain(canary);
  });
});
