import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function fixture(when: "relevant" | "always" = "relevant") {
  const repo = await createGitRepository("zedbee-project-coverage-");
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === "lint" || id === "types" ? { severity: "error", when } : "off",
        ]),
      ),
    }),
  );
  for (const name of ["web", "e2e", "extension"]) {
    await repo.write(
      `${name}/package.json`,
      JSON.stringify({ name, private: true }),
    );
    await repo.write(
      `${name}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          allowSyntheticDefaultImports: true,
        },
        include: ["src"],
        ...(name === "extension"
          ? { references: [{ path: "./tsconfig.node.json" }] }
          : {}),
      }),
    );
    await repo.write(`${name}/src/index.ts`, "export const value = 1;\n");
  }
  await repo.write(
    "extension/tsconfig.node.json",
    JSON.stringify({
      compilerOptions: { composite: true, types: [] },
      include: ["vite.config.ts"],
    }),
  );
  await repo.write("extension/vite.config.ts", "export const config = {};\n");
  await repo.write("extension/vitest.config.ts", "export const config = {};\n");
  await repo.write(
    "web/src/lib/types/entry-wire-fixtures.json",
    '{"value":1}\n',
  );
  await repo.write(
    "web/src/index.ts",
    'import data from "./lib/types/entry-wire-fixtures.json";\nexport const value: number = data.value;\n',
  );
  await repo.commitAll("baseline with an uncovered extension config");
  return repo;
}

describe("diff-aware TypeScript project coverage", () => {
  it.each(["index", "base"] as const)(
    "allows a JSON-only %s change despite an untouched project's existing gap",
    async (mode) => {
      const repo = await fixture();
      const baseline = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
      await repo.write(
        "web/src/lib/types/entry-wire-fixtures.json",
        '{"value":2}\n',
      );
      await repo.git(["add", "web/src/lib/types/entry-wire-fixtures.json"]);
      if (mode === "base") await repo.commitAll("change JSON fixture");

      const report = await runScan({
        repositoryRoot: repo.root,
        cache: false,
        ...(mode === "base" ? { baseRef: baseline } : {}),
      });

      expect(report, JSON.stringify(report)).toMatchObject({
        outcome: "pass",
        exitCode: 0,
        changedFileCount: 1,
      });
      expect(report.checks.every((check) => check.status === "completed")).toBe(
        true,
      );
    },
  );

  it("still reports an unchanged consumer broken by JSON with an existing coverage gap", async () => {
    const repo = await fixture();
    await repo.write(
      "web/src/lib/types/entry-wire-fixtures.json",
      '{"value":"wrong"}\n',
    );
    await repo.git(["add", "web/src/lib/types/entry-wire-fixtures.json"]);

    const report = await runScan({ repositoryRoot: repo.root, cache: false });

    expect(
      report.checks.every((check) => check.status === "completed"),
      JSON.stringify(report),
    ).toBe(true);
    expect(report.outcome).toBe("blocked");
    expect(report.summary.findings).toContainEqual(
      expect.objectContaining({
        check: "types",
        rule: "typescript/TS2322",
        location: expect.objectContaining({ file: "web/src/index.ts" }),
        attribution: expect.objectContaining({ staged: true }),
      }),
    );
  });

  it.each(["changed", "always", "newly-excluded"] as const)(
    "retains required coverage for %s files",
    async (scenario) => {
      const repo = await fixture(scenario === "always" ? "always" : "relevant");
      const path =
        scenario === "changed"
          ? "extension/vitest.config.ts"
          : scenario === "always"
            ? "web/src/lib/types/entry-wire-fixtures.json"
            : "extension/tsconfig.json";
      await repo.write(
        path,
        scenario === "changed"
          ? "export const config = { changed: true };\n"
          : scenario === "always"
            ? '{"value":2}\n'
            : JSON.stringify({
                files: [],
                references: [{ path: "./tsconfig.node.json" }],
              }),
      );
      await repo.git(["add", path]);

      const report = await runScan({ repositoryRoot: repo.root, cache: false });

      expect(report.outcome, JSON.stringify(report)).toBe("incomplete");
      for (const [checkId, code] of [
        ["lint", "TYPED_LINT_PROJECT_MISMATCH"],
        ["types", "TYPESCRIPT_PROJECT_MISMATCH"],
      ]) {
        expect(report.checks).toContainEqual(
          expect.objectContaining({
            checkId,
            target: "extension",
            status: "incomplete",
            error: expect.objectContaining({
              code,
              paths: expect.arrayContaining([
                scenario === "newly-excluded"
                  ? "extension/src/index.ts"
                  : "extension/vitest.config.ts",
              ]),
            }),
          }),
        );
      }
    },
  );

  it("still checks covered consumers in a workspace with an existing gap", async () => {
    const repo = await fixture();
    await repo.write(
      "extension/src/index.ts",
      'import data from "../../web/src/lib/types/entry-wire-fixtures.json";\nexport const value: number = data.value;\n',
    );
    await repo.commitAll("add a cross-project JSON consumer");
    await repo.write(
      "web/src/lib/types/entry-wire-fixtures.json",
      '{"value":"wrong"}\n',
    );
    await repo.git(["add", "web/src/lib/types/entry-wire-fixtures.json"]);

    const report = await runScan({ repositoryRoot: repo.root, cache: false });

    expect(
      report.checks.every((check) => check.status === "completed"),
      JSON.stringify(report),
    ).toBe(true);
    expect(report.summary.findings).toContainEqual(
      expect.objectContaining({
        check: "types",
        rule: "typescript/TS2322",
        location: expect.objectContaining({ file: "extension/src/index.ts" }),
        attribution: expect.objectContaining({ staged: true }),
      }),
    );
  });

  it("honors per-file always coverage even when the workspace policy is relevant", async () => {
    const repo = await fixture();
    const config = JSON.parse(await repo.read(".zedbeerc.jsonc"));
    config.overrides = [
      {
        files: ["extension/vitest.config.ts"],
        checks: { lint: { when: "always" }, types: { when: "always" } },
      },
    ];
    await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
    await repo.commitAll("require full coverage for a specific file");
    await repo.write(
      "web/src/lib/types/entry-wire-fixtures.json",
      '{"value":2}\n',
    );
    await repo.git(["add", "web/src/lib/types/entry-wire-fixtures.json"]);

    const report = await runScan({ repositoryRoot: repo.root, cache: false });

    for (const checkId of ["lint", "types"]) {
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          checkId,
          target: "extension",
          status: "incomplete",
          error: expect.objectContaining({
            paths: ["extension/vitest.config.ts"],
          }),
        }),
      );
    }
  });
});
