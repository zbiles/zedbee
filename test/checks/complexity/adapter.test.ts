import { describe, expect, it } from "vitest";
import type {
  CheckRunContext,
  CheckTarget,
} from "../../../src/checks/adapter.js";
import {
  collectComplexityObservations,
  complexityAdapters,
} from "../../../src/checks/complexity/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { CheckId } from "../../../src/config/schema.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const target: CheckTarget = { id: ".", kind: "workspace", relativeRoot: "." };

function changes(): ChangeSet {
  return {
    files: new Map([
      [
        "src/changed.ts",
        {
          path: "src/changed.ts",
          status: "modified",
          addedRanges: [{ start: 2, end: 3 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine(file, line) {
      return file === "src/changed.ts" && line >= 2 && line <= 3;
    },
  };
}

function perFileLimitChanges(): ChangeSet {
  return {
    files: new Map([
      [
        "src/strict.ts",
        {
          path: "src/strict.ts",
          status: "modified",
          addedRanges: [{ start: 1, end: 9 }],
        },
      ],
      [
        "test/renamed.test.ts",
        {
          path: "test/renamed.test.ts",
          previousPath: "src/legacy.ts",
          status: "renamed",
          addedRanges: [{ start: 1, end: 9 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine(file, line) {
      return (
        (file === "src/strict.ts" || file === "test/renamed.test.ts") &&
        line >= 1 &&
        line <= 9
      );
    },
  };
}

function branchySource(name: string): string {
  return [
    `export function ${name}(value: number) {`,
    "  let total = 0;",
    "  if (value > 0) total += 1;",
    "  if (value > 1) total += 1;",
    "  if (value > 2) total += 1;",
    "  if (value > 3) total += 1;",
    "  return total;",
    "}",
    "",
  ].join("\n");
}

async function complexityContext(checkId: CheckId): Promise<CheckRunContext> {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
    await fixture.write(
      "src/debt.ts",
      "export function debt(a: boolean) { if (a) { if (!a) return 1; } return 0; }\n",
    );
    await fixture.write(
      "src/untouched.ts",
      "export function untouched(a: boolean) { if (a) return 1; return 0; }\n",
    );
  }
  await baseline.write(
    "src/changed.ts",
    "export function changed(a: boolean) { if (a) return 1; return 0; }\n",
  );
  await staged.write(
    "src/changed.ts",
    [
      "export function changed(a: boolean) {",
      "  if (a) { if (!a) return 1; }",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
  );
  // The repository working tree is deliberately simpler than the staged snapshot.
  await live.write(
    "src/changed.ts",
    "export function changed() { return 0; }\n",
  );
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    checks: { [checkId]: { severity: "error", max: 1, blockWorsening: true } },
  });
  return {
    repositoryRoot: live.root,
    changeSet: changes(),
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
    target,
    policy: config.checks[checkId],
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

describe("collectComplexityObservations", () => {
  it("attributes object-property arrow metrics to the arrow instead of the enclosing function", async () => {
    const observations = await collectComplexityObservations(
      "src/adapter.ts",
      [
        "export function makeAdapter() {",
        "  return {",
        "    inspect: () => (ready ? true : false),",
        "    async collect() { return true; },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );

    const metrics = observations
      .filter(({ rule }) => rule === "cyclomatic-complexity")
      .map(({ entity, metric }) => ({
        name: entity?.name,
        value: metric?.value,
      }));
    expect(metrics).toHaveLength(3);
    expect(metrics).toEqual(
      expect.arrayContaining([
        { name: "makeAdapter", value: 1 },
        { name: "inspect", value: 2 },
        { name: "collect", value: 1 },
      ]),
    );
  });

  it("attributes computed object methods without duplicating the enclosing function metric", async () => {
    const observations = await collectComplexityObservations(
      "src/readonly-map.ts",
      [
        "export function readonlyMap() {",
        "  return {",
        "    [Symbol.iterator]() { return [][Symbol.iterator](); },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );

    expect(
      observations
        .filter(({ rule }) => rule === "cyclomatic-complexity")
        .map(({ entity, metric }) => ({
          name: entity?.name,
          value: metric?.value,
        })),
    ).toEqual(
      expect.arrayContaining([
        { name: "readonlyMap", value: 1 },
        { name: "Symbol.iterator", value: 1 },
      ]),
    );
  });

  it("retains real metrics for unresolved computed-property arrows", async () => {
    const observations = await collectComplexityObservations(
      "value.ts",
      'const key = "run"; export const value = { [key]: () => ready ? 1 : 0 };',
    );

    expect(
      observations
        .filter(({ rule }) => rule === "cyclomatic-complexity")
        .map(({ entity, identity, metric }) => ({
          name: entity?.name,
          identity,
          value: metric?.value,
        })),
    ).toContainEqual({
      name: "anonymous@1.1.0.1.0.1",
      identity:
        "function:value.ts:variable=value/function=anonymous%401.1.0.1.0.1",
      value: 2,
    });
  });

  it("attributes class-field initializer metrics to canonical field entities", async () => {
    const observations = await collectComplexityObservations(
      "src/stream.ts",
      [
        "export class BatchStream {",
        "  private current: Buffer<ArrayBufferLike> = Buffer.alloc(0);",
        "  private offset = 0;",
        "  private ended = false;",
        "}",
        "",
      ].join("\n"),
    );

    expect(
      observations
        .filter(({ rule }) => rule === "cyclomatic-complexity")
        .map(({ entity, metric }) => ({
          name: entity?.name,
          value: metric?.value,
        })),
    ).toEqual([
      { name: "current", value: 1 },
      { name: "offset", value: 1 },
      { name: "ended", value: 1 },
    ]);
  });

  it("uses canonical member and nested-function entity identities for both metrics", async () => {
    const observations = await collectComplexityObservations(
      "src/owners.ts",
      `class Worker { constructor() { if (ready) work(); } static get value() { return ready ? 1 : 0; } method() { const nested = () => { if (ready) work(); }; } }`,
    );

    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "cyclomaticComplexity",
          entity: expect.objectContaining({
            kind: "method",
            name: "constructor",
          }),
          identity: expect.stringContaining("member-role=constructor"),
        }),
        expect.objectContaining({
          check: "readabilityComplexity",
          entity: expect.objectContaining({ kind: "method", name: "value" }),
          identity: expect.stringContaining("member-role=get"),
        }),
        expect.objectContaining({
          check: "readabilityComplexity",
          entity: expect.objectContaining({ kind: "function", name: "nested" }),
          identity: expect.stringContaining("method=method/function=nested"),
        }),
      ]),
    );
    expect(observations.every(({ metric }) => metric !== undefined)).toBe(true);
  });

  it("fails closed when managed parsing cannot produce entity metrics", async () => {
    await expect(
      collectComplexityObservations("src/broken.ts", "function broken( {"),
    ).rejects.toThrow(SyntaxError);
  });

  it("maps callbacks and class-field arrows one-to-one without duplicate metric identities", async () => {
    const observations = await collectComplexityObservations(
      "src/callback.ts",
      "export function outer(xs: number[]) { return xs.map(x => x ? 1 : 0); } class Worker { task = () => ready ? work() : rest(); }",
    );

    for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
      const metrics = observations.filter(
        (observation) => observation.check === check,
      );
      expect(new Set(metrics.map(({ identity }) => identity)).size).toBe(
        metrics.length,
      );
      expect(metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity: expect.stringMatching(/function=anonymous%40/u),
          }),
          expect.objectContaining({
            identity: expect.stringContaining(
              "member-role=field/function=task",
            ),
          }),
        ]),
      );
    }
  });

  it("keeps same-named methods in separate inline objects as distinct metrics", async () => {
    const observations = await collectComplexityObservations(
      "src/objects.ts",
      "consume({ run(){ if (a) work(); } }, { run(){ if (a) { if (b) work(); } } });",
    );
    for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
      const methods = observations.filter(
        (observation) =>
          observation.check === check && observation.entity?.name === "run",
      );
      expect(methods).toHaveLength(2);
      expect(new Set(methods.map(({ identity }) => identity)).size).toBe(2);
    }
  });

  it("keeps duplicate same-named class-field arrows as distinct metrics", async () => {
    const observations = await collectComplexityObservations(
      "src/fields.ts",
      "class Worker { task = () => a ? 1 : 0; task = () => { if (a) { if (b) return 1; } return 0; }; }",
    );
    for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
      const fields = observations.filter(
        (observation) =>
          observation.check === check && observation.entity?.name === "task",
      );
      expect(fields).toHaveLength(2);
      expect(new Set(fields.map(({ identity }) => identity)).size).toBe(2);
    }
  });

  it("attributes arrow functions stored in object properties", async () => {
    const observations = await collectComplexityObservations(
      "src/icons.jsx",
      "export const icons = { Play: (value) => value ? 1 : 0, Pause: (value) => value ?? 0 };",
    );

    for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
      const properties = observations.filter(
        (observation) =>
          observation.check === check &&
          observation.entity?.kind === "function",
      );
      expect(properties).toHaveLength(2);
      expect(new Set(properties.map(({ identity }) => identity)).size).toBe(2);
    }
  });

  it("ignores unused disable notices that are not complexity metrics", async () => {
    await expect(
      collectComplexityObservations(
        "src/result.jsx",
        "export function result(value) { /* eslint-disable-next-line react-hooks/exhaustive-deps */ return value ? 1 : 0; }",
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "cyclomaticComplexity" }),
      ]),
    );
  });

  it.each(["mjs", "cjs", "mts", "cts"])(
    "supports the managed .%s source extension",
    async (extension) => {
      await expect(
        collectComplexityObservations(
          `src/value.${extension}`,
          "export function value() { return ready ? 1 : 0; }",
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "readabilityComplexity",
            identity: expect.stringContaining(`src/value.${extension}`),
          }),
        ]),
      );
    },
  );

  it.each(complexityAdapters)(
    "$id attributes only a worsened changed entity from the staged snapshot",
    async (adapter) => {
      const run = await complexityContext(adapter.id as CheckId);
      await expect(adapter.inspect(run)).resolves.toMatchObject({
        applies: true,
        requiresBaseline: true,
        targets: [target],
      });
      const set = await adapter.collect(run);
      const result = await observationCheckResult(adapter.id, set, run, true);
      const staged = result.findings.filter(
        ({ attribution }) => attribution.staged,
      );

      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        check: adapter.id,
        attribution: {
          kind: "metric-delta",
          staged: true,
          evidence: expect.arrayContaining([
            expect.stringContaining("function:src/changed.ts:changed"),
          ]),
        },
      });
      expect(
        result.findings
          .filter(({ attribution }) => attribution.staged)
          .every(
            ({ attribution }) =>
              !attribution.evidence.some(
                (item) => item.includes("debt") || item.includes("untouched"),
              ),
          ),
      ).toBe(true);
      const changedTarget = set.targetObservations.find(
        ({ entity }) => entity?.file === "src/changed.ts",
      );
      expect(changedTarget?.metric?.value).toBeGreaterThan(1);
    },
  );

  it.each(complexityAdapters)(
    "$id stores file-scoped metric limits on both snapshot sides",
    async (adapter) => {
      const [baseline, staged, live] = await Promise.all([
        createInspectionFixture(),
        createInspectionFixture(),
        createInspectionFixture(),
      ]);
      const changed = perFileLimitChanges();
      for (const fixture of [baseline, staged, live]) {
        await fixture.writeJson("package.json", {
          name: "fixture",
          private: true,
        });
      }
      await baseline.write(
        "src/strict.ts",
        "export function strictLimit() { return 0; }\n",
      );
      await staged.write("src/strict.ts", branchySource("strictLimit"));
      await live.write("src/strict.ts", branchySource("strictLimit"));
      await baseline.write("src/legacy.ts", branchySource("renamedLimit"));
      await staged.write("test/renamed.test.ts", branchySource("renamedLimit"));
      await live.write("test/renamed.test.ts", branchySource("renamedLimit"));
      const config = resolveConfig({
        schemaVersion: 1,
        profile: "recommended",
        checks: {
          [adapter.id]: {
            severity: "error",
            max: 1,
            blockWorsening: true,
          },
        },
        overrides: [
          {
            files: ["test/**"],
            checks: { [adapter.id]: { max: 99 } },
          },
        ],
      });
      const run: CheckRunContext = {
        repositoryRoot: live.root,
        changeSet: changed,
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
        target,
        policy: config.checks[adapter.id as CheckId],
        policyForFile: testFilePolicyResolver(config, changed),
        signal: new AbortController().signal,
      };

      const set = await adapter.collect(run);
      const srcTarget = set.targetObservations.find(
        ({ entity }) => entity?.file === "src/strict.ts",
      );
      const renamedTarget = set.targetObservations.find(
        ({ entity }) => entity?.file === "test/renamed.test.ts",
      );
      const renamedBaseline = set.baselineObservations.find(
        ({ entity }) => entity?.file === "src/legacy.ts",
      );
      const result = await observationCheckResult(adapter.id, set, run, true);
      const stagedFindings = result.findings.filter(
        ({ attribution }) => attribution.staged,
      );

      expect(srcTarget?.metric?.value).toBe(renamedTarget?.metric?.value);
      expect(srcTarget?.metric?.limit).toBe(1);
      expect(renamedTarget?.metric?.limit).toBe(99);
      expect(renamedBaseline?.metric?.limit).toBe(99);
      expect(stagedFindings.map(({ location }) => location?.file)).toEqual([
        "src/strict.ts",
      ]);
    },
  );

  it.each(complexityAdapters)(
    "$id handles the packaged JavaScript complexity shape",
    async (adapter) => {
      const [baseline, staged] = await Promise.all([
        createInspectionFixture(),
        createInspectionFixture(),
      ]);
      const baselineSource = [
        'eval("1 + 1");',
        "export function decide(first, second) {",
        "  return first && second;",
        "}",
        "",
      ].join("\n");
      const targetSource = [
        'eval("1 + 1");',
        "export function decide(first, second) {",
        "  if (first) {",
        "    if (second) return true;",
        "  }",
        "  return false;",
        "}",
        "",
      ].join("\n");
      for (const fixture of [baseline, staged]) {
        await fixture.writeJson("package.json", {
          name: "fixture",
          private: true,
        });
        await fixture.write(
          "eslint.config.mjs",
          'import js from "@eslint/js";\nexport default [js.configs.recommended];\n',
        );
      }
      await baseline.write("src/index.js", baselineSource);
      await staged.write("src/index.js", targetSource);
      const config = resolveConfig({
        schemaVersion: 1,
        profile: "fast",
        checks: {
          [adapter.id]: { severity: "error", max: 1, blockWorsening: true },
        },
      });
      const changed: ChangeSet = {
        files: new Map([
          [
            "src/index.js",
            {
              path: "src/index.js",
              status: "modified",
              addedRanges: [{ start: 3, end: 6 }],
            },
          ],
        ]),
        isEmpty: false,
        containsAddedLine: (file, line) =>
          file === "src/index.js" && line >= 3 && line <= 6,
      };
      const run: CheckRunContext = {
        repositoryRoot: staged.root,
        changeSet: changed,
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
        target,
        policy: config.checks[adapter.id as CheckId],
        policyForFile: testFilePolicyResolver(config),
        signal: new AbortController().signal,
      };

      const set = await adapter.collect(run);
      await expect(
        observationCheckResult(adapter.id, set, run, true),
      ).resolves.toMatchObject({
        findings: [expect.objectContaining({ check: adapter.id })],
      });

      if (adapter.id === "cyclomaticComplexity") {
        await expect(
          Promise.all(
            complexityAdapters.map(async (candidate) => {
              const candidateRun = {
                ...run,
                policy: config.checks[candidate.id as CheckId],
              };
              const candidateSet = await candidate.collect(candidateRun);
              return observationCheckResult(
                candidate.id,
                candidateSet,
                candidateRun,
                true,
              );
            }),
          ),
        ).resolves.toHaveLength(2);
      }
    },
  );
});
