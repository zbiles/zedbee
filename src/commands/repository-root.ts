import { GitClient } from "../git/client.js";

export async function resolveGitRepositoryRoot(cwd: string): Promise<string> {
  return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
    .stdout;
}
