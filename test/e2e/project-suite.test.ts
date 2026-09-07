import { describe, expect, it } from "vitest";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { loadConfigFromCommit } from "../../src/config/load-config.js";
import { resolveConfig } from "../../src/config/profiles.js";
import {
  readCommitChangeSet,
  readStagedChangeSet,
} from "../../src/git/change-set.js";
import { resolveBaseComparison } from "../../src/git/base-comparison.js";
import { GitClient } from "../../src/git/client.js";
import {
  buildCommitSnapshotPair,
  buildSnapshotPair,
} from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import {
  DEFAULT_CHECK_ADAPTERS,
  runScan,
  type RunScanDependencies,
} from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const PROJECT_CHECKS = new Set([
  "duplication",
  "dependencyArchitecture",
  "deadCode",
]);

function cloneFunction(name: string, increments: number): string {
  return [
    `export function ${name}(input: number) {`,
    "  let total = input;",
    ...Array.from(
      { length: increments },
      (_, index) => `  total += ${index + 1};`,
    ),
    "  return total;",
    "}",
    "",
  ].join("\n");
}

async function createMonorepo(manager: "npm" | "pnpm" | "yarn" | "bun") {
  const repository = await createGitRepository(`zedbee-${manager}-project-`);
  await repository.write(
    "package.json",
    `${JSON.stringify({
      name: `${manager}-root`,
      private: true,
      packageManager: `${manager}@1.2.3`,
      ...(manager === "pnpm" ? {} : { workspaces: ["packages/*"] }),
    })}\n`,
  );
  if (manager === "pnpm") {
    await repository.write(
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\n",
    );
  }
  const lockfiles = {
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lock",
  } as const;
  await repository.write(lockfiles[manager], "# fixture lockfile\n");
  await repository.write(
    "packages/app/package.json",
    `${JSON.stringify({
      name: `@fixture/${manager}-app`,
      private: true,
      main: "src/index.ts",
    })}\n`,
  );
  await repository.write(
    "packages/app/tsconfig.json",
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
      },
      include: ["src"],
    })}\n`,
  );
  await repository.write(
    "packages/app/src/index.ts",
    [
      "import { kept } from './public.js';",
      "import { a } from './a.js';",
      "import { firstClone } from './clone-a.js';",
      "import { secondClone } from './clone-b.js';",
      "console.log(kept, a, firstClone(1), secondClone(1));",
      "",
    ].join("\n"),
  );
  await repository.write(
    "packages/app/src/public.ts",
    "export const kept = 1;\n",
  );
  await repository.write(
    "packages/app/src/a.ts",
    "import { b } from './b.js'; export const a = () => b();\n",
  );
  await repository.write(
    "packages/app/src/b.ts",
    "export const b = () => 1;\n",
  );
  await repository.write(
    "packages/app/src/clone-a.ts",
    cloneFunction("firstClone", 12),
  );
  await repository.write(
    "packages/app/src/clone-b.ts",
    cloneFunction("secondClone", 13),
  );
  await repository.write(
    "packages/legacy/package.json",
    `${JSON.stringify({
      name: `@fixture/${manager}-legacy`,
      private: true,
      main: "src/index.ts",
    })}\n`,
  );
  await repository.write(
    "packages/legacy/src/index.ts",
    "export const legacy = true;\n",
  );
  await repository.write(
    "packages/legacy/src/debt.ts",
    "export const existingUnusedDebt = true;\n",
  );
  await repository.commitAll("baseline monorepo");

  await repository.write(
    "packages/app/src/public.ts",
    "export const kept = 1;\nexport const freshUnused = 2;\n",
  );
  await repository.write(
    "packages/app/src/b.ts",
    "import { a } from './a.js'; export const b = () => typeof a;\n",
  );
  await repository.write(
    "packages/app/src/clone-a.ts",
    cloneFunction("firstClone", 13),
  );
  await repository.git([
    "add",
    "--",
    "packages/app/src/public.ts",
    "packages/app/src/b.ts",
    "packages/app/src/clone-a.ts",
  ]);
  await repository.write(
    "packages/app/src/live-only.ts",
    "export const unstagedUnused = true;\n",
  );
  return repository;
}

describe.sequential("managed project suite", () => {
  it.each(["npm", "pnpm", "yarn", "bun"] as const)(
    "attributes project regressions in a %s workspace without changing the index",
    async (manager) => {
      const repository = await createMonorepo(manager);
      await expect(inspectRepository(repository.root)).resolves.toMatchObject({
        packageManager: manager,
      });
      const git = new GitClient(repository.root);
      const projectAdapters = DEFAULT_CHECK_ADAPTERS.filter(({ id }) =>
        PROJECT_CHECKS.has(id),
      );
      expect(projectAdapters.map(({ id }) => id)).toEqual([
        "duplication",
        "dependencyArchitecture",
        "deadCode",
      ]);
      const config = resolveConfig({
        schemaVersion: 1,
        profile: "thorough",
        checks: { duplication: { threshold: 0 } },
      });
      let tick = 0;
      const dependencies: RunScanDependencies = {
        resolveBaseComparison,
        loadIndexConfig: async () => config,
        loadCommitConfig: loadConfigFromCommit,
        createGitClient: () => git,
        readIndexChangeSet: readStagedChangeSet,
        readCommitChangeSet,
        buildIndexSnapshots: buildSnapshotPair,
        buildCommitSnapshots: buildCommitSnapshotPair,
        inspectRepository,
        baselineForEmptyChange: async () => "HEAD",
        dispatch: dispatchChecks,
        evaluate: evaluatePolicy,
        adapters: projectAdapters,
        now: () => new Date("2026-08-15T00:00:00.000Z"),
        clock: () => tick++,
      };
      const before = await repository.git(["diff", "--cached", "--binary"]);

      const report = await runScan({
        repositoryRoot: repository.root,
        dependencies,
      });

      const after = await repository.git(["diff", "--cached", "--binary"]);
      expect(after.stdout).toBe(before.stdout);
      expect(report).toMatchObject({ outcome: "blocked", exitCode: 1 });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("existingUnusedDebt");
      expect(serialized).not.toContain("unstagedUnused");
      for (const id of PROJECT_CHECKS) {
        const result = report.checks.find(({ checkId }) => checkId === id);
        expect(result, `missing ${id}`).toMatchObject({
          status: "completed",
          target: "packages/app",
        });
        expect(
          result?.findings.length,
          `${id} findings in ${JSON.stringify(report)}`,
        ).toBeGreaterThan(0);
        expect(
          result?.findings.every(({ attribution }) => attribution.staged),
        ).toBe(true);
      }
      expect(
        report.checks
          .find(({ checkId }) => checkId === "dependencyArchitecture")
          ?.findings.some(({ rule }) => rule === "no-circular"),
      ).toBe(true);
      expect(
        report.checks
          .find(({ checkId }) => checkId === "deadCode")
          ?.findings.some(({ rule }) => rule === "exports"),
      ).toBe(true);
    },
  );
});
