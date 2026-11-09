import { expect, it, vi } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";
import { CHECK_IDS } from "../../src/config/schema.js";

it("does not prepare or open an analyzer session when every check is disabled", async () => {
  const repo = await createGitRepository();
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(CHECK_IDS.map((id) => [id, "off"])),
    }),
  );
  await repo.write("README.md", "hello\n");
  await repo.commitAll("baseline");
  await repo.git(["rm", "README.md"]);
  const prepare = vi.fn();
  const openSession = vi.fn(async () => {
    throw new Error("No workers should open");
  });
  const report = await runScan({
    repositoryRoot: repo.root,
    cache: false,
    executor: { prepare, openSession, close: async () => {} },
  });
  expect(report.outcome).toBe("pass");
  expect(report.changedFileCount).toBe(1);
  expect(prepare).not.toHaveBeenCalled();
  expect(openSession).not.toHaveBeenCalled();
});

it("keeps a recommended Markdown removal worker-free", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"no-work","private":true}\n');
  await repo.write(
    "tsconfig.json",
    '{"compilerOptions":{"types":[]},"include":["src"]}\n',
  );
  await repo.write("src/value.ts", "export const value = 1;\n");
  await repo.write("README.md", "hello\n");
  await repo.commitAll("baseline");
  await repo.git(["rm", "README.md"]);
  const openSession = vi.fn(async () => {
    throw new Error("No workers should open");
  });
  const report = await runScan({
    repositoryRoot: repo.root,
    cache: false,
    executor: { openSession, close: async () => {} },
  });
  expect(report.outcome, JSON.stringify(report)).toBe("pass");
  expect(report.changedFileCount).toBe(1);
  expect(openSession).not.toHaveBeenCalled();
  expect(report.checks.every((check) => check.status === "skipped")).toBe(true);
});

it("captures only changed text for an ignore edit plus Markdown removal", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"bounded-secrets","private":true}');
  await repo.write(
    "tsconfig.json",
    '{"compilerOptions":{"types":[]},"include":["src"]}',
  );
  await repo.write("src/untouched.ts", "export const untouched = 1;\n");
  await repo.write(".gitignore", "node_modules/\n");
  await repo.write("README.md", "A document.\n");
  await repo.commitAll("baseline");
  await repo.write(".gitignore", "node_modules/\n.cache/\n");
  await repo.git(["rm", "--cached", "README.md"]);
  await repo.git(["add", ".gitignore"]);
  const local = createLocalAnalyzerExecutor();
  let selected: readonly { snapshotRoot: string; paths: readonly string[] }[] =
    [];
  const jobs: string[] = [];
  try {
    const report = await runScan({
      repositoryRoot: repo.root,
      cache: false,
      executor: {
        openSession: async (options) => {
          selected = options?.sourceSelections ?? [];
          return local.openSession(options);
        },
        close: () => local.close(),
      },
      onEvent: (event) => {
        if (event.type === "check-running") jobs.push(event.checkId);
      },
    });
    expect(report.outcome).toBe("pass");
    expect(jobs).toEqual(["secrets"]);
    expect(selected.map((selection) => selection.paths)).toEqual([
      [".gitignore"],
      [".gitignore"],
    ]);
  } finally {
    await local.close();
  }
});

it("scans multiple Markdown files alongside formatting with a partial source capture", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"mixed-text","private":true}');
  await repo.write(
    "tsconfig.json",
    '{"compilerOptions":{"types":[]},"include":["src"]}',
  );
  await repo.write("src/untouched.ts", "export const untouched = 1;\n");
  await repo.write("one.md", "First.\n");
  await repo.write("two.md", "Second.\n");
  await repo.commitAll("baseline");
  await repo.write("one.md", "First edit.\n");
  await repo.write("two.md", "Second edit.\n");
  await repo.git(["add", "one.md", "two.md"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.outcome, JSON.stringify(report)).toBe("pass");
  expect(
    report.checks.find((check) => check.checkId === "secrets")?.status,
  ).toBe("completed");
});
