import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  packageManagerInstall,
  type PackageManager,
} from "../../scripts/release-check.mjs";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const root = join(import.meta.dirname, "../..");
const managers = ["npm", "pnpm", "yarn", "bun"] as const;
const requestedManager = process.env.ZEDBEE_PACKAGE_MANAGER_UNDER_TEST;
const installedFixtureManagers = managers.includes(
  requestedManager as PackageManager,
)
  ? [requestedManager as PackageManager]
  : managers;
const available = (manager: PackageManager) =>
  spawnSync(
    process.platform === "win32" ? `${manager}.cmd` : manager,
    ["--version"],
    {
      stdio: "ignore",
    },
  ).status === 0;
let scratch: string;
let tarball: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "zedbee-managers-"));
  const shared = sharedPackedTarball();
  if (shared !== null) {
    tarball = shared.path;
    return;
  }
  const packed = await execa(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
    {
      cwd: root,
      reject: false,
      stdin: "ignore",
      env: { npm_config_cache: join(scratch, "pack-cache") },
    },
  );
  expect(packed.exitCode, packed.stderr).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarball = join(scratch, metadata[0]!.filename);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("package-manager fixture commands", () => {
  it.each([
    ["npm", ["npm", ["install", "--ignore-scripts", "zedbee.tgz"]]],
    ["pnpm", ["pnpm", ["add", "--ignore-scripts", "zedbee.tgz"]]],
    ["yarn", ["yarn", ["add", "--ignore-scripts", "zedbee.tgz"]]],
    ["bun", ["bun", ["add", "--ignore-scripts", "zedbee.tgz"]]],
  ] as const)("uses a shell-free %s install", (manager, expected) => {
    expect(packageManagerInstall(manager, "zedbee.tgz")).toEqual({
      command: expected[0],
      args: expected[1],
    });
  });

  for (const manager of installedFixtureManagers) {
    it.runIf(available(manager))(
      `installs and invokes the packed CLI with ${manager} without lifecycle or Git mutation`,
      async () => {
        const repository = await createGitRepository(`zedbee-${manager}-`);
        await repository.write(
          "package.json",
          JSON.stringify({
            name: `${manager}-fixture`,
            private: true,
            scripts: {
              preinstall:
                "node -e \"require('node:fs').writeFileSync('lifecycle-ran','bad')\"",
            },
          }),
        );
        await repository.write(".gitignore", "node_modules\nlifecycle-ran\n");
        await repository.write("src/index.ts", "export const ready = true;\n");
        await repository.commitAll("fixture");

        if (manager === "npm") {
          await installPackedFixture(
            tarball,
            root,
            repository.root,
            join(scratch, "npm-install-cache"),
          );
        } else {
          const install = packageManagerInstall(manager, tarball);
          const installArgs = [...install.args];
          if (manager === "yarn") {
            installArgs.splice(-1, 0, "--ignore-platform");
          }
          const installed = await execa(install.command, installArgs, {
            cwd: repository.root,
            reject: false,
            stdin: "ignore",
            env: {
              ...process.env,
              npm_config_cache: join(scratch, `${manager}-npm-cache`),
              PNPM_HOME: join(scratch, "pnpm-home"),
              pnpm_config_store_dir: join(scratch, "pnpm-store"),
              YARN_CACHE_FOLDER: join(scratch, "yarn-cache"),
              BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache"),
            },
          });
          expect(installed.exitCode, installed.stderr).toBe(0);
        }
        await expect(
          access(join(repository.root, "lifecycle-ran")),
        ).rejects.toThrow();
        expect(
          await readFile(
            join(repository.root, "node_modules/zedbee/LICENSE"),
            "utf8",
          ),
        ).toContain("PolyForm Small Business License");
        const installedManifest = JSON.parse(
          await readFile(
            join(repository.root, "node_modules/zedbee/package.json"),
            "utf8",
          ),
        ) as { dependencies: Record<string, string> };
        const installedNotices = await readFile(
          join(repository.root, "node_modules/zedbee/THIRD_PARTY_NOTICES.md"),
          "utf8",
        );
        const secretlintHeadings = installedNotices
          .split("\n")
          .filter((line) => line.startsWith("## @secretlint/"));
        for (const name of [
          "@secretlint/core",
          "@secretlint/secretlint-rule-preset-recommend",
          "@secretlint/types",
        ]) {
          expect(secretlintHeadings).toContain(
            `## ${name}@${installedManifest.dependencies[name]}`,
          );
        }

        const installedStatus = await repository.git(["status", "--porcelain"]);
        if (installedStatus.stdout.length > 0) {
          await repository.commitAll("installed package");
        }
        const before = await repository.git(["status", "--porcelain=v1", "-z"]);
        const result = await execa(
          process.execPath,
          [
            join(repository.root, "node_modules/zedbee/dist/cli.js"),
            "checks",
            "--format",
            "json",
          ],
          { cwd: repository.root, reject: false, stdin: "ignore" },
        );
        expect(result.exitCode, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as {
          checks: Array<{ id: string }>;
        };
        const after = await repository.git(["status", "--porcelain=v1", "-z"]);

        expect(report.checks.map(({ id }) => id)).toEqual(CHECK_IDS);
        expect(after.stdout).toBe(before.stdout);
      },
    );
  }
});
