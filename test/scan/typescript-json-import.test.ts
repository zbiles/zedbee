import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const jsonPath = "web/src/card-wire-fixtures.json";
const importerPath = "web/src/card-wire-fixtures.ts";
const validJson = JSON.stringify(
  { cards: [{ id: 42, label: "Activity", enabled: true }], count: 1 },
  null,
  2,
);

async function fixture() {
  const repo = await createGitRepository("zedbee-typescript-json-");
  await repo.write("web/package.json", '{"name":"web","private":true}\n');
  await repo.write(
    "web/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    }),
  );
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
  await repo.write(importerPath, "export {};\n");
  await repo.commitAll("base");
  return repo;
}

const scan = (repositoryRoot: string) =>
  runScan({ repositoryRoot, cache: false, sourceExcerpts: "exclude" });

describe("staged TypeScript JSON imports", () => {
  it("accepts valid staged JSON alongside its importer despite malformed working-tree JSON", async () => {
    const repo = await fixture();
    await repo.write(jsonPath, validJson);
    expect((await repo.git(["add", jsonPath])).exitCode).toBe(0);
    const jsonOnlyReport = await scan(repo.root);
    expect(jsonOnlyReport, JSON.stringify(jsonOnlyReport)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
    });

    await repo.write(
      importerPath,
      'import fixtures from "./card-wire-fixtures.json";\nexport const id: number = fixtures.cards[0]!.id;\n',
    );
    expect((await repo.git(["add", importerPath])).exitCode).toBe(0);
    await repo.write(jsonPath, '{"cards": }\n');
    const report = await scan(repo.root);

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      checks: [
        { checkId: "types", target: "web", status: "completed", findings: [] },
      ],
    });
  });

  it("still blocks TypeScript assignments incompatible with the staged JSON shape", async () => {
    const repo = await fixture();
    await repo.write(jsonPath, validJson);
    await repo.write(
      importerPath,
      'import fixtures from "./card-wire-fixtures.json";\nexport const id: string = fixtures.cards[0]!.id;\n',
    );
    expect((await repo.git(["add", jsonPath, importerPath])).exitCode).toBe(0);
    // An unstaged repair must not change the imported value's staged type.
    await repo.write(
      jsonPath,
      JSON.stringify({ cards: [{ id: "fixed" }], count: 1 }),
    );
    const report = await scan(repo.root);

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
      checks: [
        {
          checkId: "types",
          status: "completed",
          findings: [
            {
              rule: "typescript/TS2322",
              location: { file: importerPath, startLine: 2 },
            },
          ],
        },
      ],
    });
  });

  it("still reports malformed imported JSON with the compiler's JSON syntax diagnostic", async () => {
    const repo = await fixture();
    await repo.write(jsonPath, '{"cards": }\n');
    await repo.write(
      importerPath,
      'import fixtures from "./card-wire-fixtures.json";\nexport const cards = fixtures.cards;\n',
    );
    expect((await repo.git(["add", jsonPath, importerPath])).exitCode).toBe(0);
    const report = await scan(repo.root);

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
      checks: [
        {
          checkId: "types",
          status: "completed",
          findings: expect.arrayContaining([
            expect.objectContaining({
              rule: "typescript/TS1109",
              message: "Expression expected.",
              location: expect.objectContaining({
                file: jsonPath,
                startLine: 1,
              }),
            }),
          ]),
        },
      ],
    });
  });
});
