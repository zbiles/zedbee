import { describe, expect, it } from "vitest";
import type { CheckRunContext, CheckTarget } from "../../src/checks/adapter.js";
import { observationCheckResult } from "../../src/checks/observation-result.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import type { CheckId, ResolvedCheckPolicy } from "../../src/config/schema.js";
import type { Observation } from "../../src/core/types.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";

async function fixturePair() {
  const baseline = await createInspectionFixture();
  const target = await createInspectionFixture();
  for (const fixture of [baseline, target]) {
    await fixture.writeJson("package.json", {
      name: "root",
      workspaces: ["apps/**", "packages/*", "links/*"],
    });
    await fixture.write(
      "src/index.ts",
      "export function run() { return 1; }\n",
    );
    await fixture.write(
      "test/app.test.ts",
      "export function testRun() { return 1; }\n",
    );
    await fixture.writeJson("apps/web/package.json", { name: "web" });
    await fixture.write("apps/web/src/index.ts", "export const web = true;\n");
    await fixture.writeJson("apps/web/nested/package.json", { name: "nested" });
    await fixture.write(
      "apps/web/nested/src/index.ts",
      "export const nested = true;\n",
    );
    await fixture.writeJson("packages/core/package.json", { name: "core" });
    await fixture.write(
      "packages/core/src/index.ts",
      "export const core = true;\n",
    );
    await fixture.writeJson("packages/linked-real/package.json", {
      name: "linked",
    });
    await fixture.write(
      "packages/linked-real/src/index.ts",
      "export const linked = true;\n",
    );
    await fixture.symlink("../packages/linked-real", "links/linked");
  }
  return { baseline, target };
}

async function context(
  checkId: CheckId,
  target: CheckTarget,
  policy: ResolvedCheckPolicy,
  changeSet?: ChangeSet,
): Promise<CheckRunContext> {
  const fixtures = await fixturePair();
  const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  const effectiveChangeSet =
    changeSet ??
    ({
      files: new Map(),
      isEmpty: false,
      containsAddedLine: () => false,
    } satisfies ChangeSet);
  const effectiveConfig = {
    ...config,
    checks: { ...config.checks, [checkId]: policy },
  };
  return {
    repositoryRoot: fixtures.target.root,
    changeSet: effectiveChangeSet,
    config: effectiveConfig,
    snapshots: {
      baselineDir: fixtures.baseline.root,
      targetDir: fixtures.target.root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(fixtures.baseline.root),
    targetInspection: await inspectRepository(fixtures.target.root),
    target,
    policy,
    policyForFile: createFilePolicyResolver(
      effectiveConfig,
      effectiveChangeSet,
    ),
    signal: new AbortController().signal,
  };
}

function located(check: CheckId, file: string): Observation {
  return {
    check,
    rule: "fixture",
    identity: `fixture:${file}`,
    severity: "error",
    message: "Fixture observation",
    location: { file, startLine: 1, endLine: 1 },
  };
}

function metric(check: CheckId, value: number, limit?: number): Observation {
  return {
    check,
    rule: "metric",
    identity: "function:src/index.ts:run",
    severity: "error",
    message: "Metric observation",
    entity: { kind: "function", name: "run", file: "src/index.ts" },
    metric: {
      name: "fixture-metric",
      value,
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

function metricAt(
  check: CheckId,
  value: number,
  file: string,
  name: string,
): Observation {
  return {
    ...metric(check, value),
    identity: `function:${file}:${name}`,
    entity: { kind: "function", name, file },
  };
}

describe("observationCheckResult", () => {
  it("attributes manifest entities without parsing them as JavaScript", async () => {
    const target = { id: ".", kind: "workspace" as const, relativeRoot: "." };
    const runContext = await context(
      "deadCode",
      target,
      { severity: "error", when: "relevant" },
      {
        files: new Map([
          [
            "package.json",
            {
              path: "package.json",
              status: "modified",
              addedRanges: [{ start: 1, end: 1 }],
            },
          ],
        ]),
        isEmpty: false,
        containsAddedLine: (file, line) =>
          file === "package.json" && line === 1,
      },
    );

    const result = await observationCheckResult(
      "deadCode",
      {
        checkId: "deadCode",
        target,
        baselineObservations: [],
        targetObservations: [
          {
            ...located("deadCode", "package.json"),
            identity: "dependencies:package.json:unused",
            entity: {
              kind: "knip-dependencies",
              name: "unused",
              file: "package.json",
            },
          },
        ],
        projectDelta: true,
      },
      runContext,
      true,
    );

    expect(result.status).toBe("completed");
    expect(result.findings).toEqual([
      expect.objectContaining({
        location: expect.objectContaining({ file: "package.json" }),
        attribution: expect.objectContaining({
          staged: true,
          evidence: expect.arrayContaining(["project-delta"]),
        }),
      }),
    ]);
  });

  it("rejects target and baseline paths not owned by the exact workspace", async () => {
    const target = {
      id: "apps/web",
      kind: "workspace" as const,
      relativeRoot: "apps/web",
    };
    const runContext = await context("lint", target, {
      severity: "error",
      when: "relevant",
    });

    await expect(
      observationCheckResult(
        "lint",
        {
          checkId: "lint",
          target,
          baselineObservations: [],
          targetObservations: [located("lint", "apps/web/nested/src/index.ts")],
        },
        runContext,
        true,
      ),
    ).rejects.toThrow(TypeError);

    await expect(
      observationCheckResult(
        "lint",
        {
          checkId: "lint",
          target,
          baselineObservations: [located("lint", "packages/core/src/index.ts")],
          targetObservations: [],
        },
        runContext,
        true,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("rejects unknown snapshot paths before attribution", async () => {
    const target = { id: ".", kind: "repository" as const, relativeRoot: "." };
    const runContext = await context("lint", target, {
      severity: "error",
      when: "relevant",
    });

    await expect(
      observationCheckResult(
        "lint",
        {
          checkId: "lint",
          target,
          baselineObservations: [],
          targetObservations: [located("lint", "src/missing.ts")],
        },
        runContext,
        false,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("accepts a linked workspace alias but rejects its canonical sibling path", async () => {
    const target = {
      id: "links/linked",
      kind: "workspace" as const,
      relativeRoot: "links/linked",
    };
    const runContext = await context("lint", target, {
      severity: "error",
      when: "relevant",
    });
    const accepted = await observationCheckResult(
      "lint",
      {
        checkId: "lint",
        target,
        baselineObservations: [],
        targetObservations: [located("lint", "links/linked/src/index.ts")],
      },
      runContext,
      false,
    );

    expect(accepted.status).toBe("completed");
    await expect(
      observationCheckResult(
        "lint",
        {
          checkId: "lint",
          target,
          baselineObservations: [],
          targetObservations: [
            located("lint", "packages/linked-real/src/index.ts"),
          ],
        },
        runContext,
        false,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("rejects duplicate metric fingerprints on either snapshot side", async () => {
    const target = { id: ".", kind: "repository" as const, relativeRoot: "." };
    const runContext = await context("cyclomaticComplexity", target, {
      severity: "error",
      when: "relevant",
      max: 20,
      blockWorsening: true,
    });
    const duplicate = metric("cyclomaticComplexity", 21);

    for (const [baselineObservations, targetObservations] of [
      [[duplicate, duplicate], []],
      [[], [duplicate, duplicate]],
    ] as const) {
      await expect(
        observationCheckResult(
          "cyclomaticComplexity",
          {
            checkId: "cyclomaticComplexity",
            target,
            baselineObservations,
            targetObservations,
          },
          runContext,
          true,
        ),
      ).rejects.toThrow(TypeError);
    }
  });

  it("uses only the exact check policy limit and rejects unsupported metric checks", async () => {
    const target = { id: ".", kind: "repository" as const, relativeRoot: "." };
    const changeSet: ChangeSet = {
      files: new Map([
        [
          "src/index.ts",
          {
            path: "src/index.ts",
            status: "modified",
            addedRanges: [{ start: 1, end: 1 }],
          },
        ],
      ]),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    const complexityContext = await context(
      "cyclomaticComplexity",
      target,
      { severity: "error", when: "relevant", max: 20, blockWorsening: true },
      changeSet,
    );
    const result = await observationCheckResult(
      "cyclomaticComplexity",
      {
        checkId: "cyclomaticComplexity",
        target,
        baselineObservations: [],
        targetObservations: [metric("cyclomaticComplexity", 15, 10)],
      },
      complexityContext,
      true,
    );

    expect(result.findings[0]?.attribution).toEqual({
      kind: "none",
      staged: false,
      evidence: [],
    });

    const lintContext = await context("lint", target, {
      severity: "error",
      when: "relevant",
    });
    await expect(
      observationCheckResult(
        "lint",
        {
          checkId: "lint",
          target,
          baselineObservations: [],
          targetObservations: [metric("lint", 15, 10)],
        },
        lintContext,
        false,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("resolves the metric limit for each target observation file", async () => {
    const target = { id: ".", kind: "repository" as const, relativeRoot: "." };
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: {
        cyclomaticComplexity: {
          severity: "error",
          max: 10,
          blockWorsening: true,
        },
      },
      overrides: [
        {
          files: ["test/**"],
          checks: { cyclomaticComplexity: { max: 20 } },
        },
      ],
    });
    const changeSet: ChangeSet = {
      files: new Map(
        ["src/index.ts", "test/app.test.ts"].map((path) => [
          path,
          {
            path,
            status: "modified" as const,
            addedRanges: [{ start: 1, end: 1 }],
          },
        ]),
      ),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    const runContext = await context(
      "cyclomaticComplexity",
      target,
      config.checks.cyclomaticComplexity,
      changeSet,
    );
    runContext.config = config;
    const policyForFile = createFilePolicyResolver(config, changeSet);
    const result = await observationCheckResult(
      "cyclomaticComplexity",
      {
        checkId: "cyclomaticComplexity",
        target,
        baselineObservations: [],
        targetObservations: [
          metricAt("cyclomaticComplexity", 15, "src/index.ts", "run"),
          metricAt("cyclomaticComplexity", 15, "test/app.test.ts", "testRun"),
        ],
      },
      { ...runContext, policyForFile },
      true,
    );

    expect(
      result.findings.filter((finding) => finding.attribution.staged),
    ).toEqual([
      expect.objectContaining({
        attribution: expect.objectContaining({
          evidence: expect.arrayContaining(["limit:10"]),
        }),
      }),
    ]);
  });

  it("treats vulnerability severity metrics as baseline annotations", async () => {
    const target = { id: ".", kind: "repository" as const, relativeRoot: "." };
    const changeSet: ChangeSet = {
      files: new Map([
        [
          "package.json",
          {
            path: "package.json",
            status: "modified",
            addedRanges: [{ start: 1, end: 1 }],
          },
        ],
      ]),
      isEmpty: false,
      containsAddedLine: () => true,
    };
    const runContext = await context(
      "vulnerabilities",
      target,
      { severity: "error", when: "relevant", onUnavailable: "block" },
      changeSet,
    );
    const vulnerability: Observation = {
      check: "vulnerabilities",
      rule: "GHSA-test",
      identity: '["GHSA-test","npm","fixture","package.json"]',
      severity: "error",
      message: "GHSA-test affects fixture@1.0.0",
      location: { file: "package.json" },
      metric: { name: "cvss", value: 9.8 },
    };

    const newResult = await observationCheckResult(
      "vulnerabilities",
      {
        checkId: "vulnerabilities",
        target,
        baselineObservations: [],
        targetObservations: [vulnerability],
      },
      runContext,
      true,
    );
    expect(newResult.findings[0]?.attribution.staged).toBe(true);

    const existingResult = await observationCheckResult(
      "vulnerabilities",
      {
        checkId: "vulnerabilities",
        target,
        baselineObservations: [
          { ...vulnerability, message: "GHSA-test affects fixture@0.9.0" },
        ],
        targetObservations: [vulnerability],
      },
      runContext,
      true,
    );
    expect(existingResult.findings[0]?.attribution.staged).toBe(false);
  });

  it.each([
    ["lint", { severity: "error", when: "relevant" }],
    ["cyclomaticComplexity", { severity: "error", when: "relevant" }],
    ["readabilityComplexity", { severity: "error", when: "relevant" }],
    ["duplication", { severity: "error", when: "relevant" }],
  ] as const)(
    "rejects a baseline-only %s metric before empty-target pairing",
    async (checkId, policy) => {
      const target = {
        id: ".",
        kind: "repository" as const,
        relativeRoot: ".",
      };
      const runContext = await context(checkId, target, policy);

      await expect(
        observationCheckResult(
          checkId,
          {
            checkId,
            target,
            baselineObservations: [metric(checkId, 15)],
            targetObservations: [],
          },
          runContext,
          true,
        ),
      ).rejects.toThrow(TypeError);
    },
  );
});
