import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const options = {
  strict: true,
  types: [],
  skipLibCheck: true,
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "bundler",
};
const project = (selected: "sync" | "async") =>
  JSON.stringify({
    compilerOptions: {
      ...options,
      paths: { selected: [`./src/${selected}.ts`] },
    },
    include: ["src/**/*.ts"],
  });
const scan = (repositoryRoot: string) =>
  runScan({ repositoryRoot, cache: false, sourceExcerpts: "exclude" });

async function fixture(
  files: Readonly<Record<string, string>>,
  when: "relevant" | "always" = "relevant",
  checkId: "lint" | "types" = "lint",
) {
  const repo = await createGitRepository("zedbee-typed-lint-inputs-");
  await repo.write("package.json", '{"name":"fixture","private":true}\n');
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === checkId ? { severity: "error", when } : "off",
        ]),
      ),
    }),
  );
  for (const [path, text] of Object.entries(files))
    await repo.write(path, text);
  await repo.commitAll("base");
  return repo;
}

const sources = {
  "src/sync.ts": "export function action() { return 1; }\n",
  "src/async.ts":
    "export async function action() { return await Promise.resolve(1); }\n",
  "src/index.ts": 'import { action } from "selected";\naction();\n',
};

describe("typed-lint project input attribution", () => {
  it.each(["relevant", "always"] as const)(
    "blocks an unhandled promise introduced by config-only resolution changes (%s)",
    async (when) => {
      const repo = await fixture(
        { ...sources, "tsconfig.json": project("sync") },
        when,
      );
      await repo.write("tsconfig.json", project("async"));
      expect((await repo.git(["add", "tsconfig.json"])).exitCode).toBe(0);

      const report = await scan(repo.root);

      expect(report, JSON.stringify(report)).toMatchObject({
        outcome: "blocked",
        exitCode: 1,
        checks: [{ checkId: "lint", status: "completed" }],
      });
      expect(report.checks.flatMap((check) => check.findings)).toContainEqual(
        expect.objectContaining({
          rule: "@typescript-eslint/no-floating-promises",
          location: expect.objectContaining({
            file: "src/index.ts",
            startLine: 2,
          }),
          attribution: expect.objectContaining({ staged: true }),
        }),
      );
    },
  );

  it("checks an unchanged consumer of a changed sibling's return type", async () => {
    const config = JSON.stringify({
      compilerOptions: options,
      include: ["src/**/*.ts"],
    });
    const repo = await fixture({
      "package.json":
        '{"name":"fixture","private":true,"workspaces":["packages/*"]}\n',
      "packages/a/package.json": '{"name":"a","private":true}\n',
      "packages/b/package.json": '{"name":"b","private":true}\n',
      "packages/a/tsconfig.json": config,
      "packages/b/tsconfig.json": config,
      "packages/a/src/index.ts": "export function action() { return 1; }\n",
      "packages/b/src/index.ts":
        'import { action } from "../../a/src/index";\naction();\n',
    });
    await repo.write("packages/a/src/index.ts", sources["src/async.ts"]);
    expect((await repo.git(["add", "packages/a/src/index.ts"])).exitCode).toBe(
      0,
    );

    const report = await scan(repo.root);

    expect(report.outcome, JSON.stringify(report)).toBe("blocked");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        checkId: "lint",
        target: "packages/b",
        status: "completed",
        findings: expect.arrayContaining([
          expect.objectContaining({
            rule: "@typescript-eslint/no-floating-promises",
            location: expect.objectContaining({
              file: "packages/b/src/index.ts",
            }),
            attribution: expect.objectContaining({ staged: true }),
          }),
        ]),
      }),
    );
  });

  it("suppresses existing baseline diagnostics when an added line moves them", async () => {
    const repo = await fixture({
      ...sources,
      "tsconfig.json": project("async"),
    });
    await repo.write(
      "src/index.ts",
      `// Harmless insertion\n${sources["src/index.ts"]}`,
    );
    expect((await repo.git(["add", "src/index.ts"])).exitCode).toBe(0);

    const report = await scan(repo.root);

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      checks: [{ checkId: "lint", status: "completed", findings: [] }],
    });
  });

  it.each([
    { checkId: "lint", introduceDebt: false },
    { checkId: "lint", introduceDebt: true },
    { checkId: "types", introduceDebt: false },
    { checkId: "types", introduceDebt: true },
  ] as const)(
    "pairs existing $checkId debt across workspace renames (new debt: $introduceDebt)",
    async ({ checkId, introduceDebt }) => {
      const config = JSON.stringify({
        compilerOptions: options,
        include: ["src/**/*.ts"],
      });
      const existing =
        checkId === "types"
          ? 'export const value: number = "old";\nexport const keep = 1;\nexport const other = 2;\n'
          : "export async function action() { return await Promise.resolve(1); }\naction();\nexport const keep = 1;\nexport const other = 2;\n";
      const repo = await fixture(
        {
          "package.json":
            '{"name":"fixture","private":true,"workspaces":["packages/*"]}\n',
          "packages/a/package.json": '{"name":"a","private":true}\n',
          "packages/b/package.json": '{"name":"b","private":true}\n',
          "packages/a/tsconfig.json": config,
          "packages/b/tsconfig.json": config,
          "packages/a/src/keep.ts": "export const value = 1;\n",
          "packages/b/src/keep.ts": "export const value = 2;\n",
          "packages/a/src/moved.ts": existing,
        },
        "relevant",
        checkId,
      );
      expect(
        (
          await repo.git([
            "mv",
            "packages/a/src/moved.ts",
            "packages/b/src/moved.ts",
          ])
        ).exitCode,
      ).toBe(0);
      if (introduceDebt) {
        await repo.write(
          "packages/b/src/moved.ts",
          existing +
            (checkId === "types"
              ? 'export const added: boolean = "new";\n'
              : "export const added: any = 1;\n"),
        );
        expect(
          (await repo.git(["add", "packages/b/src/moved.ts"])).exitCode,
        ).toBe(0);
      }

      const report = await scan(repo.root);
      expect(report.outcome, JSON.stringify(report)).toBe(
        introduceDebt ? "blocked" : "pass",
      );
      expect(report.checks.every((check) => check.status === "completed")).toBe(
        true,
      );
      const findings = report.checks.flatMap((check) => check.findings);
      expect(findings).toHaveLength(introduceDebt ? 1 : 0);
      expect(
        findings.filter(
          (finding) =>
            finding.rule === "@typescript-eslint/no-floating-promises",
        ),
      ).toEqual([]);
      if (introduceDebt)
        expect(findings).toContainEqual(
          expect.objectContaining({
            rule:
              checkId === "types"
                ? "typescript/TS2322"
                : "@typescript-eslint/no-explicit-any",
            location: expect.objectContaining({
              file: "packages/b/src/moved.ts",
              startLine: checkId === "types" ? 4 : 5,
            }),
          }),
        );
      else expect(findings).toEqual([]);
    },
  );

  it("suppresses existing debt after a config-only edit", async () => {
    const repo = await fixture({
      ...sources,
      "tsconfig.json": project("async"),
    });
    await repo.write("tsconfig.json", `${project("async")}\n`);
    expect((await repo.git(["add", "tsconfig.json"])).exitCode).toBe(0);

    const report = await scan(repo.root);

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      checks: [{ checkId: "lint", status: "completed", findings: [] }],
    });
  });

  it.each([true, false])(
    "honors a per-file lint policy for config-only changes (enabled: %s)",
    async (enabled) => {
      const repo = await fixture({
        ...sources,
        "tsconfig.json": project("sync"),
      });
      await repo.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          schemaVersion: 1,
          checks: Object.fromEntries(
            CHECK_IDS.map((id) => [
              id,
              id === "lint" && !enabled ? "error" : "off",
            ]),
          ),
          overrides: [
            {
              files: ["src/index.ts"],
              checks: { lint: enabled ? "error" : "off" },
            },
          ],
        }),
      );
      await repo.commitAll("file policy");
      await repo.write("tsconfig.json", project("async"));
      expect((await repo.git(["add", "tsconfig.json"])).exitCode).toBe(0);

      const report = await scan(repo.root);

      expect(report.outcome, JSON.stringify(report)).toBe(
        enabled ? "blocked" : "pass",
      );
      expect(report.checks.every((check) => check.status === "completed")).toBe(
        true,
      );
      const findings = report.checks.flatMap((check) => check.findings);
      if (enabled) {
        expect(findings).toContainEqual(
          expect.objectContaining({
            rule: "@typescript-eslint/no-floating-promises",
            location: expect.objectContaining({ file: "src/index.ts" }),
          }),
        );
      } else {
        expect(findings).toEqual([]);
      }
    },
  );
});
