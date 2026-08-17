import { describe, expect, it } from "vitest";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { normalizeOsvInventory } from "../../../src/checks/vulnerabilities/normalize.js";
import { osvQueryKey } from "../../../src/checks/vulnerabilities/osv/client.js";
import type { OsvAdvisory } from "../../../src/checks/vulnerabilities/osv/types.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

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

function record(version: string) {
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

async function run(baselineVersion: string, targetVersion?: string) {
  const [baseline, target, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, target, live]) {
    await fixture.writeJson("package.json", { name: "fixture" });
    await fixture.writeJson("package-lock.json", {
      lockfileVersion: 3,
      packages: {},
    });
  }
  const baselineRecord = record(baselineVersion);
  const targetRecord = targetVersion === undefined ? undefined : record(targetVersion);
  const results = new Map([
    [osvQueryKey(baselineRecord), [advisory]],
    ...(targetRecord === undefined
      ? []
      : ([[osvQueryKey(targetRecord), [advisory]]] as const)),
  ]);
  const baselineObservations = normalizeOsvInventory([baselineRecord], results);
  const targetObservations = normalizeOsvInventory(
    targetRecord === undefined ? [] : [targetRecord],
    results,
  );
  const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  const changeSet: ChangeSet = {
    files: new Map([
      [
        "package-lock.json",
        {
          path: "package-lock.json",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
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
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection,
      target: { id: ".", kind: "repository", relativeRoot: "." },
      policy: config.checks.vulnerabilities,
      signal: new AbortController().signal,
    },
    true,
  );
}

describe("vulnerability attribution", () => {
  it("keeps an unchanged vulnerable dependency non-staged", async () => {
    const result = await run("1.0.0", "1.0.0");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.attribution.staged).toBe(false);
  });

  it("attributes an upgrade into a vulnerable version to the staged project delta", async () => {
    const result = await run("1.0.0", "2.0.0");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.attribution.staged).toBe(true);
  });

  it("does not turn a removed vulnerability into a target finding", async () => {
    const result = await run("1.0.0");
    expect(result.findings).toEqual([]);
  });
});
