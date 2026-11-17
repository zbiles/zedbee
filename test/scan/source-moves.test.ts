import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { resolve } from "node:path";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "../helpers/git-repository.js";

const debt = `export function debt(a) {
  if (a) { if (a > 1) return <p>It's debt</p>; }
  return null;
}
`;
const other = `export function other(a) {
  if (a) { if (a > 2) return <p>It's other debt</p>; }
  return null;
}
`;
async function fixture() {
  const repo = await createGitRepository("zedbee-source-moves-");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "move-fixture",
      private: true,
      type: "module",
      dependencies: { react: "19.0.0" },
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "fast",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === "cyclomaticComplexity" || id === "readabilityComplexity"
            ? { severity: "error", max: 1, blockWorsening: true }
            : id === "reactCorrectness" || id === "lint"
              ? { severity: "error" }
              : "off",
        ]),
      ),
    }),
  );
  await repo.write("old.jsx", debt + other + "export const keep = 1;\n");
  await repo.commitAll("baseline");
  return repo;
}
async function scan(root: string, args: string[] = []) {
  const result = await execa(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "scan",
      "--no-service",
      "--format",
      "json",
      ...args,
    ],
    {
      cwd: root,
      reject: false,
      env: { ZEDBEE_TELEMETRY_DISABLED: "1", ZEDBEE_NO_UPDATE_CHECK: "1" },
    },
  );
  const report = JSON.parse(result.stdout);
  return {
    code: result.exitCode,
    report,
    findings: report.checks.flatMap(
      (check: {
        findings: {
          check: string;
          rule: string;
          location?: { file: string };
        }[];
      }) => check.findings,
    ),
  };
}
describe("real Git source move attribution", () => {
  it("preserves unchanged complexity and JSX debt when deleting and splitting a donor", async () => {
    const repo = await fixture();
    await repo.git(["rm", "old.jsx"]);
    await repo.write("a.jsx", debt);
    await repo.write("b.jsx", other);
    await repo.write("rest.jsx", "export const keep = 1;\n");
    await repo.git(["add", "."]);
    expect(
      (await repo.git(["diff", "--cached", "--no-renames", "--name-status"]))
        .stdout,
    ).toContain("D\told.jsx");
    for (let run = 0; run < 2; run++) {
      const result = await scan(repo.root);
      expect(result.code, JSON.stringify(result.report)).toBe(0);
    }
  });
  it("preserves an extraction while retaining unrelated code in the donor", async () => {
    const repo = await fixture();
    await repo.write("old.jsx", other + "export const keep = 1;\n");
    await repo.write("new.jsx", debt);
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
  });
  it("preserves a rename with a comment inside an over-limit function", async () => {
    const repo = await fixture();
    await repo.git(["mv", "old.jsx", "renamed.jsx"]);
    await repo.write(
      "renamed.jsx",
      (debt + other).replace(
        "  return null",
        "  // explanation\n  return null",
      ),
    );
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
  });
  it("blocks copies even when an unstaged edit removes the donor", async () => {
    const repo = await fixture();
    await repo.write("copy.jsx", debt);
    await repo.git(["add", "copy.jsx"]);
    await repo.write("old.jsx", other);
    const result = await scan(repo.root);
    expect(result.code).toBe(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ file: "copy.jsx" }),
        }),
      ]),
    );
  });
  it("does not grandfather two destinations from one removal", async () => {
    const repo = await fixture();
    await repo.write("old.jsx", other);
    await repo.write("a.jsx", debt);
    await repo.write("b.jsx", debt);
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code).toBe(1);
    for (const file of ["a.jsx", "b.jsx"])
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            location: expect.objectContaining({ file }),
          }),
        ]),
      );
  });
  it("keeps newly introduced scope errors blocking inside an unchanged moved function", async () => {
    const repo = await fixture();
    await repo.write(
      "old.jsx",
      "const missing = 1;\n" +
        debt.replace("return null", "return missing") +
        other,
    );
    await repo.commitAll("scoped baseline");
    await repo.write("old.jsx", other);
    await repo.write("new.jsx", debt.replace("return null", "return missing"));
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code).toBe(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "no-undef",
          location: expect.objectContaining({ file: "new.jsx" }),
        }),
      ]),
    );
  });
});

describe("source move boundaries", () => {
  it("merges multiple donors into an existing receiver", async () => {
    const repo = await fixture();
    await repo.write("second.jsx", other);
    await repo.write("old.jsx", debt);
    await repo.write("receiver.jsx", "export const keep = 1;\n");
    await repo.commitAll("separate donors");
    await repo.git(["rm", "old.jsx", "second.jsx"]);
    await repo.write("receiver.jsx", "export const keep = 1;\n" + debt + other);
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
  });
  it("blocks changed bodies and rename worsening", async () => {
    const repo = await fixture();
    await repo.git(["mv", "old.jsx", "new.jsx"]);
    await repo.write(
      "new.jsx",
      (debt + other).replace("return null", "if (a > 5) return 5; return null"),
    );
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code).toBe(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "cyclomaticComplexity" }),
      ]),
    );
  });
  it("preserves a move between workspaces with equivalent effective policy", async () => {
    const repo = await fixture();
    await repo.write(
      "package.json",
      JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
      }),
    );
    for (const name of ["a", "b"])
      await repo.write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name,
          private: true,
          type: "module",
          dependencies: { react: "19.0.0" },
        }),
      );
    await repo.git(["mv", "old.jsx", "packages/a/old.jsx"]);
    await repo.commitAll("workspaces");
    await repo.write("packages/a/old.jsx", other);
    await repo.write("packages/b/new.jsx", debt);
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
  });
  it("retains debt when destination overrides change effective policy", async () => {
    const repo = await fixture();
    const config = JSON.parse(await repo.read(".zedbeerc.jsonc"));
    config.overrides = [
      {
        files: ["new.jsx"],
        checks: {
          cyclomaticComplexity: { max: 2 },
          reactCorrectness: {
            rules: {
              "react/no-unescaped-entities": ["error", { forbid: ["'"] }],
            },
          },
        },
      },
    ];
    await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
    await repo.commitAll("overrides");
    await repo.write("old.jsx", other);
    await repo.write("new.jsx", debt);
    await repo.git(["add", "."]);
    const result = await scan(repo.root);
    expect(result.code).toBe(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "cyclomaticComplexity" }),
      ]),
    );
  });
  it("pairs committed-base and per-parent merge comparisons", async () => {
    const repo = await fixture();
    const base = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
    await repo.git(["branch", "incoming"]);
    await repo.write("main.txt", "main\n");
    await repo.commitAll("main");
    await repo.git(["switch", "incoming"]);
    await repo.write("old.jsx", other);
    await repo.write("new.jsx", debt);
    await repo.commitAll("extract");
    const committed = await scan(repo.root, ["--base", base]);
    expect(committed.code, JSON.stringify(committed.report)).toBe(0);
    await repo.git(["switch", "main"]);
    await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]);
    const merged = await scan(repo.root, ["--merge"]);
    expect(merged.code, JSON.stringify(merged.report)).toBe(0);
    expect(merged.report.mergeParents).toHaveLength(2);
  });
});
