import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import type {
  CheckRunContext,
  CheckTarget,
} from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { CheckIncompleteError } from "../../../src/checks/incomplete-error.js";
import {
  createLintAdapter,
  lintAdapter,
} from "../../../src/checks/eslint/lint-adapter.js";
import {
  createManagedEslint,
  type ManagedEslintOptions,
} from "../../../src/checks/eslint/load-engine.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import {
  createInspectionFixture,
  type InspectionFixture,
} from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const target: CheckTarget = { id: ".", kind: "workspace", relativeRoot: "." };

function changes(files: readonly ChangedFile[]): ChangeSet {
  const map = new Map(files.map((file) => [file.path, file]));
  return {
    files: map,
    isEmpty: map.size === 0,
    containsAddedLine(file, line) {
      return (
        map
          .get(file)
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  };
}

async function pair(): Promise<{
  baseline: InspectionFixture;
  staged: InspectionFixture;
  live: InspectionFixture;
}> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
  }
  return { baseline, staged, live };
}

async function context(
  fixtures: Awaited<ReturnType<typeof pair>>,
  changeSet: ChangeSet,
): Promise<CheckRunContext> {
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  return {
    repositoryRoot: fixtures.live.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: fixtures.baseline.root,
      targetDir: fixtures.staged.root,
      baselineRef: "HEAD",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(fixtures.baseline.root),
    targetInspection: await inspectRepository(fixtures.staged.root),
    target,
    policy: config.checks.lint,
    policyForFile: testFilePolicyResolver(config, changeSet),
    signal: new AbortController().signal,
  };
}

describe("lintAdapter", () => {
  it("plans target-only official fixes with the same grouped per-file rules as analysis", async () => {
    const fixtures = await pair();
    const clean = "export const value = 1;\n";
    const fixable = "export const value = 1;;\n";
    for (const fixture of [fixtures.baseline, fixtures.live]) {
      await fixture.write("src/value.js", clean);
      await fixture.write("test/value.test.js", fixable);
    }
    await fixtures.staged.write("src/value.js", fixable);
    await fixtures.staged.write("test/value.test.js", fixable);
    const changeSet = changes([
      {
        path: "src/value.js",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    const base = await context(fixtures, changeSet);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { rules: { "no-extra-semi": "error" } } },
      overrides: [
        {
          files: ["test/**"],
          checks: { lint: { rules: { "no-extra-semi": "off" } } },
        },
      ],
    });
    const run: CheckRunContext = {
      ...base,
      config,
      policy: config.checks.lint,
      policyForFile: testFilePolicyResolver(config, changeSet),
    };
    const adapter = createLintAdapter();
    const collected = await adapter.collect(run);
    const result = await observationCheckResult("lint", collected, run, true);
    const finding = result.findings.find(
      ({ rule, location }) =>
        rule === "no-extra-semi" && location?.file === "src/value.js",
    );

    expect(finding).toBeDefined();
    await expect(adapter.planFixes?.(run, [finding!])).resolves.toEqual([
      expect.objectContaining({
        checkId: "lint",
        file: "src/value.js",
        baseSource: fixable,
        edits: [expect.objectContaining({ findingId: finding!.id })],
      }),
    ]);
  });

  it("applies per-file rules in grouped engines and reuses target rename policy on both sides", async () => {
    const fixtures = await pair();
    const safe = "/* global console */\nconsole.log('safe');\n";
    const renamed = "/* global console */\nconsole.log('renamed');\n";
    for (const fixture of [fixtures.baseline, fixtures.live]) {
      await fixture.write("src/app.js", safe);
      await fixture.write("src/old.js", renamed);
    }
    await fixtures.staged.write("src/app.js", safe);
    await fixtures.staged.write("test/new.test.js", renamed);
    const changeSet = changes([
      {
        path: "src/app.js",
        status: "modified",
        addedRanges: [{ start: 2, end: 2 }],
      },
      {
        path: "test/new.test.js",
        previousPath: "src/old.js",
        status: "renamed",
        addedRanges: [],
      },
    ]);
    const base = await context(fixtures, changeSet);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { rules: { "no-console": "error" } } },
      overrides: [
        {
          files: ["test/**"],
          checks: { lint: { rules: { "no-console": "off" } } },
        },
      ],
    });
    const run: CheckRunContext = {
      ...base,
      config,
      policy: config.checks.lint,
      policyForFile: testFilePolicyResolver(config, changeSet),
    };
    const factoryCalls: ManagedEslintOptions[] = [];
    const lintCalls: {
      readonly cwd: string;
      readonly files: readonly string[];
    }[] = [];
    const adapter = createLintAdapter((options) => {
      factoryCalls.push(options);
      const engine = createManagedEslint(options);
      return {
        async lintFiles(patterns) {
          const files = typeof patterns === "string" ? [patterns] : patterns;
          lintCalls.push({ cwd: options.cwd, files: [...files] });
          return engine.lintFiles(patterns);
        },
      } satisfies Pick<ESLint, "lintFiles">;
    });

    const collected = await adapter.collect(run);

    expect(
      collected.targetObservations
        .filter(({ rule }) => rule === "no-console")
        .map(({ location }) => location?.file),
    ).toEqual(["src/app.js"]);
    expect(factoryCalls).toHaveLength(4);
    expect(
      factoryCalls
        .filter(({ cwd }) => cwd === run.baselineInspection.snapshotRoot)
        .map(({ ruleOverrides }) => ruleOverrides),
    ).toEqual([{ "no-console": "error" }, { "no-console": "off" }]);
    expect(
      factoryCalls
        .filter(({ cwd }) => cwd === run.targetInspection.snapshotRoot)
        .map(({ ruleOverrides }) => ruleOverrides),
    ).toEqual([{ "no-console": "error" }, { "no-console": "off" }]);
    expect(lintCalls).toEqual(
      expect.arrayContaining([
        {
          cwd: run.baselineInspection.snapshotRoot,
          files: ["src/old.js"],
        },
        {
          cwd: run.targetInspection.snapshotRoot,
          files: ["test/new.test.js"],
        },
      ]),
    );
  });

  it("skips files whose effective per-file lint policy is off", async () => {
    const fixtures = await pair();
    await fixtures.staged.write(
      "generated/broken.js",
      "export const broken = missingName;\n",
    );
    const changeSet = changes([
      {
        path: "generated/broken.js",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    const base = await context(fixtures, changeSet);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      overrides: [
        { files: ["generated/**"], checks: { lint: { severity: "off" } } },
      ],
    });
    const run: CheckRunContext = {
      ...base,
      config,
      policy: config.checks.lint,
      policyForFile: testFilePolicyResolver(config, changeSet),
    };

    await expect(lintAdapter.collect(run)).resolves.toMatchObject({
      baselineObservations: [],
      targetObservations: [],
    });
  });

  it("stops before the next lint rule group when the run is aborted", async () => {
    const fixtures = await pair();
    await fixtures.staged.write("src/a.js", "export const a = 1;\n");
    await fixtures.staged.write("test/b.js", "export const b = 2;\n");
    const changeSet = changes([
      {
        path: "src/a.js",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
      {
        path: "test/b.js",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    const base = await context(fixtures, changeSet);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { rules: { "no-console": "error" } } },
      overrides: [
        {
          files: ["test/**"],
          checks: { lint: { rules: { "no-console": "off" } } },
        },
      ],
    });
    const controller = new AbortController();
    const run: CheckRunContext = {
      ...base,
      config,
      policy: config.checks.lint,
      policyForFile: testFilePolicyResolver(config, changeSet),
      signal: controller.signal,
    };
    const started: string[][] = [];
    const adapter = createLintAdapter((options) => ({
      async lintFiles(patterns) {
        const files = typeof patterns === "string" ? [patterns] : patterns;
        if (options.cwd === run.targetInspection.snapshotRoot) {
          started.push([...files]);
          if (started.length === 1) controller.abort();
        }
        return [];
      },
    }));

    await expect(adapter.collect(run)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(started).toEqual([["src/a.js"]]);
  });

  it("does not start a later lint rule group after the first group rejects", async () => {
    const fixtures = await pair();
    await fixtures.staged.write("src/a.js", "export const a = 1;\n");
    await fixtures.staged.write("test/b.js", "export const b = 2;\n");
    const changeSet = changes([
      {
        path: "src/a.js",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
      {
        path: "test/b.js",
        status: "added",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    const base = await context(fixtures, changeSet);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { lint: { rules: { "no-console": "error" } } },
      overrides: [
        {
          files: ["test/**"],
          checks: { lint: { rules: { "no-console": "off" } } },
        },
      ],
    });
    const run: CheckRunContext = {
      ...base,
      config,
      policy: config.checks.lint,
      policyForFile: testFilePolicyResolver(config, changeSet),
    };
    let rejectFirst: (error: Error) => void = () => undefined;
    const firstResult = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const started: string[][] = [];
    const adapter = createLintAdapter((options) => ({
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
    }));

    const collected = adapter.collect(run);
    await firstStarted;
    rejectFirst(new Error("first group failed"));
    await expect(collected).rejects.toThrow("Managed lint analysis failed.");
    expect(started).toEqual([["src/a.js"]]);
  });

  it("awaits both started sides and rejects in stable baseline-first order", async () => {
    const fixtures = await pair();
    await fixtures.baseline.write("src/old.js", "export const value = 1;\n");
    await fixtures.staged.write("test/new.js", "export const value = 2;\n");
    const changeSet = changes([
      {
        path: "test/new.js",
        previousPath: "src/old.js",
        status: "renamed",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    const run = await context(fixtures, changeSet);
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
      code: "BASELINE_GROUP_FAILED",
      message: "Baseline group failed.",
      path: "src/old.js",
      remediation: "Retry the baseline group.",
    });
    const targetFailure = new CheckIncompleteError({
      code: "TARGET_GROUP_FAILED",
      message: "Target group failed.",
      path: "test/new.js",
      remediation: "Retry the target group.",
    });
    const adapter = createLintAdapter((options) => ({
      async lintFiles() {
        if (options.cwd === run.baselineInspection.snapshotRoot) {
          markBaselineStarted();
          return baselineResult;
        }
        markTargetStarted();
        return targetResult;
      },
    }));

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
      code: "BASELINE_GROUP_FAILED",
      path: "src/old.js",
    });
  });

  it("rejects an out-of-group typed result with a precise incomplete path and no retry", async () => {
    const fixtures = await pair();
    const tsconfig = {
      compilerOptions: { strict: true },
      include: ["src/**/*.ts"],
    };
    for (const fixture of [fixtures.baseline, fixtures.staged]) {
      await fixture.writeJson("tsconfig.json", tsconfig);
      await fixture.write("src/value.ts", "export const value = 1;\n");
    }
    const changeSet = changes([
      {
        path: "src/value.ts",
        status: "modified",
        addedRanges: [{ start: 1, end: 1 }],
      },
    ]);
    const run = await context(fixtures, changeSet);
    let factoryCalls = 0;
    let releaseFactories: () => void = () => undefined;
    const bothFactoriesReady = new Promise<void>((resolve) => {
      releaseFactories = resolve;
    });
    const adapter = createLintAdapter((options) => {
      factoryCalls += 1;
      if (factoryCalls === 2) releaseFactories();
      return {
        async lintFiles() {
          await bothFactoriesReady;
          return options.cwd === run.targetInspection.snapshotRoot
            ? [
                {
                  filePath: join(options.cwd, "src/unrequested.ts"),
                  messages: [],
                  suppressedMessages: [],
                  errorCount: 0,
                  fatalErrorCount: 0,
                  warningCount: 0,
                  fixableErrorCount: 0,
                  fixableWarningCount: 0,
                  usedDeprecatedRules: [],
                },
              ]
            : [];
        },
      };
    });

    await expect(adapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "TYPED_LINT_ANALYSIS_FAILED",
      path: "src/value.ts",
    });
    expect(factoryCalls).toBe(2);
  });

  it("explains when typed lint cannot build a project for staged TypeScript", async () => {
    const fixtures = await pair();
    for (const fixture of [fixtures.baseline, fixtures.staged]) {
      await fixture.write("src/value.ts", "export const value: number = 1;\n");
    }
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.ts",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    );

    await expect(lintAdapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "TYPED_LINT_SETUP_FAILED",
      message:
        "Typed lint could not build a usable project from this workspace's TypeScript configuration.",
      remediation:
        "Verify that a staged tsconfig.json covers the staged TypeScript files and that referenced configurations are present, then retry.",
    });
  });

  it("collects managed JavaScript syntax and recommended-rule observations only from explicit snapshot files", async () => {
    const fixtures = await pair();
    await fixtures.staged.write("src/syntax.js", "export const broken = ;\n");
    await fixtures.staged.write(
      "src/value.js",
      "export const value = missingName;\n",
    );
    await fixtures.staged.write(
      "src/not-requested.txt",
      "const ignored = missingName;\n",
    );
    await fixtures.staged.write(
      "eslint.config.mjs",
      `import { writeFileSync } from "node:fs"; writeFileSync("CONFIG_EXECUTED", "yes"); export default [];`,
    );
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/syntax.js",
          status: "added",
          addedRanges: [{ start: 1, end: 1 }],
        },
        {
          path: "src/value.js",
          status: "added",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    );

    const applicability = await lintAdapter.inspect(run);
    expect(applicability).toMatchObject({
      applies: true,
      requiresBaseline: true,
      targets: [target],
    });
    const collected = await lintAdapter.collect(run);

    expect(collected.targetObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "eslint/parsing-error",
          location: expect.objectContaining({
            file: "src/syntax.js",
            startLine: 1,
          }),
        }),
        expect.objectContaining({
          rule: "no-undef",
          location: expect.objectContaining({
            file: "src/value.js",
            startLine: 1,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(collected)).not.toContain("not-requested.txt");
    await expect(
      access(join(fixtures.staged.root, "CONFIG_EXECUTED")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses type-checked managed rules for staged TypeScript", async () => {
    const fixtures = await pair();
    const config = {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src/**/*.ts"],
    };
    for (const fixture of [fixtures.baseline, fixtures.staged]) {
      await fixture.writeJson("tsconfig.json", config);
      await fixture.write(
        "src/job.ts",
        "export async function job(): Promise<void> {}\nvoid job();\n",
      );
    }
    await fixtures.staged.write(
      "src/job.ts",
      [
        "export async function job(): Promise<void> {}",
        "job();",
        'const value: string = "ok"; const asserted = value!;',
        "[1].forEach(async () => { await job(); });",
        "export { asserted };",
        "",
      ].join("\n"),
    );
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/job.ts",
          status: "modified",
          addedRanges: [{ start: 2, end: 3 }],
        },
      ]),
    );

    const collected = await lintAdapter.collect(run);

    expect(collected.targetObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "@typescript-eslint/no-floating-promises",
          location: expect.objectContaining({
            file: "src/job.ts",
            startLine: 2,
          }),
        }),
        expect.objectContaining({
          rule: "@typescript-eslint/no-unnecessary-type-assertion",
          location: expect.objectContaining({
            file: "src/job.ts",
            startLine: 3,
          }),
        }),
        expect.objectContaining({
          rule: "@typescript-eslint/no-misused-promises",
          location: expect.objectContaining({
            file: "src/job.ts",
            startLine: 4,
          }),
        }),
      ]),
    );
  });

  it("accepts snapshot-contained local extends and project-reference paths", async () => {
    const fixtures = await pair();
    for (const fixture of [fixtures.baseline, fixtures.staged]) {
      await fixture.writeJson("config/strict.json", {
        compilerOptions: { strict: true, target: "ES2022" },
      });
      await fixture.writeJson("packages/shared/tsconfig.json", {
        compilerOptions: { composite: true },
        files: [],
      });
      await fixture.writeJson("tsconfig.json", {
        extends: "./config/strict.json",
        references: [{ path: "packages/shared" }],
        include: ["src/**/*.ts"],
      });
      await fixture.write("src/value.ts", "export const value: number = 1;\n");
    }
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.ts",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    );

    await expect(lintAdapter.collect(run)).resolves.toMatchObject({
      checkId: "lint",
      baselineObservations: [],
      targetObservations: [],
    });
  });

  it("keeps existing debt unattributed and attributes only a new changed-line finding", async () => {
    const fixtures = await pair();
    await fixtures.baseline.write(
      "src/value.js",
      "const oldDebt = missingOld;\nexport { oldDebt };\n",
    );
    await fixtures.staged.write(
      "src/value.js",
      "const oldDebt = missingOld;\nconst added = missingNew;\nexport { oldDebt, added };\n",
    );
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.js",
          status: "modified",
          addedRanges: [{ start: 2, end: 2 }],
        },
      ]),
    );

    const collected = await lintAdapter.collect(run);
    const result = await observationCheckResult("lint", collected, run, true);

    expect(
      result.findings.filter((finding) => finding.attribution.staged),
    ).toEqual([
      expect.objectContaining({
        rule: "no-undef",
        location: expect.objectContaining({ startLine: 2 }),
        attribution: expect.objectContaining({ kind: "range-overlap" }),
      }),
    ]);
    expect(
      result.findings.find((finding) => finding.location?.startLine === 1)
        ?.attribution.staged,
    ).toBe(false);
  });

  it("reads staged snapshots even when an unstaged working-tree edit fixes the issue", async () => {
    const fixtures = await pair();
    await fixtures.baseline.write("src/value.js", "export const value = 1;\n");
    await fixtures.staged.write(
      "src/value.js",
      "export const value = missingName;\n",
    );
    await fixtures.live.write("src/value.js", "export const value = 1;\n");
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.js",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    );

    const collected = await lintAdapter.collect(run);
    expect(collected.targetObservations).toContainEqual(
      expect.objectContaining({ rule: "no-undef" }),
    );
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{ not-json"],
    [
      "escaping extends",
      JSON.stringify({ extends: "../outside.json", include: ["src/**/*.ts"] }),
    ],
    [
      "package extends",
      JSON.stringify({
        extends: "@company/tsconfig",
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "escaping reference",
      JSON.stringify({
        references: [{ path: "../outside" }],
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "absolute files entry",
      JSON.stringify({ files: ["/private/outside.ts"] }),
    ],
    [
      "drive include entry",
      JSON.stringify({ include: ["C:/outside/**/*.ts"] }),
    ],
    [
      "URL include entry",
      JSON.stringify({ include: ["file:///private/outside.ts"] }),
    ],
    [
      "backslash exclude entry",
      JSON.stringify({ include: ["src/**/*.ts"], exclude: ["..\\outside"] }),
    ],
    [
      "escaping baseUrl",
      JSON.stringify({
        compilerOptions: { baseUrl: "../outside" },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "escaping paths mapping",
      JSON.stringify({
        compilerOptions: { paths: { "@app/*": ["../outside/*"] } },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "escaping typeRoots",
      JSON.stringify({
        compilerOptions: { typeRoots: ["../outside/types"] },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "escaping rootDirs",
      JSON.stringify({
        compilerOptions: { rootDirs: ["src", "../outside"] },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "escaping rootDir",
      JSON.stringify({
        compilerOptions: { rootDir: "../outside" },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "absolute outDir",
      JSON.stringify({
        compilerOptions: { outDir: "/private/build" },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "drive declarationDir",
      JSON.stringify({
        compilerOptions: { declarationDir: "C:/build" },
        include: ["src/**/*.ts"],
      }),
    ],
    [
      "escaping tsBuildInfoFile",
      JSON.stringify({
        compilerOptions: { tsBuildInfoFile: "../cache/build.tsbuildinfo" },
        include: ["src/**/*.ts"],
      }),
    ],
  ])("fails closed when typed lint has %s config", async (_label, tsconfig) => {
    const fixtures = await pair();
    await fixtures.staged.write(
      "src/value.ts",
      "export const value: number = 1;\n",
    );
    if (tsconfig !== undefined)
      await fixtures.staged.write("tsconfig.json", `${tsconfig}\n`);
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.ts",
          status: "added",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    );

    await expect(lintAdapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "TYPED_LINT_SETUP_FAILED",
    });
  });

  it("fails incomplete when a safe config cannot initialize typed lint for an inspected file", async () => {
    const fixtures = await pair();
    await fixtures.staged.writeJson("tsconfig.json", {
      compilerOptions: { strict: true },
      include: ["other/**/*.ts"],
    });
    await fixtures.staged.write("src/value.ts", "export const value = 1;\n");
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.ts",
          status: "added",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    );

    await expect(lintAdapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "TYPED_LINT_SETUP_FAILED",
    });
  });

  it("explains when typed lint cannot analyze every file in a mixed TypeScript workspace", async () => {
    const fixtures = await pair();
    const nestedConfig = {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "Bundler",
      },
      include: ["src/**/*"],
    };
    for (const fixture of [fixtures.baseline, fixtures.staged]) {
      await fixture.writeJson("tools/tsconfig.json", nestedConfig);
      await fixture.write(
        "tools/src/value.ts",
        "export const value: number = 1;\n",
      );
      await fixture.write(
        "docs/config.mts",
        "export const title: string = 'Docs';\n",
      );
    }
    const run = await context(
      fixtures,
      changes([
        {
          path: "docs/config.mts",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ]),
    );

    await expect(lintAdapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "TYPED_LINT_ANALYSIS_FAILED",
      message:
        "Typed lint could not analyze every requested TypeScript file with the configured project.",
      remediation:
        "Verify that the staged TypeScript configuration includes every staged TypeScript file, then retry. If it does, report a Zedbee typed-lint compatibility issue.",
    });
  });

  it.each([
    ["escaping relative", "../../outside.ts"],
    ["file URL", "file:///private/outside.ts"],
    ["network URL", "https://example.invalid/outside.ts"],
  ])("rejects a %s staged TypeScript import", async (_label, specifier) => {
    const fixtures = await pair();
    await fixtures.staged.writeJson("tsconfig.json", {
      compilerOptions: { strict: true },
      include: ["src/**/*.ts"],
    });
    await fixtures.staged.write(
      "src/value.ts",
      `import { outside } from ${JSON.stringify(specifier)};\nexport const value = outside;\n`,
    );
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.ts",
          status: "added",
          addedRanges: [{ start: 1, end: 2 }],
        },
      ]),
    );

    await expect(lintAdapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "TYPED_LINT_SETUP_FAILED",
    });
  });

  it("uses the snapshot program for node and installed-package imports", async () => {
    const fixtures = await pair();
    await fixtures.live.symlink(
      join(process.cwd(), "node_modules"),
      "node_modules",
    );
    await fixtures.staged.writeJson("tsconfig.json", {
      compilerOptions: { strict: true },
      include: ["src/**/*.ts"],
    });
    await fixtures.staged.write(
      "src/value.ts",
      [
        'import type { Stats } from "node:fs";',
        'import type { Linter } from "eslint";',
        "export type Result = Stats | Linter.Config;",
        "",
      ].join("\n"),
    );
    const run = await context(
      fixtures,
      changes([
        {
          path: "src/value.ts",
          status: "added",
          addedRanges: [{ start: 1, end: 3 }],
        },
      ]),
    );

    await expect(lintAdapter.collect(run)).resolves.toMatchObject({
      checkId: "lint",
      targetObservations: [],
    });
  });
});
