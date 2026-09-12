import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GitClient } from "../git/client.js";
import { initFileChange } from "../init/recommend.js";
import type { InitFileChange, InitProposal } from "../init/types.js";
import { updateRawGitHook } from "./raw-git.js";

export const TRACKED_HOOK_NAMES = Object.freeze([
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-rebase",
  "post-rewrite",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
]);

export async function hookFile(
  root: string,
  relativePath: string,
): Promise<{ contents: string; mode: number } | undefined> {
  try {
    const path = join(root, relativePath);
    let ancestor = resolve(root);
    for (const part of relative(resolve(root), dirname(path))
      .split(sep)
      .filter(Boolean)) {
      ancestor = join(ancestor, part);
      const state = await lstat(ancestor);
      if (state.isSymbolicLink() || !state.isDirectory())
        throw new Error("Unsafe hook directory.");
    }
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error("Unsafe hook file.");
    return { contents: await readFile(path, "utf8"), mode: state.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function hooksPathValue(root: string): Promise<string | null> {
  const configured = await new GitClient(root).run(
    ["config", "--get", "core.hooksPath"],
    { reject: false },
  );
  if (configured.exitCode !== 0 && configured.exitCode !== 1)
    throw new Error("Could not inspect Git hook configuration.");
  return configured.exitCode === 1 ? null : configured.stdout;
}

export async function trackedRuntimeChanges(
  root: string,
): Promise<readonly InitFileChange[]> {
  const huskyRoot = dirname(fileURLToPath(import.meta.resolve("husky")));
  const runtime = await readFile(join(huskyRoot, "husky"), "utf8");
  const entries: Array<[string, string, number]> = [
    [".husky/_/.gitignore", "*\n", 0o644],
    [".husky/_/h", runtime, 0o644],
    ...TRACKED_HOOK_NAMES.map((name): [string, string, number] => [
      `.husky/_/${name}`,
      '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
      0o755,
    ]),
  ];
  return Promise.all(
    entries.map(async ([path, after, mode]) => {
      const before = await hookFile(root, path);
      return initFileChange(path, before?.contents ?? null, after, mode);
    }),
  );
}

export async function validateLocalHookMigration(root: string): Promise<void> {
  const { rawGitHookPath } = await import("./detect.js");
  const directory = dirname(await rawGitHookPath(root));
  for (const name of await readdir(directory)) {
    if (name.endsWith(".sample")) continue;
    const original = await hookFile(directory, name);
    if (original === undefined || (original.mode & 0o111) === 0) continue;
    if (name !== "pre-commit" || original.contents !== updateRawGitHook(null)) {
      throw new Error(
        "Tracked setup cannot preserve custom local hook execution. Keep the local integration or migrate those hooks manually first.",
      );
    }
  }
}

/** Installs only trusted bundled dispatcher data; never runs project scripts. */
export async function installTrackedHooks(root = process.cwd()): Promise<void> {
  if (process.env.CI || process.env.HUSKY === "0") return;
  try {
    await lstat(join(root, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const before = await hooksPathValue(root);
  if (before !== null && before !== ".husky/_")
    throw new Error(
      "Zedbee will not replace another configured hook integration.",
    );
  if (before === null) await validateLocalHookMigration(root);
  const proposal: InitProposal = {
    repositoryRoot: root,
    profile: "recommended",
    hook: "husky",
    hookActivation: {
      status: "active",
      message: "The tracked hook dispatcher is installed.",
    },
    hooksPathChange: { before, after: ".husky/_" },
    detectedEnvironments: [],
    recommendedChecks: [],
    vulnerabilityScanningAvailable: false,
    osvUnavailable: "block",
    networkChecks: [],
    limitations: [],
    files: await trackedRuntimeChanges(root),
  };
  const { applyInitProposal } = await import("../init/write-config.js");
  await applyInitProposal(proposal);
}

export const TRACKED_INSTALL_SCRIPT = `// Activate the reviewed tracked hooks after dependency installation.
import { existsSync } from "node:fs";
if (!process.env.CI && process.env.HUSKY !== "0" && existsSync(".git")) {
  let available = true;
  try { import.meta.resolve("zedbee/hooks"); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") available = false;
    else throw error;
  }
  if (available) {
    const { installTrackedHooks } = await import("zedbee/hooks");
    await installTrackedHooks(process.cwd());
  }
}
`;
