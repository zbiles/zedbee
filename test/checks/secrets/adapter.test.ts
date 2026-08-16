import { access, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { createSecretsAdapter } from "../../../src/checks/secrets/adapter.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import type { ManagedBinary } from "../../../src/managed-binaries/types.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

const canary = "zedbee_test_secret_never_expose";
const binary: ManagedBinary = {
  engine: "gitleaks",
  version: "8.28.0",
  platform: "darwin",
  arch: "arm64",
  packageName: "@zedbee/gitleaks-darwin-arm64",
  packageRoot: "/managed",
  manifestPath: "/managed/manifest.json",
  executablePath: "/managed/gitleaks",
  executableSha256: "0".repeat(64),
  configPath: "/managed/gitleaks.toml",
  configSha256: "1".repeat(64),
};

async function context(): Promise<CheckRunContext> {
  const [baseline, target, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, target, live]) {
    await fixture.writeJson("package.json", { name: "fixture" });
  }
  await baseline.write("src/secrets.ts", "export const debt = 'old';\n");
  await target.write(
    "src/secrets.ts",
    "export const debt = 'old';\nexport const staged = 'new';\n",
  );
  await live.write("src/secrets.ts", "export const live = 'different';\n");
  const changeSet: ChangeSet = {
    files: new Map([
      [
        "src/secrets.ts",
        {
          path: "src/secrets.ts",
          status: "modified",
          addedRanges: [{ start: 2, end: 2 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine: (file, line) => file === "src/secrets.ts" && line === 2,
  };
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  return {
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
    targetInspection: await inspectRepository(target.root),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.secrets,
    signal: new AbortController().signal,
  };
}

describe("secretsAdapter", () => {
  it("scans both snapshots and exposes only a new staged location", async () => {
    const run = await context();
    const cleanedOutputs: string[] = [];
    const adapter = createSecretsAdapter({
      resolveBinary: async () => binary,
      runBinary: async (_binary, args, options) => {
        const reportPath = args[args.indexOf("--report-path") + 1]!;
        cleanedOutputs.push(reportPath);
        const findings = [
          {
            RuleID: "generic-api-key",
            File: `${options.cwd}/src/secrets.ts`,
            StartLine: 1,
            EndLine: 1,
            StartColumn: 1,
            EndColumn: 20,
            Secret: canary,
            Match: `debt=${canary}`,
            Fingerprint: `commit:${canary}`,
          },
          ...(options.cwd === run.snapshots.targetDir
            ? [
                {
                  RuleID: "generic-api-key",
                  File: `${options.cwd}/src/secrets.ts`,
                  StartLine: 2,
                  EndLine: 2,
                  StartColumn: 1,
                  EndColumn: 20,
                  Secret: canary,
                  Match: `staged=${canary}`,
                  Fingerprint: `commit:${canary}:2`,
                },
              ]
            : []),
        ];
        await writeFile(reportPath, JSON.stringify(findings));
        return { stdout: "", stderr: "", exitCode: findings.length ? 1 : 0 };
      },
    });

    await expect(adapter.inspect(run)).resolves.toMatchObject({
      applies: true,
      executionClass: "project-analysis",
      requiresBaseline: true,
      targets: [{ id: ".", kind: "repository", relativeRoot: "." }],
    });
    const collected = await adapter.collect(run);
    const serialized = JSON.stringify(collected);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("Fingerprint");
    const result = await observationCheckResult(
      "secrets",
      collected,
      run,
      true,
    );
    expect(
      result.findings.filter(({ attribution }) => attribution.staged),
    ).toMatchObject([
      {
        rule: "generic-api-key",
        location: { file: "src/secrets.ts", startLine: 2 },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(canary);
    for (const path of cleanedOutputs) {
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("fails generically when the managed analyzer cannot run", async () => {
    const run = await context();
    const adapter = createSecretsAdapter({
      resolveBinary: async () => binary,
      runBinary: async () => {
        throw new Error(`analyzer leaked ${canary}`);
      },
    });
    try {
      await adapter.collect(run);
      throw new Error("expected collection failure");
    } catch (error) {
      expect(String(error)).toBe("Error: Secret analysis failed.");
      expect(JSON.stringify(error)).not.toContain(canary);
    }
  });

  it("flags a different secret that replaces one at the same rule and location", async () => {
    const run = await context();
    const oldSecret = "zedbee_old_secret_never_expose";
    const newSecret = "zedbee_new_secret_never_expose";
    await writeFile(
      `${run.snapshots.baselineDir}/src/secrets.ts`,
      `export const debt = 'old';\nexport const token = '${oldSecret}';\n`,
    );
    await writeFile(
      `${run.snapshots.targetDir}/src/secrets.ts`,
      `export const debt = 'old';\nexport const token = '${newSecret}';\n`,
    );
    const adapter = createSecretsAdapter({
      resolveBinary: async () => binary,
      runBinary: async (_binary, args, options) => {
        const reportPath = args[args.indexOf("--report-path") + 1]!;
        const Secret =
          options.cwd === run.snapshots.targetDir ? newSecret : oldSecret;
        await writeFile(
          reportPath,
          JSON.stringify([
            {
              RuleID: "generic-api-key",
              File: `${options.cwd}/src/secrets.ts`,
              StartLine: 2,
              EndLine: 2,
              StartColumn: 23,
              EndColumn: 22 + Secret.length,
              Secret,
            },
          ]),
        );
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });

    const collected = await adapter.collect(run);
    const result = await observationCheckResult(
      "secrets",
      collected,
      run,
      true,
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.attribution.staged).toBe(true);
    expect(JSON.stringify({ collected, result })).not.toContain(oldSecret);
    expect(JSON.stringify({ collected, result })).not.toContain(newSecret);
  });
});
