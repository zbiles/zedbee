import { describe, expect, it } from "vitest";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { typescriptAdapter } from "../../src/checks/typescript/adapter.js";
import { lintAdapter } from "../../src/checks/eslint/lint-adapter.js";
import { DEFAULT_CHECK_ADAPTERS } from "../../src/checks/descriptors.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";
import { readdir, readFile, rm, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";

describe("observation cache dependency inputs", () => {
  it.each([
    ["types direct", typescriptAdapter, "string", "typescript/TS2322"],
    [
      "default child runner",
      DEFAULT_CHECK_ADAPTERS.find((adapter) => adapter.id === "types")!,
      "string",
      "typescript/TS2322",
    ],
    [
      "lint direct",
      lintAdapter,
      "any   ",
      "@typescript-eslint/no-unsafe-assignment",
    ],
    [
      "lint child runner",
      DEFAULT_CHECK_ADAPTERS.find((adapter) => adapter.id === "lint")!,
      "any   ",
      "@typescript-eslint/no-unsafe-assignment",
    ],
  ] as const)(
    "does not reuse TypeScript observations after an installed declaration changes (%s)",
    async (_label, typesAdapter, changedType, expectedRule) => {
      const [baseline, target, live, cacheRoot] = await Promise.all([
        createInspectionFixture(),
        createInspectionFixture(),
        createInspectionFixture(),
        createInspectionFixture(),
      ]);
      for (const fixture of [baseline, target, live]) {
        await fixture.writeJson("package.json", {
          name: "cache-dependency-inputs",
          private: true,
          type: "module",
          dependencies: { "fake-installed-dependency": "1.0.0" },
        });
        await fixture.writeJson("tsconfig.json", {
          compilerOptions: { strict: true },
          include: ["src/**/*.ts"],
        });
      }
      await baseline.write("src/value.ts", "export const value = 1;\n");
      await target.write(
        "src/value.ts",
        [
          'import { supplied } from "fake-installed-dependency";',
          "export const value: number = supplied;",
          "export const ambientValue: number = ambient;",
          "",
        ].join("\n"),
      );
      await live.writeJson(
        "node_modules/fake-installed-dependency/package.json",
        {
          name: "fake-installed-dependency",
          version: "1.0.0",
          type: "module",
          types: "index.d.ts",
        },
      );
      const writeDeclaration = (type: string) =>
        live.write(
          "node_modules/fake-installed-dependency/index.d.ts",
          `export declare const supplied: ${type};\n`,
        );
      const writeAmbient = (type: string) =>
        live.write(
          "node_modules/@types/installed-global/index.d.ts",
          `declare const ambient: ${type};\n`,
        );
      await writeAmbient("number");

      const config = resolveConfig({
        schemaVersion: 1,
        profile: "recommended",
      });
      const changeSet: ChangeSet = {
        files: new Map([
          [
            "src/value.ts",
            {
              path: "src/value.ts",
              status: "modified",
              addedRanges: [{ start: 1, end: 3 }],
            },
          ],
        ]),
        isEmpty: false,
        containsAddedLine: (file, line) =>
          file === "src/value.ts" && line >= 1 && line <= 3,
      };
      const context = {
        repositoryRoot: live.root,
        changeSet,
        config,
        snapshots: {
          baselineDir: baseline.root,
          targetDir: target.root,
          baselineRef: "HEAD" as const,
          targetRef: "index" as const,
          unsupportedEntries: [],
        },
        baselineInspection: await inspectRepository(baseline.root),
        targetInspection: await inspectRepository(target.root),
        signal: new AbortController().signal,
        policyForFile: testFilePolicyResolver(config),
      };
      const cache = new ObservationCacheStore({ root: cacheRoot.root });
      const scan = async (useCache: boolean) =>
        evaluatePolicy(
          await dispatchChecks(
            [typesAdapter],
            context,
            useCache ? { cache } : {},
          ),
          config,
        );
      const semanticDecision = (
        decision: Awaited<ReturnType<typeof scan>>,
      ) => ({
        outcome: decision.outcome,
        results: decision.results.map((result) => ({
          checkId: result.checkId,
          status: result.status,
          target: result.target,
          findings: result.findings,
        })),
      });

      await writeDeclaration("number");
      const beforeDependencyChange = await scan(true);
      const freshBeforeDependencyChange = await scan(false);
      expect(beforeDependencyChange.outcome).toBe("pass");
      expect(semanticDecision(beforeDependencyChange)).toEqual(
        semanticDecision(freshBeforeDependencyChange),
      );
      const names = (await readdir(cacheRoot.root)).filter((name) =>
        name.endsWith(".json"),
      );
      expect(names).toHaveLength(1);
      const cachePath = join(cacheRoot.root, names[0]!);
      const cachedInode = (await stat(cachePath)).ino;
      const serialized = await readFile(cachePath, "utf8");
      expect(serialized).toContain('"dependencyInputs"');
      expect(serialized).not.toContain(live.root);
      expect(serialized).not.toContain("export declare const");
      // A real stored result must satisfy an unchanged run without replacing it.
      const warmed = await scan(true);
      expect(semanticDecision(warmed)).toEqual(
        semanticDecision(freshBeforeDependencyChange),
      );
      expect((await stat(cachePath)).ino).toBe(cachedInode);

      const declarationPath = join(
        live.root,
        "node_modules/fake-installed-dependency/index.d.ts",
      );
      const priorMetadata = await stat(declarationPath);
      await writeDeclaration(changedType);
      await utimes(declarationPath, priorMetadata.atime, priorMetadata.mtime);
      const afterChangedDependency = await scan(true);
      const freshAfterChangedDependency = await scan(false);
      expect(semanticDecision(afterChangedDependency)).toEqual(
        semanticDecision(freshAfterChangedDependency),
      );
      expect(afterChangedDependency.outcome).toBe("blocked");
      expect(
        afterChangedDependency.results
          .flatMap((result) => result.findings)
          .map((finding) => finding.rule),
      ).toContain(expectedRule);

      await writeDeclaration("number");
      const afterRestoredDependency = await scan(true);
      const freshAfterRestoredDependency = await scan(false);
      expect(semanticDecision(afterRestoredDependency)).toEqual(
        semanticDecision(freshAfterRestoredDependency),
      );
      expect(afterRestoredDependency.outcome).toBe("pass");

      await writeAmbient(changedType);
      const changedAmbient = await scan(true);
      expect(semanticDecision(changedAmbient)).toEqual(
        semanticDecision(await scan(false)),
      );
      expect(
        changedAmbient.results
          .flatMap((result) => result.findings)
          .map((finding) => finding.rule),
      ).toContain(expectedRule);
      await rm(join(live.root, "node_modules/@types/installed-global"), {
        recursive: true,
      });
      expect(semanticDecision(await scan(true))).toEqual(
        semanticDecision(await scan(false)),
      );
      await writeAmbient("number");
      expect((await scan(true)).outcome).toBe("pass");

      // A missing installed package must invalidate when it later appears.
      await rm(join(live.root, "node_modules/fake-installed-dependency"), {
        recursive: true,
      });
      expect(semanticDecision(await scan(true))).toEqual(
        semanticDecision(await scan(false)),
      );
      for (const [version, type] of [
        ["a", "number"],
        ["b", changedType],
      ] as const) {
        await live.writeJson(`node_modules/.versions/${version}/package.json`, {
          name: "fake-installed-dependency",
          version: "1.0.0",
          type: "module",
          types: "index.d.ts",
        });
        await live.write(
          `node_modules/.versions/${version}/index.d.ts`,
          `export declare const supplied: ${type};\n`,
        );
      }
      await live.symlink(
        ".versions/a",
        "node_modules/fake-installed-dependency",
      );
      expect((await scan(true)).outcome).toBe("pass");
      await unlink(join(live.root, "node_modules/fake-installed-dependency"));
      await live.symlink(
        ".versions/b",
        "node_modules/fake-installed-dependency",
      );
      const retargeted = await scan(true);
      expect(semanticDecision(retargeted)).toEqual(
        semanticDecision(await scan(false)),
      );
      expect(
        retargeted.results
          .flatMap((result) => result.findings)
          .map((finding) => finding.rule),
      ).toContain(expectedRule);
      expect(JSON.stringify(retargeted)).not.toContain("dependencyInputs");
    },
  );
});
