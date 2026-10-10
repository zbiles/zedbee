import { describe, expect, it } from "vitest";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { normalizeOsvInventory } from "../../../src/checks/vulnerabilities/normalize.js";
import { parseNpmLockfile } from "../../../src/checks/vulnerabilities/inventory/parse-npm.js";
import type { DependencyRecord } from "../../../src/checks/vulnerabilities/inventory/types.js";
import { osvQueryKey } from "../../../src/checks/vulnerabilities/osv/client.js";
import type { OsvAdvisory } from "../../../src/checks/vulnerabilities/osv/types.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../../src/policy/evaluate.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const advisory: OsvAdvisory = {
  id: "GHSA-test",
  aliases: [],
  affected: [
    {
      package: { name: "fixture", ecosystem: "npm" },
      ranges: [],
      versions: [],
    },
  ],
  severity: [],
  references: [],
};

const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });

function record(version: string): DependencyRecord {
  return {
    name: "fixture",
    version,
    ecosystem: "npm" as const,
    lockfilePath: "package-lock.json",
    line: 1,
    importer: ".",
    dependencyPath: ["fixture"],
  };
}

async function run(
  baselineRecords: readonly DependencyRecord[],
  targetRecords: readonly DependencyRecord[],
) {
  const [baseline, target, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, target, live]) {
    await fixture.writeJson("package.json", { name: "fixture" });
    for (const path of new Set([
      "package-lock.json",
      ...baselineRecords.map((dependency) => dependency.lockfilePath),
      ...targetRecords.map((dependency) => dependency.lockfilePath),
    ])) {
      await fixture.writeJson(path, { lockfileVersion: 3, packages: {} });
    }
  }
  const results = new Map(
    [...baselineRecords, ...targetRecords].map((dependency) => [
      osvQueryKey(dependency),
      [advisory],
    ]),
  );
  const baselineObservations = normalizeOsvInventory(baselineRecords, results);
  const targetObservations = normalizeOsvInventory(targetRecords, results);
  const changeSet: ChangeSet = {
    files: new Map([
      [
        "package-lock.json",
        {
          path: "package-lock.json",
          status: "modified",
          addedRanges: [{ start: 3145, end: 5912 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine: () => true,
  };
  const targetInspection = await inspectRepository(target.root);
  return observationCheckResult(
    "vulnerabilities",
    {
      checkId: "vulnerabilities",
      target: { id: ".", kind: "repository", relativeRoot: "." },
      baselineObservations,
      targetObservations,
      projectDelta: true,
    },
    {
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
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection,
      target: { id: ".", kind: "repository", relativeRoot: "." },
      policy: config.checks.vulnerabilities,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    },
    true,
  );
}

describe("vulnerability attribution", () => {
  it("keeps an unchanged vulnerable dependency non-staged", async () => {
    const result = await run([record("1.0.0")], [record("1.0.0")]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.attribution.staged).toBe(false);
  });

  it("attributes an upgrade into a vulnerable version to the staged project delta", async () => {
    const result = await run([record("1.0.0")], [record("2.0.0")]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.attribution.staged).toBe(true);
  });

  it("does not turn a removed vulnerability into a target finding", async () => {
    const result = await run([record("1.0.0")], []);
    expect(result.findings).toEqual([]);
  });

  it("does not block when an existing entry moves into a staged range", async () => {
    const result = await run(
      [{ ...record("1.0.0"), line: 3131 }],
      [{ ...record("1.0.0"), line: 4387 }],
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      location: { file: "package-lock.json", startLine: 4387 },
      attribution: { kind: "none", staged: false, evidence: [] },
    });
    expect(
      evaluatePolicy(
        [{ result, policy: config.checks.vulnerabilities }],
        config,
      ),
    ).toMatchObject({ outcome: "pass", exitCode: 0 });
  });

  it("preserves attribution after unrelated npm entries change the parsed line", async () => {
    const baseline = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: { "node_modules/fixture": { version: "1.0.0" } },
      },
      null,
      2,
    );
    const target = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "node_modules/zedbee": { version: "0.1.0-beta.10" },
          "node_modules/fixture": { version: "1.0.0" },
        },
      },
      null,
      2,
    );
    const baselineRecords = parseNpmLockfile(baseline, "package-lock.json");
    const targetRecords = parseNpmLockfile(target, "package-lock.json").filter(
      (dependency) => dependency.name === "fixture",
    );
    expect(baselineRecords[0]?.line).toBe(5);
    expect(targetRecords[0]?.line).toBe(8);
    const result = await run(baselineRecords, targetRecords);
    expect(result.findings[0]).toMatchObject({
      location: { startLine: 8 },
      attribution: { kind: "none", staged: false },
    });
  });

  it.each([
    ["package", { name: "other" }],
    ["version", { version: "2.0.0" }],
    ["lockfile", { lockfilePath: "web/package-lock.json" }],
    ["importer", { importer: "web" }],
    ["dependency path", { dependencyPath: ["parent", "fixture"] }],
  ])("still blocks a new vulnerable %s identity", async (_field, change) => {
    const result = await run(
      [{ ...record("1.0.0"), line: 3131 }],
      [{ ...record("1.0.0"), ...change, line: 4387 }],
    );
    expect(result.findings[0]?.attribution.staged).toBe(true);
    expect(
      evaluatePolicy(
        [{ result, policy: config.checks.vulnerabilities }],
        config,
      ),
    ).toMatchObject({ outcome: "blocked", exitCode: 1 });
  });

  it("still blocks a newly added vulnerable dependency", async () => {
    const result = await run([], [{ ...record("1.0.0"), line: 4387 }]);
    expect(
      evaluatePolicy(
        [{ result, policy: config.checks.vulnerabilities }],
        config,
      ),
    ).toMatchObject({ outcome: "blocked", exitCode: 1 });
  });
});
