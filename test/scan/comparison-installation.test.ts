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
  it("explains a partially installed upgrade-only commit and completes after its required typings are installed", async () => {
    const repo = await createGitRepository("zedbee-partial-install-");
    const manifest = {
      name: "fixture",
      private: true,
      version: "1.0.0",
      devDependencies: { "@types/node": "26.0.0" },
    };
    await repo.write(".gitignore", "node_modules/\n");
    await repo.write("package.json", JSON.stringify(manifest));
    await repo.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
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
    await repo.write("src/value.ts", "export const value = process.version;\n");
    await repo.commitAll("baseline with declared types");
    await repo.write(
      "node_modules/.installation-present",
      "directory exists\n",
    );
    await repo.write(
      "package.json",
      JSON.stringify({ ...manifest, version: "1.0.1" }),
    );
    await repo.git(["add", "package.json"]);
    const scan = () => runScan({ repositoryRoot: repo.root, cache: false });
    const missing = await scan();
    expect(missing.outcome).toBe("incomplete");
    expect(missing.checks).toContainEqual(
      expect.objectContaining({
        checkId: "types",
        error: expect.objectContaining({
          code: "COMPARISON_INSTALLATION_UNAVAILABLE",
          message: expect.stringContaining("@types/node"),
          path: "package.json",
        }),
      }),
    );
    await repo.write(
      "node_modules/@types/node/package.json",
      JSON.stringify({
        name: "@types/node",
        version: "26.0.0",
        types: "index.d.ts",
      }),
    );
    await repo.write(
      "node_modules/@types/node/index.d.ts",
      "declare const process: { version: string };\n",
    );
    expect((await scan()).outcome).toBe("pass");
    await repo.write(
      "src/value.ts",
      'export const value: number = "new error";\n',
    );
    await repo.git(["add", "src/value.ts"]);
    const broken = await scan();
    expect(broken.outcome).toBe("blocked");
    expect(broken.summary.findings).toContainEqual(
      expect.objectContaining({ rule: "typescript/TS2322" }),
    );
  });
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

it.each([
  ["independent npm project", false, false, "npm --prefix e2e ci"],
  ["npm workspace", true, false, "Run npm ci from the repository root"],
  ["conflicting package manager", false, true, undefined],
] as const)(
  "describes the local installation for a %s",
  async (_, shared, conflicting, command) => {
    const repo = await createGitRepository("zedbee-install-advice-");
    const placement = shared ? "" : "e2e/";
    if (shared) {
      await repo.write(
        "package.json",
        JSON.stringify({
          name: "root",
          workspaces: ["e2e"],
        }),
      );
    }
    await repo.write(
      "e2e/package.json",
      JSON.stringify({
        name: "e2e",
        ...(conflicting ? { packageManager: "pnpm@10.0.0" } : {}),
        dependencies: { "fixture-missing-module": "1.0.0" },
      }),
    );
    await repo.write(
      `${placement}package-lock.json`,
      JSON.stringify({
        name: shared ? "root" : "e2e",
        lockfileVersion: 3,
        packages: {},
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
      "e2e/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        include: ["main.ts"],
      }),
    );
    await repo.write("e2e/main.ts", "export const previous = 0;\n");
    await repo.commitAll("baseline");
    await repo.write(
      "e2e/main.ts",
      'import { fixture } from "fixture-missing-module";\nexport const value = fixture;\n',
    );
    await repo.git(["add", "e2e"]);
    const scan = (diagnosticMessages: "source-free" | "contextual") =>
      runScan({ repositoryRoot: repo.root, cache: false, diagnosticMessages });
    const report = await scan("contextual");
    const error = report.checks.find(({ target }) => target === "e2e")?.error;
    expect(error?.code, JSON.stringify(report.checks)).toBe(
      "COMPARISON_INSTALLATION_UNAVAILABLE",
    );
    expect(error?.message).toBe(
      "This checkout cannot resolve 'fixture-missing-module' for workspace 'e2e'.",
    );
    if (command === undefined) {
      expect(error?.remediation).toContain("repository's package-manager");
      expect(error?.remediation).not.toContain("npm");
    } else {
      expect(error?.remediation).toContain(command);
    }
    const redacted = JSON.stringify((await scan("source-free")).checks);
    expect(redacted).not.toContain("fixture-missing-module");
    expect(redacted).not.toContain("npm");
  },
);

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

it("withholds an install command when the checkout changed its baseline install inputs", async () => {
  const repo = await fixture(true);
  await repo.write(
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { react: "19.0.0" } } },
    }),
  );
  await repo.commitAll("Baseline JSX and npm lock");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "fixture", private: true }),
  );
  await repo.write(
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
  );
  await repo.write("src/value.tsx", "export const value = 1;\n");
  await repo.git(["add", "."]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome).toBe("incomplete");
  expect(
    report.checks.find(({ checkId }) => checkId === "types")?.error,
  ).toMatchObject({
    code: "COMPARISON_INSTALLATION_UNAVAILABLE",
    snapshot: "last-commit",
    remediation: expect.stringContaining("repository's package-manager"),
  });
});
