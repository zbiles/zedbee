import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitClient } from "./client.js";
import { isGitObjectId } from "./base-ref.js";

export class MergeComparisonError extends Error {
  constructor(
    readonly code:
      | "MERGE_PARENTS_UNAVAILABLE"
      | "MERGE_PARENTS_INVALID"
      | "MERGE_INDEX_UNRESOLVED",
  ) {
    super(
      code === "MERGE_INDEX_UNRESOLVED"
        ? "The merge index still contains unresolved conflicts."
        : code === "MERGE_PARENTS_INVALID"
          ? "Zedbee could not validate the merge parent commits."
          : "Zedbee could not identify the incoming merge parent commits.",
    );
    this.name = "MergeComparisonError";
  }
}

/** Git writes MERGE_HEAD after the automatic merge hook, but supplies GITHEAD_<oid> before it. */
export async function resolveMergeComparison(
  git: GitClient,
  environment: Readonly<Record<string, string | undefined>>,
  required: boolean,
  signal?: AbortSignal,
): Promise<{ parents: readonly string[]; tree: string } | undefined> {
  const options = signal === undefined ? {} : { signal };
  const path = (
    await git.run(["rev-parse", "--git-path", "MERGE_HEAD"], options)
  ).stdout;
  let incoming: string[];
  try {
    incoming = (await readFile(resolve(git.repositoryRoot, path), "utf8"))
      .trim()
      .split(/\r?\n/u);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    incoming = Object.keys(environment)
      .filter((key) => /^GITHEAD_/u.test(key))
      .map((key) => key.slice("GITHEAD_".length));
  }
  if (incoming.length === 0) {
    if (required) throw new MergeComparisonError("MERGE_PARENTS_UNAVAILABLE");
    return undefined;
  }
  if (incoming.length > 100 || incoming.some((id) => !isGitObjectId(id)))
    throw new MergeComparisonError("MERGE_PARENTS_INVALID");
  const parents: string[] = [];
  for (const ref of ["HEAD", ...incoming]) {
    const output = await git.tryRun(
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      options,
    );
    if (output.exitCode !== 0 || !isGitObjectId(output.stdout))
      throw new MergeComparisonError("MERGE_PARENTS_INVALID");
    if (!parents.includes(output.stdout)) parents.push(output.stdout);
  }
  if (parents.length < 2)
    throw new MergeComparisonError("MERGE_PARENTS_INVALID");
  const unresolved = await git.run(["ls-files", "--unmerged", "-z"], options);
  if (unresolved.stdout !== "")
    throw new MergeComparisonError("MERGE_INDEX_UNRESOLVED");
  const tree = (await git.run(["write-tree"], options)).stdout;
  if (!isGitObjectId(tree))
    throw new MergeComparisonError("MERGE_PARENTS_INVALID");
  return { parents: Object.freeze(parents), tree };
}
