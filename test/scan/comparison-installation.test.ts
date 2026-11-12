import { describe, it, expect } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";
async function fixture(reactDeclared: boolean, jsxImportSource = "react") {
  const repo = await createGitRepository("zedbee-comparison-install-");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      private: true,
      dependencies: reactDeclared ? { react: "19.0.0" } : {},
    }),
  );
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        jsx: "react-jsx",
        jsxImportSource,
        types: [],
      },
      include: ["src"],
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
      ),
    }),
  );
  await repo.write("src/value.tsx", "export const value = 1;\n");
  await repo.commitAll("baseline");
  await repo.write("src/value.tsx", "export const value = <div />;\n");
  await repo.git(["add", "src/value.tsx"]);
  return repo;
}
describe("comparison installation evidence", () => {
  it("reports a declared missing JSX runtime as an incomplete prerequisite", async () => {
    const repo = await fixture(true);
    const report = await runScan({ repositoryRoot: repo.root, cache: false });
    expect(report.outcome, JSON.stringify(report)).toBe("incomplete");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        checkId: "types",
        status: "incomplete",
        error: expect.objectContaining({
          code: "COMPARISON_INSTALLATION_UNAVAILABLE",
        }),
      }),
    );
    expect(
      report.summary.findings.filter((f) => f.rule === "typescript/TS2875"),
    ).toEqual([]);
  });
  it("does not excuse a newly mistyped undeclared JSX runtime", async () => {
    const repo = await fixture(true, "not-the-runtime");
    const report = await runScan({ repositoryRoot: repo.root, cache: false });
    expect(report.outcome).toBe("blocked");
    expect(report.summary.findings).toContainEqual(
      expect.objectContaining({ rule: "typescript/TS2875" }),
    );
  });
});

it("preserves a newly missing export in an otherwise self-contained project", async () => {
  const repo = await fixture(false);
  await repo.write(
    "src/value.tsx",
    "import { Account } from './account'; export const value = Account;\n",
  );
  await repo.write("src/account.ts", "export const Other = 1;\n");
  await repo.git(["add", "src"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome).toBe("blocked");
  expect(report.summary.findings).toContainEqual(
    expect.objectContaining({ rule: "typescript/TS2305" }),
  );
  expect(report.checks[0]?.comparisonContext).toMatchObject({
    version: 1,
    status: "comparable",
    reason: "captured-inputs",
  });
});

it("revalidates missing and installed runtime inputs between cached scans", async () => {
  const repo = await fixture(true);
  const { ObservationCacheStore } = await import("../../src/cache/store.js");
  const { rm } = await import("node:fs/promises");
  const cache = new ObservationCacheStore({ root: repo.root + "/cache" });
  const scan = () => runScan({ repositoryRoot: repo.root, cache });
  expect((await scan()).outcome).toBe("incomplete");
  await repo.write(
    "node_modules/react/package.json",
    JSON.stringify({ name: "react", version: "19.0.0" }),
  );
  await repo.write(
    "node_modules/react/jsx-runtime.d.ts",
    "export namespace JSX { interface IntrinsicElements { div: {}; } }\nexport function jsx(...args: unknown[]): unknown;\n",
  );
  for (let i = 0; i < 2; i++) expect((await scan()).outcome).toBe("pass");
  await rm(repo.root + "/node_modules", { recursive: true, force: true });
  expect((await scan()).outcome).toBe("incomplete");
});

it("never borrows installation results from another repository with the same source", async () => {
  const left = await fixture(true),
    right = await fixture(true);
  await left.write(
    "node_modules/react/package.json",
    JSON.stringify({ name: "react", version: "19.0.0" }),
  );
  await left.write(
    "node_modules/react/jsx-runtime.d.ts",
    "export namespace JSX { interface IntrinsicElements { div: {}; } }\nexport function jsx(...args: unknown[]): unknown;\n",
  );
  const { ObservationCacheStore } = await import("../../src/cache/store.js");
  const cache = new ObservationCacheStore({ root: left.root + "/cache" });
  for (const repo of [left, right, right, left]) {
    const report = await runScan({ repositoryRoot: repo.root, cache });
    expect(report.outcome).toBe(repo === left ? "pass" : "incomplete");
  }
});

it("accounts for installation declarations inherited from an intermediate workspace", async () => {
  const repo = await createGitRepository("zedbee-comparison-ancestor-");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "root",
      private: true,
      workspaces: ["web", "web/packages/*"],
    }),
  );
  await repo.write(
    "web/package.json",
    JSON.stringify({
      name: "web",
      private: true,
      dependencies: { react: "19.0.0" },
    }),
  );
  await repo.write(
    "web/packages/child/package.json",
    JSON.stringify({ name: "child", private: true }),
  );
  await repo.write(
    "web/packages/child/tsconfig.json",
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", types: [] },
      include: ["src"],
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
      ),
    }),
  );
  await repo.write(
    "web/packages/child/src/app.tsx",
    "export const value = 1;\n",
  );
  await repo.commitAll("baseline");
  await repo.write(
    "web/packages/child/src/app.tsx",
    "export const value = <div />;\n",
  );
  await repo.git(["add", "web/packages/child/src/app.tsx"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome, JSON.stringify(report)).toBe("incomplete");
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      target: "web/packages/child",
      status: "incomplete",
    }),
  );
});
