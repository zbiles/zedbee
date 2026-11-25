import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { GitClient } from "../git/client.js";
import type { ScanHookName } from "./command.js";

export async function resolveRawGitHookPath(
  root: string,
  hookName: ScanHookName,
  requireRegularCommonDirectory: boolean,
): Promise<string> {
  const unsafe = () =>
    new Error(
      requireRegularCommonDirectory
        ? "Zedbee refused an unsafe initialization target."
        : "Zedbee refused an unsafe hook target.",
    );
  if (hookName !== "pre-commit" && hookName !== "pre-merge-commit")
    throw unsafe();
  const git = new GitClient(root);
  const [hookOutput, commonOutput] = await Promise.all([
    git.run(["rev-parse", "--git-path", `hooks/${hookName}`]),
    git.run(["rev-parse", "--git-common-dir"]),
  ]);
  const hook = isAbsolute(hookOutput.stdout)
    ? resolve(hookOutput.stdout)
    : resolve(root, hookOutput.stdout);
  const common = isAbsolute(commonOutput.stdout)
    ? resolve(commonOutput.stdout)
    : resolve(root, commonOutput.stdout);
  if (requireRegularCommonDirectory) {
    const commonState = await lstat(common);
    if (commonState.isSymbolicLink() || !commonState.isDirectory())
      throw unsafe();
  }
  const canonicalCommon = await realpath(common);
  const hooksDirectory = resolve(canonicalCommon, "hooks");
  const hooksState = await lstat(hooksDirectory);
  if (hooksState.isSymbolicLink() || !hooksState.isDirectory()) {
    throw unsafe();
  }
  const canonicalHook = resolve(await realpath(dirname(hook)), basename(hook));
  if (canonicalHook !== resolve(hooksDirectory, hookName)) {
    throw unsafe();
  }
  return canonicalHook;
}
