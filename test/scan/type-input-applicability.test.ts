import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const compilerOptions = {
  strict: true,
  noEmit: true,
  module: "esnext",
  moduleResolution: "bundler",
  types: [],
};
const scan = (repositoryRoot: string) =>
  runScan({ repositoryRoot, cache: false, sourceExcerpts: "exclude" });

async function fixture(files: Readonly<Record<string, string>>) {
  const repo = await createGitRepository("zedbee-type-input-delta-");
  await repo.write("package.json", '{"name":"fixture","private":true}\n');
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
      ),
    }),
  );
  for (const [path, text] of Object.entries(files))
    await repo.write(path, text);
  await repo.commitAll("base");
  return repo;
}

describe("relevant TypeScript project inputs", () => {
  it("blocks new errors caused by a configuration-only strictness change", async () => {
    const repo = await fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...compilerOptions, strict: false },
        files: ["main.ts"],
      }),
      "main.ts": "export function identity(value) { return value; }\n",
    });
    await repo.write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions, files: ["main.ts"] }),
    );
    expect((await repo.git(["add", "tsconfig.json"])).exitCode).toBe(0);
    const report = await scan(repo.root);
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "blocked",
      checks: [
        {
          checkId: "types",
          status: "completed",
          findings: [
            { rule: "typescript/TS7006", location: { file: "main.ts" } },
          ],
        },
      ],
    });
  });

  it("blocks a JSON-only change that breaks an unchanged importer", async () => {
    const repo = await fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...compilerOptions, resolveJsonModule: true },
        files: ["main.ts"],
      }),
      "main.ts":
        'import data from "./data.json"; export const value: string = data.value;\n',
      "data.json": '{"value":"original"}\n',
    });
    await repo.write("data.json", '{"value":42}\n');
    expect((await repo.git(["add", "data.json"])).exitCode).toBe(0);
    const report = await scan(repo.root);
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "blocked",
      checks: [
        {
          checkId: "types",
          status: "completed",
          findings: [
            { rule: "typescript/TS2322", location: { file: "main.ts" } },
          ],
        },
      ],
    });
  });

  it("checks an unchanged workspace importing a changed sibling without a declared dependency", async () => {
    const project = JSON.stringify({
      compilerOptions,
      include: ["src/**/*.ts"],
    });
    const repo = await fixture({
      "package.json":
        '{"name":"fixture","private":true,"workspaces":["packages/*"]}\n',
      "packages/a/package.json": '{"name":"a","private":true}\n',
      "packages/b/package.json": '{"name":"b","private":true}\n',
      "packages/a/tsconfig.json": project,
      "packages/b/tsconfig.json": project,
      "packages/a/src/index.ts": 'export const value = "original";\n',
      "packages/b/src/index.ts":
        'import {value} from "../../a/src/index"; export const text: string = value;\n',
    });
    await repo.write("packages/a/src/index.ts", "export const value = 42;\n");
    expect((await repo.git(["add", "packages/a/src/index.ts"])).exitCode).toBe(
      0,
    );
    const report = await scan(repo.root);
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "blocked",
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "types",
          target: "packages/b",
          status: "completed",
          findings: [
            expect.objectContaining({
              rule: "typescript/TS2322",
              location: expect.objectContaining({
                file: "packages/b/src/index.ts",
              }),
            }),
          ],
        }),
      ]),
    );
  });

  it("still suppresses an existing baseline error after a JSON-only edit", async () => {
    const repo = await fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...compilerOptions, resolveJsonModule: true },
        files: ["main.ts"],
      }),
      "main.ts":
        'import data from "./data.json"; export const value: string = data.value;\n',
      "data.json": '{"value":42}\n',
    });
    await repo.write("data.json", '{"value":43}\n');
    expect((await repo.git(["add", "data.json"])).exitCode).toBe(0);
    const report = await scan(repo.root);
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      checks: [{ checkId: "types", status: "completed", findings: [] }],
    });
  });
});
