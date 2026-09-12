import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { GitClient } from "../git/client.js";
import { customGitHookPath } from "../hooks/detect.js";
import { hooksPathValue, TRACKED_HOOK_NAMES } from "../hooks/install.js";
import { initContentHash } from "./recommend.js";
import type {
  ApplyInitDependencies,
  ApplyResult,
  InitFileChange,
  InitProposal,
} from "./types.js";

const EXACT_TARGETS = new Set([
  ".zedbeerc.jsonc",
  "lefthook.yml",
  "lefthook.yaml",
  "package.json",
  ".husky/pre-commit",
  ".husky/install.mjs",
  ".husky/_/.gitignore",
  ".husky/_/h",
  ...TRACKED_HOOK_NAMES.flatMap((name) => [
    `.husky/${name}`,
    `.husky/_/${name}`,
  ]),
]);

function normalizedPath(path: string): string {
  return path.split(sep).join("/");
}

function unsafeTarget(): Error {
  return new Error("Zedbee refused an unsafe initialization target.");
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    !isAbsolute(fromRoot) &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`)
  );
}

async function metadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateAncestors(root: string, target: string): Promise<void> {
  const parent = dirname(target);
  const fromRoot = relative(root, parent);
  const segments = fromRoot === "" ? [] : fromRoot.split(sep);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const state = await metadata(current);
    if (state === undefined) continue;
    if (state.isSymbolicLink() || !state.isDirectory()) throw unsafeTarget();
  }
}

async function currentContents(path: string): Promise<string | null> {
  const state = await metadata(path);
  if (state === undefined) return null;
  if (state.isSymbolicLink() || !state.isFile()) throw unsafeTarget();
  return readFile(path, "utf8");
}

async function validateGitConfig(root: string): Promise<void> {
  const output = await new GitClient(root).run([
    "rev-parse",
    "--git-path",
    "config",
  ]);
  const path = resolve(root, output.stdout);
  const state = await metadata(path);
  if (
    state === undefined ||
    state.isSymbolicLink() ||
    !state.isFile() ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw unsafeTarget();
}

async function validatedRawGitPath(
  root: string,
  change: InitFileChange,
): Promise<string> {
  if (
    change.relativePath !== ".git/hooks/pre-commit" ||
    change.absolutePath === undefined ||
    !isAbsolute(change.absolutePath)
  ) {
    throw unsafeTarget();
  }
  const git = new GitClient(root);
  const [hookOutput, commonOutput] = await Promise.all([
    git.run(["rev-parse", "--git-path", "hooks/pre-commit"]),
    git.run(["rev-parse", "--git-common-dir"]),
  ]);
  const hook = isAbsolute(hookOutput.stdout)
    ? resolve(hookOutput.stdout)
    : resolve(root, hookOutput.stdout);
  const common = isAbsolute(commonOutput.stdout)
    ? resolve(commonOutput.stdout)
    : resolve(root, commonOutput.stdout);
  const commonState = await lstat(common);
  if (commonState.isSymbolicLink() || !commonState.isDirectory()) {
    throw unsafeTarget();
  }
  const canonicalCommon = await realpath(common);
  const hooksDirectory = resolve(canonicalCommon, "hooks");
  const hooksState = await lstat(hooksDirectory);
  if (hooksState.isSymbolicLink() || !hooksState.isDirectory()) {
    throw unsafeTarget();
  }
  const canonicalHook = resolve(await realpath(dirname(hook)), basename(hook));
  if (
    canonicalHook !== resolve(hooksDirectory, "pre-commit") ||
    canonicalHook !== change.absolutePath
  ) {
    throw unsafeTarget();
  }
  return canonicalHook;
}

async function validateChange(
  root: string,
  change: InitFileChange,
): Promise<{
  readonly path: string;
  readonly before: string | null;
  readonly mode: number;
}> {
  const portable = normalizedPath(change.relativePath).replace(/^\.\//u, "");
  let path: string;
  if (change.absolutePath !== undefined) {
    if (change.relativePath === ".git/hooks/pre-commit") {
      path = await validatedRawGitPath(root, change);
    } else {
      const configured = await customGitHookPath(root);
      if (
        configured === undefined ||
        configured !== change.absolutePath ||
        normalizedPath(relative(root, configured)) !== change.relativePath
      )
        throw unsafeTarget();
      path = configured;
      await validateAncestors(root, path);
    }
  } else {
    if (!EXACT_TARGETS.has(portable) || portable !== change.relativePath) {
      throw unsafeTarget();
    }
    path = resolve(root, portable);
    if (!contained(root, path)) throw unsafeTarget();
    await validateAncestors(root, path);
  }
  const before = await currentContents(path);
  const beforeHash = before === null ? null : initContentHash(before);
  if (
    beforeHash !== change.beforeHash ||
    change.afterHash !== initContentHash(change.after) ||
    change.before !== before
  ) {
    throw new Error("Zedbee initialization proposal is stale.");
  }
  const state = await metadata(path);
  return {
    path,
    before,
    mode: state === undefined ? change.mode : state.mode & 0o777,
  };
}

async function atomicReplace(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) throw unsafeTarget();
  const temporary = resolve(
    parent,
    `.zedbee-init-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    await rename(temporary, path);
    renamed = true;
    await chmod(path, mode);
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

async function rollback(
  applied: readonly { path: string; before: string | null; mode: number }[],
): Promise<void> {
  for (const item of [...applied].reverse()) {
    if (item.before === null) {
      await unlink(item.path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } else {
      await atomicReplace(item.path, item.before, item.mode);
    }
  }
}

export async function applyInitProposal(
  proposal: InitProposal,
  dependencies: ApplyInitDependencies = {},
): Promise<ApplyResult> {
  const root = await realpath(resolve(proposal.repositoryRoot)).catch(() => {
    throw unsafeTarget();
  });
  const validated = [] as Array<{
    readonly change: InitFileChange;
    readonly path: string;
    readonly before: string | null;
    readonly mode: number;
  }>;
  const paths = new Set<string>();
  if (proposal.hooksPathChange !== undefined) await validateGitConfig(root);
  if (
    proposal.hooksPathChange !== undefined &&
    (proposal.hooksPathChange.after !== ".husky/_" ||
      (await hooksPathValue(root)) !== proposal.hooksPathChange.before)
  ) {
    throw new Error("Zedbee initialization proposal is stale.");
  }
  for (const change of proposal.files) {
    const state = await validateChange(root, change);
    if (paths.has(state.path)) throw unsafeTarget();
    paths.add(state.path);
    validated.push({ change, ...state });
  }

  const applied: Array<{ path: string; before: string | null; mode: number }> =
    [];
  try {
    for (const [index, item] of validated.entries()) {
      await dependencies.beforeWrite?.(index, item.change);
      const refreshed = await validateChange(root, item.change);
      const mode = item.change.relativePath.startsWith(".husky/_/")
        ? item.change.mode
        : refreshed.mode;
      await atomicReplace(item.path, item.change.after, mode);
      applied.push({ path: item.path, before: item.before, mode: item.mode });
    }
    if (proposal.hooksPathChange !== undefined) {
      await validateGitConfig(root);
      if ((await hooksPathValue(root)) !== proposal.hooksPathChange.before)
        throw new Error(
          "Git hook configuration changed during initialization.",
        );
      await new GitClient(root).run([
        "config",
        "--local",
        "core.hooksPath",
        proposal.hooksPathChange.after,
      ]);
    }
  } catch {
    try {
      await rollback(applied);
    } catch {
      throw new Error(
        "Zedbee initialization failed and rollback was incomplete.",
      );
    }
    throw new Error("Zedbee initialization failed and was rolled back.");
  }
  return Object.freeze({
    applied: true,
    files: Object.freeze(
      proposal.files.map(({ relativePath }) => relativePath),
    ),
    rolledBack: false,
  });
}
