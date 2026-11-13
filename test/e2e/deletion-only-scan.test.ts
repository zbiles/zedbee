import { expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { runScan } from "../../src/scan/run-scan.js";
it("reports only staged deletions after failed staging without touching untracked content", async () => {
  const repo = await createGitRepository();
  await repo.write("old.md", "Old docs\n");
  await repo.commitAll("baseline");
  await repo.git(["rm", "old.md"]);
  await repo.write("unstaged.py", "value = 42\n");
  expect((await repo.git(["add", "nonexistent.py"])).exitCode).not.toBe(0);
  const before = (await repo.git(["status", "--porcelain"])).stdout;
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome).toBe("pass");
  expect(report.changeSummary).toEqual({
    added: 0,
    modified: 0,
    deleted: 1,
    renamed: 0,
  });
  expect(report.summary.passed).toBe(0);
  expect((await repo.git(["status", "--porcelain"])).stdout).toBe(before);
});
it("still blocks a deleted imported source file", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"fixture","private":true}');
  await repo.write(
    "tsconfig.json",
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}',
  );
  await repo.write("a.ts", "export const value = 1;\n");
  await repo.write(
    "b.ts",
    'import { value } from "./a";\nexport const used = value;\n',
  );
  await repo.commitAll("baseline");
  await repo.git(["rm", "a.ts"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome).toBe("blocked");
  expect(
    report.summary.findings.some((f) => f.rule === "typescript/TS2307"),
  ).toBe(true);
  expect(report.changeSummary?.deleted).toBe(1);
});
it("retains known counts when analysis cannot finish", async () => {
  const repo = await createGitRepository();
  await repo.write("README.md", "baseline\n");
  await repo.commitAll("baseline");
  await repo.write("large.txt", "x".repeat(1024 * 1024 + 1));
  await repo.git(["add", "large.txt"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome).toBe("incomplete");
  expect(report.changeSummary).toEqual({
    added: 1,
    modified: 0,
    deleted: 0,
    renamed: 0,
  });
});
it("does not claim all checks were disabled when selected targets are excluded", async () => {
  const repo = await createGitRepository();
  const { CHECK_IDS } = await import("../../src/config/schema.js");
  const { allowedScanDetail } =
    await import("../../src/reporting/check-coverage.js");
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [id, id === "secrets" ? "error" : "off"]),
      ),
      pathExclusions: [
        {
          files: ["fixture.txt"],
          checks: ["secrets"],
          reason: "Synthetic fixture",
        },
      ],
    }),
  );
  await repo.commitAll("baseline");
  await repo.write("fixture.txt", "safe fixture\n");
  await repo.git(["add", "fixture.txt"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome).toBe("pass");
  expect(report.checks).toEqual([]);
  expect(allowedScanDetail(report)).toBe(
    "No checks ran for the selected changes. Commit allowed.",
  );
});
