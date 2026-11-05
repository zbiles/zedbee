import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { resolve } from "node:path";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "../helpers/git-repository.js";

const code = `export function calculate(values) {
  const result = [];
  for (const value of values) {
    if (value.active) {
      const amount = value.price * value.quantity;
      const tax = amount * 0.08;
      const discount = value.member ? amount * 0.1 : 0;
      const total = amount + tax - discount;
      result.push({ name: value.name, amount, tax, discount, total });
    }
  }
  return result;
}
`;
const commented = code.replace(
  "      const tax",
  "      // explanatory comment\n      const tax",
);
async function fixture() {
  const repo = await createGitRepository("zedbee-duplication-scan-");
  await repo.write(
    "package.json",
    '{"name":"duplication-fixture","private":true}',
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "fast",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === "duplication" ? { severity: "error", threshold: 5 } : "off",
        ]),
      ),
    }),
  );
  await repo.write("src/a.js", code);
  await repo.write("src/b.js", code);
  await repo.commitAll("baseline");
  return repo;
}
async function scan(root: string, extra: string[] = []) {
  const result = await execa(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "scan",
      "--no-service",
      "--format",
      "json",
      ...extra,
    ],
    {
      cwd: root,
      reject: false,
      env: { ZEDBEE_TELEMETRY_DISABLED: "1", ZEDBEE_NO_UPDATE_CHECK: "1" },
    },
  );
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) };
}
describe("duplication scan attribution", () => {
  it("pairs a selected rename with a comment-only edit", async () => {
    const repo = await fixture();
    await repo.git(["mv", "src/a.js", "src/renamed.js"]);
    await repo.write("src/renamed.js", commented);
    await repo.git(["add", "src/renamed.js"]);
    const result = await scan(repo.root);
    expect(result.exitCode, JSON.stringify(result.report)).toBe(0);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "duplication",
          status: "completed",
          findings: [],
        }),
      ]),
    );
  });
  it("uses the selected index through cold and warm scans and blocks a new third copy", async () => {
    const repo = await fixture();
    await repo.write("src/a.js", commented);
    await repo.git(["add", "src/a.js"]);
    await repo.write("src/a.js", code);
    for (let run = 0; run < 2; run++) {
      const result = await scan(repo.root);
      expect(result.exitCode, JSON.stringify(result.report)).toBe(0);
      expect(result.report.outcome).toBe("pass");
      expect(result.report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "duplication",
            status: "completed",
            findings: [],
          }),
        ]),
      );
    }
    await repo.write("src/c.js", code);
    await repo.git(["add", "src/c.js"]);
    const result = await scan(repo.root);
    expect(result.exitCode).toBe(1);
    expect(
      result.report.checks.flatMap(
        (check: { findings: unknown[] }) => check.findings,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ file: "src/c.js" }),
        }),
      ]),
    );
  });
  it("preserves trivia-only debt in a committed base comparison", async () => {
    const repo = await fixture();
    const base = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
    await repo.write("src/a.js", commented);
    await repo.commitAll("comment");
    const result = await scan(repo.root, ["--base", base]);
    expect(result.exitCode, JSON.stringify(result.report)).toBe(0);
    expect(result.report.mode).toBe("base");
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "duplication",
          status: "completed",
          findings: [],
        }),
      ]),
    );
  });
  it("preserves trivia-only debt in an in-progress merge", async () => {
    const repo = await fixture();
    await repo.git(["branch", "incoming"]);
    await repo.write("main.txt", "main\n");
    await repo.commitAll("main change");
    await repo.git(["switch", "incoming"]);
    await repo.write("src/a.js", commented);
    await repo.commitAll("comment");
    await repo.git(["switch", "main"]);
    expect(
      (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"]))
        .exitCode,
    ).toBe(0);
    const result = await scan(repo.root, ["--merge"]);
    expect(result.exitCode, JSON.stringify(result.report)).toBe(0);
    expect(result.report.mergeParents).toHaveLength(2);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "duplication",
          status: "completed",
          findings: [],
        }),
      ]),
    );
  });
});
