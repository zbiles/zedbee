import { resolveRawGitHookPath } from "../hooks/raw-hook-path.js";
import {
  hasProjectEslintTrust,
  persistProjectEslintTrust,
  revokeProjectEslintCapability,
} from "../checks/eslint/project/trust.js";
import { ProjectEslintSetupError } from "./eslint-setup.js";
import { randomUUID } from "node:crypto";
import {
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
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { GitClient } from "../git/client.js";
import { customGitHookPath } from "../hooks/detect.js";
import { hooksPathValue, TRACKED_HOOK_NAMES } from "../hooks/install.js";
import {
  ProjectPrettierTrustRollbackError,
  persistProjectPrettierTrust,
  restoreProjectPrettierTrust,
  revokeProjectPrettierTrust,
} from "../checks/prettier/project-trust.js";
import { decodeLosslessUtf8 } from "../core/utf8.js";
import {
  openWithoutFollowing,
  readBoundedBytes,
} from "../inspection/read-json.js";
import { verifyExecutableImportProvenance } from "./import-provenance.js";
import { initContentHash } from "./recommend.js";
import type {
  ApplyInitDependencies,
  ApplyResult,
  InitFileChange,
  InitProposal,
} from "./types.js";

const EXACT_TARGETS = new Set([
  ".github/workflows/zedbee.yml",
  ".zedbeerc.jsonc",
  "lefthook.yml",
  "lefthook.yaml",
  "package.json",
  ".husky/pre-commit",
  ".husky/.gitattributes",
  ".husky/install.mjs",
  ".husky/_/.gitignore",
  ".husky/_/h",
  ".husky/_/LICENSE.zedbee-husky",
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
  return decodeLosslessUtf8(await readFile(path));
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
  const hookName =
    change.relativePath === ".git/hooks/pre-commit"
      ? "pre-commit"
      : change.relativePath === ".git/hooks/pre-merge-commit"
        ? "pre-merge-commit"
        : undefined;
  if (
    hookName === undefined ||
    change.absolutePath === undefined ||
    !isAbsolute(change.absolutePath)
  ) {
    throw unsafeTarget();
  }
  const canonicalHook = await resolveRawGitHookPath(root, hookName, true);
  if (canonicalHook !== change.absolutePath) throw unsafeTarget();
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
    if (
      change.relativePath === ".git/hooks/pre-commit" ||
      change.relativePath === ".git/hooks/pre-merge-commit"
    ) {
      path = await validatedRawGitPath(root, change);
    } else {
      const hookName = basename(change.relativePath);
      if (hookName !== "pre-commit" && hookName !== "pre-merge-commit")
        throw unsafeTarget();
      const configured = await customGitHookPath(root, hookName);
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

export class InitRollbackError extends Error {
  constructor(readonly incompletePaths: readonly string[]) {
    super(
      "Zedbee initialization failed and rollback was incomplete." +
        (incompletePaths.length === 0
          ? ""
          : ` Inspect preserved or unrestored paths: ${incompletePaths.map((path) => JSON.stringify(path)).join(", ")}.`),
    );
    this.name = "InitRollbackError";
  }
}

interface InitWriteOwnership {
  readonly bytes: Buffer;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
}

function matchesWrite(
  state: {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    size: bigint;
    isFile(): boolean;
  },
  written: InitWriteOwnership,
): boolean {
  return (
    state.isFile() &&
    state.dev === written.device &&
    state.ino === written.inode &&
    (BigInt(state.mode) & 0o7777n) === written.mode &&
    BigInt(state.size) === BigInt(written.bytes.length)
  );
}

async function assertOwned(
  path: string,
  written: InitWriteOwnership,
): Promise<void> {
  if ((await realpath(dirname(path))) !== dirname(path)) throw unsafeTarget();
  if (!matchesWrite(await lstat(path, { bigint: true }), written))
    throw unsafeTarget();
  const handle = await openWithoutFollowing(path);
  try {
    const state = await handle.stat({ bigint: true });
    if (!matchesWrite(state, written)) throw unsafeTarget();
    const bytes = await readBoundedBytes(handle, path, written.bytes.length);
    if (
      !bytes.equals(written.bytes) ||
      !matchesWrite(await lstat(path, { bigint: true }), written)
    )
      throw unsafeTarget();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(
  path: string,
  contents: string,
  mode: number,
  expectedOwnership?: InitWriteOwnership,
): Promise<InitWriteOwnership> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) throw unsafeTarget();
  const temporary = resolve(
    parent,
    `.zedbee-init-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  const bytes = Buffer.from(contents, "utf8");
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
    const written = await handle.stat({ bigint: true });
    await handle.close();
    if (expectedOwnership !== undefined)
      await assertOwned(path, expectedOwnership);
    await rename(temporary, path);
    renamed = true;
    return {
      bytes,
      device: written.dev,
      inode: written.ino,
      mode: written.mode & 0o7777n,
    };
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

export async function applyInitProposal(
  proposal: InitProposal,
  dependencies: ApplyInitDependencies = {},
): Promise<ApplyResult> {
  const signal = dependencies.signal;
  signal?.throwIfAborted();
  const root = await realpath(resolve(proposal.repositoryRoot)).catch(() => {
    throw unsafeTarget();
  });
  if ((proposal.eslintConflicts?.length ?? 0) > 0)
    throw new ProjectEslintSetupError(proposal.eslintConflicts!.join(" "));
  const eslintRoots = proposal.projectEslintTrustRoots ?? [];
  if (eslintRoots.length > 0 && proposal.projectEslintTrustConfirmed !== true) {
    for (const projectRoot of eslintRoots) {
      if (!(await hasProjectEslintTrust(root, projectRoot, "execute")))
        throw new ProjectEslintSetupError(
          "Project ESLint requires separate execution trust. Use --trust-project-eslint or confirm its disclosure interactively.",
        );
    }
  }
  if (
    eslintRoots.length > 0 &&
    proposal.projectEslintMessages === "full" &&
    proposal.projectEslintMessagesConfirmed !== true
  ) {
    for (const projectRoot of eslintRoots) {
      if (!(await hasProjectEslintTrust(root, projectRoot, "messages")))
        throw new ProjectEslintSetupError(
          "Full project ESLint messages require separate source-disclosure consent. Use --allow-project-eslint-messages or choose redacted messages.",
        );
    }
  }
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

  const updatedFiles: string[] = [];
  const undo: Array<() => Promise<unknown>> = [];
  const incompletePaths = new Set<string>();
  if (proposal.executableEvaluatedConfigs !== undefined) {
    await verifyExecutableImportProvenance(
      root,
      proposal.executableEvaluatedConfigs,
    );
  }
  try {
    for (const [index, item] of validated.entries()) {
      await dependencies.beforeWrite?.(index, item.change);
      signal?.throwIfAborted();
      const refreshed = await validateChange(root, item.change);
      if (refreshed.path !== item.path) throw unsafeTarget();
      const mode = item.change.relativePath.startsWith(".husky/_/")
        ? item.change.mode
        : refreshed.mode;
      if (
        (item.change.relativePath === ".zedbeerc.jsonc" ||
          item.change.relativePath === ".husky/.gitattributes" ||
          item.change.relativePath.startsWith(".husky/_/")) &&
        refreshed.before === item.change.after &&
        refreshed.mode === mode
      )
        continue;
      signal?.throwIfAborted();
      const written = await atomicReplace(item.path, item.change.after, mode);
      updatedFiles.push(item.change.relativePath);
      undo.push(async () => {
        try {
          if (refreshed.before === null) {
            await assertOwned(item.path, written);
            await unlink(item.path);
          } else {
            await atomicReplace(
              item.path,
              refreshed.before,
              refreshed.mode,
              written,
            );
          }
        } catch (error) {
          incompletePaths.add(item.change.relativePath);
          throw error;
        }
      });
    }
    if (proposal.hooksPathChange !== undefined) {
      await validateGitConfig(root);
      if ((await hooksPathValue(root)) !== proposal.hooksPathChange.before)
        throw new Error(
          "Git hook configuration changed during initialization.",
        );
      const git = new GitClient(root);
      const previous = await git.tryRun([
        "config",
        "--local",
        "--get",
        "core.hooksPath",
      ]);
      if (previous.exitCode !== 0 && previous.exitCode !== 1)
        throw new Error("Could not inspect local Git hook configuration.");
      signal?.throwIfAborted();
      await git.run([
        "config",
        "--local",
        "core.hooksPath",
        proposal.hooksPathChange.after,
      ]);
      undo.push(() =>
        git.run(
          previous.exitCode === 1
            ? ["config", "--local", "--unset", "core.hooksPath"]
            : ["config", "--local", "core.hooksPath", previous.stdout],
        ),
      );
    }
    if (
      proposal.projectPrettierTrustRoots !== undefined &&
      proposal.projectPrettierTrustRoots.length > 0
    ) {
      if (proposal.projectPrettierTrustConfirmed !== true) {
        throw unsafeTarget();
      }
      for (const projectRoot of proposal.projectPrettierTrustRoots) {
        signal?.throwIfAborted();
        const previous = await persistProjectPrettierTrust(root, projectRoot);
        undo.push(() => restoreProjectPrettierTrust(root, previous));
      }
    }
    for (const projectRoot of eslintRoots) {
      for (const capability of ["execute", "messages"] as const) {
        const confirmed =
          capability === "execute"
            ? proposal.projectEslintTrustConfirmed
            : proposal.projectEslintMessagesConfirmed;
        if (
          confirmed === true &&
          !(await hasProjectEslintTrust(root, projectRoot, capability))
        ) {
          signal?.throwIfAborted();
          await persistProjectEslintTrust(root, projectRoot, capability);
          undo.push(() =>
            revokeProjectEslintCapability(root, projectRoot, capability),
          );
        }
      }
    }
    if (
      proposal.projectPrettierRevokeRoots !== undefined &&
      proposal.projectPrettierRevokeRoots.length > 0
    ) {
      // Switching projects to managed/off withdraws their executable-code
      // grants in the same transaction; a failure restores each previous value.
      for (const projectRoot of proposal.projectPrettierRevokeRoots) {
        signal?.throwIfAborted();
        const revoked = await revokeProjectPrettierTrust(root, projectRoot);
        // This revocation removes a group of Git keys. Reinsert those keys in
        // their prior order when the undo stack is unwound.
        for (const previous of revoked.toReversed())
          undo.push(() => restoreProjectPrettierTrust(root, previous));
      }
    }
    signal?.throwIfAborted();
  } catch (error) {
    let incomplete = error instanceof ProjectPrettierTrustRollbackError;
    for (const compensate of undo.reverse()) {
      try {
        await compensate();
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) throw new InitRollbackError([...incompletePaths]);
    signal?.throwIfAborted();
    throw new Error("Zedbee initialization failed and was rolled back.");
  }
  return Object.freeze({
    applied: true,
    files: Object.freeze(updatedFiles),
    rolledBack: false,
  });
}
