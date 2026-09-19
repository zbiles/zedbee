import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { persistProjectPrettierTrust } from "../../../src/checks/prettier/project-trust.js";
import type { PreparedFixPlan } from "../../../src/fixes/types.js";
import { createGitRepository } from "../../helpers/git-repository.js";

const repositoryPackageRoot = fileURLToPath(new URL("../../../", import.meta.url));

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
  it("formats the working file with the project engine and preserves the index", async () => {
    const repository = await projectRepository();
    const selection = await projectSelection(repository.root);
    const plan = planFor(repository.root, selection, 'export const value = "hello";\n');

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
    const plan = planFor(repository.root, selection, 'export const value = "hello";\n');

    // No persistProjectPrettierTrust here: only the in-memory invocation
    // consent carried by the apply call authorizes the project engine.
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
    const plan = planFor(repository.root, selection, 'export const value = "hello";\n');
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