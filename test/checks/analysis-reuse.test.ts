import { afterEach, describe, expect, it, vi } from "vitest";
import { Linter, SourceCode } from "eslint";
import tseslint from "typescript-eslint";
import ts from "typescript";
import {
  analysisStore,
  createAnalysisReuseSession,
  withAnalysisReuseSession,
} from "../../src/checks/analysis-reuse.js";
import { managedConfig } from "../../src/checks/eslint/managed-config.js";
import { collectComplexityObservations } from "../../src/checks/complexity/adapter.js";
import { createSnapshotProgram } from "../../src/checks/typescript/compiler-host.js";
import * as compilerHost from "../../src/checks/typescript/compiler-host.js";
import { createManagedEslint } from "../../src/checks/eslint/load-engine.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { reuseTypescriptParser } from "../../src/checks/eslint/parse-store.js";
import { validateDependencyInputs } from "../../src/cache/captured-dependencies.js";
import { captureAnalysisDependencies } from "../../src/checks/typescript/reuse-inputs.js";
import { join } from "node:path";
import { readFile, realpath, stat, utimes } from "node:fs/promises";
import {
  cyclomaticComplexityAdapter,
  readabilityComplexityAdapter,
} from "../../src/checks/complexity/adapter.js";
import { lintAdapter } from "../../src/checks/eslint/lint-adapter.js";
import { reactCorrectnessAdapter } from "../../src/checks/react/correctness-adapter.js";
import { reactAccessibilityAdapter } from "../../src/checks/react/accessibility-adapter.js";
import { typescriptAdapter } from "../../src/checks/typescript/adapter.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";
import type {
  CheckRunContext,
  ObservationCheckAdapter,
} from "../../src/checks/adapter.js";
import type { CheckId } from "../../src/config/schema.js";
import {
  countSyntaxParses,
  countContainedSourceReads,
  restoreAnalysisProbes,
} from "../helpers/analysis-probes.js";

afterEach(restoreAnalysisProbes);

const branch =
  "export function branch(value: boolean) { if (value) return 1; return 0; }";
const upstreamParser =
  tseslint.parser as unknown as typeof import("@typescript-eslint/parser");

function lint(
  source: string,
  file = "/tmp/zedbee-reuse/src/file.ts",
  rules = {},
  mode: "lint" | "complexity" = "lint",
) {
  return new Linter().verify(
    source,
    [
      ...managedConfig({ mode, managedIgnores: [], typeInformation: "basic" }),
      { rules },
    ],
    { filename: file },
  );
}

describe("owned analysis reuse", () => {
  it("keeps literal complexity metrics and independent limits with one syntax parse", async () => {
    const parses = countSyntaxParses();
    const verify = vi.spyOn(Linter.prototype, "verify");
    const session = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(session, async () => {
        const first = await collectComplexityObservations(
          "src/branch.ts",
          branch,
          3,
        );
        const second = await collectComplexityObservations(
          "src/branch.ts",
          branch,
          9,
        );
        expect(first.map(({ metric }) => metric)).toEqual([
          { name: "cyclomatic-complexity", value: 2, limit: 3 },
          { name: "readability-complexity", value: 1, limit: 3 },
        ]);
        expect(second.map(({ metric }) => metric)).toEqual([
          { name: "cyclomatic-complexity", value: 2, limit: 9 },
          { name: "readability-complexity", value: 1, limit: 9 },
        ]);
        expect(parses()).toBe(1);
        expect(verify).toHaveBeenCalledTimes(1);
      });
    } finally {
      await session.close();
    }
  });

  it("runs the common complexity traversal once and rechecks changed on-disk bytes", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/branch.ts", branch);
    const owner = createAnalysisReuseSession();
    const verify = vi.spyOn(Linter.prototype, "verify");
    try {
      await withAnalysisReuseSession(owner, async () => {
        const engine = () =>
          createManagedEslint({
            cwd: fixture.root,
            mode: "complexity",
            managedIgnores: [],
          });
        const first = await engine().lintFiles(["src/branch.ts"]);
        const second = await engine().lintFiles(["src/branch.ts"]);
        expect(first).toEqual(second);
        expect(first[0]?.messages.map(({ message }) => message)).toEqual([
          "Function 'branch' has a complexity of 2. Maximum allowed is 0.",
          "zedbee-readability:1",
        ]);
        expect(verify).toHaveBeenCalledTimes(1);
        await fixture.write(
          "src/branch.ts",
          "export function branch() { return 0; }",
        );
        const changed = await engine().lintFiles(["src/branch.ts"]);
        expect(changed[0]?.messages.map(({ message }) => message)).toEqual([
          "Function 'branch' has a complexity of 1. Maximum allowed is 0.",
          "zedbee-readability:0",
        ]);
        expect(verify).toHaveBeenCalledTimes(2);
      });
    } finally {
      await owner.close();
    }
  });

  it("preserves explicitly requested generated paths without walking unrelated directories", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("dist/branch.ts", branch);
    await fixture.write("unrelated/deep/file.ts", "export {};");
    await fixture.symlink("/", "unrelated/outside");
    const engine = () =>
      createManagedEslint({
        cwd: fixture.root,
        mode: "complexity",
        managedIgnores: [],
      });
    const standalone = await engine().lintFiles(["dist/branch.ts"]);
    expect(standalone[0]?.messages).toHaveLength(2);
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        expect(await engine().lintFiles(["dist/branch.ts"])).toEqual(
          standalone,
        );
        expect(await engine().lintFiles(["missing.ts"])).toEqual([]);
      });
    } finally {
      await owner.close();
    }
  });

  it("keeps complexity ignore configuration and file aliases out of each other's raw results", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/branch.ts", branch);
    const ignored = () =>
      createManagedEslint({
        cwd: fixture.root,
        mode: "complexity",
        managedIgnores: ["src/**"],
      });
    const active = () =>
      createManagedEslint({
        cwd: fixture.root,
        mode: "complexity",
        managedIgnores: [],
      });
    const expectedIgnored = await ignored().lintFiles(["src/branch.ts"]);
    const expectedActive = await active().lintFiles(["src/branch.ts"]);
    const canonicalRoot = await realpath(fixture.root);
    const canonical = () =>
      createManagedEslint({
        cwd: canonicalRoot,
        mode: "complexity",
        managedIgnores: [],
      });
    const expectedCanonical = await canonical().lintFiles(["src/branch.ts"]);
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        expect(await active().lintFiles(["src/branch.ts"])).toEqual(
          expectedActive,
        );
        expect(await ignored().lintFiles(["src/branch.ts"])).toEqual(
          expectedIgnored,
        );
        expect(await canonical().lintFiles(["src/branch.ts"])).toEqual(
          expectedCanonical,
        );
      });
    } finally {
      await owner.close();
    }
  });

  it("shares basic TypeScript syntax across rule runs while isolating used-variable metadata", async () => {
    const source = "const unused: number = 1;";
    const config = [
      ...managedConfig({
        mode: "lint",
        managedIgnores: [],
        typeInformation: "basic",
      }),
    ];
    const markUsed: Linter.Config = {
      plugins: {
        probe: {
          rules: {
            mark: {
              create(context) {
                return {
                  Program(node) {
                    (context.sourceCode as SourceCode).markVariableAsUsed(
                      "unused",
                      node,
                    );
                  },
                };
              },
            },
          },
        },
      },
      rules: { "probe/mark": "error" },
    };
    const verify = (mark: boolean) =>
      new Linter().verify(source, mark ? [...config, markUsed] : config, {
        filename: "src/file.ts",
      });
    const standalone = verify(false);
    expect(standalone.map(({ ruleId }) => ruleId)).toEqual([
      "@typescript-eslint/no-unused-vars",
    ]);
    const parses = countSyntaxParses();
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        expect(verify(true)).toEqual([]);
        expect(verify(false)).toEqual(standalone);
        expect(verify(true)).toEqual([]);
        expect(verify(false)).toEqual(standalone);
        expect(parses()).toBe(1);
      });
    } finally {
      await owner.close();
    }
  });

  it("invalidates same filenames with changed bytes and keeps parser options distinct", async () => {
    const owner = createAnalysisReuseSession();
    const parses = countSyntaxParses();
    try {
      await withAnalysisReuseSession(owner, async () => {
        expect(lint("export const value: number = 1;", "src/file.ts")).toEqual(
          [],
        );
        expect(
          lint("const unused: number = 1;", "src/file.ts").map(
            ({ ruleId }) => ruleId,
          ),
        ).toEqual(["@typescript-eslint/no-unused-vars"]);
        lint("const unused: number = 1;", "other/file.ts");
        new Linter().verify(
          "const unused: number = 1;",
          [
            ...managedConfig({ mode: "complexity", managedIgnores: [] }),
            { languageOptions: { parserOptions: { jsxPragma: "h" } } },
          ],
          { filename: "src/file.ts" },
        );
        expect(parses()).toBe(4);
      });
    } finally {
      await owner.close();
    }
  });

  it("bypasses reuse when parser options contain hidden state", async () => {
    const owner = createAnalysisReuseSession();
    const parses = countSyntaxParses();
    const source = "/** @deprecated old */\nexport const value = 1;";
    const hidden = (mode: "all" | "none") =>
      Object.defineProperty({ filePath: "src/file.ts" }, "jsDocParsingMode", {
        value: mode,
      });
    try {
      await withAnalysisReuseSession(owner, async () => {
        for (const mode of ["none", "all"] as const) {
          const parsed = reuseTypescriptParser.parseForESLint(
            source,
            hidden(mode),
          );
          const root = parsed.services.esTreeNodeToTSNodeMap.get(
            parsed.ast,
          ) as ts.SourceFile;
          expect(root.text).toBe(source);
          expect(parsed.ast.body).toHaveLength(1);
        }
        expect(parses()).toBe(2);
      });
    } finally {
      await owner.close();
    }
  });

  it("keeps fresh private-field scope methods, parent graphs and parser-services maps after mutations", async () => {
    const owner = createAnalysisReuseSession();
    const source =
      "/** original */\nconst value: number = 1;\nconst view = <div>{value}</div>;";
    const options = {
      filePath: "src/file.tsx",
      sourceType: "module" as const,
      ecmaFeatures: { jsx: true },
      jsDocParsingMode: "all" as const,
    };
    const standalone = upstreamParser.parseForESLint(source, options);
    const parses = countSyntaxParses();
    try {
      await withAnalysisReuseSession(owner, async () => {
        const first = reuseTypescriptParser.parseForESLint(source, options);
        const firstRoot = first.services.esTreeNodeToTSNodeMap.get(
          first.ast,
        ) as ts.SourceFile;
        const declaration = (firstRoot.statements[0] as ts.VariableStatement)
          .declarationList.declarations[0]!;
        Object.defineProperty(declaration.name, "escapedText", {
          value: "polluted",
        });
        firstRoot.text = "polluted";
        first.ast.body.splice(0, 1);
        first.scopeManager.scopes[1]!.variables[0]!.eslintUsed = true;
        const second = reuseTypescriptParser.parseForESLint(source, options);
        const root = second.services.esTreeNodeToTSNodeMap.get(
          second.ast,
        ) as ts.SourceFile;
        expect(second.ast).toEqual(standalone.ast);
        expect(second.ast).not.toBe(first.ast);
        expect(second.scopeManager.isModule()).toBe(true);
        expect(second.scopeManager.acquire(second.ast, true)?.type).toBe(
          "module",
        );
        expect(
          second.scopeManager.scopes[1]!.variables[0]!.eslintUsed,
        ).not.toBe(true);
        expect(second.services.tsNodeToESTreeNodeMap.get(root)).toBe(
          second.ast,
        );
        expect(root.getFullText()).toBe(source);
        expect(
          root.getLineAndCharacterOfPosition(source.indexOf("const view")),
        ).toEqual({ line: 2, character: 0 });
        expect(root.statements[0]!.getSourceFile()).toBe(root);
        expect(root.statements[0]!.parent).toBe(root);
        expect(
          (
            root.statements[0] as ts.VariableStatement
          ).declarationList.declarations[0]!.name.getText(),
        ).toBe("value");
        expect(root).not.toBe(firstRoot);
        expect(parses()).toBe(1);
      });
    } finally {
      await owner.close();
    }
  });

  it("matches independently selected real lint, React and complexity checks with one syntax parse per side", async () => {
    const baseline = await createInspectionFixture();
    const target = await createInspectionFixture();
    for (const fixture of [baseline, target])
      await fixture.writeJson("package.json", {
        name: "reuse-parity",
        private: true,
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      });
    await baseline.write("src/app.tsx", "export const App = () => <main />;\n");
    await target.write(
      "src/app.tsx",
      "import { useState } from 'react';\nexport function App({ready}: {ready: boolean}) {\n if (ready) useState(0);\n const unused = 1;\n return <img />;\n}\n",
    );
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        lint: { typeInformation: "basic" },
        cyclomaticComplexity: { max: 1 },
        readabilityComplexity: { max: 9 },
      },
    });
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
        files: new Map(),
        isEmpty: false,
        containsAddedLine: () => true,
      },
      config,
      policy: config.checks.lint,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    };
    const adapters = [
      lintAdapter,
      reactCorrectnessAdapter,
      reactAccessibilityAdapter,
      cyclomaticComplexityAdapter,
      readabilityComplexityAdapter,
    ];
    const collect = async (adapter: ObservationCheckAdapter) =>
      adapter.collect({
        ...context,
        policy: config.checks[adapter.id as CheckId],
      });
    const parses = countSyntaxParses();
    const standalone: Awaited<
      ReturnType<ObservationCheckAdapter["collect"]>
    >[] = [];
    for (const adapter of adapters) standalone.push(await collect(adapter));
    expect(parses()).toBe(10);
    expect(standalone[0]!.targetObservations.map(({ rule }) => rule)).toContain(
      "@typescript-eslint/no-unused-vars",
    );
    expect(standalone[1]!.targetObservations.map(({ rule }) => rule)).toContain(
      "react-hooks/rules-of-hooks",
    );
    expect(standalone[2]!.targetObservations.map(({ rule }) => rule)).toContain(
      "jsx-a11y/alt-text",
    );
    expect(standalone[3]!.targetObservations[0]?.metric).toEqual({
      name: "cyclomatic-complexity",
      value: 2,
      limit: 1,
    });
    expect(standalone[4]!.targetObservations[0]?.metric).toEqual({
      name: "readability-complexity",
      value: 1,
      limit: 9,
    });
    const owner = createAnalysisReuseSession();
    const reads = countContainedSourceReads("/src/app.tsx");
    try {
      await withAnalysisReuseSession(owner, async () => {
        for (let index = 0; index < adapters.length; index += 1)
          expect(await collect(adapters[index]!)).toEqual(standalone[index]);
        expect(parses()).toBe(12);
        expect(reads()).toBe(10);
        for (const adapter of [...adapters].reverse()) await collect(adapter);
        expect(parses()).toBe(12);
        expect(reads()).toBe(20);
        const cancelled = new AbortController();
        cancelled.abort(new Error("cancelled collection"));
        await expect(
          lintAdapter.collect({ ...context, signal: cancelled.signal }),
        ).rejects.toThrow();
        const originalSource = await readFile(
          join(target.root, "src/app.tsx"),
          "utf8",
        );
        await target.write("src/app.tsx", "export function App(");
        await expect(collect(cyclomaticComplexityAdapter)).rejects.toThrow();
        await target.write("src/app.tsx", originalSource);
        expect(await collect(lintAdapter)).toEqual(standalone[0]);
      });
    } finally {
      await owner.close();
    }
  });

  it("handles deep valid syntax and bypasses oversized syntax retention without dropping findings", async () => {
    const deep = `export function value() { ${"{".repeat(100)} return 1; ${"}".repeat(100)} }`;
    const large = `/*${"x".repeat(1024 * 1024)}*/\nconst unused = 1;`;
    const expectedDeep = lint(deep, "src/deep.ts");
    const expectedLarge = lint(large, "src/large.ts");
    expect(expectedDeep).toEqual([]);
    expect(expectedLarge.map(({ ruleId }) => ruleId)).toEqual([
      "@typescript-eslint/no-unused-vars",
    ]);
    const parses = countSyntaxParses();
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        for (let index = 0; index < 2; index += 1) {
          expect(lint(deep, "src/deep.ts")).toEqual(expectedDeep);
          expect(lint(large, "src/large.ts")).toEqual(expectedLarge);
        }
        expect(parses()).toBe(3);
      });
    } finally {
      await owner.close();
    }
  });

  it("shares exact real typed-lint/type programs in both orders with complete dependency metadata", async () => {
    const baseline = await createInspectionFixture();
    const target = await createInspectionFixture();
    for (const fixture of [baseline, target]) {
      await fixture.writeJson("package.json", {
        name: "typed-reuse",
        private: true,
      });
      await fixture.writeJson("tsconfig.json", {
        compilerOptions: { strict: true, types: [] },
        include: ["src/*.ts"],
      });
    }
    await baseline.write("src/value.ts", "export const result = 1;\n");
    await target.write(
      "src/value.ts",
      "declare const supplied: any;\nexport const result: number = supplied;\nexport const wrong: number = 'wrong';\n",
    );
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
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
        files: new Map(),
        isEmpty: false,
        containsAddedLine: () => true,
      },
      config,
      policy: config.checks.types,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    };
    const independentTypes = await typescriptAdapter.collect(context);
    const independentLint = await lintAdapter.collect({
      ...context,
      policy: config.checks.lint,
    });
    expect(
      independentTypes.targetObservations.map(({ rule }) => rule),
    ).toContain("typescript/TS2322");
    expect(
      independentLint.targetObservations.map(({ rule }) => rule),
    ).toContain("@typescript-eslint/no-unsafe-assignment");
    const original = compilerHost.createSnapshotProgram;
    const seen: ts.Program[] = [];
    vi.spyOn(compilerHost, "createSnapshotProgram").mockImplementation(
      (input) => {
        const result = original(input);
        seen.push(result.program);
        return result;
      },
    );
    for (const order of [
      [typescriptAdapter, lintAdapter],
      [lintAdapter, typescriptAdapter],
    ]) {
      const owner = createAnalysisReuseSession();
      seen.length = 0;
      try {
        await withAnalysisReuseSession(owner, async () => {
          for (const adapter of order) {
            const result = await adapter.collect({
              ...context,
              policy: config.checks[adapter.id as CheckId],
            });
            const independent =
              adapter.id === "types" ? independentTypes : independentLint;
            expect(result.baselineObservations).toEqual(
              independent.baselineObservations,
            );
            expect(result.targetObservations).toEqual(
              independent.targetObservations,
            );
            expect(
              validateDependencyInputs(result.dependencyInputs, context),
            ).toBe(true);
          }
          expect(seen).toHaveLength(4);
          expect(seen[0]).not.toBe(seen[1]);
          expect(new Set(seen).size).toBe(2);
        });
      } finally {
        await owner.close();
      }
    }
  });

  it("rotates dependency captures on same-size restored-mtime changes and records lazy program reads", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("node_modules/x/package.json", {
      name: "x",
      types: "index.d.ts",
    });
    await fixture.write(
      "node_modules/x/index.d.ts",
      "export const value: string;",
    );
    const path = join(fixture.root, "node_modules/x/index.d.ts");
    const input = {
      repositoryRoot: fixture.root,
      files: {
        "a.ts": "import { value } from 'x'; const result: number = value;",
      },
      rootNames: ["a.ts"],
      options: { noLib: true, types: [] },
    };
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        const capture = captureAnalysisDependencies(input);
        const first = createSnapshotProgram({
          ...input,
          dependencies: capture,
        });
        expect(
          first.program.getSemanticDiagnostics().map(({ code }) => code),
        ).toEqual([2322]);
        expect(captureAnalysisDependencies(input)).toBe(capture);
        expect(
          createSnapshotProgram({ ...input, dependencies: capture }).program,
        ).toBe(first.program);
        expect(capture.manifest()?.probes).toContainEqual(
          expect.objectContaining({
            kind: "file",
            path: "packages:x/index.d.ts",
          }),
        );
        expect(validateDependencyInputs(capture.manifest(), input)).toBe(true);
        const before = await stat(path);
        await fixture.write(
          "node_modules/x/index.d.ts",
          "export const value: number;",
        );
        await utimes(path, before.atime, before.mtime);
        const changedCapture = captureAnalysisDependencies(input);
        expect(changedCapture).not.toBe(capture);
        expect(
          createSnapshotProgram({
            ...input,
            dependencies: changedCapture,
          }).program.getSemanticDiagnostics(),
        ).toEqual([]);
        expect(validateDependencyInputs(changedCapture.manifest(), input)).toBe(
          true,
        );
        expect(validateDependencyInputs(capture.manifest(), input)).toBe(false);
      });
    } finally {
      await owner.close();
    }
  });

  it("preserves separate nested and concurrent owners and survives failed callbacks until close", async () => {
    const one = createAnalysisReuseSession();
    const two = createAnalysisReuseSession();
    const parses = countSyntaxParses();
    try {
      await withAnalysisReuseSession(one, async () => {
        lint(branch, "src/file.ts");
        await withAnalysisReuseSession(two, async () => {
          lint(branch, "src/file.ts");
        });
        lint(branch, "src/file.ts");
      });
      await expect(
        withAnalysisReuseSession(one, async () => {
          throw new Error("cancelled");
        }),
      ).rejects.toThrow("cancelled");
      await Promise.all(
        [one, two].map((owner) =>
          withAnalysisReuseSession(owner, async () => {
            await Promise.resolve();
            lint(branch, "src/file.ts");
          }),
        ),
      );
      expect(parses()).toBe(2);
      await one.close();
      await expect(
        withAnalysisReuseSession(one, async () => lint(branch)),
      ).rejects.toThrow(/closed/i);
      await withAnalysisReuseSession(two, async () => {
        lint(branch, "src/file.ts");
      });
      expect(parses()).toBe(2);
    } finally {
      await one.close();
      await two.close();
    }
    lint(branch, "src/file.ts");
    expect(parses()).toBe(3);
  });

  it("releases retained values at close, rejects in-flight scopes, and bypasses over-budget retention", async () => {
    const owner = createAnalysisReuseSession();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const family = Symbol("owned fixture input");
    let store!: NonNullable<ReturnType<typeof analysisStore<object>>>;
    const run = withAnalysisReuseSession(owner, async () => {
      store = analysisStore<object>(family)!;
      store.set("small", { source: "secret source" }, 100);
      store.set(
        "large",
        { source: "large accounting reservation" },
        1024 * 1024 * 1024,
      );
      expect(store.get("large")).toBeUndefined();
      expect(store.get("small")).toEqual({ source: "secret source" });
      await gate;
      store.set("late", { source: "late source" }, 100);
    });
    await owner.close();
    resume();
    await expect(run).rejects.toThrow(/closed/i);
    expect(store.get("small")).toBeUndefined();
    expect(store.get("late")).toBeUndefined();
  });

  it("reuses exact compiler programs but not different source, options, roots or repositories", async () => {
    const owner = createAnalysisReuseSession();
    const input = {
      repositoryRoot: process.cwd(),
      files: { "a.ts": "const value: number = 'wrong';" },
      rootNames: ["a.ts"],
      options: { noLib: true, types: [] },
    };
    try {
      await withAnalysisReuseSession(owner, async () => {
        const first = createSnapshotProgram(input);
        expect(
          first.program.getSemanticDiagnostics().map(({ code }) => code),
        ).toEqual([2322]);
        expect(
          createSnapshotProgram({ ...input, files: { ...input.files } })
            .program,
        ).toBe(first.program);
        const changed = createSnapshotProgram({
          ...input,
          files: { "a.ts": "const value: number = 1;" },
        });
        expect(changed.program.getSemanticDiagnostics()).toEqual([]);
        expect(
          createSnapshotProgram({
            ...input,
            options: { ...input.options, strict: true },
          }).program,
        ).not.toBe(first.program);
        expect(
          createSnapshotProgram({ ...input, snapshotRoot: "/tmp/zedbee-other" })
            .program,
        ).not.toBe(first.program);
        expect(
          createSnapshotProgram({ ...input, rootNames: [] }).program,
        ).not.toBe(first.program);
      });
    } finally {
      await owner.close();
    }
  });
});
