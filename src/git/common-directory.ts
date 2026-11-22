import { realpath } from "node:fs/promises";
import { GitClient } from "./client.js";

/** Shared by all worktrees, but distinct for independent clones. */
export async function canonicalTrustRoot(
  repositoryRoot: string,
): Promise<string> {
  const result = await new GitClient(repositoryRoot).run([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return realpath(result.stdout);
}
