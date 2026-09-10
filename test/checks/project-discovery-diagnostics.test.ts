import { describe, expect, it } from "vitest";
import { DEFAULT_CHECK_ADAPTERS } from "../../src/checks/descriptors.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import type { CheckRunContext } from "../../src/checks/adapter.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { CheckId, ResolvedConfig } from "../../src/config/schema.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { createInspectionFixture } from "../inspection/fixture.js";

const sourceChecks: readonly CheckId[] = [
  "lint",
  "types",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "duplication",
  "dependencyArchitecture",
  "deadCode",
  "reactCorrectness",
  "reactAccessibility",
];

async function contextFor(
  paths: readonly string[],
  config = resolveConfig({ schemaVersion: 1, profile: "thorough" }),
): Promise<CheckRunContext> {
  const baseline = await createInspectionFixture();
  const target = await createInspectionFixture();
  for (const path of paths)
    await target.write(path, "export const value = 1;\n");
  const files = new Map(
    paths.map((path) => [
      path,
      { path, status: "added" as const, addedRanges: [{ start: 1, end: 1 }] },
    ]),
  );
  const changeSet: ChangeSet = {
    files,
    isEmpty: files.size === 0,
    containsAddedLine: (path, line) => files.has(path) && line === 1,
  };
  return {
    repositoryRoot: target.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: target.root,
      baselineRef: "a".repeat(40),
      targetRef: "b".repeat(40),
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(target.root),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.lint,
    policyForFile: createFilePolicyResolver(config, changeSet),
    signal: new AbortController().signal,
  };
}

function adaptersFor(ids: readonly CheckId[]) {
  return DEFAULT_CHECK_ADAPTERS.filter((adapter) =>
    ids.includes(adapter.id as CheckId),
  );
}

describe("project discovery diagnostics through dispatch", () => {
  it.each(sourceChecks)(
    "reports incomplete %s when changed source has no discovered project",
    async (checkId) => {
      const context = await contextFor(["src/value.tsx"]);
      expect(context.targetInspection.workspaces).toEqual([]);

      const results = await dispatchChecks(adaptersFor([checkId]), context);

      expect(results).toHaveLength(1);
      expect(results[0]?.result).toMatchObject({
        checkId,
        status: "incomplete",
        findings: [],
        error: {
          code: "PROJECT_NOT_DISCOVERED",
          path: "src/value.tsx",
          message: expect.stringContaining("project"),
          remediation: expect.any(String),
        },
      });
      expect(evaluatePolicy(results, context.config).outcome).toBe(
        "incomplete",
      );
    },
  );

  it.each(["override", "pathExclusion"])(
    "respects a per-file %s before reporting missing projects",
    async (policyKind) => {
      const config = resolveConfig({
        schemaVersion: 1,
        profile: "thorough",
        ...(policyKind === "override"
          ? { overrides: [{ files: ["src/**"], checks: { lint: "off" } }] }
          : {
              pathExclusions: [
                {
                  files: ["src/**"],
                  checks: ["lint"],
                  reason: "Fixture exclusion",
                },
              ],
            }),
      });
      const context = await contextFor(["src/value.ts"], config);

      const results = await dispatchChecks(adaptersFor(["lint"]), context);

      expect(results[0]?.result).toMatchObject({ status: "skipped" });
      expect(evaluatePolicy(results, config).outcome).toBe("pass");
    },
  );

  it("reports the enabled changed file when another file is excluded", async () => {
    const config: ResolvedConfig = resolveConfig({
      schemaVersion: 1,
      profile: "thorough",
      overrides: [{ files: ["src/ignored.ts"], checks: { lint: "off" } }],
    });
    const context = await contextFor(
      ["src/ignored.ts", "src/included.ts"],
      config,
    );

    const results = await dispatchChecks(adaptersFor(["lint"]), context);

    expect(results[0]?.result.error).toMatchObject({
      code: "PROJECT_NOT_DISCOVERED",
      path: "src/included.ts",
    });
  });

  it.each([
    { path: "src/disabled.ts", status: "skipped" },
    { path: "src/enabled.ts", status: "incomplete" },
  ])(
    "uses actual file policy for an off root and enabled override: $path",
    async ({ path, status }) => {
      const config = resolveConfig({
        schemaVersion: 1,
        profile: "thorough",
        checks: { lint: "off" },
        overrides: [{ files: ["src/enabled.ts"], checks: { lint: "error" } }],
      });
      const context = await contextFor([path], config);

      const results = await dispatchChecks(adaptersFor(["lint"]), context);

      expect(results[0]?.result.status).toBe(status);
    },
  );

  it("ignores source in standard excluded directories", async () => {
    const context = await contextFor([
      "node_modules/dependency/index.ts",
      "app/generated/types.ts",
      "dist/output.js",
    ]);

    const results = await dispatchChecks(adaptersFor(sourceChecks), context);

    expect(results).toHaveLength(sourceChecks.length);
    expect(results.every(({ result }) => result.status === "skipped")).toBe(
      true,
    );
  });

  it("keeps TypeScript and renderer checks irrelevant without matching changed source", async () => {
    const javascript = await contextFor(["src/value.js"]);
    const types = await dispatchChecks(adaptersFor(["types"]), javascript);
    expect(types[0]?.result).toMatchObject({
      status: "skipped",
      skipReason: "No supported changed TypeScript source files",
    });

    const docs = await contextFor(["README.md"]);
    const renderers = await dispatchChecks(
      adaptersFor(["reactCorrectness", "reactAccessibility"]),
      docs,
    );
    expect(renderers.map(({ result }) => result.skipReason).sort()).toEqual([
      "No React renderer detected",
      "No browser DOM renderer detected",
    ]);
  });
});
