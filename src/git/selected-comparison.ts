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

function invalidSelection(): never {
  throw new GitCommandError(
    "GIT_COMMAND_FAILED",
    "Zedbee could not capture a consistent selected index.",
  );
}

async function indexState(path: string) {
  try {
    const before = await lstat(path, { bigint: true });
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function head(
  git: GitClient,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await git.tryRun(
    ["rev-parse", "--verify", "HEAD"],
    signal ? { signal } : {},
  );
  if (result.exitCode !== 0) return null;
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
  const baselineCommit = await head(git, signal);
  const mergePath = resolve(
    git.repositoryRoot,
    (await git.run(["rev-parse", "--git-path", "MERGE_HEAD"], options)).stdout,
  );
  const incoming = await mergeHeads(mergePath);
  const indexPath = resolve(
    git.repositoryRoot,
    (
      await git.run(
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        options,
      )
    ).stdout,
  );
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
      baselineCommit !== (await head(git, signal)) ||
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
    await cleanup();
    throw error;
  }
}
