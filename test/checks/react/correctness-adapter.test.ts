import { access } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ESLint, Linter } from "eslint";
import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { createManagedEslint } from "../../../src/checks/eslint/load-engine.js";
import type { ManagedEslintOptions } from "../../../src/checks/eslint/load-engine.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { CheckIncompleteError } from "../../../src/checks/incomplete-error.js";
import { createReactAdapter } from "../../../src/checks/react/adapter.js";
import { managedReactCorrectnessConfig } from "../../../src/checks/react/config.js";
import { reactCorrectnessAdapter } from "../../../src/checks/react/correctness-adapter.js";
import {
  createReactVersionResolver,
  resolveReactVersion,
} from "../../../src/checks/react/version.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import type { RepositoryInspection } from "../../../src/inspection/types.js";
import {
  createInspectionFixture,
  type InspectionFixture,
} from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

async function writeReactResolutionFixture(
  fixture: InspectionFixture,
  version: "18.3.1" | "19.2.0",
): Promise<void> {
  await fixture.writeJson("package.json", {
    name: "fixture",
    private: true,
    dependencies: { react: ">=18 <20", "react-dom": ">=18 <20" },
  });
  await fixture.writeJson("package-lock.json", {
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/react": { version },
    },
  });
}

async function reactContext(
  environment: "react" | "ink",
  options: {
    readonly filePath?: string;
    readonly cleanSource?: string;
    readonly stagedSource?: string;
  } = {},
) {
  const filePath = options.filePath ?? "src/app.tsx";
  const cleanSource =
    options.cleanSource ?? "export const App = () => <main />;\n";
  const stagedSource =
    options.stagedSource ??
    [
      'import { useState } from "react";',
      "export function App({ ready }: { ready: boolean }) {",
      "  if (ready) useState(0);",
      "  return [1, 2].map(value => <span>{value}</span>);",
      "}",
      "",
    ].join("\n");
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", {
      name: "fixture",
      private: true,
      dependencies:
        environment === "ink"
          ? { react: "19.0.0", ink: "7.0.0" }
          : { react: "19.0.0", "react-dom": "19.0.0" },
    });
    await fixture.write(filePath, cleanSource);
  }
  await staged.write(filePath, stagedSource);
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  const changedFiles = new Map<string, ChangedFile>([
    [
      filePath,
      {
        path: filePath,
        status: "modified",
        addedRanges: [{ start: 1, end: 5 }],
      },
    ],
  ]);
  const changeSet: ChangeSet = {
    files: changedFiles,
    isEmpty: false,
    containsAddedLine(file, line) {
      return (
        changedFiles
          .get(file)
          ?.addedRanges.some(
            ({ start, end }) => line >= start && line <= end,
          ) ?? false
      );
    },
  };
  return {
    fixtures: { baseline, staged, live },
    changedFiles,
    run: {
      repositoryRoot: live.root,
      changeSet,
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        targetRef: "index",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(staged.root),
      target: { id: ".", kind: "workspace", relativeRoot: "." },
      policy: config.checks.reactCorrectness,
      policyForFile: testFilePolicyResolver(config, changeSet),
      signal: new AbortController().signal,
    } satisfies CheckRunContext,
  };
}

async function groupedReactContext(): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", {
      name: "fixture",
      private: true,
      dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
    });
  }
  await staged.write("src/a.tsx", "export const A = () => <main />;\n");
  await staged.write("test/b.tsx", "export const B = () => <main />;\n");
  const changedFiles = new Map<string, ChangedFile>([
    [
      "src/a.tsx",
      {
        path: "src/a.tsx",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ],
    [
      "test/b.tsx",
      {
        path: "test/b.tsx",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ],
  ]);
  const changeSet: ChangeSet = {
    files: changedFiles,
    isEmpty: false,
    containsAddedLine: () => true,
  };
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    checks: {
      reactCorrectness: { rules: { "react/jsx-key": "error" } },
    },
    overrides: [
      {
        files: ["test/**"],
        checks: {
          reactCorrectness: { rules: { "react/jsx-key": "off" } },
        },
      },
    ],
  });
  return {
    repositoryRoot: live.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: staged.root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(staged.root),
    target: { id: ".", kind: "workspace", relativeRoot: "." },
    policy: config.checks.reactCorrectness,
    policyForFile: testFilePolicyResolver(config, changeSet),
    signal: new AbortController().signal,
  };
}

describe("reactCorrectnessAdapter", () => {
  it("plans a reported official React plugin fix from the target snapshot", async () => {
    const source = 'export const App = () => <div class="button" />;\n';
    const { run } = await reactContext("react", {
      cleanSource: 'export const App = () => <div className="button" />;\n',
      stagedSource: source,
    });
    const collected = await reactCorrectnessAdapter.collect(run);
    const result = await observationCheckResult(
      "reactCorrectness",
      collected,
      run,
      true,
    );
    const finding = result.findings.find(
      ({ rule }) => rule === "react/no-unknown-property",
    );

    expect(finding).toBeDefined();
    await expect(
      reactCorrectnessAdapter.planFixes?.(run, [finding!]),
    ).resolves.toEqual([
      expect.objectContaining({
        checkId: "reactCorrectness",
        file: "src/app.tsx",
        baseSource: source,
        edits: [expect.objectContaining({ findingId: finding!.id })],
      }),
    ]);
  });

  it("applies grouped per-file rules with identical patches on both snapshot sides", async () => {
    const { fixtures, changedFiles, run } = await reactContext("react");
    const clean =
      "export const App = () => [1].map(value => <span key={value}>{value}</span>);\n";
    const violating =
      "export const App = () => [1].map(value => <span>{value}</span>);\n";
    for (const fixture of [fixtures.baseline, fixtures.live]) {
      await fixture.write("src/app.tsx", clean);
      await fixture.write("test/app.test.tsx", clean);
    }
    await fixtures.staged.write("src/app.tsx", violating);
    await fixtures.staged.write("test/app.test.tsx", violating);
    changedFiles.set("src/app.tsx", {
      path: "src/app.tsx",
      status: "modified",
      addedRanges: [{ start: 1, end: 1 }],
    });
    changedFiles.set("test/app.test.tsx", {
      path: "test/app.test.tsx",
      status: "modified",
      addedRanges: [{ start: 1, end: 1 }],
    });
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        reactCorrectness: { rules: { "react/jsx-key": "error" } },
      },
      overrides: [
        {
          files: ["test/**"],
          checks: {
            reactCorrectness: { rules: { "react/jsx-key": "off" } },
          },
        },
      ],
    });
    const context: CheckRunContext = {
      ...run,
      config,
      baselineInspection: await inspectRepository(fixtures.baseline.root),
      targetInspection: await inspectRepository(fixtures.staged.root),
      policy: config.checks.reactCorrectness,
      policyForFile: testFilePolicyResolver(config, run.changeSet),
    };
    const factoryCalls: ManagedEslintOptions[] = [];
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      (options) => {
        factoryCalls.push(options);
        return createManagedEslint(options);
      },
    );

    const collected = await adapter.collect(context);

    expect(
      collected.targetObservations
        .filter(({ rule }) => rule === "react/jsx-key")
        .map(({ location }) => location?.file),
    ).toEqual(["src/app.tsx"]);
    expect(factoryCalls).toHaveLength(4);
    for (const inspection of [
      context.baselineInspection,
      context.targetInspection,
    ]) {
      expect(
        factoryCalls
          .filter(({ cwd }) => cwd === inspection.snapshotRoot)
          .map(({ ruleOverrides }) => ruleOverrides),
      ).toEqual([{ "react/jsx-key": "error" }, { "react/jsx-key": "off" }]);
    }
  });

  it("reports a precise incomplete path without retrying a failed correctness group", async () => {
    const { run } = await reactContext("react");
    let factoryCalls = 0;
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      (options) => {
        factoryCalls += 1;
        return {
          async lintFiles() {
            if (options.cwd === run.targetInspection.snapshotRoot) {
              throw new Error("engine failure");
            }
            return [];
          },
        };
      },
    );

    await expect(adapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "REACT_CORRECTNESS_ANALYSIS_FAILED",
      path: "src/app.tsx",
    });
    expect(factoryCalls).toBe(2);
  });

  it("does not create or start a later React rule group after the first rejects", async () => {
    const run = await groupedReactContext();
    let rejectFirst: (error: Error) => void = () => undefined;
    const firstResult = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const created: string[] = [];
    const started: string[][] = [];
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      (options) => {
        if (options.cwd === run.targetInspection.snapshotRoot) {
          created.push(String(options.ruleOverrides?.["react/jsx-key"]));
        }
        return {
          async lintFiles(patterns) {
            const files = typeof patterns === "string" ? [patterns] : patterns;
            if (options.cwd !== run.targetInspection.snapshotRoot) return [];
            started.push([...files]);
            if (started.length === 1) {
              markFirstStarted();
              return firstResult;
            }
            return [];
          },
        };
      },
    );

    const collected = adapter.collect(run);
    await firstStarted;
    rejectFirst(new Error("first group failed"));
    await expect(collected).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "REACT_CORRECTNESS_ANALYSIS_FAILED",
      path: "src/a.tsx",
    });
    expect(created).toEqual(["error"]);
    expect(started).toEqual([["src/a.tsx"]]);
  });

  it("stops before the next React rule group when the run is aborted", async () => {
    const base = await groupedReactContext();
    const controller = new AbortController();
    const run: CheckRunContext = { ...base, signal: controller.signal };
    const created: string[] = [];
    const started: string[][] = [];
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      (options) => {
        if (options.cwd === run.targetInspection.snapshotRoot) {
          created.push(String(options.ruleOverrides?.["react/jsx-key"]));
        }
        return {
          async lintFiles(patterns) {
            const files = typeof patterns === "string" ? [patterns] : patterns;
            if (options.cwd === run.targetInspection.snapshotRoot) {
              started.push([...files]);
              if (started.length === 1) controller.abort();
            }
            return [];
          },
        };
      },
    );

    await expect(adapter.collect(run)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(created).toEqual(["error"]);
    expect(started).toEqual([["src/a.tsx"]]);
  });

  it("awaits both React sides and uses stable baseline-first failure precedence", async () => {
    const { run } = await reactContext("react");
    let rejectBaseline: (error: Error) => void = () => undefined;
    const baselineResult = new Promise<never>((_resolve, reject) => {
      rejectBaseline = reject;
    });
    let rejectTarget: (error: Error) => void = () => undefined;
    const targetResult = new Promise<never>((_resolve, reject) => {
      rejectTarget = reject;
    });
    let markBaselineStarted: () => void = () => undefined;
    const baselineStarted = new Promise<void>((resolve) => {
      markBaselineStarted = resolve;
    });
    let markTargetStarted: () => void = () => undefined;
    const targetStarted = new Promise<void>((resolve) => {
      markTargetStarted = resolve;
    });
    const baselineFailure = new CheckIncompleteError({
      code: "BASELINE_REACT_FAILED",
      message: "Baseline React group failed.",
      path: "src/app.tsx",
      remediation: "Retry the baseline React group.",
    });
    const targetFailure = new CheckIncompleteError({
      code: "TARGET_REACT_FAILED",
      message: "Target React group failed.",
      path: "src/app.tsx",
      remediation: "Retry the target React group.",
    });
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      (options) => ({
        async lintFiles() {
          if (options.cwd === run.baselineInspection.snapshotRoot) {
            markBaselineStarted();
            return baselineResult;
          }
          markTargetStarted();
          return targetResult;
        },
      }),
    );

    let collectionSettled = false;
    const outcome = adapter.collect(run).then(
      () => {
        collectionSettled = true;
        return undefined;
      },
      (error: unknown) => {
        collectionSettled = true;
        return error;
      },
    );
    await Promise.all([baselineStarted, targetStarted]);
    rejectTarget(targetFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeBaseline = collectionSettled;
    rejectBaseline(baselineFailure);
    const error = await outcome;

    expect(settledBeforeBaseline).toBe(false);
    expect(error).toMatchObject({
      name: "CheckIncompleteError",
      code: "BASELINE_REACT_FAILED",
      path: "src/app.tsx",
    });
  });

  it("skips effective-off files before React version resolution or engine creation", async () => {
    const { run } = await reactContext("react");
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      overrides: [
        {
          files: ["src/**"],
          checks: { reactCorrectness: { severity: "off" } },
        },
      ],
    });
    const context: CheckRunContext = {
      ...run,
      config,
      policy: config.checks.reactCorrectness,
      policyForFile: testFilePolicyResolver(config, run.changeSet),
    };
    let engineCalls = 0;
    let resolverCalls = 0;
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      () => {
        engineCalls += 1;
        throw new Error("engine should not be created");
      },
      async () => {
        resolverCalls += 1;
        throw new Error("React version should not be resolved");
      },
    );

    await expect(adapter.collect(context)).resolves.toMatchObject({
      baselineObservations: [],
      targetObservations: [],
    });
    expect(engineCalls).toBe(0);
    expect(resolverCalls).toBe(0);
  });

  it("parses each lockfile once per immutable snapshot across many workspaces", async () => {
    const workspaceCount = 8;
    const [baseline, target, live] = await Promise.all([
      createInspectionFixture(),
      createInspectionFixture(),
      createInspectionFixture(),
    ]);
    const fixtures = [baseline, target, live] as const;
    for (const fixture of fixtures) {
      await fixture.writeJson("package.json", {
        private: true,
        workspaces: ["packages/*"],
      });
      for (let index = 0; index < workspaceCount; index += 1) {
        const root = `packages/app-${index}`;
        await fixture.writeJson(`${root}/package.json`, {
          name: `app-${index}`,
          dependencies: { react: ">=18 <20", "react-dom": ">=18 <20" },
        });
        await fixture.write(
          `${root}/src/app.tsx`,
          "export const App = () => <main />;\n",
        );
        await fixture.writeJson(`${root}/package-lock.json`, {
          lockfileVersion: 3,
          packages: {},
        });
      }
    }
    const [baselineInspection, targetInspection] = await Promise.all([
      inspectRepository(baseline.root),
      inspectRepository(target.root),
    ]);
    const parseCounts = new Map<string, number>();
    const resolverInspections: RepositoryInspection[] = [];
    const resolverFactory = (inspection: RepositoryInspection) => {
      resolverInspections.push(inspection);
      return createReactVersionResolver(
        inspection,
        async (current, lockfile) => {
          const key = `${current.snapshotRoot}\0${lockfile}`;
          parseCounts.set(key, (parseCounts.get(key) ?? 0) + 1);
          return Object.freeze([
            Object.freeze({
              name: "react",
              version: current === baselineInspection ? "18.3.1" : "19.2.0",
              ecosystem: "npm" as const,
              lockfilePath: lockfile,
              importer: ".",
              dependencyPath: Object.freeze(["react"]),
            }),
          ]);
        },
      );
    };
    const configuredVersions: {
      readonly cwd: string;
      readonly version?: string;
    }[] = [];
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      (options) => {
        configuredVersions.push({
          cwd: options.cwd,
          ...(options.reactVersion === undefined
            ? {}
            : { version: options.reactVersion }),
        });
        return {
          async lintFiles() {
            return [];
          },
        };
      },
      resolverFactory,
    );
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
    const changedFiles = new Map<string, ChangedFile>();
    for (let index = 0; index < workspaceCount; index += 1) {
      const path = `packages/app-${index}/src/app.tsx`;
      changedFiles.set(path, {
        path,
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      });
    }
    const changeSet: ChangeSet = {
      files: changedFiles,
      isEmpty: false,
      containsAddedLine: () => true,
    };

    await Promise.all(
      targetInspection.workspaces
        .filter(({ relativeRoot }) => relativeRoot !== ".")
        .map((workspace) =>
          adapter.collect({
            repositoryRoot: live.root,
            changeSet,
            config,
            snapshots: {
              baselineDir: baseline.root,
              targetDir: target.root,
              baselineRef: "HEAD",
              targetRef: "index",
              unsupportedEntries: [],
            },
            baselineInspection,
            targetInspection,
            target: {
              id: workspace.relativeRoot,
              kind: "workspace",
              relativeRoot: workspace.relativeRoot,
            },
            policy: config.checks.reactCorrectness,
            policyForFile: testFilePolicyResolver(config),
            signal: new AbortController().signal,
          }),
        ),
    );

    expect(resolverInspections).toHaveLength(2);
    expect(new Set(resolverInspections)).toEqual(
      new Set([baselineInspection, targetInspection]),
    );
    expect(parseCounts.size).toBe(
      baselineInspection.lockfiles.length + targetInspection.lockfiles.length,
    );
    expect([...parseCounts.values()].every((count) => count === 1)).toBe(true);
    expect(
      configuredVersions.filter(
        ({ cwd, version }) =>
          cwd === baselineInspection.snapshotRoot && version === "18.3.1",
      ),
    ).toHaveLength(workspaceCount);
    expect(
      configuredVersions.filter(
        ({ cwd, version }) =>
          cwd === targetInspection.snapshotRoot && version === "19.2.0",
      ),
    ).toHaveLength(workspaceCount);
    expect(
      targetInspection.lockfiles.every((lockfile) =>
        posix.dirname(lockfile).startsWith("packages/app-"),
      ),
    ).toBe(true);
  });

  it("calibration resolves baseline and target React versions independently", async () => {
    const { fixtures, run } = await reactContext("react");
    await writeReactResolutionFixture(fixtures.baseline, "18.3.1");
    await writeReactResolutionFixture(fixtures.staged, "19.2.0");
    const context: CheckRunContext = {
      ...run,
      baselineInspection: await inspectRepository(fixtures.baseline.root),
      targetInspection: await inspectRepository(fixtures.staged.root),
    };
    const versions: string[] = [];
    const configFactory = (version: string): Linter.Config => {
      versions.push(version);
      return managedReactCorrectnessConfig(version);
    };
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      configFactory,
    );

    await adapter.collect(context);

    expect(versions).toEqual(["18.3.1", "19.2.0"]);
  });

  it("starts target lint before baseline lint completes", async () => {
    const { run } = await reactContext("react");
    let markTargetStarted: () => void = () => undefined;
    const targetStarted = new Promise<void>((resolve) => {
      markTargetStarted = resolve;
    });
    let targetStartedWhileBaselineHeld = false;
    const engineFactory = (
      options: ManagedEslintOptions,
    ): Pick<ESLint, "lintFiles"> => {
      const engine = createManagedEslint(options);
      return {
        async lintFiles(patterns) {
          if (options.cwd === run.baselineInspection.snapshotRoot) {
            let timeout: NodeJS.Timeout | undefined;
            try {
              targetStartedWhileBaselineHeld = await Promise.race([
                targetStarted.then(() => true),
                new Promise<boolean>((resolve) => {
                  timeout = setTimeout(() => resolve(false), 250);
                }),
              ]);
            } finally {
              if (timeout !== undefined) clearTimeout(timeout);
            }
          } else if (options.cwd === run.targetInspection.snapshotRoot) {
            markTargetStarted();
          }
          return engine.lintFiles(patterns);
        },
      };
    };
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      managedReactCorrectnessConfig,
      engineFactory,
    );

    const result = await adapter.collect(run);

    expect(targetStartedWhileBaselineHeld).toBe(true);
    expect(result.targetObservations).toContainEqual(
      expect.objectContaining({ rule: "react-hooks/rules-of-hooks" }),
    );
  });

  it("calibration never executes project React from node_modules", async () => {
    const { fixtures, run } = await reactContext("react");
    await writeReactResolutionFixture(fixtures.staged, "19.2.0");
    await fixtures.staged.write(
      "node_modules/react/index.js",
      [
        `require("node:fs").writeFileSync(${JSON.stringify(join(fixtures.staged.root, "REACT_EXECUTED"))}, "yes");`,
        "module.exports = {};",
        "",
      ].join("\n"),
    );
    const targetInspection = await inspectRepository(fixtures.staged.root);
    const context: CheckRunContext = {
      ...run,
      targetInspection,
    };
    const versions: string[] = [];
    const adapter = createReactAdapter(
      "reactCorrectness",
      "react-correctness",
      (version): Linter.Config => {
        versions.push(version);
        return managedReactCorrectnessConfig(version);
      },
    );

    await adapter.collect(context);

    const workspace = targetInspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === ".",
    );
    expect(workspace).toBeDefined();
    await expect(
      resolveReactVersion(targetInspection, workspace!),
    ).resolves.toEqual({ version: "19.2.0", source: "lockfile" });
    expect(versions[1]).toBe("19.2.0");
    await expect(
      access(join(fixtures.staged.root, "REACT_EXECUTED")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["react", "ink"] as const)(
    "finds Rules of Hooks and missing-key violations in a %s workspace",
    async (environment) => {
      const { run } = await reactContext(environment);

      await expect(reactCorrectnessAdapter.inspect(run)).resolves.toMatchObject(
        {
          applies: true,
          requiresBaseline: true,
          targets: [{ id: ".", kind: "workspace", relativeRoot: "." }],
        },
      );
      const result = await reactCorrectnessAdapter.collect(run);

      expect(result.targetObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "react-hooks/rules-of-hooks" }),
          expect.objectContaining({ rule: "react/jsx-key" }),
        ]),
      );
    },
  );

  it.each(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"])(
    "parses managed .%s source without project configuration",
    async (extension) => {
      const filePath = `src/app.${extension}`;
      const { run } = await reactContext("react", {
        filePath,
        cleanSource: "export function App() { return null; }\n",
        stagedSource:
          "export function App(ready) { if (ready) useState(0); return null; }\n",
      });

      const result = await reactCorrectnessAdapter.collect(run);

      expect(result.targetObservations).toContainEqual(
        expect.objectContaining({
          rule: "react-hooks/rules-of-hooks",
          location: expect.objectContaining({ file: filePath }),
        }),
      );
    },
  );

  it("returns a parsing observation instead of an empty success for malformed JSX", async () => {
    const { fixtures, run } = await reactContext("react");
    await fixtures.staged.write(
      "src/app.tsx",
      "export const App = () => <main>;\n",
    );

    const result = await reactCorrectnessAdapter.collect(run);

    expect(result.targetObservations).toContainEqual(
      expect.objectContaining({
        check: "reactCorrectness",
        rule: "eslint/parsing-error",
        location: expect.objectContaining({ file: "src/app.tsx" }),
      }),
    );
  });

  it("attributes only the new changed-line finding and ignores clean live code", async () => {
    const { fixtures, changedFiles, run } = await reactContext("react");
    const existing = [
      "export function Existing({ ready }: { ready: boolean }) {",
      "  if (ready) React.useState(0);",
      "  return null;",
      "}",
      "",
    ].join("\n");
    await fixtures.baseline.write("src/app.tsx", existing);
    await fixtures.staged.write(
      "src/app.tsx",
      [
        existing.trimEnd(),
        "export function Added({ ready }: { ready: boolean }) {",
        "  if (ready) React.useState(0);",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    await fixtures.live.write(
      "src/app.tsx",
      "export function Added() { return null; }\n",
    );
    changedFiles.set("src/app.tsx", {
      path: "src/app.tsx",
      status: "modified",
      addedRanges: [{ start: 5, end: 8 }],
    });

    const collected = await reactCorrectnessAdapter.collect(run);
    const result = await observationCheckResult(
      "reactCorrectness",
      collected,
      run,
      true,
    );

    expect(
      result.findings
        .filter(({ rule }) => rule === "react-hooks/rules-of-hooks")
        .map(({ attribution, location }) => ({
          staged: attribution.staged,
          line: location?.startLine,
        })),
    ).toEqual([
      { staged: false, line: 2 },
      { staged: true, line: 6 },
    ]);
  });

  it("never executes project ESLint config and emits only normalized observations", async () => {
    const { fixtures, run } = await reactContext("react");
    await fixtures.staged.write(
      "eslint.config.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("CONFIG_EXECUTED", "yes");',
        "export default [];",
        "",
      ].join("\n"),
    );

    const collected = await reactCorrectnessAdapter.collect(run);
    const serialized = JSON.stringify(collected);

    await expect(
      access(join(fixtures.staged.root, "CONFIG_EXECUTED")),
    ).rejects.toThrow();
    expect(serialized).not.toContain(fixtures.staged.root);
    expect(serialized).not.toContain(fixtures.live.root);
    expect(serialized).not.toContain("useState } from");
    expect(serialized).not.toContain('"fix"');
    expect(serialized).not.toContain('"suggestions"');
  });
});
