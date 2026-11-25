import { expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function fixture(
  specifier: string,
  types: readonly string[] | undefined,
) {
  const repo = await createGitRepository("zedbee-node-install-");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "node-fixture",
      private: true,
      devDependencies: { "@types/node": "25.0.0" },
    }),
  );
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        ...(types === undefined ? {} : { types }),
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
  await repo.write("src/value.ts", "export const value = 1;\n");
  await repo.commitAll("baseline with declared Node types");
  await repo.write(
    "src/value.ts",
    specifier === "Buffer"
      ? "export const value = Buffer;\n"
      : `import * as nodeModule from ${JSON.stringify(specifier)};\nexport const value = nodeModule;\n`,
  );
  await repo.git(["add", "src/value.ts"]);
  return repo;
}
it.each([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "node:test",
  "Buffer",
])("recognizes missing declared Node types for %s", async (specifier) => {
  const repo = await fixture(specifier, undefined);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome, JSON.stringify(report)).toBe("incomplete");
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      error: expect.objectContaining({
        code: "COMPARISON_INSTALLATION_UNAVAILABLE",
      }),
    }),
  );
  expect(report.summary.findings.filter((f) => f.attribution.staged)).toEqual(
    [],
  );
});
it("retains source/configuration findings when Node types are explicitly excluded", async () => {
  const repo = await fixture("node:fs", []);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome, JSON.stringify(report)).toBe("blocked");
  expect(report.summary.findings).toContainEqual(
    expect.objectContaining({
      rule: "typescript/TS2591",
      attribution: expect.objectContaining({ staged: true }),
    }),
  );
});

it("does not excuse a typo in a Node builtin specifier", async () => {
  const repo = await fixture("node:not-a-real-builtin", undefined);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome, JSON.stringify(report)).toBe("blocked");
  expect(report.summary.findings.some((f) => f.attribution.staged)).toBe(true);
});

it("recognizes a missing installation when Node types are explicitly included", async () => {
  const repo = await fixture("node:fs", ["node"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome, JSON.stringify(report)).toBe("incomplete");
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      error: expect.objectContaining({
        code: "COMPARISON_INSTALLATION_UNAVAILABLE",
      }),
    }),
  );
});

it("compares nested projects with Node builtin probes and a TypeScript alias base", async () => {
  const repo = await createGitRepository("zedbee-node-alias-");
  await repo.write(".gitignore", "node_modules/\n");
  await repo.write(
    "e2e/package.json",
    '{"name":"e2e-fixture","devDependencies":{"widget":"1.0.0"}}',
  );
  await repo.write(
    "e2e/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        baseUrl: ".",
        paths: { "@fixtures/*": ["./fixtures/*"] },
        strict: true,
      },
      include: ["**/*.ts"],
    }),
  );
  await repo.write(
    "e2e/node_modules/widget/package.json",
    '{"name":"widget","types":"index.d.ts"}',
  );
  await repo.write(
    "e2e/node_modules/widget/index.d.ts",
    'import { EventEmitter } from "node:events"; export declare const widget: EventEmitter;',
  );
  await repo.write(
    "e2e/node_modules/@types/node/package.json",
    '{"name":"@types/node","types":"index.d.ts"}',
  );
  await repo.write(
    "e2e/node_modules/@types/node/index.d.ts",
    'declare module "node:events" { export class EventEmitter {} }',
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          ["lint", "types"].includes(id) ? "error" : "off",
        ]),
      ),
    }),
  );
  await repo.write("e2e/fixtures/value.ts", "export const value = 1;\n");
  const source =
    'import { widget } from "widget";\nimport { value } from "@fixtures/value";\nexport const result = [widget, value];\n';
  await repo.write("e2e/main.ts", source);
  await repo.commitAll("consumer baseline");
  await repo.write(
    "e2e/main.ts",
    source.replace("[widget, value]", "[value, widget]"),
  );
  await repo.git(["add", "e2e/main.ts"]);

  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  for (const checkId of ["lint", "types"]) {
    expect(
      report.checks.find((check) => check.checkId === checkId),
    ).toMatchObject({
      status: "completed",
      comparisonContext: { status: "comparable" },
    });
  }
  expect(report.outcome).toBe("pass");

  await repo.write(
    "e2e/main.ts",
    source + "export const broken: string = value;\n",
  );
  await repo.git(["add", "e2e/main.ts"]);
  const broken = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(broken.outcome).toBe("blocked");
  expect(broken.summary.findings).toContainEqual(
    expect.objectContaining({ rule: "typescript/TS2322" }),
  );
});

it.each([
  "upgrade",
  "source",
  "cross-workspace source",
  "source with stale type declarations",
  "upgrade introducing a workspace link",
])(
  "selects affected compiler targets in separately installed npm projects for %s",
  async (change) => {
    const repo = await createGitRepository("zedbee-npm-projects-");
    await repo.write(".gitignore", "node_modules/\n");
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [
            id,
            ["lint", "types"].includes(id) ? "error" : "off",
          ]),
        ),
      }),
    );
    for (const name of ["web", "e2e"]) {
      await repo.write(
        `${name}/package.json`,
        JSON.stringify({
          name,
          private: true,
          devDependencies:
            name === "e2e" ? { widget: "1.0.0" } : { zedbee: "0.1.0-beta.15" },
        }),
      );
      await repo.write(
        `${name}/package-lock.json`,
        JSON.stringify({
          name,
          lockfileVersion: 3,
          packages: { "": { name } },
        }),
      );
      await repo.write(
        `${name}/tsconfig.json`,
        '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","baseUrl":"."},"include":["*.ts"]}',
      );
    }
    await repo.write("web/value.ts", "export const value = 1;\n");
    await repo.write(
      "e2e/spec.ts",
      change === "cross-workspace source"
        ? 'export { value } from "../web/value";\nexport { test } from "widget";\n'
        : 'export { test } from "widget";\n',
    );
    if (change === "source with stale type declarations") {
      await repo.write(
        "e2e/node_modules/widget/package.json",
        '{"name":"widget","types":"index.d.ts"}',
      );
      await repo.write(
        "e2e/node_modules/widget/index.d.ts",
        '/// <reference types="node" />\nexport declare const test: number;\n',
      );
    }
    await repo.commitAll("consumer baseline");
    if (change.startsWith("upgrade")) {
      await repo.write(
        "web/package.json",
        (await repo.read("web/package.json")).replace("beta.15", "beta.18"),
      );
      await repo.write(
        "web/package-lock.json",
        (await repo.read("web/package-lock.json")).replace(
          '"packages":',
          '"version":"1.0.0","packages":',
        ),
      );
    } else {
      await repo.write("web/value.ts", "export const value = 2;\n");
    }
    if (change === "upgrade introducing a workspace link") {
      const lock = JSON.parse(await repo.read("web/package-lock.json"));
      lock.packages["../e2e"] = { name: "e2e" };
      lock.packages["node_modules/e2e"] = { resolved: "../e2e", link: true };
      await repo.write("web/package-lock.json", JSON.stringify(lock));
    }
    await repo.git(["add", "web"]);
    const report = await runScan({ repositoryRoot: repo.root, cache: false });
    expect(
      report.checks.filter(
        (check) =>
          ["lint", "types"].includes(check.checkId) && check.target === "web",
      ),
    ).toHaveLength(2);
    const sibling = report.checks.filter((check) => check.target === "e2e");
    expect(sibling).toHaveLength(2);
    if (
      change === "cross-workspace source" ||
      change === "upgrade introducing a workspace link"
    ) {
      expect(report.outcome).toBe("incomplete");
    } else {
      expect(sibling.every((check) => check.status === "skipped")).toBe(true);
      expect(report.outcome).toBe("pass");
    }
  },
);

it("keeps a sibling whose installed declaration resolves through the compiler fallback", async () => {
  const repo = await createGitRepository("zedbee-npm-fallback-");
  await repo.write(".gitignore", "node_modules/\n");
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
      ),
    }),
  );
  for (const name of ["src", "e2e"]) {
    await repo.write(
      `${name}/package.json`,
      JSON.stringify({ name, private: true }),
    );
    await repo.write(
      `${name}/package-lock.json`,
      JSON.stringify({ name, lockfileVersion: 3, packages: { "": { name } } }),
    );
    await repo.write(
      `${name}/tsconfig.json`,
      '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"},"include":["*.ts"]}',
    );
  }
  await repo.write("src/value.ts", "export const value = 1;\n");
  await repo.write(
    "e2e/spec.ts",
    'import { test } from "widget";\nexport const value: string = test;\n',
  );
  await repo.write(
    "e2e/node_modules/widget/package.json",
    '{"name":"widget","types":"index.d.ts"}',
  );
  await repo.write(
    "e2e/node_modules/widget/index.d.ts",
    'export declare const test: typeof import("shape").value;',
  );
  await repo.write(
    "src/node_modules/shape/package.json",
    '{"name":"shape","types":"index.d.ts"}',
  );
  await repo.write(
    "src/node_modules/shape/index.d.ts",
    "export declare const value: string;",
  );
  await repo.commitAll("consumer baseline");
  await repo.write(
    "src/package-lock.json",
    (await repo.read("src/package-lock.json")).replace(
      '"packages":',
      '"version":"1.0.0","packages":',
    ),
  );
  await repo.git(["add", "src/package-lock.json"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(
    report.checks.find(
      (check) => check.checkId === "types" && check.target === "e2e",
    ),
  ).toMatchObject({
    status: "completed",
    comparisonContext: { status: "comparable" },
  });
});
