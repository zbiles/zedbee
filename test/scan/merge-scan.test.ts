import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
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
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
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
