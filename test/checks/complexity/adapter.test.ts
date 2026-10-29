import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { collectChangedEntities } from "../../../src/attribution/entities.js";
import { attributeMetricDelta } from "../../../src/attribution/metrics.js";

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
  const inlineDebt =
    "install(class { observe() { if (ready) { if (visible) work(); } } });";
  const inlineNew =
    "install(class { observe() { if (ready) { if (visible) notify(); } } });";
  const inlineLow = "install(class { observe() { work(); } });";

  it.each([
    {
      name: "prepend",
      before: inlineDebt,
      after: `${inlineNew}\n${inlineDebt}`,
      added: [{ start: 1, end: 1 }],
      staged: [1],
    },
    {
      name: "append",
      before: inlineDebt,
      after: `${inlineDebt}\n${inlineNew}`,
      added: [{ start: 2, end: 2 }],
      staged: [2],
    },
    {
      name: "remove earlier class",
      before: `${inlineLow}\n${inlineDebt}`,
      after: inlineDebt,
      added: [{ start: 1, end: 1 }],
      staged: [],
    },
    {
      name: "reorder",
      before: `${inlineDebt}\n${inlineLow}`,
      after: `${inlineLow}\n${inlineDebt}`,
      added: [{ start: 1, end: 2 }],
      staged: [],
    },
    {
      name: "unanchored rewritten classes cannot borrow reordered debt",
      before: `${inlineDebt}\n${inlineLow}`,
      after: `${inlineNew}\n${inlineDebt.replace("work();", "work(); notify();")}`,
      added: [{ start: 1, end: 2 }],
      staged: [1, 2],
    },
    {
      name: "one middle anchor cannot pair two rewritten endpoints",
      before: `${inlineDebt}\ninstall(class { observe() { if (ready) middle(); } });\n${inlineLow}`,
      after: `${inlineNew}\ninstall(class { observe() { if (ready) middle(); } });\n${inlineDebt.replace("work();", "work(); notify();")}`,
      added: [
        { start: 1, end: 1 },
        { start: 3, end: 3 },
      ],
      staged: [1, 3],
    },
    {
      name: "one remaining edited class follows a consistent anchor",
      before: `${inlineDebt}\n${inlineNew}`,
      after: `${inlineNew.replace("notify();", "notify(); finish();")}\n${inlineDebt}`,
      added: [{ start: 1, end: 1 }],
      staged: [],
    },
    {
      name: "prepend identical source",
      before: inlineDebt,
      after: `${inlineDebt}\n${inlineDebt}`,
      added: [{ start: 1, end: 1 }],
      staged: [1],
    },
    {
      name: "unrelated insertion and harmless edit",
      before: inlineDebt,
      after: `const marker = 1;\n${inlineDebt.replace("work();", "work(); notify();")}`,
      added: [{ start: 1, end: 2 }],
      staged: [],
    },
    {
      name: "prepend nested class with unchanged debt anchor",
      before: [
        "install(class {",
        "outer() {",
        inlineDebt,
        "}",
        "stable() {}",
        "});",
      ].join("\n"),
      after: [
        "install(class {",
        "outer() {",
        inlineNew,
        inlineDebt,
        "}",
        "stable() {}",
        "});",
      ].join("\n"),
      added: [{ start: 3, end: 3 }],
      staged: [3],
    },
    {
      name: "unanchored nested classes cannot borrow outer debt",
      before: [
        "install(class {",
        "outer() {",
        inlineDebt,
        "}",
        "stable() {}",
        "});",
      ].join("\n"),
      after: [
        "install(class {",
        "outer() {",
        inlineNew,
        inlineDebt.replace("work();", "work(); notify();"),
        "}",
        "stable() {}",
        "});",
      ].join("\n"),
      added: [{ start: 3, end: 4 }],
      // Neither inner member has an unchanged source anchor: conservatively
      // treat both as target-only rather than hide a new violation.
      staged: [3, 4],
    },
  ])(
    "pairs class metrics across snapshots: $name",
    async ({ before, after, added, staged }) => {
      for (const adapter of complexityAdapters) {
        const run = await complexityContext(adapter.id as CheckId);
        await Promise.all([
          writeFile(join(run.snapshots.baselineDir, "src/changed.ts"), before),
          writeFile(join(run.snapshots.targetDir, "src/changed.ts"), after),
        ]);
        run.changeSet = {
          files: new Map([
            [
              "src/changed.ts",
              {
                path: "src/changed.ts",
                status: "modified",
                addedRanges: added,
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: (file, line) =>
            file === "src/changed.ts" &&
            added.some(({ start, end }) => line >= start && line <= end),
        };

        const set = await adapter.collect(run);
        const result = await observationCheckResult(adapter.id, set, run, true);
        expect(
          result.findings
            .filter(({ attribution }) => attribution.staged)
            .map(({ location }) => location?.startLine)
            .sort(),
        ).toEqual(staged);
      }
    },
  );

  it.each(complexityAdapters)(
    "$id does not parse unrelated unchanged files",
    async (adapter) => {
      const context = await complexityContext(adapter.id as CheckId);
      for (const root of [
        context.snapshots.baselineDir,
        context.snapshots.targetDir,
      ]) {
        await writeFile(
          join(root, "src/untouched.ts"),
          "export const invalid = &;\n",
        );
      }
      const collected = await adapter.collect(context);
      expect(collected.targetObservations).toHaveLength(1);
      expect(collected.baselineObservations).toHaveLength(1);
      expect(collected.targetObservations[0]?.entity?.file).toBe(
        "src/changed.ts",
      );
    },
  );

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

  it.each([
    {
      property:
        "[key()]: async () => { if (a) { if (b) return 1; } return 0; }",
      outerCyclomatic: 1,
      outerReadability: 0,
    },
    {
      property:
        "[ready ? first : second]:\n async () => { if (a) { if (b) return 1; } return 0; }",
      outerCyclomatic: 2,
      outerReadability: 1,
    },
    {
      property:
        "[key()]: function () { if (a) { if (b) return 1; } return 0; }",
      outerCyclomatic: 1,
      outerReadability: 0,
    },
  ])(
    "keeps nested computed-property metrics separate: $property",
    async ({ property, outerCyclomatic, outerReadability }) => {
      const source = `function outer() { const routes = { ${property} }; }`;
      const observations = await collectComplexityObservations(
        "routes.tsx",
        source,
      );

      for (const [rule, outerValue] of [
        ["cyclomatic-complexity", outerCyclomatic],
        ["readability-complexity", outerReadability],
      ] as const) {
        const metrics = observations.filter(
          (observation) => observation.rule === rule,
        );
        expect(metrics).toHaveLength(2);
        expect(new Set(metrics.map(({ identity }) => identity)).size).toBe(2);
        expect(
          metrics.find(({ entity }) => entity?.name === "outer")?.metric?.value,
        ).toBe(outerValue);
        expect(
          metrics.find(({ entity }) => entity?.name.startsWith("anonymous@"))
            ?.metric?.value,
        ).toBe(3);
      }
    },
  );

  it("attributes computed-property worsening to the same inner entity across snapshots", async () => {
    const file = "routes.tsx";
    const baselineSource =
      "function outer() { const routes = { [key()]: async () => { return 0; } }; }";
    const targetSource =
      "\nfunction outer() { const routes = { [key()]: async () => { if (a) { if (b) return 1; } return 0; } }; }";
    const baseline = await collectComplexityObservations(file, baselineSource);
    const target = await collectComplexityObservations(file, targetSource);
    const changed = collectChangedEntities(targetSource, file, [
      { start: 2, end: 2 },
    ]);

    for (const rule of ["cyclomatic-complexity", "readability-complexity"]) {
      const previous = baseline.filter(
        (observation) => observation.rule === rule,
      );
      const current = target.filter((observation) => observation.rule === rule);
      expect(current.map(({ identity }) => identity)).toEqual(
        previous.map(({ identity }) => identity),
      );
      const staged = current.filter(
        (observation) =>
          attributeMetricDelta(
            previous.find(({ identity }) => identity === observation.identity),
            observation,
            changed,
            { limit: 1, blockWorsening: true },
          ).attribution.staged,
      );
      expect(staged).toHaveLength(1);
      expect(staged[0]?.entity?.name).toMatch(/^anonymous@/u);
      expect(staged[0]?.metric?.value).toBe(3);
    }
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

  it.each([
    ["anonymous", "class", "class"],
    ["same-named", "class Observer", "class Observer"],
    ["differently-named", "class FirstObserver", "class SecondObserver"],
  ])(
    "attributes members of %s inline classes independently",
    async (_label, first, second) => {
      const members = [
        "constructor(private callback: () => void) { if (ready) this.callback(); }",
        "observe() { if (ready) { if (visible) this.callback(); } }",
        "get active() { return ready ? true : false; }",
        "set active(value: boolean) { if (value) this.callback(); }",
        "task = () => ready ? this.callback() : undefined;",
      ].join(" ");
      const source = `install(${first} { ${members} });\ninstall(${second} { ${members} });`;
      const observations = await collectComplexityObservations(
        "src/observers.ts",
        source,
      );

      for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
        const metrics = observations.filter(
          (observation) => observation.check === check,
        );
        expect(metrics).toHaveLength(10);
        expect(new Set(metrics.map(({ identity }) => identity)).size).toBe(10);
        expect(
          metrics
            .filter(({ entity }) => entity?.name === "observe")
            .map(({ metric }) => metric?.value),
        ).toEqual([3, 3]);
      }
    },
  );

  it("stages only the worsened inline class member while suppressing baseline debt", async () => {
    const file = "src/observers.ts";
    const debt =
      "install(class { observe() { if (ready) { if (visible) work(); } } });";
    const baselineSource = `${debt}\ninstall(class { observe() { work(); } });`;
    const targetSource = `\n${debt}\ninstall(class { observe() { if (ready) { if (visible) work(); } } });`;
    const baseline = await collectComplexityObservations(file, baselineSource);
    const target = await collectComplexityObservations(file, targetSource);
    const changed = collectChangedEntities(targetSource, file, [
      { start: 2, end: 3 },
    ]);

    for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
      const previous = baseline.filter(
        (observation) => observation.check === check,
      );
      const current = target.filter(
        (observation) => observation.check === check,
      );
      expect(current.map(({ identity }) => identity)).toEqual(
        previous.map(({ identity }) => identity),
      );
      const findings = current.map((observation) =>
        attributeMetricDelta(
          previous.find(({ identity }) => identity === observation.identity),
          observation,
          changed,
          { limit: 1, blockWorsening: true },
        ),
      );

      expect(findings.filter(({ attribution }) => attribution.staged)).toEqual([
        expect.objectContaining({
          check,
          location: { file, startLine: 3, endLine: 3 },
          attribution: expect.objectContaining({
            evidence: expect.arrayContaining([
              `baseline-value:${check === "cyclomaticComplexity" ? 1 : 0}`,
              "target-value:3",
              "reason:limit-crossing",
            ]),
          }),
        }),
      ]);
      expect(
        findings.find(({ location }) => location?.startLine === 2)?.attribution
          .staged,
      ).toBe(false);
    }
  });

  it.each([
    "CLASS",
    "(CLASS)",
    "CLASS as unknown",
    "<unknown>CLASS",
    "CLASS satisfies unknown",
    "CLASS!",
    "((CLASS as unknown)!)",
  ])(
    "preserves variable-bound class debt after unrelated insertion: %s",
    async (expression) => {
      const file = "src/observer.ts";
      const source = `const Observer = ${expression.replace(
        "CLASS",
        "class { observe() { if (ready) { if (visible) work(); } } }",
      )};`;
      const targetSource = `const unrelated = 0;\n${source.replace("work();", "work(); notify();")}`;
      const baseline = await collectComplexityObservations(file, source);
      const target = await collectComplexityObservations(file, targetSource);
      const changed = collectChangedEntities(targetSource, file, [
        { start: 2, end: 2 },
      ]);

      for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
        const previous = baseline.find(
          (observation) => observation.check === check,
        );
        const current = target.find(
          (observation) => observation.check === check,
        )!;
        expect(current.metric?.value).toBe(3);
        expect(
          attributeMetricDelta(
            baseline.find(
              (observation) =>
                observation.check === check &&
                observation.identity === current.identity,
            ),
            current,
            changed,
            { limit: 1, blockWorsening: true },
          ).attribution.staged,
        ).toBe(false);
        expect(current.identity).toBe(previous?.identity);
        expect(current.identity).toBe(
          "method:src/observer.ts:variable=Observer/member-scope=instance/member-role=method/method=observe",
        );
      }
    },
  );

  it.each([
    ["top-level", "BODY"],
    ["named function", "function setup() { BODY }"],
    ["named class method", "class Setup { install() { BODY } }"],
  ])(
    "preserves inline class debt after unrelated insertion in a %s owner",
    async (_label, wrapper) => {
      const file = "src/observer.ts";
      const body =
        "install(class { observe() { if (ready) { if (visible) work(); } } });";
      const baselineSource = wrapper.replace("BODY", body);
      const targetSource = wrapper.replace(
        "BODY",
        `const unrelated = 0;\n${body.replace("work();", "work(); notify();")}`,
      );
      const baseline = await collectComplexityObservations(
        file,
        baselineSource,
      );
      const target = await collectComplexityObservations(file, targetSource);
      const changed = collectChangedEntities(targetSource, file, [
        { start: 1, end: 2 },
      ]);

      for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
        const current = target.find(
          (observation) =>
            observation.check === check &&
            observation.entity?.name === "observe",
        )!;
        expect(current.metric?.value).toBe(3);
        expect(
          changed.some(({ identity }) => identity === current.identity),
        ).toBe(true);
        expect(
          attributeMetricDelta(
            baseline.find(
              (observation) =>
                observation.check === check &&
                observation.identity === current.identity,
            ),
            current,
            changed,
            { limit: 1, blockWorsening: true },
          ).attribution.staged,
        ).toBe(false);
        expect(current.identity).toBe(
          baseline.find(
            (observation) =>
              observation.check === check &&
              observation.entity?.name === "observe",
          )?.identity,
        );
      }
    },
  );

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
        location: { file: "src/changed.ts", startLine: 1, endLine: 4 },
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
