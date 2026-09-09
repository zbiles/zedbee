import { afterEach, describe, expect, it } from "vitest";
import { realpath, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureAnalysisSources,
  withAnalysisSourceCapture,
} from "../../src/inspection/source-capture.js";
import { captureSnapshotRegistry } from "../../src/inspection/snapshot-registry.js";
import { readContainedFile } from "../../src/inspection/read-json.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import {
  countContainedSourceReads,
  restoreAnalysisProbes,
} from "../helpers/analysis-probes.js";
import { lintAdapter } from "../../src/checks/eslint/lint-adapter.js";
import { structuralSecurityAdapter } from "../../src/checks/structural-security/adapter.js";
import { createSecretsAdapter } from "../../src/checks/secrets/adapter.js";
import { prettierAdapter } from "../../src/checks/prettier/adapter.js";
import { lintSource } from "@secretlint/core";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";
import type { CheckRunContext } from "../../src/checks/adapter.js";
import { loadSnapshotProgramInput } from "../../src/checks/typescript/config.js";
import { createSnapshotProgram } from "../../src/checks/typescript/compiler-host.js";
import { createManagedEslint } from "../../src/checks/eslint/load-engine.js";
import { collectSecretSourcePairs } from "../../src/checks/secrets/content.js";

afterEach(restoreAnalysisProbes);

describe("explicit immutable source input capture", () => {
  it("retains logical aliases and captured absence without suppressing unselected live paths", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/real.js", "const unused = 1;");
    await fixture.symlink("real.js", "src/alias.js");
    const owner = (await captureAnalysisSources([
      { snapshotRoot: fixture.root, paths: ["src/alias.js", "src/missing.js"] },
    ]))!;
    const registry = await captureSnapshotRegistry(
      await realpath(fixture.root),
    );
    await fixture.write("src/missing.js", "const alsoUnused = 2;");
    try {
      await expect(
        withAnalysisSourceCapture(owner, async () => {
          throw new Error("callback failed");
        }),
      ).rejects.toThrow("callback failed");
      await withAnalysisSourceCapture(owner, async () => {
        const engine = createManagedEslint({
          cwd: fixture.root,
          mode: "lint",
          managedIgnores: [],
          typeInformation: "basic",
        });
        const results = await engine.lintFiles([
          "src/alias.js",
          "src/real.js",
          "src/missing.js",
        ]);
        expect(results.map((result) => result.filePath)).toEqual([
          join(fixture.root, "src/alias.js"),
          join(fixture.root, "src/real.js"),
        ]);
        expect(results.map((result) => result.messages[0]?.ruleId)).toEqual([
          "no-unused-vars",
          "no-unused-vars",
        ]);
        await expect(
          readContainedFile(registry, "src/missing.js"),
        ).rejects.toThrow();
      });
    } finally {
      await owner.close();
    }
    expect(
      await createManagedEslint({
        cwd: fixture.root,
        mode: "lint",
        managedIgnores: [],
        typeInformation: "basic",
      }).lintFiles(["src/missing.js"]),
    ).toHaveLength(1);
  });

  it("feeds the TypeScript source map and managed lint from the same acquired input", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "captured-types" });
    await fixture.writeJson("tsconfig.json", {
      compilerOptions: { strict: true },
      include: ["src"],
    });
    await fixture.write("src/file.ts", "export const value: number = 'wrong';");
    const inspection = await inspectRepository(fixture.root);
    const workspace = inspection.workspaces[0]!;
    const reads = countContainedSourceReads("/src/file.ts");
    const owner = (await captureAnalysisSources([
      { snapshotRoot: fixture.root, paths: ["src/file.ts"] },
    ]))!;
    await fixture.write("src/file.ts", "export const value: number = 1234567;");
    try {
      await withAnalysisSourceCapture(owner, async () => {
        for (let index = 0; index < 2; index++) {
          const input = await loadSnapshotProgramInput(
            fixture.root,
            fixture.root,
            workspace,
          );
          expect(
            createSnapshotProgram(input)
              .program.getSemanticDiagnostics()
              .map(({ code }) => code),
          ).toEqual([2322]);
          expect(
            await createManagedEslint({
              cwd: fixture.root,
              mode: "lint",
              managedIgnores: [],
              typeInformation: "basic",
            }).lintFiles(["src/file.ts"]),
          ).toHaveLength(1);
        }
        await unlink(join(fixture.root, "src/file.ts"));
        expect(
          createSnapshotProgram(
            await loadSnapshotProgramInput(
              fixture.root,
              fixture.root,
              workspace,
            ),
          )
            .program.getSemanticDiagnostics()
            .map(({ code }) => code),
        ).toEqual([2322]);
        expect(reads()).toBe(1);
      });
    } finally {
      await owner.close();
    }
    await fixture.write("src/file.ts", "export const value: number = 1234567;");
    const fresh = (await captureAnalysisSources([
      { snapshotRoot: fixture.root, paths: ["src/file.ts"] },
    ]))!;
    try {
      await withAnalysisSourceCapture(fresh, async () => {
        expect(
          createSnapshotProgram(
            await loadSnapshotProgramInput(
              fixture.root,
              fixture.root,
              workspace,
            ),
          ).program.getSemanticDiagnostics(),
        ).toEqual([]);
        expect(reads()).toBe(2);
      });
    } finally {
      await fresh.close();
    }
  });

  it.each(["invalid-utf8", "oversize", "symlink", "ignored"] as const)(
    "preserves Secretlint's %s restriction inside a view",
    async (kind) => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", { name: "restrictions" });
      const path = kind === "ignored" ? "dist/file.js" : "src/file.js";
      await fixture.write(
        path,
        kind === "oversize"
          ? "x".repeat(1024 * 1024 + 1)
          : "export const value = 1;",
      );
      if (kind === "invalid-utf8")
        await writeFile(join(fixture.root, path), Buffer.from([0xff]));
      if (kind === "symlink") {
        await fixture.write("src/real.js", "export const value = 1;");
        // Replace only this test's known regular file with a contained link.
        await unlink(join(fixture.root, path));
        await fixture.symlink("real.js", path);
      }
      const inspection = await inspectRepository(fixture.root);
      const context = {
        baselineInspection: inspection,
        targetInspection: inspection,
        changeSet: {
          files: new Map([
            [
              path,
              { path, status: "added", addedRanges: [{ start: 1, end: 1 }] },
            ],
          ]),
        },
      } as unknown as CheckRunContext;
      const standalone = await collectSecretSourcePairs(context).catch(
        (error) => error,
      );
      expect(standalone.code).toBe(
        kind === "invalid-utf8"
          ? "SECRET_FILE_INVALID_UTF8"
          : kind === "oversize"
            ? "SECRET_FILE_TOO_LARGE"
            : "SECRET_FILE_UNSAFE",
      );
      const owner = (await captureAnalysisSources([
        { snapshotRoot: fixture.root, paths: [path] },
      ]))!;
      try {
        await withAnalysisSourceCapture(owner, async () => {
          await expect(collectSecretSourcePairs(context)).rejects.toMatchObject(
            { code: standalone.code, message: standalone.message, path },
          );
        });
      } finally {
        await owner.close();
      }
    },
  );

  it("feeds real ESLint, ast-grep, Secretlint and Prettier from two acquisitions without changing literal findings", async () => {
    const baseline = await createInspectionFixture();
    const target = await createInspectionFixture();
    const path = "src/file.js";
    for (const fixture of [baseline, target])
      await fixture.writeJson("package.json", {
        name: "source-sharing",
        private: true,
      });
    const safe = "export const value = 1;\n";
    const unsafe = `const unused=1;export const value=eval('1');export const token='ghp_${"g".repeat(36)}';\n`;
    await baseline.write(path, safe);
    await target.write(path, unsafe);
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
    const changed = {
      path,
      status: "modified" as const,
      addedRanges: [{ start: 1, end: 1 }],
    };
    const context: CheckRunContext = {
      repositoryRoot: target.root,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: target.root,
        baselineRef: "HEAD",
        targetRef: "index",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(target.root),
      target: { id: ".", kind: "workspace", relativeRoot: "." },
      changeSet: {
        files: new Map([[path, changed]]),
        isEmpty: false,
        containsAddedLine: () => true,
      },
      config,
      policy: config.checks.lint,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    };
    const secrets = createSecretsAdapter({
      lintSource,
      comparisonKey: () => new Uint8Array(32).fill(7),
    });
    const collect = async () => ({
      lint: (await lintAdapter.collect(context)).targetObservations,
      structural: (
        await structuralSecurityAdapter.collect({
          ...context,
          policy: config.checks.structuralSecurity,
        })
      ).targetObservations,
      secrets: (
        await secrets.collect({ ...context, policy: config.checks.secrets })
      ).targetObservations,
      formatting: (
        await prettierAdapter.runLegacy({
          ...context,
          policy: config.checks.formatting,
        })
      ).findings,
    });
    const reads = countContainedSourceReads("/src/file.js");
    const independent = await collect();
    expect(independent.lint.map(({ rule }) => rule)).toContain(
      "no-unused-vars",
    );
    expect(independent.structural.map(({ rule }) => rule)).toContain(
      "direct-eval",
    );
    expect(independent.secrets.map(({ rule }) => rule)).toContain(
      "@secretlint/secretlint-rule-github",
    );
    expect(independent.formatting.map(({ rule }) => rule)).toEqual([
      "prettier",
    ]);
    expect(reads()).toBe(7);
    const selections = [baseline, target].map((fixture) => ({
      snapshotRoot: fixture.root,
      paths: [path],
    }));
    const captured = (await captureAnalysisSources(selections))!;
    expect(reads()).toBe(9);
    await target.write(path, safe);
    try {
      await withAnalysisSourceCapture(captured, async () => {
        expect(await collect()).toEqual(independent);
        expect(await collect()).toEqual(independent);
        await unlink(join(target.root, path));
        expect(await collect()).toEqual(independent);
        expect(reads()).toBe(9);
        const cancelled = { ...context, signal: AbortSignal.abort() };
        await expect(lintAdapter.collect(cancelled)).rejects.toThrow();
        await expect(
          structuralSecurityAdapter.collect(cancelled),
        ).rejects.toThrow();
        await expect(secrets.collect(cancelled)).rejects.toThrow();
        await expect(prettierAdapter.runLegacy(cancelled)).rejects.toThrow();
      });
    } finally {
      await captured.close();
    }
    await target.write(path, safe);
    const fresh = (await captureAnalysisSources(selections))!;
    try {
      await withAnalysisSourceCapture(fresh, async () => {
        expect(await collect()).toEqual({
          lint: [],
          structural: [],
          secrets: [],
          formatting: [],
        });
        expect(reads()).toBe(11);
      });
    } finally {
      await fresh.close();
    }
  });
  it("shares actual acquired bytes, while a new capture bypasses the outer view and restored timestamps", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/file.js", "export const value = 1;");
    const root = await realpath(fixture.root);
    const selection = [{ snapshotRoot: fixture.root, paths: ["src/file.js"] }];
    const registry = await captureSnapshotRegistry(root);
    const reads = countContainedSourceReads("/src/file.js");
    const old = (await captureAnalysisSources(selection))!;
    expect(old).toBeDefined();
    expect(reads()).toBe(1);
    const before = await stat(join(root, "src/file.js"));
    await fixture.write("src/file.js", "export const value = 2;");
    await utimes(join(root, "src/file.js"), before.atime, before.mtime);
    try {
      await withAnalysisSourceCapture(old, async () => {
        expect(await readContainedFile(registry, "src/file.js")).toBe(
          "export const value = 1;",
        );
        expect(await readContainedFile(registry, "src/file.js")).toBe(
          "export const value = 1;",
        );
        expect(reads()).toBe(1);
        const fresh = (await captureAnalysisSources(selection))!;
        try {
          await withAnalysisSourceCapture(fresh, async () => {
            expect(await readContainedFile(registry, "src/file.js")).toBe(
              "export const value = 2;",
            );
          });
        } finally {
          await fresh.close();
        }
        expect(reads()).toBe(2);
        expect(await readContainedFile(registry, "src/file.js")).toBe(
          "export const value = 1;",
        );
      });
    } finally {
      await old.close();
    }
    expect(await readContainedFile(registry, "src/file.js")).toBe(
      "export const value = 2;",
    );
    expect(reads()).toBe(3);
  });

  it("isolates concurrent owners, preserves unselected live files, and rejects closed scopes", async () => {
    const one = await createInspectionFixture();
    const two = await createInspectionFixture();
    await one.write("file.js", "one");
    await two.write("file.js", "two");
    await one.write("other.js", "old");
    const a = (await captureAnalysisSources([
      { snapshotRoot: one.root, paths: ["file.js"] },
    ]))!;
    const b = (await captureAnalysisSources([
      { snapshotRoot: two.root, paths: ["file.js"] },
    ]))!;
    const ra = await captureSnapshotRegistry(await realpath(one.root));
    const rb = await captureSnapshotRegistry(await realpath(two.root));
    await one.write("other.js", "new");
    try {
      await Promise.all([
        withAnalysisSourceCapture(a, async () => {
          await Promise.resolve();
          expect(await readContainedFile(ra, "file.js")).toBe("one");
          expect(await readContainedFile(ra, "other.js")).toBe("new");
        }),
        withAnalysisSourceCapture(b, async () => {
          expect(await readContainedFile(rb, "file.js")).toBe("two");
        }),
      ]);
      await withAnalysisSourceCapture(a, async () => {
        await a.close();
        await expect(readContainedFile(ra, "file.js")).rejects.toThrow(
          /closed/i,
        );
      }).catch((error) => expect(String(error)).toMatch(/closed/i));
      await expect(
        withAnalysisSourceCapture(a, async () => "ignored"),
      ).rejects.toThrow(/closed/i);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("uses captured raw byte lengths for per-consumer limits and retains UTF-8 decoding", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("invalid.js", "");
    await writeFile(join(fixture.root, "invalid.js"), Buffer.from([0xff]));
    const registry = await captureSnapshotRegistry(
      await realpath(fixture.root),
    );
    const owner = (await captureAnalysisSources([
      { snapshotRoot: fixture.root, paths: ["invalid.js"] },
    ]))!;
    try {
      await withAnalysisSourceCapture(owner, async () => {
        expect(
          await readContainedFile(registry, "invalid.js", { maxBytes: 1 }),
        ).toBe("\ufffd");
        await expect(
          readContainedFile(registry, "invalid.js", { maxBytes: 0 }),
        ).rejects.toMatchObject({ code: "FILE_SIZE_LIMIT_EXCEEDED" });
      });
    } finally {
      await owner.close();
    }
  });

  it("releases partial capture on capacity bypass and does not hide unsafe acquisitions", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("small.js", "export const old = 1;");
    await fixture.write("large.js", "x".repeat(8 * 1024 * 1024 + 1));
    expect(
      await captureAnalysisSources([
        { snapshotRoot: fixture.root, paths: ["small.js", "large.js"] },
      ]),
    ).toBeUndefined();
    await fixture.write("small.js", "export const newValue = 2;");
    const registry = await captureSnapshotRegistry(
      await realpath(fixture.root),
    );
    expect(await readContainedFile(registry, "small.js")).toBe(
      "export const newValue = 2;",
    );
    expect((await readContainedFile(registry, "large.js")).length).toBe(
      8 * 1024 * 1024 + 1,
    );
    await fixture.symlink("/", "outside");
    await expect(
      captureAnalysisSources([
        { snapshotRoot: fixture.root, paths: ["outside/file.js"] },
      ]),
    ).rejects.toThrow();
  });
});
