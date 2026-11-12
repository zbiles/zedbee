import { describe, expect, it } from "vitest";
import {
  readdir,
  readFile,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  acquireServiceExecutor,
  stopService,
} from "../../src/service/client.js";
import { join } from "node:path";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import type { ScanEvent } from "../../src/checks/events.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function fixture() {
  const repo = await createGitRepository("zedbee-message-clarity-");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "clarity", type: "module" }),
  );
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
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
        CHECK_IDS.map((id) => [
          id,
          ["types", "lint"].includes(id) ? "error" : "off",
        ]),
      ),
    }),
  );
  await repo.write("src/account.ts", "export const existing = 1;\n");
  await repo.write("src/index.ts", "export const value = 1;\n");
  await repo.commitAll("baseline");
  await repo.write(
    "src/index.ts",
    'import { MissingAccount } from "./account";\nexport const current = MissingAccount;\nexport async function loadAccount() { return 1; }\n',
  );
  expect((await repo.git(["add", "src/index.ts"])).exitCode).toBe(0);
  return repo;
}

describe("managed diagnostic clarity", () => {
  it("retains module/member and function-category details across warm scans without cache/event leaks", async () => {
    const repo = await fixture();
    const root = join(repo.root, "analysis-cache");
    const cache = new ObservationCacheStore({ root });
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: ScanEvent[] = [];
      const report = await runScan({
        repositoryRoot: repo.root,
        cache,
        onEvent: (e) => events.push(e),
        sourceExcerpts: "exclude",
      });
      expect(report.outcome, JSON.stringify(report)).toBe("blocked");
      expect(report.summary.findings).toContainEqual(
        expect.objectContaining({
          rule: "typescript/TS2305",
          message: expect.stringContaining("MissingAccount"),
        }),
      );
      expect(report.summary.findings).toContainEqual(
        expect.objectContaining({
          rule: "@typescript-eslint/require-await",
          message: expect.stringMatching(/Async function.*has no 'await'/u),
        }),
      );
      expect(JSON.stringify(events)).not.toContain("MissingAccount");
    }
    const files = await readdir(root);
    for (const file of files.filter((file) => file.endsWith(".json")))
      expect(await readFile(join(root, file), "utf8")).not.toContain(
        "MissingAccount",
      );
  });

  it("changes presentation without changing semantic finding IDs", async () => {
    const repo = await fixture();
    const contextual = await runScan({
      repositoryRoot: repo.root,
      cache: false,
      diagnosticMessages: "contextual",
    });
    const sourceFree = await runScan({
      repositoryRoot: repo.root,
      cache: false,
      diagnosticMessages: "source-free",
    });
    expect(JSON.stringify(contextual.summary)).toContain("MissingAccount");
    expect(JSON.stringify(sourceFree.summary)).not.toContain("MissingAccount");
    const semantic = (report: typeof contextual) =>
      report.summary.findings.map(({ id, rule, severity, attribution }) => ({
        id,
        rule,
        severity,
        attribution,
      }));
    expect(semantic(contextual)).toEqual(semantic(sourceFree));
  });
});

it("keeps contextual detail isolated across worktrees sharing a service", async () => {
  const repo = await fixture();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "zd-")));
  const other = join(scratch, "w");
  expect(
    (await repo.git(["worktree", "add", "--detach", other, "HEAD"])).exitCode,
  ).toBe(0);
  const { execa } = await import("execa");
  await writeFile(
    join(other, "src/index.ts"),
    'import { OtherAccount } from "./account";\nexport const current = OtherAccount;\n',
  );
  await execa("git", ["add", "src/index.ts"], { cwd: other });
  const options = { directory: join(scratch, "s"), concurrency: 1 as const };
  const executor = await acquireServiceExecutor(options);
  const cache = new ObservationCacheStore({ root: join(scratch, "cache") });
  try {
    for (const order of [
      [repo.root, other],
      [other, repo.root],
    ]) {
      for (const repositoryRoot of order) {
        const expected =
          repositoryRoot === repo.root ? "MissingAccount" : "OtherAccount";
        const absent =
          repositoryRoot === repo.root ? "OtherAccount" : "MissingAccount";
        const report = await runScan({ repositoryRoot, cache, executor });
        expect(JSON.stringify(report.summary)).toContain(expected);
        expect(JSON.stringify(report.summary)).not.toContain(absent);
      }
    }
  } finally {
    await executor.close();
    await stopService(options);
    await repo.git(["worktree", "remove", "--force", other]);
    await rm(scratch, { recursive: true, force: true });
  }
});

it("renders merge detail after source-free events and semantic intersection", async () => {
  const repo = await fixture();
  await repo.git(["reset", "--hard", "HEAD"]);
  await repo.git(["switch", "-c", "incoming"]);
  await repo.write("incoming.md", "incoming\n");
  await repo.commitAll("incoming docs");
  await repo.git(["switch", "main"]);
  await repo.write("main.md", "main\n");
  await repo.commitAll("main docs");
  expect(
    (await repo.git(["merge", "--no-commit", "--no-ff", "incoming"])).exitCode,
  ).toBe(0);
  await repo.write(
    "src/index.ts",
    'import { MissingAccount } from "./account";\nexport const current = MissingAccount;\n',
  );
  await repo.git(["add", "src/index.ts"]);
  const events: ScanEvent[] = [];
  const contextual = await runScan({
    repositoryRoot: repo.root,
    merge: "required",
    mergeEnvironment: {},
    cache: false,
    onEvent: (e) => events.push(e),
  });
  expect(JSON.stringify(contextual.summary)).toContain("MissingAccount");
  expect(JSON.stringify(events)).not.toContain("MissingAccount");
  const strict = await runScan({
    repositoryRoot: repo.root,
    merge: "required",
    mergeEnvironment: {},
    cache: false,
    diagnosticMessages: "source-free",
  });
  expect(JSON.stringify(strict.summary)).not.toContain("MissingAccount");
  expect(contextual.summary.findings.map((f) => f.id)).toEqual(
    strict.summary.findings.map((f) => f.id),
  );
  const config = JSON.parse(await repo.read(".zedbeerc.jsonc"));
  config.reporting = { diagnosticMessages: "source-free" };
  await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
  await repo.git(["add", ".zedbeerc.jsonc"]);
  const configured = await runScan({
    repositoryRoot: repo.root,
    merge: "required",
    mergeEnvironment: {},
    cache: false,
  });
  expect(JSON.stringify(configured.summary)).not.toContain("MissingAccount");
});
