import {
  access,
  chmod,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it, onTestFinished } from "vitest";
import { runScan } from "../../src/scan/run-scan.js";
import {
  createGitRepository,
  type TestGitRepository,
} from "../helpers/git-repository.js";

const packageRoot = resolve(import.meta.dirname, "../..");
const cliPath = join(packageRoot, "dist", "cli.js");

const strictConfig = `${JSON.stringify({
  schemaVersion: 1,
  profile: "fast",
  checks: {
    formatting: "error",
    lint: "off",
    types: "off",
    cyclomaticComplexity: "off",
    readabilityComplexity: "off",
    structuralSecurity: "off",
    secrets: "off",
    duplication: "off",
    dependencyArchitecture: "off",
    deadCode: "off",
    reactCorrectness: "off",
    reactAccessibility: "off",
    vulnerabilities: "off",
  },
})}\n`;

const weakConfig = `${JSON.stringify({
  schemaVersion: 1,
  profile: "fast",
  checks: { formatting: "off" },
})}\n`;

interface GitIdentity {
  readonly tree: string;
  readonly head: string;
  readonly refs: string;
  readonly status: string;
}

interface BaseFixture {
  readonly repository: TestGitRepository;
  readonly baseline: string;
  readonly target: string;
}

type GitRepositoryView = Pick<TestGitRepository, "root" | "git">;

interface JsonReport {
  readonly outcome: "pass" | "blocked" | "incomplete";
  readonly exitCode: 0 | 1 | 2;
  readonly mode: "index" | "base";
  readonly baseline: string | null;
  readonly target: string | null;
  readonly requestedBase?: string;
  readonly changedFileCount: number | null;
  readonly checks: readonly {
    readonly checkId: string;
    readonly findings: readonly {
      readonly location?: { readonly file: string };
    }[];
    readonly error?: { readonly code: string };
  }[];
}

async function gitIdentity(
  repository: GitRepositoryView,
): Promise<GitIdentity> {
  const [tree, head, refs, status] = await Promise.all([
    repository.git(["write-tree"]),
    repository.git(["rev-parse", "HEAD"]),
    repository.git(["for-each-ref", "--format=%(refname)%00%(objectname)"]),
    repository.git(["status", "--porcelain=v1", "-z"]),
  ]);
  return {
    tree: tree.stdout,
    head: head.stdout,
    refs: refs.stdout,
    status: status.stdout,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

function runCli(
  repositoryRoot: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) {
  return execa(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env: {
      ZEDBEE_NO_UPDATE_CHECK: "1",
      ...environment,
    },
    reject: false,
    stdin: "ignore",
  });
}

async function runBaseScan(
  repository: GitRepositoryView,
  baseRef: string,
  extraArgs: readonly string[] = [],
  environment: Readonly<Record<string, string>> = {},
) {
  const before = await gitIdentity(repository);
  const result = await runCli(
    repository.root,
    ["scan", "--base", baseRef, "--format", "json", ...extraArgs],
    environment,
  );
  expect(await gitIdentity(repository)).toEqual(before);
  return result;
}

async function createBaseFixture(
  baselineConfig = strictConfig,
): Promise<BaseFixture> {
  const repository = await createGitRepository("zedbee-base-e2e-");
  await repository.write(
    "package.json",
    '{"name":"zedbee-base-e2e","private":true}\n',
  );
  await repository.write(".zedbeerc.jsonc", baselineConfig);
  await repository.write("src/existing.ts", "export const existing = true;\n");
  await repository.commitAll("baseline");
  const baseline = (await repository.git(["rev-parse", "HEAD"])).stdout;
  await repository.git(["switch", "--create", "feature"]);
  await repository.write("src/branch.ts", "export const branch={value:1}\n");
  await repository.commitAll("committed branch finding");
  const target = (await repository.git(["rev-parse", "HEAD"])).stdout;
  return { repository, baseline, target };
}

async function createDelayedGitEnvironment(snapshotRoot: string) {
  const shimRoot = await temporaryDirectory("zedbee-git-shim-");
  const realGit = await realpath((await execa("which", ["git"])).stdout);
  const firstBlobRead = join(shimRoot, "first-blob-read");
  const delayedBlobRead = join(shimRoot, "delayed-blob-read");
  const shim = join(shimRoot, "git");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      'if [ "$1" = "cat-file" ] && [ "$2" = "--batch" ]; then',
      '  if [ -f "$ZEDBEE_FIRST_BLOB_READ" ]; then',
      '    : > "$ZEDBEE_DELAYED_BLOB_READ"',
      "    exec sleep 30",
      "  else",
      '    : > "$ZEDBEE_FIRST_BLOB_READ"',
      "  fi",
      "fi",
      'exec "$ZEDBEE_REAL_GIT" "$@"',
      "",
    ].join("\n"),
  );
  await chmod(shim, 0o755);
  return {
    firstBlobRead,
    delayedBlobRead,
    environment: {
      PATH: `${shimRoot}${delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: snapshotRoot,
      TMP: snapshotRoot,
      TEMP: snapshotRoot,
      ZEDBEE_FIRST_BLOB_READ: firstBlobRead,
      ZEDBEE_DELAYED_BLOB_READ: delayedBlobRead,
      ZEDBEE_REAL_GIT: realGit,
    },
  };
}

async function expectNoSnapshots(snapshotRoot: string): Promise<void> {
  expect(
    (await readdir(snapshotRoot)).filter((entry) =>
      entry.startsWith("zedbee-snapshot-"),
    ),
  ).toEqual([]);
}

describe("committed base scans", () => {
  it("blocks a vulnerable committed branch change in a clean checkout", async () => {
    const { repository, baseline, target } = await createBaseFixture();
    const snapshotRoot = await temporaryDirectory("zedbee-blocked-snapshots-");

    const result = await runBaseScan(repository, "main", [], {
      TMPDIR: snapshotRoot,
      TMP: snapshotRoot,
      TEMP: snapshotRoot,
    });
    const report = JSON.parse(result.stdout) as JsonReport;

    expect(result.exitCode, result.stderr).toBe(1);
    expect(report).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
      mode: "base",
      baseline,
      target,
      requestedBase: "main",
      changedFileCount: 1,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "formatting",
          findings: expect.arrayContaining([
            expect.objectContaining({
              location: expect.objectContaining({ file: "src/branch.ts" }),
            }),
          ]),
        }),
      ]),
    );
    await expectNoSnapshots(snapshotRoot);
  }, 30_000);

  it("cleans both commit snapshots after a committed unsupported input makes the scan incomplete", async () => {
    const { repository, baseline } = await createBaseFixture();
    await repository.write("src/binary.js", "export\0binary\n");
    await repository.commitAll("committed unsupported input");
    const target = (await repository.git(["rev-parse", "HEAD"])).stdout;
    const snapshotRoot = await temporaryDirectory(
      "zedbee-incomplete-snapshots-",
    );

    const result = await runBaseScan(repository, "main", [], {
      TMPDIR: snapshotRoot,
      TMP: snapshotRoot,
      TEMP: snapshotRoot,
    });
    const report = JSON.parse(result.stdout) as JsonReport;

    expect(result.exitCode, result.stderr).toBe(2);
    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      mode: "base",
      baseline,
      target,
      changedFileCount: 2,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: expect.objectContaining({
            code: "UNSUPPORTED_BINARY_INPUT",
          }),
        }),
      ]),
    );
    await expectNoSnapshots(snapshotRoot);
  }, 30_000);

  it("does not send an irrelevant changed binary through the bounded text diff", async () => {
    const repository = await createGitRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      `${JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        resources: { git: { outputLimitBytes: 1024 } },
        checks: {
          formatting: "error",
          lint: "off",
          types: "off",
          cyclomaticComplexity: "off",
          readabilityComplexity: "off",
          structuralSecurity: "off",
          secrets: "off",
          duplication: "off",
          dependencyArchitecture: "off",
          deadCode: "off",
          reactCorrectness: "off",
          reactAccessibility: "off",
          vulnerabilities: "off",
        },
      })}\n`,
    );
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.git(["switch", "-c", "feature"]);
    await repository.write("src/value.ts", "export const value = 2;\n");
    await writeFile(join(repository.root, "asset.bin"), Buffer.alloc(4096, 0));
    await repository.commitAll("text and irrelevant binary");

    const report = await runScan({
      repositoryRoot: repository.root,
      baseRef: "main",
    });

    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      changedFileCount: 2,
    });
  }, 30_000);

  it("fails closed for a relevant NUL beyond the first 8192 bytes", async () => {
    const repository = await createGitRepository();
    await repository.write(".zedbeerc.jsonc", strictConfig);
    await repository.write("src/value.ts", "export const value = 1;\n");
    await repository.commitAll("baseline");
    await repository.git(["switch", "-c", "feature"]);
    await repository.write(
      "src/late-nul.js",
      `${"export const value = 1;\n".repeat(400)}\0binary\n`,
    );
    await repository.commitAll("late NUL");

    const report = await runScan({
      repositoryRoot: repository.root,
      baseRef: "main",
    });

    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      checks: [
        expect.objectContaining({
          error: expect.objectContaining({
            code: "UNSUPPORTED_BINARY_INPUT",
            path: "src/late-nul.js",
          }),
        }),
      ],
    });
  }, 30_000);

  it("reports no index changes for the same clean checkout without --base", async () => {
    const { repository } = await createBaseFixture();

    const before = await gitIdentity(repository);
    const result = await runCli(repository.root, ["scan", "--format", "json"]);
    const report = JSON.parse(result.stdout) as JsonReport;

    expect(result.exitCode, result.stderr).toBe(0);
    expect(report).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      mode: "index",
      baseline: "HEAD",
      target: "index",
      changedFileCount: 0,
    });
    expect(await gitIdentity(repository)).toEqual(before);
  }, 30_000);

  it("uses the merge base after the base branch advances", async () => {
    const { repository, baseline, target } = await createBaseFixture();
    await repository.git(["switch", "main"]);
    await repository.write("main-only.txt", "advanced base branch\n");
    await repository.commitAll("advance main");
    const advancedMain = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.git(["switch", "feature"]);

    const result = await runBaseScan(repository, "main");
    const report = JSON.parse(result.stdout) as JsonReport;

    expect(result.exitCode, result.stderr).toBe(1);
    expect(report).toMatchObject({
      mode: "base",
      baseline,
      target,
      changedFileCount: 1,
    });
    expect(report.baseline).not.toBe(advancedMain);
  }, 30_000);

  it("ignores weaker staged, unstaged, and untracked checkout configuration", async () => {
    const { repository } = await createBaseFixture();
    await repository.write(".zedbeerc.jsonc", weakConfig);
    await repository.git(["add", "--", ".zedbeerc.jsonc"]);
    await repository.write(
      ".zedbeerc.jsonc",
      `${weakConfig.trim()}\n// weaker working copy\n`,
    );
    await repository.write(".zedbeerc.json", weakConfig);

    const result = await runBaseScan(repository, "main");
    const report = JSON.parse(result.stdout) as JsonReport;

    expect(result.exitCode, result.stderr).toBe(1);
    expect(report).toMatchObject({
      outcome: "blocked",
      mode: "base",
      changedFileCount: 1,
    });
  }, 30_000);

  it("uses configuration committed in the target commit", async () => {
    const { repository, baseline } = await createBaseFixture(weakConfig);
    await repository.write(".zedbeerc.jsonc", strictConfig);
    await repository.commitAll("activate target policy");
    const target = (await repository.git(["rev-parse", "HEAD"])).stdout;

    const result = await runBaseScan(repository, "main");
    const report = JSON.parse(result.stdout) as JsonReport;

    expect(result.exitCode, result.stderr).toBe(1);
    expect(report).toMatchObject({
      outcome: "blocked",
      mode: "base",
      baseline,
      target,
      changedFileCount: 2,
    });
  }, 30_000);

  it("returns incomplete without fetching a missing shallow merge base", async () => {
    const source = await createBaseFixture();
    await source.repository.git(["switch", "main"]);
    await source.repository.write("main-only.txt", "advanced main\n");
    await source.repository.commitAll("advance main");
    const cloneParent = await temporaryDirectory("zedbee-shallow-e2e-");
    const cloneRoot = join(cloneParent, "checkout");
    const clone = await execa(
      "git",
      [
        "clone",
        "--branch",
        "feature",
        "--depth",
        "1",
        `file://${source.repository.root}`,
        cloneRoot,
      ],
      { reject: false },
    );
    expect(clone.exitCode, clone.stderr).toBe(0);
    const fetched = await execa(
      "git",
      ["fetch", "--depth", "1", "origin", "main:refs/remotes/origin/main"],
      { cwd: cloneRoot, reject: false },
    );
    expect(fetched.exitCode, fetched.stderr).toBe(0);
    const repository: GitRepositoryView = {
      root: cloneRoot,
      git: async (args) => {
        const result = await execa("git", args, {
          cwd: cloneRoot,
          reject: false,
          stdin: "ignore",
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode ?? -1,
        };
      },
    };

    const result = await runBaseScan(repository, "origin/main");
    const report = JSON.parse(result.stdout) as JsonReport;

    expect(result.exitCode, result.stderr).toBe(2);
    expect(report).toMatchObject({
      outcome: "incomplete",
      exitCode: 2,
      mode: "base",
      baseline: null,
      target: null,
      requestedBase: "origin/main",
      changedFileCount: null,
    });
    expect(report.checks).toEqual([
      expect.objectContaining({
        checkId: "zedbee",
        error: expect.objectContaining({ code: "MERGE_BASE_UNAVAILABLE" }),
      }),
    ]);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "returns incomplete without invoking a promisor remote for missing blobs",
    async () => {
      const source = await createBaseFixture();
      await source.repository.git(["config", "uploadpack.allowFilter", "true"]);
      const cloneParent = await temporaryDirectory("zedbee-partial-e2e-");
      const cloneRoot = join(cloneParent, "checkout");
      const clone = await execa(
        "git",
        [
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          "--branch",
          "feature",
          `file://${source.repository.root}`,
          cloneRoot,
        ],
        { reject: false },
      );
      expect(clone.exitCode, clone.stderr).toBe(0);
      const missing = await execa(
        "git",
        ["rev-list", "--objects", "--missing=print", "HEAD"],
        {
          cwd: cloneRoot,
          env: { GIT_NO_LAZY_FETCH: "1" },
          reject: false,
        },
      );
      expect(missing.stdout).toMatch(/^\?/mu);

      const sentinel = join(cloneParent, "PROMISOR_REMOTE_INVOKED");
      const uploadPack = join(cloneParent, "sentinel-upload-pack.sh");
      await writeFile(
        uploadPack,
        `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 97\n`,
      );
      await chmod(uploadPack, 0o755);
      const configure = await execa(
        "git",
        ["config", "remote.origin.uploadpack", uploadPack],
        { cwd: cloneRoot, reject: false },
      );
      expect(configure.exitCode, configure.stderr).toBe(0);

      const result = await runCli(cloneRoot, [
        "scan",
        "--base",
        source.baseline,
        "--format",
        "json",
      ]);
      const report = JSON.parse(result.stdout) as JsonReport;

      expect(result.exitCode, result.stderr).toBe(2);
      expect(report).toMatchObject({
        outcome: "incomplete",
        exitCode: 2,
        mode: "base",
      });
      await expect(access(sentinel)).rejects.toThrow();
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "cleans both commit snapshots after a Git hard timeout",
    async () => {
      const { repository } = await createBaseFixture();
      const snapshotRoot = await temporaryDirectory(
        "zedbee-timeout-snapshots-",
      );
      const delayed = await createDelayedGitEnvironment(snapshotRoot);

      const result = await runBaseScan(
        repository,
        "main",
        ["--timeout", "250ms"],
        delayed.environment,
      );
      const report = JSON.parse(result.stdout) as JsonReport;

      expect(result.exitCode, result.stderr).toBe(2);
      expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
      expect(report.checks).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({ code: "GIT_HARD_TIMEOUT" }),
        }),
      ]);
      await expectNoSnapshots(snapshotRoot);
    },
    30_000,
  );

  it("cleans both commit snapshots after scan cancellation", async () => {
    const { repository } = await createBaseFixture();
    const snapshotRoot = await temporaryDirectory("zedbee-cancel-snapshots-");
    const before = await gitIdentity(repository);
    const originalTemporaryDirectory = process.env.TMPDIR;
    process.env.TMPDIR = snapshotRoot;
    const controller = new AbortController();
    const cancellation = new DOMException("cancelled E2E scan", "AbortError");

    try {
      await expect(
        runScan({
          repositoryRoot: repository.root,
          baseRef: "main",
          cache: false,
          signal: controller.signal,
          onEvent(event) {
            if (event.type === "check-running") {
              controller.abort(cancellation);
            }
          },
        }),
      ).rejects.toBe(cancellation);
    } finally {
      if (originalTemporaryDirectory === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTemporaryDirectory;
      }
    }

    expect(await gitIdentity(repository)).toEqual(before);
    await expectNoSnapshots(snapshotRoot);
    expect(controller.signal.aborted).toBe(true);
  }, 30_000);
});
