import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GitClient } from "./client.js";
import { GitCommandError } from "./errors.js";
import { isGitObjectId } from "./base-ref.js";

export interface SelectedIndexComparison {
  readonly baselineCommit: string | null;
  bind(client: GitClient): GitClient;
  cleanup(): Promise<void>;
}

export class SelectedIndexCleanupError extends Error {
  constructor(readonly originalError: unknown) {
    super("Zedbee could not remove its private selected index.", {
      cause: originalError,
    });
    this.name = "SelectedIndexCleanupError";
  }
}

function invalidSelection(): never {
  throw new GitCommandError(
    "GIT_COMMAND_FAILED",
    "Zedbee could not capture a consistent selected index.",
  );
}

async function indexState(path: string) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // Once an index was observed, disappearance is a capture failure, not the
  // legitimate initial-commit/no-index case.
  if (!before.isFile() || before.isSymbolicLink()) return invalidSelection();
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    return invalidSelection();
  return {
    bytes,
    dev: after.dev,
    ino: after.ino,
    mtime: after.mtimeNs,
    ctime: after.ctimeNs,
  };
}
export async function resolveIndexBaseline(
  git: GitClient,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await git.tryRun(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    signal ? { signal } : {},
  );
  if (result.exitCode !== 0) {
    const options = signal ? { signal } : {};
    const symbolic = await git.tryRun(
      ["symbolic-ref", "--quiet", "HEAD"],
      options,
    );
    if (symbolic.exitCode !== 0 || !symbolic.stdout.startsWith("refs/heads/"))
      return invalidSelection();
    const existence = await git.tryRun(
      ["show-ref", "--exists", symbolic.stdout],
      options,
    );
    if (existence.exitCode === 2) return null;
    // Older Git lacks --exists. A missing ref must also have no loose ref
    // file and no packed matching ref. Ref lookup warnings are failures.
    if (existence.exitCode === 129) {
      const path = await git.run(
        ["rev-parse", "--git-path", symbolic.stdout],
        options,
      );
      try {
        await lstat(resolve(git.repositoryRoot, path.stdout));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return invalidSelection();
        const refs = await git.tryRun(
          ["for-each-ref", "--format=%(refname)", symbolic.stdout],
          options,
        );
        if (
          refs.exitCode === 0 &&
          refs.stderr === "" &&
          !refs.stdout.split("\n").includes(symbolic.stdout)
        )
          return null;
      }
    }
    return invalidSelection();
  }
  if (!isGitObjectId(result.stdout)) return invalidSelection();
  return result.stdout;
}

async function mergeHeads(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Copy staging metadata once; source blobs stay in Git until materialization. */
export async function captureSelectedIndexComparison(
  git: GitClient,
  signal?: AbortSignal,
): Promise<SelectedIndexComparison> {
  signal?.throwIfAborted();
  const options = signal ? { signal } : {};
  const [baseline, merge, index] = await Promise.allSettled([
    resolveIndexBaseline(git, signal),
    git.run(["rev-parse", "--git-path", "MERGE_HEAD"], options),
    git.run(["rev-parse", "--git-path", "index"], options),
  ]);
  // These reads are independent, but all Git children must settle before this
  // owner can fail or create the private selection directory.
  if (baseline.status === "rejected") throw baseline.reason;
  if (merge.status === "rejected") throw merge.reason;
  if (index.status === "rejected") throw index.reason;
  const baselineCommit = baseline.value;
  const mergePath = resolve(git.repositoryRoot, merge.value.stdout);
  const incoming = await mergeHeads(mergePath);
  const indexPath = resolve(git.repositoryRoot, index.value.stdout);
  const before = await indexState(indexPath);
  const temporary = await mkdtemp(join(tmpdir(), "zedbee-selection-"));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await rm(temporary, { recursive: true, force: true });
    cleaned = true;
  };
  try {
    const privateIndex = join(temporary, "index");
    const diffBase =
      baselineCommit ??
      (await git.run(["hash-object", "-t", "tree", "--stdin"], options)).stdout;
    if (!isGitObjectId(diffBase)) return invalidSelection();
    const parents = incoming?.trim().split(/\r?\n/u);
    const bound = git.withSelectedIndex(
      privateIndex,
      baselineCommit,
      diffBase,
      parents,
    );
    if (before) {
      await writeFile(privateIndex, before.bytes, { mode: 0o600, flag: "wx" });
      // Resolve split-index dependencies using Git's own hash validation, and
      // remove the link extension only in our private index. Preserve ITA/stages.
      await bound.run(["update-index", "--no-split-index"], options);
    } else {
      await bound.run(["read-tree", "--empty"], options);
    }
    const after = await indexState(indexPath);
    if (
      baselineCommit !== (await resolveIndexBaseline(git, signal)) ||
      incoming !== (await mergeHeads(mergePath)) ||
      (before === undefined) !== (after === undefined) ||
      (before &&
        after &&
        (!before.bytes.equals(after.bytes) ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.mtime !== after.mtime ||
          before.ctime !== after.ctime))
    )
      return invalidSelection();
    signal?.throwIfAborted();
    return {
      baselineCommit,
      bind: (client) =>
        client.withSelectedIndex(
          privateIndex,
          baselineCommit,
          diffBase,
          parents,
        ),
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch {
      throw new SelectedIndexCleanupError(error);
    }
    throw error;
  }
}
