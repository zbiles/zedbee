import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOCTOR_DIAGNOSTIC_IDS } from "../../src/doctor/diagnostics.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { installPackedFixture } from "../helpers/packed-install.js";

const packageRoot = join(import.meta.dirname, "../..");
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
  packDirectory = await mkdtemp(join(tmpdir(), "zedbee-doctor-pack-"));
  const build = await runNpm(["run", "build"], packageRoot);
  expect(build.exitCode, build.stderr).toBe(0);
  const packed = await runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    packageRoot,
  );
  expect(packed.exitCode, packed.stderr).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarballPath = join(packDirectory, metadata[0]!.filename);
}, 30_000);

afterAll(async () => {
  await rm(packDirectory, { recursive: true, force: true });
});

async function repository() {
  const fixture = await createGitRepository();
  await fixture.write(
    "package.json",
    '{"name":"doctor-fixture","private":true}\n',
  );
  await fixture.write(".gitignore", "node_modules/\n");
  await fixture.write("src/index.ts", "export const ready = true;\n");
  await fixture.commitAll("fixture");
  await installPackedFixture(
    tarballPath,
    packageRoot,
    fixture.root,
    join(packDirectory, "install-cache"),
  );
  return fixture;
}

async function run(root: string, command: "checks" | "doctor") {
  return execa(
    process.execPath,
    [
      join(root, "node_modules", "zedbee", "dist", "cli.js"),
      command,
      "--format",
      "json",
    ],
    {
      cwd: root,
      reject: false,
      stdin: "ignore",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
}

describe("diagnostic command surface", () => {
  it(
    "invokes doctor without running a scan and emits every deterministic diagnostic",
    async () => {
      const fixture = await repository();
      const result = await run(fixture.root, "doctor");
      const report = JSON.parse(result.stdout) as {
        exitCode: number;
        diagnostics: Array<{ id: string; message: string }>;
      };

      expect(result.exitCode).toBe(report.exitCode);
      expect(report.diagnostics.map(({ id }) => id)).toEqual(
        DOCTOR_DIAGNOSTIC_IDS,
      );
      expect(JSON.stringify(report)).not.toContain("zedbee-snapshot-");
      expect(JSON.stringify(report)).not.toContain(fixture.root);
    },
    30_000,
  );

  it(
    "invokes checks and lists the canonical configured check catalog",
    async () => {
      const fixture = await repository();
      const result = await run(fixture.root, "checks");
      const report = JSON.parse(result.stdout) as {
        exitCode: number;
        checks: Array<{ id: string }>;
      };

      expect(result.exitCode).toBe(0);
      expect(report.exitCode).toBe(0);
      expect(report.checks.map(({ id }) => id)).toEqual(CHECK_IDS);
    },
    30_000,
  );
});
