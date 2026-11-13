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
