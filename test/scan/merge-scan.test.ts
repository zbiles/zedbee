import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";
import { lstat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { DEFAULT_ANALYSIS_SESSION_DEPENDENCIES } from "../../src/scan/analysis-session.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import type { ScanEvent } from "../../src/checks/events.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderSarif } from "../../src/renderers/sarif.js";
import { scanSourceIdentityLine } from "../../src/reporting/source-identity.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function fixture() {
  const repo = await createGitRepository("zedbee-merge-scan-");
  await repo.write("package.json", '{"name":"merge-fixture","private":true}\n');
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["**/*.ts"],
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          { severity: id === "types" ? "error" : "off" },
        ]),
      ),
    }),
  );
  await repo.write(
    "summarize.ts",
    "export const advisoryLabel = () => 'label';\n",
  );
  await repo.write(
    "main-caller.ts",
    "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
  );
  await repo.commitAll("base");
  await repo.git(["branch", "incoming"]);
  return repo;
}

const scan = (repositoryRoot: string) =>
  runScan({
    repositoryRoot,
    merge: "auto",
    mergeEnvironment: {},
    cache: false,
    sourceExcerpts: "exclude",
  });

describe("staged merge comparison", () => {
  it("does not open an analyzer session when every check is disabled", async () => {
    const repo = await fixture();
    await repo.git(["switch", "incoming"]);
    await repo.write("incoming.md", "Incoming change");
    await repo.commitAll("incoming change");
    await repo.git(["switch", "main"]);
    await repo.write("main.md", "Main change");
    await repo.commitAll("main change");
    await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]);
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(CHECK_IDS.map((id) => [id, "off"])),
      }),
    );
    await repo.git(["add", ".zedbeerc.jsonc"]);

    let opens = 0;
    const report = await runScan({
      repositoryRoot: repo.root,
      merge: "required",
      cache: false,
      executor: {
        async openSession() {
          opens++;
          return {
            async run() {
              throw new Error("No jobs expected");
            },
            async close() {},
          };
        },
        async close() {},
      },
    });

    expect(report.exitCode).toBe(0);
    expect(report.mergeParents).toHaveLength(2);
    expect(opens).toBe(0);
  });

  it.each(["secrets", "deadCode"] as const)(
    "captures the scheduled inputs for %s across merge parents",
    async (checkId) => {
      const repo = await fixture();
      await repo.write(
        "package.json",
        JSON.stringify({
          name: "app",
          devDependencies: { vite: "7" },
        }),
      );
      await repo.write("index.html", "<p>Before entry selection</p>");
      await repo.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          schemaVersion: 1,
          checks: Object.fromEntries(
            CHECK_IDS.map((id) => [id, id === checkId ? "error" : "off"]),
          ),
        }),
      );
      await repo.commitAll("configure check");
      await repo.git(["branch", "-f", "incoming", "HEAD"]);
      await repo.git(["switch", "incoming"]);
      await repo.write(
        "index.html",
        '<script type="module" src="/summarize.ts"></script>',
      );
      await repo.commitAll("select entry");
      await repo.git(["switch", "main"]);
      await repo.write("README.md", "Application notes");
      await repo.commitAll("notes");
      await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]);

      const local = createLocalAnalyzerExecutor();
      const selections: (readonly string[])[] = [];
      try {
        const report = await runScan({
          repositoryRoot: repo.root,
          merge: "required",
          cache: false,
          executor: {
            openSession(options) {
              for (const selection of options?.sourceSelections ?? [])
                selections.push(selection.paths);
              return local.openSession(options);
            },
            close: () => local.close(),
          },
        });
        expect(report.checks, JSON.stringify(report)).toEqual([
          expect.objectContaining({ checkId, status: "completed" }),
        ]);
        expect(selections).toHaveLength(4);
        for (const paths of selections) {
          expect(paths).toContain("index.html");
          if (checkId === "secrets")
            expect(paths).not.toContain("main-caller.ts");
          else expect(paths).toContain("main-caller.ts");
        }
      } finally {
        await local.close();
      }
    },
  );

  it("blocks a merge when both parent scans fail to load the staged config", async () => {
    const repo = await fixture();
    await repo.git(["switch", "incoming"]);
    await repo.write("incoming.ts", "export const incoming = 1;\n");
    await repo.commitAll("incoming change");
    await repo.git(["switch", "main"]);
    await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]);
    await repo.write(".zedbeerc.jsonc", "invalid");
    await repo.git(["add", ".zedbeerc.jsonc"]);

    const report = await scan(repo.root);
    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      checks: [{ status: "incomplete", error: { code: "CONFIG_INVALID" } }],
    });
  });

  it("prepares the same target once for an octopus merge and cleans every snapshot", async () => {
    const repo = await fixture();
    await repo.git(["branch", "other"]);
    for (const branch of ["main", "incoming", "other"]) {
      await repo.git(["switch", branch]);
      await repo.write(`${branch}.ts`, `export const ${branch} = 1;\n`);
      await repo.commitAll(branch);
    }
    await repo.git(["switch", "main"]);
    const merge = await repo.git([
      "merge",
      "--no-commit",
      "--no-ff",
      "incoming",
      "other",
    ]);
    expect(merge.exitCode, merge.stderr).toBe(0);
    const pairs: { baselineDir: string; targetDir: string }[] = [];
    const dependencies = DEFAULT_ANALYSIS_SESSION_DEPENDENCIES;
    const report = await runScan({
      repositoryRoot: repo.root,
      merge: "required",
      cache: false,
      dependencies: {
        ...dependencies,
        evaluate: evaluatePolicy,
        now: () => new Date(),
        async buildCommitSnapshots(...args) {
          const pair = await dependencies.buildCommitSnapshots(...args);
          pairs.push(pair);
          return pair;
        },
        async buildMergeBaseline(...args) {
          const pair = await dependencies.buildMergeBaseline!(...args);
          pairs.push(pair);
          return pair;
        },
      },
    });
    expect(report).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      summary: { passed: 1 },
    });
    expect(report.mergeParents).toHaveLength(3);
    expect(pairs).toHaveLength(3);
    expect(new Set(pairs.map((pair) => pair.targetDir)).size).toBe(1);
    expect(new Set(pairs.map((pair) => pair.baselineDir)).size).toBe(3);
    for (const pair of pairs) {
      await expect(lstat(pair.baselineDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(pair.targetDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
  it("retains a sanitized merge failure and cleanup diagnosis when private-index removal fails", async () => {
    const repo = await createGitRepository();
    await repo.write("value.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    const report = await runScan({
      repositoryRoot: repo.root,
      merge: "required",
      mergeEnvironment: {},
      cache: false,
      dependencies: {
        ...DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
        evaluate: evaluatePolicy,
        now: () => new Date(),
        async captureIndexComparison(...parameters) {
          const selected =
            await DEFAULT_ANALYSIS_SESSION_DEPENDENCIES.captureIndexComparison!(
              ...parameters,
            );
          return {
            ...selected,
            async cleanup() {
              await selected.cleanup();
              throw new Error("private raw cleanup path");
            },
          };
        },
      },
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.checks.map((check) => check.error?.code)).toEqual(
      expect.arrayContaining([
        "MERGE_PARENTS_UNAVAILABLE",
        "SNAPSHOT_CLEANUP_FAILED",
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("private raw cleanup path");
  });
  it("does not block a TypeScript finding inherited from the incoming parent", async () => {
    const repo = await fixture();
    await repo.git(["switch", "incoming"]);
    await repo.write(
      "incoming.ts",
      'export const inherited: number = "debt";\n',
    );
    await repo.commitAll("existing incoming finding");
    const incoming = (await repo.git(["rev-parse", "HEAD"])).stdout;
    await repo.git(["switch", "main"]);
    await repo.write("main.ts", "export const main = 1;\n");
    await repo.commitAll("main change");
    const main = (await repo.git(["rev-parse", "HEAD"])).stdout;
    expect(
      (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]))
        .exitCode,
    ).toBe(0);
    const events: ScanEvent[] = [];
    const report = await runScan({
      repositoryRoot: repo.root,
      merge: "auto",
      mergeEnvironment: {},
      cache: false,
      sourceExcerpts: "exclude",
      onEvent: (event) => events.push(event),
    });
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      mode: "index",
      target: "index",
      mergeParents: [main, incoming],
    });
    expect(report.checks.flatMap((check) => check.findings)).toEqual([]);
    const completed = events.filter(
      (event) => event.type === "check-completed",
    );
    expect(completed.map((event) => event.result)).toEqual(report.checks);
    expect(events.slice(0, 2)).toMatchObject([
      { type: "scan-phase", phase: "baseline-resolution" },
      { type: "scan-phase", phase: "change-discovery" },
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
    expect(report.changeSummary).toBeUndefined();
    expect(JSON.parse(renderJson(report)).changeSummary).toBeUndefined();
    expect(JSON.parse(renderJson(report)).mergeParents).toEqual([
      main,
      incoming,
    ]);
    expect(
      JSON.parse(renderSarif(report)).runs[0].invocations[0].properties
        .mergeParents,
    ).toEqual([main, incoming]);
    expect(scanSourceIdentityLine(report)).toContain(main.slice(0, 12));
  });

  it("blocks a caller added on one branch when the other branch renames its export", async () => {
    const repo = await fixture();
    await repo.git(["switch", "incoming"]);
    await repo.write(
      "incoming-caller.ts",
      "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
    );
    await repo.commitAll("new caller");
    expect(
      (
        await runScan({
          repositoryRoot: repo.root,
          baseRef: "main",
          cache: false,
        })
      ).exitCode,
    ).toBe(0);
    await repo.git(["switch", "main"]);
    await repo.write(
      "summarize.ts",
      "export const advisoryLabelRenamed = () => 'label';\n",
    );
    await repo.write(
      "main-caller.ts",
      "import { advisoryLabelRenamed } from './summarize';\nexport const label = advisoryLabelRenamed();\n",
    );
    await repo.commitAll("rename export and its caller");
    expect(
      (
        await runScan({
          repositoryRoot: repo.root,
          baseRef: "incoming",
          cache: false,
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]))
        .exitCode,
    ).toBe(0);
    // A working-tree-only repair must not hide the broken staged merge.
    await repo.write(
      "incoming-caller.ts",
      "import { advisoryLabelRenamed } from './summarize';\nexport const label = advisoryLabelRenamed();\n",
    );
    await repo.write(
      ".zedbeerc.jsonc",
      '{"schemaVersion":1,"profile":"recommended","checks":{"types":"off"}}\n',
    );
    const report = await scan(repo.root);
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
    });
    expect(
      report.checks
        .flatMap((check) => check.findings)
        .map((finding) => ({
          rule: finding.rule,
          file: finding.location?.file,
        })),
    ).toEqual([{ rule: "typescript/TS2305", file: "incoming-caller.ts" }]);
  });
});

it("does not treat an inherited lint error as new when both branches shift its line", async () => {
  const repo = await fixture();
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          {
            severity: id === "lint" ? "error" : "off",
            ...(id === "lint" ? { rules: { "no-debugger": "error" } } : {}),
          },
        ]),
      ),
    }),
  );
  const source =
    "export function existing() {\n  let value = 0;\n" +
    Array.from(
      { length: 12 },
      (_, index) => `  value += ${index}; // anchor${index}`,
    ).join("\n") +
    "\n  debugger;\n  return value;\n}\n";
  await repo.write("debt.ts", source);
  await repo.commitAll("existing lint debt");
  await repo.git(["branch", "-f", "incoming", "HEAD"]);
  await repo.git(["switch", "incoming"]);
  await repo.write(
    "debt.ts",
    source.replace("// anchor9", "// anchor9\n  // incoming change"),
  );
  await repo.commitAll("incoming shifts debt");
  await repo.git(["switch", "main"]);
  await repo.write(
    "debt.ts",
    source.replace("// anchor1\n", "// anchor1\n  // main change\n"),
  );
  await repo.commitAll("main shifts debt");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);
  const report = await scan(repo.root);
  expect(report, JSON.stringify(report)).toMatchObject({
    outcome: "pass",
    exitCode: 0,
  });
  expect(report.checks.flatMap((check) => check.findings)).toEqual([]);
});

it("fails clearly when the merge hook cannot identify incoming parents", async () => {
  const repo = await fixture();
  const report = await runScan({
    repositoryRoot: repo.root,
    merge: "required",
    mergeEnvironment: {},
  });
  expect(report).toMatchObject({
    outcome: "incomplete",
    exitCode: 2,
    checks: [{ error: { code: "MERGE_PARENTS_UNAVAILABLE" } }],
  });
});

it("blocks a new typed-lint failure in an unchanged caller after combining branches", async () => {
  const repo = await fixture();
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          {
            severity: id === "lint" ? "error" : "off",
            ...(id === "lint"
              ? {
                  rules: { "@typescript-eslint/no-floating-promises": "error" },
                }
              : {}),
          },
        ]),
      ),
    }),
  );
  await repo.commitAll("lint policy");
  await repo.git(["branch", "-f", "incoming", "HEAD"]);
  await repo.git(["switch", "incoming"]);
  await repo.write(
    "incoming-caller.ts",
    "import { advisoryLabel } from './summarize';\nadvisoryLabel();\n",
  );
  await repo.commitAll("sync caller");
  await repo.git(["switch", "main"]);
  await repo.write(
    "summarize.ts",
    "export const advisoryLabel = async () => 'label';\n",
  );
  await repo.commitAll("async export");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);
  const report = await scan(repo.root);
  expect(report, JSON.stringify(report)).toMatchObject({
    outcome: "blocked",
    exitCode: 1,
  });
  expect(
    report.checks
      .flatMap((check) => check.findings)
      .map((finding) => ({ rule: finding.rule, file: finding.location?.file })),
  ).toContainEqual({
    rule: "@typescript-eslint/no-floating-promises",
    file: "incoming-caller.ts",
  });
});

it("suppresses incoming complexity debt but blocks a threshold crossed by the merge", async () => {
  const repo = await fixture();
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          {
            severity: id === "cyclomaticComplexity" ? "error" : "off",
            ...(id === "cyclomaticComplexity" ? { max: 2 } : {}),
          },
        ]),
      ),
    }),
  );
  const source =
    "export function combined(a: boolean, b: boolean) {\n  let value = 0;\n  // main slot\n" +
    Array.from({ length: 10 }, (_, index) => `  value += ${index};`).join(
      "\n",
    ) +
    "\n  // incoming slot\n  return value;\n}\n";
  await repo.write("combined.ts", source);
  await repo.commitAll("complexity policy and base");
  await repo.git(["branch", "-f", "incoming", "HEAD"]);
  await repo.git(["switch", "incoming"]);
  await repo.write(
    "combined.ts",
    source.replace("// incoming slot", "if (b) value++;"),
  );
  await repo.write(
    "debt.ts",
    "export function debt(a: boolean, b: boolean, c: boolean) {\n  if (a) return 1;\n  if (b) return 2;\n  if (c) return 3;\n  return 0;\n}\n",
  );
  await repo.commitAll("incoming branch");
  await repo.git(["switch", "main"]);
  await repo.write(
    "combined.ts",
    source.replace("// main slot", "if (a) value++;"),
  );
  await repo.commitAll("main branch");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);
  const report = await scan(repo.root);
  expect(report, JSON.stringify(report)).toMatchObject({
    outcome: "blocked",
    exitCode: 1,
  });
  expect(
    report.summary.findings.map((finding) => finding.location?.file),
  ).toEqual(["combined.ts"]);
});

it("suppresses inherited formatting but blocks new formatting in the staged merge", async () => {
  const repo = await fixture();
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          { severity: id === "formatting" ? "error" : "off" },
        ]),
      ),
    }),
  );
  await repo.commitAll("formatting policy");
  await repo.git(["branch", "-f", "incoming", "HEAD"]);
  await repo.git(["switch", "incoming"]);
  await repo.write("inherited.ts", "export const inherited={a:1}\n");
  await repo.commitAll("existing incoming formatting");
  await repo.git(["switch", "main"]);
  await repo.write("main.ts", "export const main = 1;\n");
  await repo.commitAll("main change");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);
  const inherited = await scan(repo.root);
  expect(inherited, JSON.stringify(inherited)).toMatchObject({
    outcome: "pass",
    exitCode: 0,
  });
  await repo.write("new.ts", "export const newValue={b:2}\n");
  await repo.git(["add", "new.ts"]);
  const changed = await scan(repo.root);
  expect(changed, JSON.stringify(changed)).toMatchObject({
    outcome: "blocked",
    exitCode: 1,
  });
  expect([
    ...new Set(
      changed.summary.findings.map((finding) => finding.location?.file),
    ),
  ]).toEqual(["new.ts"]);
});

it.each(["dependencyArchitecture", "deadCode"] as const)(
  "allows an inherited project-folder deletion with %s enabled",
  async (checkId) => {
    const repo = await fixture();
    await repo.write(
      "package.json",
      JSON.stringify({
        name: "merge-fixture",
        private: true,
        workspaces: ["packages/*"],
      }),
    );
    await repo.write(
      "packages/retired/package.json",
      '{"name":"retired","private":true}\n',
    );
    await repo.write(
      "packages/retired/index.js",
      "export const retired = 1;\n",
    );
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "recommended",
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [
            id,
            { severity: id === checkId ? "error" : "off" },
          ]),
        ),
      }),
    );
    await repo.commitAll("workspace base");
    await repo.git(["branch", "-f", "incoming", "HEAD"]);
    await repo.git(["switch", "incoming"]);
    await repo.write("README.md", "Incoming documentation.\n");
    await repo.commitAll("incoming documentation");
    await repo.git(["switch", "main"]);
    await repo.git(["rm", "-r", "packages/retired"]);
    await repo.commitAll("remove retired project");
    expect(
      (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]))
        .exitCode,
    ).toBe(0);
    const report = await scan(repo.root);
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
    });
    expect(report.summary.findings).toEqual([]);
  },
);

it("allows an inherited empty lockfile deletion when one parent has no dependency changes", async () => {
  const repo = await fixture();
  await repo.write(
    "package-lock.json",
    JSON.stringify({
      name: "merge-fixture",
      lockfileVersion: 3,
      packages: { "": { name: "merge-fixture" } },
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          { severity: id === "vulnerabilities" ? "error" : "off" },
        ]),
      ),
    }),
  );
  await repo.commitAll("dependency policy and empty inventory");
  await repo.git(["branch", "-f", "incoming", "HEAD"]);
  await repo.git(["switch", "incoming"]);
  await repo.write("README.md", "Incoming documentation.\n");
  await repo.commitAll("incoming documentation");
  await repo.git(["switch", "main"]);
  await repo.git(["rm", "package-lock.json"]);
  await repo.commitAll("remove empty lockfile");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);
  const report = await scan(repo.root);
  expect(report, JSON.stringify(report)).toMatchObject({
    outcome: "pass",
    exitCode: 0,
  });
  expect(report.summary.findings).toEqual([]);
});

it("skips proven independent compiler targets across both mixed merge parents", async () => {
  const { createSeparateCompilerWorkspaces } =
    await import("../helpers/separate-compiler-workspaces.js");
  const repo = await createSeparateCompilerWorkspaces({
    "web/src/style.css": "body { margin: 1px; }\n",
    "web/src/data.json": '{"value":1}\n',
    "docs/openapi.yaml": 'openapi: "3.0.0"\n',
    "scripts/check.sh": "#!/bin/sh\nexit 0\n",
  });
  expect((await repo.git(["switch", "-c", "incoming"])).exitCode).toBe(0);
  await repo.write("web/src/index.ts", "export const value = 2;\n");
  await repo.write("web/src/style.css", "body { margin: 2px; }\n");
  await repo.write("web/src/data.json", '{"value":2}\n');
  await repo.commitAll("storefront changes");
  expect((await repo.git(["switch", "main"])).exitCode).toBe(0);
  await repo.write("docs/openapi.yaml", 'openapi: "3.1.0"\n');
  await repo.write("scripts/check.sh", "#!/bin/sh\nexit 1\n");
  await repo.commitAll("API notes and helper");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);

  const report = await scan(repo.root);
  expect(report.outcome, JSON.stringify(report)).toBe("pass");
  expect(report.mergeParents).toHaveLength(2);
  for (const checkId of ["lint", "types"]) {
    expect(
      report.checks
        .filter((check) => check.checkId === checkId)
        .map(({ target, status, skipReason }) => ({
          target,
          status,
          skipReason,
        })),
    ).toEqual([
      {
        target: "e2e",
        status: "skipped",
        skipReason:
          "Workspace compiler inputs are independent of the selected changes",
      },
      {
        target: "extension",
        status: "skipped",
        skipReason:
          "Workspace compiler inputs are independent of the selected changes",
      },
      { target: "web", status: "completed", skipReason: undefined },
    ]);
  }
});

it("keeps an unchanged workspace that imports changed cross-workspace JSON", async () => {
  const { createSeparateCompilerWorkspaces } =
    await import("../helpers/separate-compiler-workspaces.js");
  const repo = await createSeparateCompilerWorkspaces({
    "web/src/data.json": '{"value":"before"}\n',
    "extension/src/index.ts":
      'import data from "../../web/src/data.json"; export const value: string = data.value;\n',
  });
  expect((await repo.git(["switch", "-c", "incoming"])).exitCode).toBe(0);
  await repo.write("docs/openapi.yaml", 'openapi: "3.1.0"\n');
  await repo.commitAll("API notes");
  expect((await repo.git(["switch", "main"])).exitCode).toBe(0);
  await repo.write("scripts/check.sh", "#!/bin/sh\nexit 0\n");
  await repo.commitAll("API helper");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);
  await repo.write("web/src/data.json", '{"value":1}\n');
  expect((await repo.git(["add", "web/src/data.json"])).exitCode).toBe(0);

  const report = await scan(repo.root);
  expect(report.outcome, JSON.stringify(report)).toBe("blocked");
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      checkId: "types",
      target: "extension",
      status: "completed",
      findings: [
        expect.objectContaining({
          rule: "typescript/TS2322",
          location: expect.objectContaining({ file: "extension/src/index.ts" }),
        }),
      ],
    }),
  );
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      checkId: "types",
      target: "e2e",
      status: "skipped",
      skipReason:
        "Workspace compiler inputs are independent of the selected changes",
    }),
  );
});

it("finds the same compiler error from a conflict resolution with narrowed and broad plans", async () => {
  const { createSeparateCompilerWorkspaces } =
    await import("../helpers/separate-compiler-workspaces.js");
  const repo = await createSeparateCompilerWorkspaces({
    "web/src/index.ts": 'export const value: string = "base";\n',
  });
  expect((await repo.git(["switch", "-c", "incoming"])).exitCode).toBe(0);
  await repo.write(
    "web/src/index.ts",
    'export const value: string = "incoming";\n',
  );
  await repo.write("docs/openapi.yaml", 'openapi: "3.1.0"\n');
  await repo.commitAll("incoming version");
  expect((await repo.git(["switch", "main"])).exitCode).toBe(0);
  await repo.write(
    "web/src/index.ts",
    'export const value: string = "main";\n',
  );
  await repo.write("web/src/style.css", "body { margin: 1px; }\n");
  await repo.commitAll("main version");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(1);
  await repo.write("web/src/index.ts", "export const value: string = 1;\n");
  expect((await repo.git(["add", "web/src/index.ts"])).exitCode).toBe(0);

  const narrow = await scan(repo.root);
  expect(narrow.outcome, JSON.stringify(narrow)).toBe("blocked");
  expect(narrow.checks).toContainEqual(
    expect.objectContaining({
      checkId: "types",
      target: "e2e",
      status: "skipped",
    }),
  );
  expect(narrow.summary.findings).toContainEqual(
    expect.objectContaining({
      rule: "typescript/TS2322",
      location: expect.objectContaining({ file: "web/src/index.ts" }),
    }),
  );

  for (const name of ["e2e", "extension"]) {
    await repo.write(
      `${name}/node_modules/fixture-package/package.json`,
      '{"name":"fixture-package","version":"1.0.0","types":"index.d.ts"}',
    );
    await repo.write(
      `${name}/node_modules/fixture-package/index.d.ts`,
      "export declare const value: number;\n",
    );
  }

  const broad = await scan(repo.root);
  expect(broad.outcome, JSON.stringify(broad)).toBe(narrow.outcome);
  expect(broad.checks).toContainEqual(
    expect.objectContaining({
      checkId: "types",
      target: "e2e",
      status: "completed",
    }),
  );
  expect(broad.summary.findings).toEqual(narrow.summary.findings);
});
