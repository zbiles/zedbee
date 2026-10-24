import { buildFixPlan } from "../../../src/fixes/build-plan.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { cp, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../../src/git/client.js";
import { buildSnapshotPair } from "../../../src/git/snapshot.js";
import { applyFixPlan } from "../../../src/fixes/apply-plan.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../../src/checks/prettier/settings.js";
import {
  resolveProjectPrettierInstallation,
  snapshotIdentity,
} from "../../../src/checks/prettier/project-engine.js";
import {
  persistProjectPrettierTrust,
  revokeProjectPrettierTrust,
} from "../../../src/checks/prettier/project-trust.js";
import type { PreparedFixPlan } from "../../../src/fixes/types.js";
import { createGitRepository } from "../../helpers/git-repository.js";
import { writeWorkingFile } from "../../../src/fixes/write-working-file.js";
import { AnalysisSessionCleanupError } from "../../../src/scan/analysis-failure.js";

const repositoryPackageRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);

function digest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function projectRepository() {
  const repository = await createGitRepository("zedbee-project-fix-");
  await repository.write(
    "package.json",
    '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
  );
  await mkdir(join(repository.root, "node_modules"), { recursive: true });
  await cp(
    join(repositoryPackageRoot, "node_modules", "prettier"),
    join(repository.root, "node_modules", "prettier"),
    { recursive: true },
  );
  await repository.write(".prettierrc.json", '{"singleQuote":true}');
  await repository.write("value.ts", 'export const value = "hello";\n');
  await repository.git([
    "add",
    "--",
    "package.json",
    ".prettierrc.json",
    "value.ts",
  ]);
  const commit = await repository.git([
    "commit",
    "--message",
    "base",
    "--no-verify",
  ]);
  if (commit.exitCode !== 0) throw new Error(commit.stderr);
  await persistProjectPrettierTrust(repository.root, ".");
  return repository;
}

async function projectSelection(repositoryRoot: string) {
  const git = new GitClient(repositoryRoot);
  const snapshot = await buildSnapshotPair(repositoryRoot, git);
  try {
    const installation = await resolveProjectPrettierInstallation(
      repositoryRoot,
      ".",
      snapshot.targetDir,
    );
    return {
      engine: "project" as const,
      projectRoot: ".",
      installationIdentity: installation.identity,
      snapshotIdentity: await snapshotIdentity(snapshot.targetDir),
    };
  } finally {
    await snapshot.cleanup();
  }
}

function planFor(
  repositoryRoot: string,
  selection: Awaited<ReturnType<typeof projectSelection>>,
  workingSource: string,
): PreparedFixPlan {
  return {
    repositoryRoot,
    candidates: [
      {
        kind: "format-file",
        checkId: "formatting",
        file: "value.ts",
        findingIds: ["format-1"],
        severities: ["error"],
        settings: DEFAULT_FORMATTING_SETTINGS,
        selection,
      },
    ],
    temporaryReportMaxAgeMs: 60_000,
    publicPlan: {
      schemaVersion: 1,
      target: "index",
      selectedChecks: ["formatting"],
      exitCode: 0,
      summary: { fixes: 1, files: 1, blocking: 1, warnings: 0, skipped: 0 },
      files: [{ path: "value.ts", fixes: 1, hasUnstagedChanges: true }],
      items: [],
    },
    workingFiles: new Map([
      [
        "value.ts",
        {
          path: "value.ts",
          sha256: digest(workingSource),
          content: workingSource,
          mode: 0o644,
          hasUnstagedChanges: true,
        },
      ],
    ]),
  };
}

describe("project Prettier fix parity", () => {
  it("reports a retained snapshot after cleanup denial without losing committed fixes", async () => {
    const repository = await projectRepository();
    const source = 'export const value = "hello";\n';
    const selection = await projectSelection(repository.root);
    const plan = planFor(repository.root, selection, source);
    const originalRemove = fs.rm;
    const retained: string[] = [];
    fs.rm = async (path, options) => {
      if (basename(String(path)).startsWith("zedbee-snapshot-")) {
        retained.push(String(path));
        throw Object.assign(new Error("private injected cleanup denial"), {
          code: "EACCES",
        });
      }
      return originalRemove(path, options);
    };
    syncBuiltinESMExports();
    try {
      const failure = await applyFixPlan(plan).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AnalysisSessionCleanupError);
      expect(failure).toHaveProperty("temporaryPath", retained[0]);
      expect(failure).toHaveProperty("cause.code", "EACCES");
      expect(failure).toHaveProperty("result.changedFiles", ["value.ts"]);
      expect(failure).toHaveProperty("result.appliedFixes", 1);
      expect(await repository.read("value.ts")).toBe(
        "export const value = 'hello';\n",
      );
      expect(
        await readFile(join(retained[0]!, "target/value.ts"), "utf8"),
      ).toBe(source);
      expect(JSON.stringify(failure)).not.toContain("private injected");
    } finally {
      fs.rm = originalRemove;
      syncBuiltinESMExports();
      for (const path of retained)
        await originalRemove(path, { recursive: true, force: true });
    }
  });
  it("retains the formatter failure alongside an actionable cleanup failure", async () => {
    const repository = await projectRepository();
    const selection = await projectSelection(repository.root);
    const source = "export const = ;\n";
    await repository.write("value.ts", source);
    const originalRemove = fs.rm;
    const retained: string[] = [];
    fs.rm = async (path, options) => {
      if (basename(String(path)).startsWith("zedbee-snapshot-")) {
        retained.push(String(path));
        throw Object.assign(new Error("private cleanup denial"), {
          code: "EACCES",
        });
      }
      return originalRemove(path, options);
    };
    syncBuiltinESMExports();
    try {
      const failure = await applyFixPlan(
        planFor(repository.root, selection, source),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AnalysisSessionCleanupError);
      expect(failure).toHaveProperty(
        "cause.code",
        "PROJECT_PRETTIER_WORKER_FAILED",
      );
      expect(failure).toHaveProperty("result.issues.0.kind", "format");
      expect(failure).toHaveProperty("result.changedFiles", []);
      expect(failure).toHaveProperty("temporaryPath", retained[0]);
      expect(await repository.read("value.ts")).toBe(source);
      expect(JSON.stringify(failure)).not.toContain("private cleanup");
    } finally {
      fs.rm = originalRemove;
      syncBuiltinESMExports();
      for (const path of retained)
        await originalRemove(path, { recursive: true, force: true });
    }
  });

  it.each([
    new Error("private cancellation"),
    Object.freeze(new Error("private frozen cancellation")),
    "private primitive cancellation",
  ])(
    "preserves cancellation identity or cause and earlier committed fixes when cleanup fails",
    async (reason) => {
      const repository = await projectRepository();
      const source = 'export const value = "hello";\n';
      await repository.write("z-second.ts", source);
      await repository.git(["add", "--", "z-second.ts"]);
      const selection = await projectSelection(repository.root);
      const base = planFor(repository.root, selection, source);
      const plan: PreparedFixPlan = {
        ...base,
        candidates: [
          ...base.candidates,
          { ...base.candidates[0]!, file: "z-second.ts" },
        ],
        workingFiles: new Map([
          ...base.workingFiles,
          [
            "z-second.ts",
            { ...base.workingFiles.get("value.ts")!, path: "z-second.ts" },
          ],
        ]),
      };
      const controller = new AbortController();
      const originalRemove = fs.rm;
      const retained: string[] = [];
      fs.rm = async (path, options) => {
        if (basename(String(path)).startsWith("zedbee-snapshot-")) {
          retained.push(String(path));
          throw Object.assign(new Error("private cleanup denial"), {
            code: "EACCES",
          });
        }
        return originalRemove(path, options);
      };
      syncBuiltinESMExports();
      try {
        const failure = await applyFixPlan(plan, {
          signal: controller.signal,
          async writeWorkingFile(request) {
            await writeWorkingFile(request);
            controller.abort(reason);
          },
        }).catch((error: unknown) => error);
        const extensible =
          reason instanceof Error && Object.isExtensible(reason);
        if (extensible) expect(failure).toBe(reason);
        else expect(failure).toHaveProperty("cause", reason);
        const cleanup = extensible
          ? Object.getOwnPropertyDescriptor(failure, "cleanupFailure")?.value
          : failure;
        expect(cleanup).toBeInstanceOf(AnalysisSessionCleanupError);
        expect(cleanup).toHaveProperty("temporaryPath", retained[0]);
        expect(cleanup).toHaveProperty("result.changedFiles", ["value.ts"]);
        expect(cleanup).toHaveProperty("result.appliedFixes", 1);
        expect(cleanup).toHaveProperty("result.exitCode", 1);
        expect(await repository.read("value.ts")).toBe(
          "export const value = 'hello';\n",
        );
        expect(await repository.read("z-second.ts")).toBe(source);
        expect(JSON.stringify(failure)).not.toContain(
          reason instanceof Error ? reason.message : reason,
        );
      } finally {
        fs.rm = originalRemove;
        syncBuiltinESMExports();
        for (const path of retained)
          await originalRemove(path, { recursive: true, force: true });
      }
    },
  );

  it("retains the snapshot when real formatter workspace cleanup fails", async () => {
    const repository = await projectRepository();
    const source = 'export const value = "hello";\n';
    const selection = await projectSelection(repository.root);
    const originalRemove = fs.rm;
    const retained: string[] = [];
    let snapshotRemovalAttempted = false;
    fs.rm = async (path, options) => {
      if (basename(String(path)).startsWith("zedbee-snapshot-"))
        snapshotRemovalAttempted = true;
      if (basename(String(path)).startsWith("zedbee-project-workspace-")) {
        retained.push(String(path));
        throw Object.assign(new Error("private worker workspace denial"), {
          code: "EACCES",
        });
      }
      return originalRemove(path, options);
    };
    syncBuiltinESMExports();
    try {
      const failure = await applyFixPlan(
        planFor(repository.root, selection, source),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AnalysisSessionCleanupError);
      expect(snapshotRemovalAttempted).toBe(false);
      expect(failure).toHaveProperty("result.changedFiles", ["value.ts"]);
      const path = (failure as AnalysisSessionCleanupError).temporaryPath!;
      retained.push(path);
      expect(await readFile(join(path, "target/value.ts"), "utf8")).toBe(
        source,
      );
      expect(JSON.stringify(failure)).not.toContain("private worker");
    } finally {
      fs.rm = originalRemove;
      syncBuiltinESMExports();
      for (const path of retained)
        await originalRemove(path, { recursive: true, force: true });
    }
  });

  it("does not hide snapshot construction cleanup denial as an ordinary format issue", async () => {
    const repository = await projectRepository();
    const source = 'export const value = "hello";\n';
    const selection = await projectSelection(repository.root);
    const originalRemove = fs.rm;
    const originalMkdir = fs.mkdir;
    const retained: string[] = [];
    fs.mkdir = (async (path, options) => {
      if (
        basename(String(path)) === "target" &&
        String(path).includes("zedbee-snapshot-")
      ) {
        throw Object.assign(new Error("private construction denial"), {
          code: "EACCES",
        });
      }
      return originalMkdir(path, options);
    }) as typeof fs.mkdir;
    fs.rm = async (path, options) => {
      if (basename(String(path)).startsWith("zedbee-snapshot-")) {
        retained.push(String(path));
        throw Object.assign(new Error("private cleanup denial"), {
          code: "EACCES",
        });
      }
      return originalRemove(path, options);
    };
    syncBuiltinESMExports();
    try {
      const failure = await applyFixPlan(
        planFor(repository.root, selection, source),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AnalysisSessionCleanupError);
      expect(failure).toHaveProperty("temporaryPath", retained[0]);
      expect(failure).toHaveProperty(
        "cause.code",
        "SNAPSHOT_CONSTRUCTION_FAILED",
      );
      expect(failure).toHaveProperty("result.issues.0.kind", "format");
      expect(await repository.read("value.ts")).toBe(source);
      expect(JSON.stringify(failure)).not.toContain("private construction");
    } finally {
      fs.rm = originalRemove;
      fs.mkdir = originalMkdir;
      syncBuiltinESMExports();
      for (const path of retained)
        await originalRemove(path, { recursive: true, force: true });
    }
  });

  it("shares one staged snapshot and project formatter across files in an apply session", async () => {
    const repository = await projectRepository();
    const source = 'export const value = "hello";\n';
    await repository.write("z-second.ts", source);
    await repository.git(["add", "--", "z-second.ts"]);
    const selection = await projectSelection(repository.root);
    const base = planFor(repository.root, selection, source);
    const plan: PreparedFixPlan = {
      ...base,
      candidates: [
        ...base.candidates,
        { ...base.candidates[0]!, file: "z-second.ts" },
      ],
      workingFiles: new Map([
        ...base.workingFiles,
        [
          "z-second.ts",
          { ...base.workingFiles.get("value.ts")!, path: "z-second.ts" },
        ],
      ]),
    };
    const originalRemove = fs.rm;
    let snapshotsRemoved = 0;
    let workspacesRemoved = 0;
    fs.rm = async (path, options) => {
      if (basename(String(path)).startsWith("zedbee-snapshot-"))
        snapshotsRemoved++;
      if (basename(String(path)).startsWith("zedbee-project-workspace-"))
        workspacesRemoved++;
      return originalRemove(path, options);
    };
    syncBuiltinESMExports();
    try {
      const result = await applyFixPlan(plan);
      expect(result.changedFiles).toEqual(["value.ts", "z-second.ts"]);
      expect(await repository.read("value.ts")).toBe(
        "export const value = 'hello';\n",
      );
      expect(await repository.read("z-second.ts")).toBe(
        "export const value = 'hello';\n",
      );
      expect(snapshotsRemoved).toBe(1);
      expect(workspacesRemoved).toBe(1);
    } finally {
      fs.rm = originalRemove;
      syncBuiltinESMExports();
    }
  });

  it("formats the working file with the project engine and preserves the index", async () => {
    const repository = await projectRepository();
    const selection = await projectSelection(repository.root);
    const plan = planFor(
      repository.root,
      selection,
      'export const value = "hello";\n',
    );

    const result = await applyFixPlan(plan);

    expect(result.exitCode).toBe(0);
    expect(result.changedFiles).toEqual(["value.ts"]);
    expect(await readFile(join(repository.root, "value.ts"), "utf8")).toBe(
      "export const value = 'hello';\n",
    );
    const index = await repository.git(["show", ":value.ts"]);
    expect(index.stdout).toBe('export const value = "hello";');
  });

  it("applies with invocation-only trust on a fresh checkout without a stored grant", async () => {
    const repository = await projectRepository();
    const selection = await projectSelection(repository.root);
    const plan = planFor(
      repository.root,
      selection,
      'export const value = "hello";\n',
    );
    await revokeProjectPrettierTrust(repository.root, ".");

    // The fixture's persisted grant has been removed. Only the in-memory
    // invocation consent carried by the apply call authorizes the engine.
    const result = await applyFixPlan(plan, { projectPrettierTrust: true });

    expect(result.exitCode).toBe(0);
    expect(result.changedFiles).toEqual(["value.ts"]);
    expect(await readFile(join(repository.root, "value.ts"), "utf8")).toBe(
      "export const value = 'hello';\n",
    );
    const index = await repository.git(["show", ":value.ts"]);
    expect(index.stdout).toBe('export const value = "hello";');
  });

  it("rejects a plan whose selected snapshot changed", async () => {
    const repository = await projectRepository();
    const selection = await projectSelection(repository.root);
    const plan = planFor(
      repository.root,
      selection,
      'export const value = "hello";\n',
    );
    await repository.write(".prettierrc.json", '{"singleQuote":false}');
    await repository.git(["add", "--", ".prettierrc.json"]);

    const result = await applyFixPlan(plan);

    expect(result.issues).toEqual([
      expect.objectContaining({ kind: "stale", file: "value.ts" }),
    ]);
    expect(await readFile(join(repository.root, "value.ts"), "utf8")).toBe(
      'export const value = "hello";\n',
    );
  });
});

it("preserves preexisting partial staging through a production project-format fix", async () => {
  const repository = await projectRepository();
  await repository.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: { formatting: { engine: "project" } },
    }),
  );
  await repository.commitAll("project policy");
  await repository.write("value.ts", 'export const value="staged";\n');
  await repository.git(["add", "value.ts"]);
  await repository.write(
    "value.ts",
    'export const value="staged";\nexport const local="unstaged";\n',
  );
  const beforeIndex = (await repository.git(["show", ":value.ts"])).stdout;
  const plan = await buildFixPlan({
    repositoryRoot: repository.root,
    selectedChecks: ["formatting"],
  });
  expect(plan.publicPlan.files).toContainEqual(
    expect.objectContaining({ path: "value.ts", hasUnstagedChanges: true }),
  );
  expect(plan.candidates).toContainEqual(
    expect.objectContaining({
      kind: "format-file",
      selection: expect.objectContaining({ engine: "project" }),
    }),
  );
  const result = await applyFixPlan(plan);
  expect(result.changedFiles).toEqual(["value.ts"]);
  expect(await repository.read("value.ts")).toBe(
    "export const value = 'staged';\nexport const local = 'unstaged';\n",
  );
  expect((await repository.git(["show", ":value.ts"])).stdout).toBe(
    beforeIndex,
  );
});

it.each(["unchanged", "installation", "revoked", "working"] as const)(
  "revalidates the real scan-to-fix plan after %s inputs",
  async (change) => {
    const repository = await projectRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: { formatting: { engine: "project", severity: "error" } },
      }),
    );
    await repository.git(["add", "--", ".zedbeerc.jsonc"]);
    await repository.git([
      "commit",
      "--message",
      "project policy",
      "--no-verify",
    ]);
    await repository.write("value.ts", 'export const value = "changed";\n');
    await repository.git(["add", "--", ".zedbeerc.jsonc", "value.ts"]);
    const plan = await buildFixPlan({
      repositoryRoot: repository.root,
      selectedChecks: ["formatting"],
    });
    expect(
      plan.candidates.some(
        (candidate) =>
          candidate.kind === "format-file" &&
          candidate.selection?.engine === "project",
      ),
      JSON.stringify(plan.publicPlan),
    ).toBe(true);
    if (change === "installation") {
      const path = join(repository.root, "node_modules/prettier/index.mjs");
      await repository.write(
        "node_modules/prettier/index.mjs",
        (await readFile(path, "utf8")) + "\n// changed installation\n",
      );
    }
    if (change === "revoked")
      await revokeProjectPrettierTrust(repository.root, ".");
    if (change === "working")
      await repository.write("value.ts", 'export const value = "unstaged";\n');
    const before = await repository.read("value.ts");
    const index = (await repository.git(["show", ":value.ts"])).stdout;
    const result = await applyFixPlan(plan);
    expect((await repository.git(["show", ":value.ts"])).stdout).toBe(index);
    if (change === "unchanged") {
      expect(result.changedFiles).toEqual(["value.ts"]);
      expect(await repository.read("value.ts")).toBe(
        "export const value = 'changed';\n",
      );
    } else {
      expect(result.changedFiles).toEqual([]);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(await repository.read("value.ts")).toBe(before);
    }
  },
);
